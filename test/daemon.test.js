// The daemon over its Unix socket, with CLAUDESURF_BROWSER pointing at fake-chrome:
// the socket mode, the API's envelope and 400 cases, /health, and the payload shapes
// of every action on the session page and after a navigate.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnDaemon, request, waitFor } = require('./helpers');

let daemon;
before(async () => { daemon = await spawnDaemon(); });
after(() => daemon.stop());

test('the command socket is created 0600', () => {
  assert.strictEqual(fs.statSync(daemon.socketPath).mode & 0o777, 0o600);
});

test('/health reports no browser before the first action', async () => {
  const { status, body } = await request({ socketPath: daemon.socketPath });
  assert.strictEqual(status, 200);
  assert.deepStrictEqual(body, { status: 'ok', browser: 'none', sessions: 0 });
});

test('400 for a body that is not JSON or lacks a session id; 404 elsewhere', async () => {
  const notJson = await request({ socketPath: daemon.socketPath, method: 'POST', path: '/api', body: '{nope' });
  assert.strictEqual(notJson.status, 400);
  const noSession = await daemon.api({ tool: 'claudesurf_read', action: 'info', args: {} });
  assert.strictEqual(noSession.status, 400);
  assert.match(noSession.body.error, /sessionId/);
  const missing = await request({ socketPath: daemon.socketPath, path: '/nothing' });
  assert.strictEqual(missing.status, 404);
});

test('a bad action is a schema_error envelope with status 200, before any browser is launched', async () => {
  const r = await daemon.api({ sessionId: 'd1', tool: 'claudesurf_read', action: 'fly', args: {} });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.outcome, 'schema_error');
  const missing = await daemon.call('d1', 'claudesurf_act', 'click', {});
  assert.strictEqual(missing.outcome, 'schema_error');
  assert.match(missing.message, /ref is required/);
  const health = await request({ socketPath: daemon.socketPath });
  assert.strictEqual(health.body.browser, 'none');
});

test('on the session page: info and navigate succeed, page says navigate first', async () => {
  const info = await daemon.call('d1', 'claudesurf_read', 'info');
  assert.strictEqual(info.outcome, 'success', JSON.stringify(info));
  const lines = info.payload.split('\n');
  assert.match(lines[0], /^URL: file:\/\/.*session\.html#role=working&session=d1/);
  assert.match(lines[1], /^Title: /);
  assert.match(lines[2], /^Scroll: \d+ of \d+ \(viewport \d+\)$/);
  assert.strictEqual(lines[3], 'Session: (unnamed)');
  assert.strictEqual(lines.length, 4);
  const page = await daemon.call('d1', 'claudesurf_read', 'page');
  assert.strictEqual(page.outcome, 'error');
  assert.match(page.message, /navigate first/);
  const health = await request({ socketPath: daemon.socketPath });
  assert.deepStrictEqual(health.body, { status: 'ok', browser: 'running', sessions: 1 });
  const record = path.join(path.dirname(daemon.socketPath), 'cs.browser.json');
  assert.ok(fs.existsSync(record), 'browser record written beside the socket');
});

test('navigate, page, click, scroll, and screenshot payload shapes', async () => {
  const nav = await daemon.call('d1', 'claudesurf_act', 'navigate', { url: 'http://fake.test/', name: 'daemon test' });
  assert.strictEqual(nav.outcome, 'success', JSON.stringify(nav));
  assert.strictEqual(nav.payload, 'URL: http://fake.test/\nTitle: Fake page');
  const page = await daemon.call('d1', 'claudesurf_read', 'page');
  assert.strictEqual(page.outcome, 'success', JSON.stringify(page));
  assert.match(page.payload, /^URL: http:\/\/fake\.test\/\nTitle: Fake page\n\nHello from the fake browser\.\n\n## Interactive elements \(2 visible, 0 hidden\)\n\[e\d+\] link "Next" → http:\/\/fake\.test\/next\n\[e\d+\] button "Go"$/);
  const ref = page.payload.match(/\[(e\d+)\] button "Go"/)[1];
  const click = await daemon.call('d1', 'claudesurf_act', 'click', { ref });
  assert.strictEqual(click.outcome, 'success');
  assert.strictEqual(click.payload, 'URL: http://fake.test/\nTitle: Fake page\nNavigated: no');
  const scroll = await daemon.call('d1', 'claudesurf_act', 'scroll', { direction: 'down' });
  assert.strictEqual(scroll.payload, 'URL: http://fake.test/\nTitle: Fake page\nScroll: 500 of 2000 (viewport 600)');
  const info = await daemon.call('d1', 'claudesurf_read', 'info');
  assert.strictEqual(info.payload, 'URL: http://fake.test/\nTitle: Fake page\nScroll: 500 of 2000 (viewport 600)\nSession: daemon test');
  const shot = await daemon.call('d1', 'claudesurf_read', 'screenshot', { full_page: true });
  assert.strictEqual(shot.outcome, 'success');
  assert.strictEqual(shot.payload, 'URL: http://fake.test/\nTitle: Fake page\nCaptured: 0–2000 of 2000 px in 4 segments');
  assert.strictEqual(shot.images.length, 4);
  assert.strictEqual(shot.images[0].mimeType, 'image/png');
  const viewport = await daemon.call('d1', 'claudesurf_read', 'screenshot');
  assert.strictEqual(viewport.images.length, 1);
  assert.strictEqual(viewport.payload, 'URL: http://fake.test/\nTitle: Fake page');
});

test('a second session gets its own window', async () => {
  const info = await daemon.call('d2', 'claudesurf_read', 'info');
  assert.strictEqual(info.outcome, 'success');
  assert.match(info.payload, /session=d2/);
  const health = await request({ socketPath: daemon.socketPath });
  assert.strictEqual(health.body.sessions, 2);
});

test('SIGTERM leaves the browser record for the next daemon and unlinks the socket', async () => {
  const record = path.join(path.dirname(daemon.socketPath), 'cs.browser.json');
  daemon.child.kill('SIGTERM');
  assert.ok(await waitFor(() => daemon.child.exitCode !== null));
  assert.ok(!fs.existsSync(daemon.socketPath), 'socket unlinked');
  assert.ok(fs.existsSync(record), 'record left in place');
});
