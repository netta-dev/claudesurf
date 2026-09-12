// Browser lifecycle: locating the binary, the graphical environment, launching Chrome
// as a child over --remote-debugging-pipe, the handshake, the browser record, and
// reaping an orphan left by a previous daemon.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Connection } = require('./cdp');
const { browserRecordPath } = require('./paths');

// A misconfigured environment the human has to fix; renders as setup_error.
class SetupError extends Error {
  constructor(message) { super(message); this.name = 'SetupError'; }
}
// A launch that failed for another reason; renders as error.
class BrowserError extends Error {
  constructor(message) { super(message); this.name = 'BrowserError'; }
}

const BINARIES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
const GRAPHICAL_VARS = ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS'];
const HANDSHAKE_TIMEOUT_MS = 15_000;
// Chrome's RESULT_CODE_NORMAL_EXIT_PROCESS_NOTIFIED: the profile is held by another
// instance, which was told to open the launch's URLs instead.
const EXIT_HANDED_OFF = 21;
const REAP_GRACE_MS = 5_000;
const EXIT_STATUS_WAIT_MS = 2_000;

function locateBinary(env = process.env) {
  if (env.CLAUDESURF_BROWSER) return env.CLAUDESURF_BROWSER;
  for (const dir of (env.PATH || '').split(path.delimiter)) {
    for (const name of BINARIES) {
      const candidate = path.join(dir, name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch { /* not here */ }
    }
  }
  throw new SetupError(`No Chrome binary found: set CLAUDESURF_BROWSER or put one of ${BINARIES.join(', ')} on PATH`);
}

// The environment the browser is spawned with: the daemon's own when it has a display,
// else the allowlisted values the bridge sent. An XAUTHORITY naming a file this
// process cannot read is dropped, since the second OS user reaches the X server
// through an xhost grant rather than a cookie.
function graphicalEnv(processEnv, requestEnv = {}) {
  const source = processEnv.DISPLAY || processEnv.WAYLAND_DISPLAY ? processEnv : requestEnv;
  const picked = {};
  for (const name of GRAPHICAL_VARS) {
    if (typeof source[name] === 'string' && source[name] !== '') picked[name] = source[name];
  }
  if (!picked.DISPLAY && !picked.WAYLAND_DISPLAY) {
    throw new SetupError('No graphical session: neither the daemon nor the request carries DISPLAY or WAYLAND_DISPLAY. Add a drop-in with Environment=DISPLAY=... to the claudesurf unit, or run Claude Code from a desktop session.');
  }
  if (picked.XAUTHORITY) {
    try { fs.accessSync(picked.XAUTHORITY, fs.constants.R_OK); } catch { delete picked.XAUTHORITY; }
  }
  return picked;
}

function launchArgs(profileDir, headless) {
  const args = [
    '--remote-debugging-pipe',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--no-startup-window',
    '--hide-crash-restore-bubble',
    '--password-store=basic',
    '--disable-blink-features=AutomationControlled',
  ];
  if (headless) args.push('--headless=new');
  return args;
}

function processStartTime(pid) {
  let stat;
  try { stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch { return null; }
  // The command name in parentheses may contain spaces; fields start after the last ')'.
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return fields[19] || null; // field 22 overall, 1-based
}

function lockHolderPid(profileDir) {
  try {
    const link = fs.readlinkSync(path.join(profileDir, 'SingletonLock'));
    const m = link.match(/-(\d+)$/);
    return m ? m[1] : null;
  } catch { return null; }
}

// Spawns the browser and completes the handshake. Resolves { conn, child } once
// Browser.getVersion answers; a pre-handshake exit rejects with SetupError (exit 21,
// the profile is held by another Chrome) or BrowserError (anything else, carrying
// the child's last stderr lines).
async function launch({ binary, profileDir, env, headless = false, log, args: extraArgs = [] }) {
  fs.mkdirSync(profileDir, { recursive: true });
  const child = spawn(binary, [...launchArgs(profileDir, headless), ...extraArgs], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
  const conn = new Connection(child.stdio[4], child.stdio[3], log);
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', (e) => resolve({ code: null, signal: null, spawnError: e }));
  });
  exited.then(({ code, signal, spawnError }) => {
    if (!spawnError) log.info(`browser pid ${child.pid} exited (${signal || `code ${code}`})`);
  });
  conn.onClose(() => clearRecord());
  let version;
  try {
    version = await conn.send('Browser.getVersion', {}, { timeout: HANDSHAKE_TIMEOUT_MS });
  } catch (e) {
    conn.close();
    // The pipe reaches EOF before the exit status arrives; wait briefly for it.
    const status = await Promise.race([exited, new Promise((r) => setTimeout(() => r(null), EXIT_STATUS_WAIT_MS))]);
    if (!status) {
      child.kill('SIGKILL');
      throw new BrowserError(`Browser handshake failed: ${e.message}`);
    }
    if (status.spawnError) throw new BrowserError(`Cannot start ${binary}: ${status.spawnError.message}`);
    if (status.code === EXIT_HANDED_OFF) {
      const holder = lockHolderPid(profileDir);
      throw new SetupError(`Profile ${profileDir} is held by another Chrome${holder ? ` (pid ${holder})` : ''}; close it or point CLAUDESURF_PROFILE_DIR elsewhere`);
    }
    const tail = stderr.trim().split('\n').slice(-5).join('\n');
    throw new BrowserError(`Browser exited before the handshake (${status.signal || `code ${status.code}`})${tail ? `:\n${tail}` : ''}`);
  }
  log.info(`browser pid ${child.pid}: ${version.product}`);
  writeRecord({ pid: child.pid, startTime: processStartTime(child.pid) });
  return { conn, child };
}

// Sent after every launch, once the attach handlers are registered: new targets pause
// until released, and downloads are denied.
async function enableTargets(conn) {
  await conn.send('Target.setAutoAttach', {
    autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
    filter: [{ type: 'page' }, { type: 'iframe' }],
  });
  await conn.send('Browser.setDownloadBehavior', { behavior: 'deny' });
}

function readRecord() {
  try { return JSON.parse(fs.readFileSync(browserRecordPath(), 'utf8')); } catch { return null; }
}

function writeRecord(record) {
  fs.writeFileSync(browserRecordPath(), JSON.stringify(record));
}

function clearRecord() {
  try { fs.unlinkSync(browserRecordPath()); } catch { /* already gone */ }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Runs at daemon start, before the socket is bound. Resolves true when a browser
// was reaped; a record whose process is gone or was reused is only cleared.
async function reapOrphan(log) {
  const record = readRecord();
  if (!record) return false;
  const { pid, startTime } = record;
  const same = alive(pid) && processStartTime(pid) === startTime;
  if (!same) {
    log.info(`browser record for pid ${pid} is stale; cleared`);
    clearRecord();
    return false;
  }
  log.warn(`reaping browser pid ${pid} left by a previous daemon`);
  process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + REAP_GRACE_MS;
  while (Date.now() < deadline && alive(pid)) await new Promise((r) => setTimeout(r, 100));
  if (alive(pid)) process.kill(pid, 'SIGKILL');
  clearRecord();
  return true;
}

module.exports = {
  SetupError, BrowserError, GRAPHICAL_VARS,
  locateBinary, graphicalEnv, launch, enableTargets,
  readRecord, writeRecord, clearRecord, reapOrphan, processStartTime,
};
