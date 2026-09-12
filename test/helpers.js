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

let seq = 0;
function tmpDir(prefix = 'claudesurf-test') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-${process.pid}-${++seq}-`));
}

function tmpSocket() {
  return path.join(tmpDir(), 'cs.sock');
}

// In-process fake browser behind a Connection, with Sessions attached and auto-attach
// enabled, as the daemon does after a launch.
function fakeSession() {
  const { Sessions } = require('../server/sessions');
  const { fake, readable, writable } = FakeBrowser.inProcess();
  const conn = new Connection(readable, writable, silentLog);
  const sessions = new Sessions(silentLog);
  sessions.attach(conn);
  return { fake, conn, sessions };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitFor(pred, timeoutMs = 3000, stepMs = 20) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return true;
    await sleep(stepMs);
  }
  return false;
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
      CLAUDESURF_BROWSER: FAKE_CHROME,
      DISPLAY: ':0',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const up = await waitFor(() => request({ socketPath }).then(() => true, () => false), 5000);
  if (!up) { child.kill(); throw new Error(`daemon did not come up\n${log}`); }
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

// Spawns the real bridge against `socketPath`, sends one tools/call, and resolves
// { response, stderr } with the JSON-RPC reply.
function callBridge({ socketPath, name, args, env = {}, timeoutMs = 9000 }) {
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
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    }, 150);
  });
}

// The installed Chrome, or null when none is found (live tests skip then).
function liveBinary() {
  try { return require('../server/browser').locateBinary(); } catch { return null; }
}

// Launches the real browser against a temp profile with Sessions attached; headless
// unless asked otherwise. Own socket path so the record lands in the temp directory.
async function liveBrowser({ headless = true } = {}) {
  const browser = require('../server/browser');
  const { Sessions } = require('../server/sessions');
  const dir = tmpDir('claudesurf-live');
  process.env.CLAUDESURF_SOCKET = path.join(dir, 'cs.sock');
  const env = headless ? {} : browser.graphicalEnv(process.env, {});
  const { conn, child } = await browser.launch({ binary: liveBinary(), profileDir: path.join(dir, 'profile'), env, headless, log: silentLog });
  const sessions = new Sessions(silentLog);
  sessions.attach(conn);
  await browser.enableTargets(conn);
  return {
    conn, child, sessions, dir,
    close: async () => {
      await conn.send('Browser.close').catch(() => {});
      await waitFor(() => child.exitCode !== null || child.signalCode !== null, 5000);
      if (child.exitCode === null) child.kill('SIGKILL');
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

module.exports = { silentLog, tmpDir, tmpSocket, fakeSession, sleep, waitFor, request, spawnDaemon, mockDaemon, callBridge, liveBinary, liveBrowser, SERVER_DIR, FAKE_CHROME };
