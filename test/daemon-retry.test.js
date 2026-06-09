#!/usr/bin/env node

// Tests for the MCP bridge's behavior when the daemon is unreachable.
//
// The daemon runs as a systemd service (Restart=always), so a crash is back in ~3s.
// server.js retries ECONNREFUSED over that window so a restart is invisible, and if the
// daemon stays down it returns a message pointing at the service, not a bare `node` cmd.
//
// This is an integration test: it spawns the real server.js, drives one MCP tools/call
// over stdio, and points the bridge at a throwaway port via CLAUDESURF_DAEMON_PORT.
//
//   node test/daemon-retry.test.js
//
// Red/green: run against the pre-fix bridge to see both checks fail —
//   tmp=$(mktemp /tmp/old-XXXX.js)
//   git show HEAD:server/server.js \
//     | sed 's#const DAEMON_PORT = 7865;#const DAEMON_PORT = Number(process.env.CLAUDESURF_DAEMON_PORT) || 7865;#' > "$tmp"
//   CLAUDESURF_TEST_SERVER=$tmp node test/daemon-retry.test.js   # A1 + B1 FAIL

const { spawn } = require('child_process');
const net = require('net');
const http = require('http');
const path = require('path');
const assert = require('assert');

const SERVER = process.env.CLAUDESURF_TEST_SERVER || path.join(__dirname, '..', 'server', 'server.js');

// Reserve an ephemeral port, then free it — so the bridge first sees ECONNREFUSED there
// and we can (optionally) bind a mock daemon on it mid-flight.
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

// Spawn the bridge, send one tools/call, resolve { response, stderr } when the JSON-RPC
// reply arrives. If startDaemonAfterMs is set, a mock daemon binds `port` at that time
// and answers every request with a success payload.
function callTool({ port, startDaemonAfterMs }) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, CLAUDESURF_DAEMON_PORT: String(port), CLAUDE_CODE_SESSION_ID: 'test-retry' };
    const child = spawn('node', [SERVER], { env });
    let out = '', err = '', daemon = null, done = false;
    const finish = (fn) => {
      if (done) return; done = true;
      clearTimeout(timer);
      try { child.kill(); } catch {}
      if (daemon) { try { daemon.close(); } catch {} }
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error('timed out waiting for MCP reply\nstderr:\n' + err))), 9000);

    child.stdout.on('data', (d) => {
      out += d;
      for (const line of out.split('\n')) {
        if (!line.trim()) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) { finish(() => resolve({ response: msg, stderr: err })); return; }
      }
    });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish(() => reject(e)));

    if (startDaemonAfterMs !== undefined) {
      setTimeout(() => {
        if (done) return;
        daemon = http.createServer((req, res) => {
          let b = ''; req.on('data', (c) => { b += c; });
          req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, url: 'http://retry-rode-it-out', title: 't' }));
          });
        });
        daemon.listen(port, '127.0.0.1');
      }, startDaemonAfterMs);
    }

    // Give the bridge a moment to attach its stdin reader, then issue the call.
    setTimeout(() => {
      child.stdin.write(JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_page_info', arguments: {} },
      }) + '\n');
    }, 150);
  });
}

(async () => {
  let passed = 0;
  const ok = (label) => { passed++; console.log('  ok - ' + label); };

  console.log('A1. Retry makes a daemon restart invisible (down at first, up within the window):');
  {
    const port = await freePort();
    const { response, stderr } = await callTool({ port, startDaemonAfterMs: 1500 });
    const text = response.result.content[0].text;
    assert(!response.result.isError, 'should succeed once the daemon comes up; got: ' + text);
    assert(text.includes('retry-rode-it-out'), 'should return the mock daemon payload; got: ' + text);
    assert(/retrying \(/.test(stderr), 'should have logged at least one retry; stderr:\n' + stderr);
    ok('down→up within window returns success after retrying');
  }

  console.log('B1. Daemon stays down → systemctl message, no `node` foot-gun:');
  {
    const port = await freePort();
    const { response } = await callTool({ port }); // never bring a daemon up
    const text = response.result.content[0].text;
    assert(response.result.isError, 'should be an error when the daemon stays down; got: ' + text);
    assert(text.includes('systemctl --user restart claudesurf'), 'message should point at the service; got: ' + text);
    assert(!/\bnode\b/.test(text), 'message must not tell the agent to run node directly; got: ' + text);
    ok('stays-down returns the systemctl message after exhausting retries');
  }

  console.log('\n' + passed + ' checks passed.');
})().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
