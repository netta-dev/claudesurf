// Shared derivation of the daemon's command-channel address.
//
// The command channel (/api + /health) is a Unix domain socket, 0600, in the per-user
// runtime dir — so ONLY the same OS user can send the daemon commands. That's the
// security boundary between users z and c: c physically cannot open a socket sitting in
// /run/user/<z-uid> (mode 0700), so c can never drive z's Chrome, no matter how routing
// behaves or what a hand-crafted request claims.
//
// daemon.js and server.js run as the same user, so they derive the same path from the
// per-uid runtime dir. An explicit CLAUDESURF_SOCKET overrides it (used by tests).
const path = require('path');

function daemonSocketPath() {
  if (process.env.CLAUDESURF_SOCKET) return process.env.CLAUDESURF_SOCKET;
  const runtimeDir = process.env.XDG_RUNTIME_DIR || path.join('/run/user', String(process.getuid()));
  return path.join(runtimeDir, 'claudesurf.sock');
}

module.exports = { daemonSocketPath };
