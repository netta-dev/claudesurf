// browser.js against fake-chrome: launch and handshake, exit-code handling, the
// browser record and reap, and the graphical environment.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const browser = require('../server/browser');
const { silentLog, tmpDir, sleep, waitFor, FAKE_CHROME } = require('./helpers');

// Every test gets its own socket (hence record path) and profile.
function isolate() {
  const dir = tmpDir('claudesurf-browser');
  process.env.CLAUDESURF_SOCKET = path.join(dir, 'cs.sock');
  return { dir, profileDir: path.join(dir, 'profile'), record: path.join(dir, 'cs.browser.json') };
}

function fakeLaunch(profileDir, env = {}) {
  return browser.launch({ binary: FAKE_CHROME, profileDir, env, log: silentLog });
}

test('launch completes the handshake, writes the record, and enableTargets sends auto-attach and download denial', async () => {
  const { profileDir, record } = isolate();
  const log = { ...silentLog, info: (m) => log.lines.push(m), lines: [] };
  const { conn, child } = await browser.launch({ binary: FAKE_CHROME, profileDir, env: {}, log });
  try {
    assert.ok(log.lines.some((l) => /FakeChrome\/1\.0/.test(l)), 'product string logged');
    const written = JSON.parse(fs.readFileSync(record, 'utf8'));
    assert.strictEqual(written.pid, child.pid);
    assert.strictEqual(written.startTime, browser.processStartTime(child.pid));
    await browser.enableTargets(conn);
    assert.ok(fs.existsSync(profileDir), 'profile directory created');
  } finally {
    conn.close();
  }
  await waitFor(() => !fs.existsSync(record));
  assert.ok(!fs.existsSync(record), 'record cleared when the pipe closes');
});

test('exit 21 before the handshake is setup_error naming the profile and lock holder', async () => {
  const { profileDir } = isolate();
  fs.mkdirSync(profileDir, { recursive: true });
  fs.symlinkSync('host-4242', path.join(profileDir, 'SingletonLock'));
  await assert.rejects(fakeLaunch(profileDir, { CLAUDESURF_FAKE_EXIT: '21' }), (e) => {
    assert.ok(e instanceof browser.SetupError);
    assert.match(e.message, new RegExp(`held by another Chrome \\(pid 4242\\)`));
    assert.ok(e.message.includes(profileDir));
    return true;
  });
});

test('any other pre-handshake exit is a BrowserError carrying stderr', async () => {
  const { profileDir } = isolate();
  await assert.rejects(fakeLaunch(profileDir, { CLAUDESURF_FAKE_EXIT: '3', CLAUDESURF_FAKE_STDERR: 'libgbm: no device' }), (e) => {
    assert.ok(e instanceof browser.BrowserError);
    assert.match(e.message, /exited before the handshake \(code 3\)/);
    assert.match(e.message, /libgbm: no device/);
    return true;
  });
});

test('the record is left in place when the daemon side stops without the pipe closing', async () => {
  const { profileDir, record } = isolate();
  const { conn, child } = await fakeLaunch(profileDir);
  assert.ok(fs.existsSync(record));
  // Stopping the daemon leaves the record to the next daemon; only a close clears it.
  assert.ok(fs.existsSync(record));
  conn.close();
  await waitFor(() => child.exitCode !== null);
});

test('reapOrphan clears a record whose process is gone', async () => {
  const { record } = isolate();
  browser.writeRecord({ pid: 2 ** 22 - 7, startTime: '1' });
  assert.strictEqual(await browser.reapOrphan(silentLog), false);
  assert.ok(!fs.existsSync(record));
});

test('reapOrphan ignores a live pid whose start time differs', async () => {
  const { record } = isolate();
  browser.writeRecord({ pid: process.pid, startTime: 'not-this-process' });
  assert.strictEqual(await browser.reapOrphan(silentLog), false);
  assert.ok(!fs.existsSync(record), 'stale record cleared');
});

test('reapOrphan terminates a live fake matching the record', async () => {
  const { record } = isolate();
  const child = spawn(process.execPath, [FAKE_CHROME], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  await sleep(200);
  browser.writeRecord({ pid: child.pid, startTime: browser.processStartTime(child.pid) });
  assert.strictEqual(await browser.reapOrphan(silentLog), true);
  assert.ok(await waitFor(() => child.exitCode !== null || child.signalCode !== null));
  assert.ok(!fs.existsSync(record));
});

test('graphicalEnv takes the process values when it has a display, else the request values', () => {
  const own = browser.graphicalEnv({ DISPLAY: ':0', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/a' }, { DISPLAY: ':9' });
  assert.deepStrictEqual(own, { DISPLAY: ':0', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/a' });
  const fromRequest = browser.graphicalEnv({ HOME: '/x' }, { DISPLAY: ':9', WAYLAND_DISPLAY: 'wayland-0', PATH: '/evil' });
  assert.deepStrictEqual(fromRequest, { DISPLAY: ':9', WAYLAND_DISPLAY: 'wayland-0' });
  assert.throws(() => browser.graphicalEnv({}, {}), (e) => e instanceof browser.SetupError && /DISPLAY/.test(e.message));
  assert.throws(() => browser.graphicalEnv({ XAUTHORITY: '/x' }, { DBUS_SESSION_BUS_ADDRESS: 'x' }), browser.SetupError);
});

test('graphicalEnv drops an XAUTHORITY it cannot read, from either source', () => {
  const dir = tmpDir('xauth');
  const readable = path.join(dir, 'ok');
  fs.writeFileSync(readable, '');
  assert.deepStrictEqual(browser.graphicalEnv({ DISPLAY: ':0', XAUTHORITY: readable }, {}), { DISPLAY: ':0', XAUTHORITY: readable });
  assert.deepStrictEqual(browser.graphicalEnv({ DISPLAY: ':0', XAUTHORITY: path.join(dir, 'missing') }, {}), { DISPLAY: ':0' });
  assert.deepStrictEqual(browser.graphicalEnv({}, { DISPLAY: ':0', XAUTHORITY: '/root/.Xauthority' }), { DISPLAY: ':0' });
});

test('locateBinary honours CLAUDESURF_BROWSER, probes PATH, and fails as setup_error', () => {
  assert.strictEqual(browser.locateBinary({ CLAUDESURF_BROWSER: '/opt/chrome' }), '/opt/chrome');
  const dir = tmpDir('bin');
  const chromium = path.join(dir, 'chromium');
  fs.writeFileSync(chromium, '#!/bin/sh\n', { mode: 0o755 });
  assert.strictEqual(browser.locateBinary({ PATH: `/nonexistent:${dir}` }), chromium);
  assert.throws(() => browser.locateBinary({ PATH: '/nonexistent' }), browser.SetupError);
});
