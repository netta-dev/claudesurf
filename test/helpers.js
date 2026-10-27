// Shared test scaffolding: temp paths, a silent logger, the in-process fake wired to a
// Connection and Sessions, and a daemon child on a temp socket.

const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { Connection } = require('../server/cdp');
const { FakeBrowser } = require('./fakes/fake-browser');

const SERVER_DIR = path.join(__dirname, '..', 'server');
const FAKE_CHROME = path.join(__dirname, 'fakes', 'fake-chrome.js');

const silentLog = { debug() {}, info() {}, warn() {}, error() {} };

// The skip reason of a test that needs a file mode to deny it access, which root
// bypasses; false for any other user.
const modesIgnored = process.getuid && process.getuid() === 0 ? 'root passes file modes, which this test needs to deny access' : false;

// A logger that keeps its lines per level, for tests that assert on diagnostics.
function recordingLog() {
  const lines = { debug: [], info: [], warn: [], error: [] };
  const keep = (level) => (...args) => lines[level].push(args.map(String).join(' '));
  return { lines, debug: keep('debug'), info: keep('info'), warn: keep('warn'), error: keep('error') };
}

let seq = 0;
function tmpDir(prefix = 'claudesurf-test') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-${process.pid}-${++seq}-`));
}

function tmpSocket() {
  return path.join(tmpDir(), 'cs.sock');
}

// Sets process.env entries (null unsets) and returns the function that restores them.
function setEnv(overrides) {
  const saved = {};
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = process.env[k];
    if (v === null) delete process.env[k]; else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };
}

// Runs fn with the overrides in place and restores them after it settles.
async function withEnv(overrides, fn) {
  const restore = setEnv(overrides);
  try { return await fn(); } finally { restore(); }
}

// A temp directory with its own socket path (hence record path) and profile, both
// removed and the env restored when the test ends.
function isolatedPaths(t, prefix = 'claudesurf-test') {
  const dir = tmpDir(prefix);
  const restore = setEnv({ CLAUDESURF_SOCKET: path.join(dir, 'cs.sock') });
  t.after(() => { restore(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, profileDir: path.join(dir, 'profile'), record: path.join(dir, 'cs.browser.json') };
}

// Temp directories that outlive the test that made them, removed when the process
// exits.
const leftovers = [];
process.once('exit', () => {
  for (const dir of leftovers) fs.rmSync(dir, { recursive: true, force: true });
});

// Writes an allowlist file in `dir` listing `hosts`, as the human writes one.
function writeAllowlist(dir, hosts) {
  const file = path.join(dir, 'allowed-hosts');
  fs.writeFileSync(file, hosts.map((host) => `${host}\n`).join(''));
  return file;
}

// Attaches the domain gate over an allowlist of `allow` to `conn` as the daemon
// attaches it on a launch: before auto-attach, so every armed tab gets Fetch.enable.
function attachGate(sessions, conn, { allow, dir, log }) {
  const { Policy } = require('../server/policy');
  const { Gate } = require('../server/gate');
  const policyFile = writeAllowlist(dir, allow);
  const policy = new Policy({ file: policyFile, log });
  const gate = new Gate({ sessions, policy, log });
  gate.attach(conn);
  return { gate, policy, policyFile };
}

// Returns an in-process fake browser behind a Connection, with Sessions attached as
// the daemon attaches them after a launch, and the handlers' context over it; the
// caller enables auto-attach. `log` is the daemon's one logger, which a test replaces
// with recordingLog() to read the diagnostics back. With `allow`, a list of hosts, the
// domain gate attaches over an allowlist of them; without it the gate is null, and a
// handler's pre-check passes every URL. Given the test `t`, settling's quiet window is
// `quietMs` until the test ends, and null leaves the 500 ms default; without `t` the
// window is left alone, for tests that don't settle.
function fakeSession({ t, log = silentLog, allow, quietMs = 20 } = {}) {
  if (t) {
    const restore = setEnv({ CLAUDESURF_SETTLE_QUIET_MS: quietMs === null ? null : String(quietMs) });
    t.after(restore);
  }
  const { Sessions } = require('../server/sessions');
  const { fake, readable, writable } = FakeBrowser.inProcess();
  const conn = new Connection(readable, writable, log);
  const sessions = new Sessions(log);
  sessions.attach(conn);
  let gated = { gate: null, policy: null, policyFile: null };
  if (allow) {
    const dir = tmpDir('claudesurf-policy');
    leftovers.push(dir);
    gated = attachGate(sessions, conn, { allow, dir, log });
  }
  const { gate, policy, policyFile } = gated;
  return { fake, conn, sessions, log, gate, policy, policyFile, context: { sessions, gate, policy, log } };
}

// Resolves with fakeSession()'s context over `options`, plus session s1 as `session`
// and its working tab's registry record as `target`, once that tab has navigated to
// `url`. `site` maps each URL to the fixture that the fake serves there.
async function navigatedSession({ url, site, ...options }) {
  const ctx = fakeSession(options);
  await require('../server/browser').enableTargets(ctx.conn);
  Object.assign(ctx.fake.site, site);
  const session = await ctx.sessions.ensure('s1');
  await require('../server/navigation').navigate(ctx.context, session, { url, name: 'n' });
  return { ...ctx, session, target: ctx.sessions.target(session.workingTargetId) };
}

// Replaces the fake's handler for `method` with one that answers a call on a
// page-opened tab with `answer` and passes any other call to the handler it replaced.
function handleOpened(fake, method, answer) {
  const original = fake.handlers.get(method);
  fake.handle(method, (p, sid, f) => (fake.bySession(sid).openerId ? answer(p, sid, f) : original(p, sid, f)));
}

// Resolves with a page read's result with its head and body joined as `payload`, as
// the response carries them when neither a dialog nor a refusal line comes between.
async function readPayload(sessions, session, args) {
  const result = await require('../server/read').readPage(sessions, session, args);
  return { ...result, payload: result.body ? `${result.head}\n\n${result.body}` : result.head };
}

// The refs a page payload carries, keyed by the name beside them: control, landmark,
// and group markers, both link forms, and the hidden section's lines.
function refsIn(payload) {
  const refs = {};
  const collect = (pattern, nameFirst) => {
    for (const match of payload.matchAll(pattern)) {
      const [, first, second] = match;
      refs[nameFirst ? first : second] = nameFirst ? second : first;
    }
  };
  collect(/\[((?:f\d+)?e\d+) [\w-]+ "([^"]*)"/g, false);
  collect(/\[((?:f\d+)?e\d+)\] [\w-]+ "([^"]*)"/g, false);
  collect(/\[([^[\]\n]*)\]\([^)\n]*\)\[((?:f\d+)?e\d+)\]/g, true);
  collect(/\[([^[\]\n]*)\]\[((?:f\d+)?e\d+)\]/g, true);
  return refs;
}

// Returns every ref that a payload's markers and links' trailing refs carry, each once
// in the order it first appears, read by the daemon's own rule (render.js's
// markedRefs): an unescaped bracket, which page text that Turndown escaped doesn't
// open. A reader that stripped the escapes and the quoted fields instead would drop a
// name that forged a marker along with them.
function markedRefs(text) {
  return [...require('../server/render').markedRefs(text)];
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Polls until `pred` holds; throws at the timeout, so a test that waited for something
// that never happened fails there rather than on the assertion after it.
async function waitFor(pred, timeoutMs = 3000, stepMs = 20) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return true;
    await sleep(stepMs);
  }
  throw new Error(`condition did not hold within ${timeoutMs} ms: ${pred}`);
}

function request({ socketPath, method = 'GET', path: p = '/health', body, timeout = 5000 }) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({ socketPath, path: p, method, headers: data === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(out); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, body: parsed, raw: out });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('request timed out')); });
    req.end(data);
  });
}

// Spawns the real daemon against the fake browser on a temp socket; resolves once
// /health answers. `env` overrides the child's environment.
async function spawnDaemon({ env = {} } = {}) {
  const dir = tmpDir('claudesurf-daemon');
  const socketPath = path.join(dir, 'cs.sock');
  const profile = path.join(dir, 'profile');
  const child = spawn(process.execPath, [path.join(SERVER_DIR, 'daemon.js')], {
    env: {
      ...process.env,
      CLAUDESURF_SOCKET: socketPath,
      CLAUDESURF_PROFILE_DIR: profile,
      CLAUDESURF_POLICY_FILE: writeAllowlist(dir, ['fake.test', 'frame.test']),
      CLAUDESURF_ACTION_LOG: path.join(dir, 'actions.jsonl'),
      CLAUDESURF_SETTLE_QUIET_MS: '20',
      CLAUDESURF_BROWSER: FAKE_CHROME,
      DISPLAY: ':0',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  try {
    await waitFor(() => request({ socketPath }).then(() => true, () => false), 5000);
  } catch {
    child.kill();
    throw new Error(`daemon did not come up\n${log}`);
  }
  return {
    socketPath, dir, child,
    log: () => log,
    api: (body) => request({ socketPath, method: 'POST', path: '/api', body, timeout: 40000 }),
    call: (sessionId, tool, action, args = {}) => request({ socketPath, method: 'POST', path: '/api', body: { sessionId, tool, action, args }, timeout: 40000 }).then((r) => r.body),
    stop: () => { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

// A mock daemon on `socketPath` answering every /api request with `respond(body)`;
// records the request bodies it saw.
function mockDaemon(socketPath, respond) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      const body = JSON.parse(b);
      seen.push(body);
      const answer = respond(body, res);
      if (answer === undefined) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(answer));
    });
  });
  return { seen, listen: () => new Promise((r) => server.listen(socketPath, r)), close: () => server.close() };
}

// Spawns the real bridge against `socketPath`, sends one JSON-RPC request — a
// tools/call of `name` with `args` unless `method` and `params` say otherwise — and
// resolves { response, stderr } with the reply.
function callBridge({ socketPath, name, args, method = 'tools/call', params = { name, arguments: args }, env = {}, timeoutMs = 9000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(SERVER_DIR, 'server.js')], {
      env: { ...process.env, CLAUDESURF_SOCKET: socketPath, CLAUDE_CODE_SESSION_ID: 'test-session', ...env },
    });
    let out = '';
    let err = '';
    let done = false;
    const finish = (fn) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error('timed out waiting for MCP reply\nstderr:\n' + err))), timeoutMs);
    child.stdout.on('data', (d) => {
      out += d;
      for (const line of out.split('\n')) {
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) { finish(() => resolve({ response: msg, stderr: err })); return; }
      }
    });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish(() => reject(e)));
    setTimeout(() => {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) + '\n');
    }, 150);
  });
}

// The installed Chrome, or null when none is found (live tests skip then).
function liveBinary() {
  try { return require('../server/browser').locateBinary(); } catch { return null; }
}

// Launches the real browser against a temp profile with Sessions attached; headless
// unless asked otherwise. Own socket path, so the record lands in the temp
// directory; the env is restored and the directory removed by close(). With `allow`,
// a list of hosts, the domain gate attaches over an allowlist of them, which the
// returned `policyFile` names; without it the handlers' context holds a null gate.
async function liveBrowser({ headless = true, allow } = {}) {
  const browser = require('../server/browser');
  const { Sessions } = require('../server/sessions');
  const dir = tmpDir('claudesurf-live');
  const restore = setEnv({ CLAUDESURF_SOCKET: path.join(dir, 'cs.sock') });
  const env = headless ? {} : browser.graphicalEnv(process.env, {});
  const { conn, child } = await browser.launch({ binary: liveBinary(), profileDir: path.join(dir, 'profile'), env, headless, log: silentLog });
  const sessions = new Sessions(silentLog);
  sessions.attach(conn);
  const { gate, policy, policyFile } = allow ? attachGate(sessions, conn, { allow, dir, log: silentLog }) : {};
  await browser.enableTargets(conn);
  return {
    conn, child, sessions, dir, gate, policy, policyFile,
    context: { sessions, gate: gate || null, policy: policy || null, log: silentLog },
    close: async () => {
      await conn.send('Browser.close').catch(() => {});
      const exited = () => child.exitCode !== null || child.signalCode !== null;
      // A Chrome that outlives the wait is killed, so the teardown still restores the
      // environment and removes the directory.
      await waitFor(exited, 5000).catch(() => {});
      if (!exited()) child.kill('SIGKILL');
      restore();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

module.exports = { silentLog, modesIgnored, recordingLog, tmpDir, tmpSocket, setEnv, withEnv, isolatedPaths, fakeSession, navigatedSession, handleOpened, readPayload, refsIn, markedRefs, sleep, waitFor, request, spawnDaemon, mockDaemon, callBridge, liveBinary, liveBrowser, FAKE_CHROME };
