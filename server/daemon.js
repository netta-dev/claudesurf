#!/usr/bin/env node

// Persistent daemon process — run once, stays up.
// Owns the WebSocket connections to one or more Chrome extension instances
// (one per Chrome profile) and exposes an HTTP API for MCP server instances.

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = 7865;
const FOCUS_PROBE_TIMEOUT_MS = 500;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

const connectedExtensions = new Set();
const sessionBindings = new Map();
const pendingRequests = new Map();
let requestId = 0;

function log(...args) {
  console.log('[ClaudeSurf daemon]', ...args);
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
  return live.reduce((best, r) => (r.ts > best.ts ? r : best)).socket;
}

async function getOrBindSessionSocket(sessionId) {
  const bound = sessionBindings.get(sessionId);
  if (bound && connectedExtensions.has(bound) && bound.readyState === 1) {
    return bound;
  }
  const picked = await pickProfileForSession();
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

// HTTP server handles API requests from MCP server instances
const httpServer = http.createServer(async (req, res) => {
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

// WebSocket server for Chrome extension, shares the HTTP server
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (socket) => {
  log('Chrome extension connected');
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
    log('Chrome extension disconnected');
    connectedExtensions.delete(socket);
    for (const [sid, s] of sessionBindings.entries()) {
      if (s === socket) sessionBindings.delete(sid);
    }
    for (const [id, entry] of pendingRequests.entries()) {
      if (entry.socket === socket) {
        pendingRequests.delete(id);
        entry.reject(new Error('Extension disconnected before responding'));
      }
    }
  });
});

httpServer.listen(PORT, () => {
  log(`Listening on port ${PORT}`);
  log('Waiting for Chrome extension...');
});
