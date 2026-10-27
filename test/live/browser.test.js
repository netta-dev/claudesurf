// Real launch and handshake against the installed Chrome, headless, on a temp profile.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const browser = require('../../server/browser');
const { liveBinary, liveBrowser, silentLog, waitFor } = require('../helpers');

const skip = liveBinary() ? false : 'no Chrome binary found';

test('launch, handshake, one window per session, and a clean close', { skip }, async () => {
  const live = await liveBrowser();
  try {
    const record = browser.readRecord();
    assert.strictEqual(record.pid, live.child.pid);
    const session = await live.sessions.ensure('live-1');
    assert.ok(session.windowId !== null);
    const working = live.sessions.target(session.workingTargetId);
    const identity = live.sessions.target(session.identityTargetId);
    assert.strictEqual(working.windowId, identity.windowId, 'both tabs in one window');
    const other = await live.sessions.ensure('live-2');
    assert.notStrictEqual(other.windowId, session.windowId, 'a second session gets its own window');
    const { result } = await live.sessions.send(session.workingTargetId, 'Runtime.evaluate', { expression: 'navigator.webdriver', returnByValue: true });
    assert.strictEqual(result.value, false, 'AutomationControlled is disabled');
    // The test checks the record before live.close(), which restores CLAUDESURF_SOCKET
    // and deletes the record's directory.
    await live.conn.send('Browser.close').catch(() => {});
    await waitFor(() => browser.readRecord() === null, 5000).catch(() => {});
    assert.strictEqual(browser.readRecord(), null, 'record cleared on close');
  } finally {
    await live.close();
  }
});

test('a second launch on the same profile is setup_error naming the holder', { skip }, async () => {
  const live = await liveBrowser();
  try {
    await assert.rejects(
      browser.launch({ binary: liveBinary(), profileDir: path.join(live.dir, 'profile'), env: {}, headless: true, log: silentLog }),
      (e) => e instanceof browser.SetupError && new RegExp(`pid ${live.child.pid}`).test(e.message) && e.message.includes(live.dir),
    );
  } finally {
    await live.close();
  }
});
