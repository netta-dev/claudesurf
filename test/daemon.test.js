// The daemon over its Unix socket, with CLAUDESURF_BROWSER pointing at fake-chrome:
// the socket mode, the API's envelope and 400 cases, /health, and the payload shapes
// of every action on the session page and after a navigate.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnDaemon, request, refsIn, waitFor } = require('./helpers');
const { LABEL_MAX } = require('../server/action-support');

const script = (name) => path.join(__dirname, 'fakes', 'scripts', name);

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
  assert.match(page.payload, /^URL: http:\/\/fake\.test\/\nTitle: Fake page\nScope: body\n\nHello from the fake browser\.\n\n\[Next\]\(http:\/\/fake\.test\/next\)\[e\d+\]\n\n\[e\d+ button "Go"\]$/);
  const ref = refsIn(page.payload).Go;
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

test('the page arguments reach the read: scope, find, links, article', async () => {
  const page = await daemon.call('d1', 'claudesurf_read', 'page', { links: 'index' });
  assert.strictEqual(page.outcome, 'success', JSON.stringify(page));
  assert.match(page.payload, /\nLinks: 1 \(index at offset \d+\)\n/);
  assert.ok(page.payload.endsWith('## Links\n[e101] http://fake.test/next'));
  const found = await daemon.call('d1', 'claudesurf_read', 'page', { find: 'fake browser' });
  assert.match(found.payload, /\nFind: "fake browser" — 1 block\n/);
  assert.match(found.payload, /\n\[offset 0\]\nHello from the fake browser\.$/);
  const article = await daemon.call('d1', 'claudesurf_read', 'page', { article: true, scope: 'all' });
  assert.match(article.payload, /\nScope: all\nArticle: none found\n/);
  const scoped = await daemon.call('d1', 'claudesurf_read', 'page', { scope: 'e102' });
  assert.match(scoped.payload, /\nScope: e102 \(omitted: 1 link elsewhere; scope=all shows everything\)\n/);
  assert.ok(!scoped.payload.includes('e101'), 'the link outside the scope is not rendered');
  const conflict = await daemon.call('d1', 'claudesurf_read', 'page', { find: 'x', offset: 10 });
  assert.strictEqual(conflict.outcome, 'schema_error');
});

test('hidden=true reaches the read: the count line is there either way, the list only when asked', async () => {
  const own = await spawnDaemon({ env: { CLAUDESURF_FAKE_SCRIPT: script('hidden-control.js') } });
  try {
    await own.call('d1', 'claudesurf_act', 'navigate', { url: 'http://fake.test/', name: 'hidden' });
    const counted = await own.call('d1', 'claudesurf_read', 'page');
    assert.match(counted.payload, /\nHidden: 1 control on the page \(hidden=true lists them\)\n/);
    assert.ok(!counted.payload.includes('## Hidden elements'), 'and no list without the argument');
    const listed = await own.call('d1', 'claudesurf_read', 'page', { hidden: true });
    assert.match(listed.payload, /\nHidden: 1 control on the page \(listed at the end\)\n/);
    assert.ok(listed.payload.endsWith('## Hidden elements (1)\n[e103] button "Shade" (hidden)'), listed.payload);
  } finally {
    own.stop();
  }
});

test('a renderer that throws on the page fails the read with what it said and what to try', async () => {
  const own = await spawnDaemon({ env: { CLAUDESURF_FAKE_SCRIPT: script('render-throws.js') } });
  try {
    await own.call('d1', 'claudesurf_act', 'navigate', { url: 'http://fake.test/', name: 'renderer' });
    const page = await own.call('d1', 'claudesurf_read', 'page', { article: true });
    assert.strictEqual(page.outcome, 'error');
    assert.match(page.message, /^Rendering the page failed: .*cannot read properties of null/);
    assert.match(page.message, /Try scope=all or scope=<ref> for another subtree, article=false, or screenshot\.$/);
  } finally {
    own.stop();
  }
});

test('a renderer that throws inside a frame costs that frame alone', async () => {
  const own = await spawnDaemon({ env: { CLAUDESURF_FAKE_SCRIPT: script('frame-render-throws.js') } });
  try {
    await own.call('d1', 'claudesurf_act', 'navigate', { url: 'http://fake.test/', name: 'frame renderer' });
    const page = await own.call('d1', 'claudesurf_read', 'page');
    assert.strictEqual(page.outcome, 'success', JSON.stringify(page));
    assert.match(page.payload, /The page around the frame\./);
    assert.match(page.payload, /\[e102 button "Go"\]/);
    assert.match(page.payload, /\[e103 frame http:\/\/frame\.test\/child \(not readable\)\]/);
    // The marker reads the same whichever session the render was tried on, so the
    // target the renderer threw in says the frame rendered as a unit of its own; the
    // fixture's exception names it and the log carries it.
    await waitFor(() => /frame e103 \(http:\/\/frame\.test\/child\) is not readable: .*in iframe target /.test(own.log()));
  } finally {
    own.stop();
  }
});

test('a second session gets its own window', async () => {
  const info = await daemon.call('d2', 'claudesurf_read', 'info');
  assert.strictEqual(info.outcome, 'success');
  assert.match(info.payload, /session=d2/);
  const health = await request({ socketPath: daemon.socketPath });
  assert.strictEqual(health.body.sessions, 2);
});

test('a dialog dismissed during an action lands in its payload and note, once', async () => {
  const own = await spawnDaemon({ env: { CLAUDESURF_FAKE_SCRIPT: script('dialog-on-click.js') } });
  try {
    await own.call('d1', 'claudesurf_act', 'navigate', { url: 'http://fake.test/', name: 'dialogs' });
    const page = await own.call('d1', 'claudesurf_read', 'page');
    const ref = refsIn(page.payload).Go;
    const click = await own.call('d1', 'claudesurf_act', 'click', { ref });
    assert.strictEqual(click.outcome, 'success', JSON.stringify(click));
    assert.strictEqual(click.payload, 'URL: http://fake.test/\nTitle: Fake page\nNavigated: no\nDialog (confirm): Leave the page?');
    assert.deepStrictEqual(click.notes, ['a confirm dialog was dismissed']);
    const info = await own.call('d1', 'claudesurf_read', 'info');
    assert.ok(!info.payload.includes('Dialog'), 'reported once');
    assert.strictEqual(info.notes, undefined);
  } finally {
    own.stop();
  }
});

test('a dialog message is made safe and cut to the cap before it joins the payload, so it cannot forge a section or a live marker', async () => {
  const own = await spawnDaemon({ env: { CLAUDESURF_FAKE_SCRIPT: script('dialog-forged.js') } });
  try {
    await own.call('d1', 'claudesurf_act', 'navigate', { url: 'http://fake.test/', name: 'forged dialog' });
    const page = await own.call('d1', 'claudesurf_read', 'page');
    const ref = refsIn(page.payload).Go;
    const click = await own.call('d1', 'claudesurf_act', 'click', { ref });
    assert.strictEqual(click.outcome, 'success', JSON.stringify(click));
    const lines = click.payload.split('\n');
    assert.strictEqual(lines.length, 5, 'each dialog keeps to one line of its own');
    assert.deepStrictEqual(lines.slice(0, 4), [
      'URL: http://fake.test/', 'Title: Fake page', 'Navigated: no',
      'Dialog (alert): ## Hidden elements (1) \\[e9 button "Confirm"\\]',
    ]);
    const long = lines[4].replace('Dialog (confirm): ', '');
    assert.strictEqual(long.length, LABEL_MAX, 'a message past the cap is cut to it');
    assert.ok(long.endsWith('…'), `and says it was cut: ${long}`);
  } finally {
    own.stop();
  }
});

test('a dialog raised inside a frame is drained with the page target\'s', async () => {
  const own = await spawnDaemon({ env: { CLAUDESURF_FAKE_SCRIPT: script('dialog-in-frame.js') } });
  try {
    await own.call('d1', 'claudesurf_act', 'navigate', { url: 'http://fake.test/', name: 'frame dialogs' });
    const page = await own.call('d1', 'claudesurf_read', 'page');
    assert.strictEqual(page.outcome, 'success', JSON.stringify(page));
    assert.ok(page.payload.endsWith('\nDialog (alert): Alert from the frame'), page.payload);
    assert.deepStrictEqual(page.notes, ['a alert dialog was dismissed']);
    const again = await own.call('d1', 'claudesurf_read', 'page');
    assert.ok(!again.payload.includes('Dialog'), 'reported once');
  } finally {
    own.stop();
  }
});

test('a target destroyed mid-action is reported as the working tab being gone', async () => {
  const own = await spawnDaemon({ env: { CLAUDESURF_FAKE_SCRIPT: script('destroy-on-read.js') } });
  try {
    await own.call('d1', 'claudesurf_act', 'navigate', { url: 'http://fake.test/', name: 'gone' });
    const page = await own.call('d1', 'claudesurf_read', 'page');
    assert.strictEqual(page.outcome, 'error');
    assert.strictEqual(page.message, 'The working tab is gone; retry the action.');
  } finally {
    own.stop();
  }
});

test('a launch whose setup step fails is not kept as the live browser', async () => {
  const own = await spawnDaemon({ env: { CLAUDESURF_FAKE_SCRIPT: script('refuse-auto-attach.js') } });
  try {
    const first = await own.call('d1', 'claudesurf_read', 'info');
    assert.strictEqual(first.outcome, 'error');
    assert.match(first.message, /Browser setup failed: .*auto-attach refused/);
    const health = await request({ socketPath: own.socketPath });
    assert.strictEqual(health.body.browser, 'none');
    const second = await own.call('d1', 'claudesurf_read', 'info');
    assert.strictEqual(second.outcome, 'error');
    assert.strictEqual((own.log().match(/browser pid \d+: FakeChrome/g) || []).length, 2, 'the next call launched again');
  } finally {
    own.stop();
  }
});

test('SIGTERM leaves the browser record for the next daemon and unlinks the socket', async () => {
  const record = path.join(path.dirname(daemon.socketPath), 'cs.browser.json');
  daemon.child.kill('SIGTERM');
  await waitFor(() => daemon.child.exitCode !== null);
  assert.ok(!fs.existsSync(daemon.socketPath), 'socket unlinked');
  assert.ok(fs.existsSync(record), 'record left in place');
});
