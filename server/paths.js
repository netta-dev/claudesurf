// The daemon's paths (the command socket, the browser profile, the browser record, the
// allowlist, and the action log); the graphical variables that the bridge forwards; and
// the XAUTHORITY check that the browser's and the desktop tools' environments share.
// The bridge takes the socket path from here too. Each path follows its override, so a
// worktree daemon started with CLAUDESURF_SOCKET, CLAUDESURF_PROFILE_DIR,
// CLAUDESURF_POLICY_FILE, and CLAUDESURF_ACTION_LOG uses its own socket, profile,
// record, allowlist, and log.
const fs = require('fs');
const os = require('os');
const path = require('path');

// The bridge sends these from Claude Code's environment; the daemon uses them for
// the browser when its own environment has no display.
const GRAPHICAL_VARS = ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS'];

function dropUnreadableXauthority(env) {
  if (env.XAUTHORITY) {
    try { fs.accessSync(env.XAUTHORITY, fs.constants.R_OK); } catch { delete env.XAUTHORITY; }
  }
  return env;
}

// Unix socket, 0600 inside the 0700 per-user runtime directory; only this OS user can
// reach it.
function daemonSocketPath() {
  if (process.env.CLAUDESURF_SOCKET) return process.env.CLAUDESURF_SOCKET;
  const runtimeDir = process.env.XDG_RUNTIME_DIR || path.join('/run/user', String(process.getuid()));
  return path.join(runtimeDir, 'claudesurf.sock');
}

// The dedicated Chrome profile; persists across reboots so its logins survive.
function profileDir() {
  if (process.env.CLAUDESURF_PROFILE_DIR) return process.env.CLAUDESURF_PROFILE_DIR;
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(dataHome, 'claudesurf', 'profile');
}

// Returns the path of the domain gate's allowlist, one host per line; the human edits
// it by hand too.
function policyFile() {
  if (process.env.CLAUDESURF_POLICY_FILE) return process.env.CLAUDESURF_POLICY_FILE;
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configHome, 'claudesurf', 'allowed-hosts');
}

// Returns the path of the action log, one JSON record per call that reaches the daemon.
function actionLogPath() {
  if (process.env.CLAUDESURF_ACTION_LOG) return process.env.CLAUDESURF_ACTION_LOG;
  const stateHome = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(stateHome, 'claudesurf', 'actions.jsonl');
}

// Beside the socket, named after it: /run/user/1001/claudesurf.sock records at
// /run/user/1001/claudesurf.browser.json. Lives in the runtime directory, which is
// cleared at logout, matching the browser's lifetime.
function browserRecordPath() {
  const sock = daemonSocketPath();
  const base = path.basename(sock, path.extname(sock));
  return path.join(path.dirname(sock), base + '.browser.json');
}

module.exports = { daemonSocketPath, profileDir, browserRecordPath, policyFile, actionLogPath, GRAPHICAL_VARS, dropUnreadableXauthority };
