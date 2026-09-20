// What the daemon and the bridge must agree on: the command socket, the browser
// profile, and the browser record paths, and the graphical variables the bridge
// forwards. Each path follows its override, so a worktree daemon started with
// CLAUDESURF_SOCKET and CLAUDESURF_PROFILE_DIR uses its own socket, profile, and
// record.
const os = require('os');
const path = require('path');

// The bridge sends these from Claude Code's environment; the daemon uses them for
// the browser when its own environment has no display.
const GRAPHICAL_VARS = ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS'];

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

// Beside the socket, named after it: /run/user/1001/claudesurf.sock records at
// /run/user/1001/claudesurf.browser.json. Lives in the runtime directory, which is
// cleared at logout, matching the browser's lifetime.
function browserRecordPath() {
  const sock = daemonSocketPath();
  const base = path.basename(sock, path.extname(sock));
  return path.join(path.dirname(sock), base + '.browser.json');
}

module.exports = { daemonSocketPath, profileDir, browserRecordPath, GRAPHICAL_VARS };
