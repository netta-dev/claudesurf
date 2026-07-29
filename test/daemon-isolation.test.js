#!/usr/bin/env node

// Tests for the daemon's per-user isolation surface (the two-channel split):
//
//   A. The command channel (/api + /health) is a Unix domain socket created 0600, so
//      only the daemon's own OS user can send it commands. This is THE boundary that
//      stops another user (e.g. c) from driving this user's Chrome — verify the mode.
//   B. A legitimate same-uid extension WebSocket is ACCEPTED. The daemon peer-uid-filters
//      incoming connections via /proc/net/tcp; this guards against the resolver breaking
//      and rejecting everyone (which would silently disable claudesurf for its own user).
//
// The reject-a-foreign-uid path can't be exercised without a second OS user, so it's
// verified live rather than here — see the daemon's peerUidForPort/connection handler.
//
//   node test/daemon-isolation.test.js

const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const DAEMON = path.join(__dirname, '..', 'server', 'daemon.js');
const WebSocket = require(path.join(__dirname, '..', 'server', 'node_modules', 'ws')).WebSocket;

const sock = path.join(os.tmpdir(), `claudesurf-iso-${process.pid}.sock`);

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function health(cb) {
  const req = http.request({ socketPath: sock, path: '/health', method: 'GET' }, (res) => {
    let d = ''; res.on('data', (c) => { d += c; });
    res.on('end', () => { try { cb(JSON.parse(d)); } catch { cb(null); } });
  });
  req.on('error', () => cb(null));
  req.setTimeout(1500, () => { req.destroy(); cb(null); });
  req.end();
}

function healthAsync() { return new Promise((r) => health(r)); }

async function waitFor(pred, timeoutMs, stepMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}

(async () => {
  let passed = 0;
  const ok = (label) => { passed++; console.log('  ok - ' + label); };

  try { fs.unlinkSync(sock); } catch {}
  const port = await freePort();
  const daemon = spawn('node', [DAEMON], {
    env: { ...process.env, CLAUDESURF_SOCKET: sock, CLAUDESURF_WS_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let dlog = '';
  daemon.stdout.on('data', (d) => { dlog += d; });
  daemon.stderr.on('data', (d) => { dlog += d; });

  const cleanup = () => { try { daemon.kill(); } catch {} try { fs.unlinkSync(sock); } catch {} };

  try {
    const up = await waitFor(async () => (await healthAsync()) !== null, 5000);
    assert(up, 'daemon should answer /health over the socket\ndaemon log:\n' + dlog);

    console.log('A. Command socket is created 0600 (same-user-only):');
    {
      const mode = fs.statSync(sock).mode & 0o777;
      assert.strictEqual(mode, 0o600, 'socket mode should be 0600, got 0' + mode.toString(8));
      ok('command socket mode is 0600');
    }

    console.log('B. A same-uid extension WebSocket is accepted (peer-uid resolver works):');
    {
      const before = (await healthAsync()).extensionsConnected;
      assert.strictEqual(before, 0, 'no extensions expected before connecting');
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
      const connected = await waitFor(async () => (await healthAsync()).extensionsConnected >= 1, 4000);
      assert(connected, 'same-uid extension should be accepted (count -> 1)\ndaemon log:\n' + dlog);
      ok('same-uid extension accepted; extensionsConnected -> 1');
      ws.close();
    }

    console.log('\n' + passed + ' checks passed.');
  } finally {
    cleanup();
  }
})().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
