#!/usr/bin/env node

// Persistent daemon process — run once, stays up. One per OS user.
// Owns the WebSocket connections to one or more Chrome extension instances
// (one per Chrome profile) and exposes a command API for MCP server instances.
//
// TWO channels, deliberately split so a second OS user can't reach this user's Chrome:
//   - Command channel (/api + /health): a Unix domain socket, 0600, in this user's
//     runtime dir. Only the same OS user's server.js can send commands. This is the
//     hard, kernel-enforced isolation boundary — see socket-path.js.
//   - Extension channel: a loopback TCP port (Chrome extensions can only speak ws://
//     TCP, not Unix sockets). We can't stop another user's Chrome from *connecting*, so
//     the daemon resolves each connection's real peer uid via /proc and rejects any that
//     isn't this user's — so a foreign Chrome can neither register here nor intercept
//     what this user browses.

const http = require('http');
const net = require('net');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const { daemonSocketPath } = require('./paths');

const WS_PORT = Number(process.env.CLAUDESURF_WS_PORT) || 7865;
const SOCK = daemonSocketPath();
const MY_UID = process.getuid();
const FOCUS_PROBE_TIMEOUT_MS = 500;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

const connectedExtensions = new Set();
const sessionBindings = new Map();
const pendingRequests = new Map();
let requestId = 0;
// [debug] never pruned — lets us tell a brand-new sessionId (MCP respawn) from a
// sessionId we've seen before that lost its binding (socket churn / profile change).
const seenSessions = new Set();
// [debug] stable short label per extension socket so logs can name profiles.
let socketSeq = 0;

function log(...args) {
  console.log('[ClaudeSurf daemon]', ...args);
}

// Resolve the OS uid owning the peer end of a loopback TCP connection by matching the
// peer's port against /proc/net/tcp{,6}. Chrome extensions connect over TCP, so
// SO_PEERCRED (the clean Unix-socket way) isn't available — this is the Linux-specific
// substitute. The peer's socket row has local_port = the peer's ephemeral port and
// rem_port = our WS listen port; requiring rem_port === WS_PORT excludes the daemon's
// own mirror-image accept()ed socket. Returns null if it can't be resolved (caller
// treats null as "not us" and rejects — fail closed).
function peerUidForPort(peerPort) {
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let data;
    try { data = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of data.split('\n').slice(1)) {
      const p = line.trim().split(/\s+/);
      if (p.length < 8) continue;
      const localPort = parseInt(p[1].split(':')[1], 16);
      const remPort = parseInt(p[2].split(':')[1], 16);
      if (localPort === peerPort && remPort === WS_PORT) {
        const uid = parseInt(p[7], 10);
        return Number.isNaN(uid) ? null : uid;
      }
    }
  }
  return null;
}

function sendToSocket(socket, action, params, sessionId, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    if (!socket || socket.readyState !== 1) {
      reject(new Error('Extension socket not open'));
      return;
    }
    const id = ++requestId;
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pendingRequests.set(id, {
      resolve: (result) => { clearTimeout(timer); resolve(result); },
      reject: (err) => { clearTimeout(timer); reject(err); },
      socket,
    });
    socket.send(JSON.stringify({ id, action, params, sessionId }));
  });
}

// Every extension here belongs to this same OS user (peer-uid filtered at connect), so
// the only thing to disambiguate is multiple Chrome *profiles* of this one user — done
// by most-recently-focused, exactly as before.
async function pickProfileForSession() {
  const sockets = [...connectedExtensions];
  if (sockets.length === 1) return sockets[0];

  const probed = await Promise.all(sockets.map((s) =>
    sendToSocket(s, '__claudesurf_get_focus', {}, null, FOCUS_PROBE_TIMEOUT_MS)
      .then((r) => ({ socket: s, ts: (r && r.lastFocusedAt) || 0 }))
      .catch(() => ({ socket: s, ts: 0 }))
  ));
  // Drop sockets that closed during the probe — picking a dead one would just throw
  // "Extension socket not open" downstream.
  const live = probed.filter((r) => connectedExtensions.has(r.socket) && r.socket.readyState === 1);
  if (live.length === 0) {
    throw new Error('All Chrome extension sockets closed during profile probe');
  }
  // Highest timestamp wins; first-connected breaks ties (reduce only swaps on strictly greater).
  const winner = live.reduce((best, r) => (r.ts > best.ts ? r : best)).socket;
  // [debug] show every candidate's focus timestamp + which one won. If the winner
  // differs from the session's previous profile, that's the "wrong window" path.
  log('[debug] focus probe:', live.map((r) => `ext#${r.socket.__csId}=${r.ts}`).join(' '),
    '-> picked ext#' + winner.__csId);
  return winner;
}

async function getOrBindSessionSocket(sessionId) {
  const short = sessionId.slice(0, 8);
  const bound = sessionBindings.get(sessionId);
  if (bound && connectedExtensions.has(bound) && bound.readyState === 1) {
    log(`[debug] session ${short}: REUSE binding -> ext#${bound.__csId}`);
    return bound;
  }
  // [debug] why are we (re)binding? Three cases, and they point at different bugs:
  //   - never seen   => a brand-new sessionId reached the daemon (MCP respawn / new session)
  //   - bound-gone   => we had a binding but its socket closed (service-worker death during
  //                     an idle gap, e.g. a compaction) — about to re-pick from current focus
  //   - no-binding   => seen before but not currently bound (binding was dropped earlier)
  const reason = !seenSessions.has(sessionId) ? 'never-seen'
    : (bound ? 'bound-socket-gone' : 'no-current-binding');
  seenSessions.add(sessionId);
  const picked = await pickProfileForSession();
  const rebindToDifferent = bound && bound !== picked;
  log(`[debug] session ${short}: BIND (${reason}) -> ext#${picked.__csId}`
    + (rebindToDifferent ? ` [CHANGED from ext#${bound.__csId} — expect a NEW window in ext#${picked.__csId}]` : ''));
  sessionBindings.set(sessionId, picked);
  return picked;
}

async function sendToExtension(action, params = {}, sessionId = null) {
  if (connectedExtensions.size === 0) {
    throw new Error('Chrome extension not connected. Make sure the ClaudeSurf extension is loaded and a page is open.');
  }
  const socket = await getOrBindSessionSocket(sessionId);
  return sendToSocket(socket, action, params, sessionId);
}

// --- Command channel: Unix domain socket (0600), same-user only ---
const commandServer = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/api') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
        if (typeof parsed.sessionId !== 'string' || parsed.sessionId.length === 0 || parsed.sessionId.length > 100) {
          throw new Error('Invalid or missing sessionId');
        }
        // Reserve __claudesurf_* for daemon-initiated internal RPC. External callers
        // must not be able to address that channel or they could read focus state and
        // trigger profile bindings as a side effect.
        if (typeof parsed.action === 'string' && parsed.action.startsWith('__claudesurf_')) {
          throw new Error('Reserved action');
        }
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
        return;
      }
      try {
        const { sessionId, action, params } = parsed;
        const result = await sendToExtension(action, params || {}, sessionId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  } else if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      extensionsConnected: connectedExtensions.size
    }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

// --- Extension channel: loopback TCP + WebSocket, peer-uid filtered ---
const wsHttpServer = http.createServer((req, res) => {
  res.writeHead(426, { 'Content-Type': 'text/plain' });
  res.end('This port serves the ClaudeSurf extension WebSocket only.');
});
const wss = new WebSocketServer({ server: wsHttpServer });

wss.on('connection', (socket, req) => {
  const peerPort = req.socket.remotePort;
  const peerUid = peerUidForPort(peerPort);
  if (peerUid !== MY_UID) {
    // A Chrome running as a different OS user (or an unresolvable peer). Refuse it, so a
    // foreign Chrome can't register as one of our profiles or eavesdrop on our sessions.
    log(`Rejected extension connection: peer uid ${peerUid} != daemon uid ${MY_UID} (port ${peerPort})`);
    socket.close(1008, 'unauthorized');
    return;
  }
  socket.__csId = ++socketSeq;
  log(`Chrome extension connected (ext#${socket.__csId}, uid ${peerUid}, ${connectedExtensions.size + 1} total)`);
  connectedExtensions.add(socket);

  socket.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    const pending = pendingRequests.get(msg.id);
    if (!pending) return;
    pendingRequests.delete(msg.id);
    if (msg.error) {
      pending.reject(new Error(msg.error));
    } else {
      pending.resolve(msg.result);
    }
  });

  socket.on('close', () => {
    connectedExtensions.delete(socket);
    // [debug] which sessions just lost their binding? Each of these will re-pick a
    // profile on its next tool call. If a service worker dies during a compaction's
    // idle gap, the session re-binds and may land elsewhere -> new window.
    const dropped = [];
    for (const [sid, s] of sessionBindings.entries()) {
      if (s === socket) { sessionBindings.delete(sid); dropped.push(sid.slice(0, 8)); }
    }
    log(`Chrome extension disconnected (ext#${socket.__csId}); dropped ${dropped.length} binding(s)`
      + (dropped.length ? ': ' + dropped.join(', ') : ''));
    for (const [id, entry] of pendingRequests.entries()) {
      if (entry.socket === socket) {
        pendingRequests.delete(id);
        entry.reject(new Error('Extension disconnected before responding'));
      }
    }
  });
});

// --- Startup: bind the command socket (handling a stale one), then the WS port ---
function startCommandServer() {
  commandServer.once('error', (e) => {
    if (e.code !== 'EADDRINUSE') {
      log('Command socket error:', e.message);
      process.exit(1);
    }
    // The socket file exists. Either a live daemon owns it, or it's a leftover from a
    // crash/unclean exit. Probe: if we can connect, someone's home — bail rather than
    // steal it. If the connect is refused, it's stale — unlink and retry once.
    const probe = net.connect(SOCK);
    probe.once('connect', () => {
      probe.destroy();
      log(`Another daemon is already listening on ${SOCK}; exiting.`);
      process.exit(1);
    });
    probe.once('error', () => {
      try { fs.unlinkSync(SOCK); } catch {}
      commandServer.listen(SOCK, onCommandListening);
    });
  });
  commandServer.listen(SOCK, onCommandListening);
}

function onCommandListening() {
  fs.chmodSync(SOCK, 0o600); // belt-and-suspenders on top of the 0700 runtime dir
  log(`Command socket listening at ${SOCK} (0600, uid ${MY_UID})`);
  wsHttpServer.listen(WS_PORT, '127.0.0.1', () => {
    log(`Extension WebSocket listening on 127.0.0.1:${WS_PORT}`);
    log('Waiting for Chrome extension...');
  });
}

function cleanup() {
  try { fs.unlinkSync(SOCK); } catch {}
  process.exit(0);
}
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

startCommandServer();
