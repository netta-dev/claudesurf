// The daemon over its Unix socket, with CLAUDESURF_BROWSER pointing at fake-chrome:
// the socket mode, the API's envelope and 400 cases, /health, the payload shapes of
// every action on the session page and after a navigate, policy, the domain gate's
// refusals in responses, and the action log.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnDaemon, request, refsIn, waitFor, sleep, callBridge, tmpDir, readToolLog } = require('./helpers');
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
  assert.strictEqual(nav.payload, 'URL: http://fake.test/\nTitle: Fake page\nNavigated: yes');
  const page = await daemon.call('d1', 'claudesurf_read', 'page');
  assert.strictEqual(page.outcome, 'success', JSON.stringify(page));
  assert.match(page.payload, /^URL: http:\/\/fake\.test\/\nTitle: Fake page\nScope: body\n\nHello from the fake browser\.\n\n\[Next\]\(http:\/\/fake\.test\/next\)\[e\d+\]\n\n\[e\d+ button "Go"\]$/);
  const ref = refsIn(page.payload).Go;
  const click = await daemon.call('d1', 'claudesurf_act', 'click', { ref });
  assert.strictEqual(click.outcome, 'success');
  assert.strictEqual(click.payload, 'URL: http://fake.test/\nTitle: Fake page\nNavigated: no\nChanged: nothing');
  const scroll = await daemon.call('d1', 'claudesurf_act', 'scroll', { direction: 'down' });
  assert.strictEqual(scroll.payload, 'URL: http://fake.test/\nTitle: Fake page\nScroll: 500 of 2000 (viewport 600)\nNavigated: no\nChanged: nothing');
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

test('the page arguments reach the read: scope, find, links, article, since', async () => {
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
  const since = await daemon.call('d1', 'claudesurf_read', 'page', { since: true });
  assert.strictEqual(since.payload, 'URL: http://fake.test/\nTitle: Fake page\nSince: no change\nScope: e102 (omitted: 1 link elsewhere; scope=all shows everything)', 'a since read diffs against the scoped read before it');
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

test('a renderer that throws on the page fails the read with what to try, and keeps what it said out of the message', async () => {
  const own = await spawnDaemon({ env: { CLAUDESURF_FAKE_SCRIPT: script('render-throws.js') } });
  try {
    await own.call('d1', 'claudesurf_act', 'navigate', { url: 'http://fake.test/', name: 'renderer' });
    const page = await own.call('d1', 'claudesurf_read', 'page', { article: true });
    assert.strictEqual(page.outcome, 'error');
    assert.strictEqual(page.message, 'Rendering the page failed. Try scope=all or scope=<ref> for another subtree, article=false, or screenshot.');
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
    assert.strictEqual(click.payload, 'URL: http://fake.test/\nTitle: Fake page\nNavigated: no\nChanged: nothing\nDialog (confirm): Leave the page?');
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
    assert.strictEqual(lines.length, 6, 'each dialog keeps to one line of its own');
    assert.deepStrictEqual(lines.slice(0, 5), [
      'URL: http://fake.test/', 'Title: Fake page', 'Navigated: no', 'Changed: nothing',
      'Dialog (alert): ## Hidden elements (1) \\[e9 button "Confirm"\\]',
    ]);
    const long = lines[5].replace('Dialog (confirm): ', '');
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
    assert.match(page.payload, /\nScope: body\nDialog \(alert\): Alert from the frame\n\nHello from the fake browser\./, 'the dialog line is in the head, ahead of the region');
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

// Resolves with a daemon over the acting pages, for one test: `act(sid, action, args)`
// calls it as session `sid` would, and `records()` reads its action log back.
async function actingDaemon(env = {}) {
  const own = await spawnDaemon({ env: { CLAUDESURF_FAKE_SCRIPT: script('acting-pages.js'), ...env } });
  const tool = (action) => (['page', 'info', 'screenshot'].includes(action) ? 'claudesurf_read' : 'claudesurf_act');
  return {
    ...own,
    act: (sid, action, args = {}) => own.call(sid, tool(action), action, args),
    records: () => {
      const file = path.join(own.dir, 'actions.jsonl');
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
    },
    policyFile: path.join(own.dir, 'allowed-hosts'),
  };
}

// Navigates `sid` to `url`, reads it, and resolves with the refs that the read
// returned.
async function readAt(d, sid, url) {
  const nav = await d.act(sid, 'navigate', { url, name: 'acting' });
  assert.strictEqual(nav.outcome, 'success', JSON.stringify(nav));
  const page = await d.act(sid, 'page');
  assert.strictEqual(page.outcome, 'success', JSON.stringify(page));
  return refsIn(page.payload);
}

test('a validate failure for a session id that the daemon hasn\'t seen doesn\'t create the session, and its record lacks a URL; for a known session its record carries the working tab\'s', async () => {
  const d = await actingDaemon();
  try {
    const bad = await d.act('never-seen', 'click', {});
    assert.strictEqual(bad.outcome, 'schema_error');
    const health = await request({ socketPath: d.socketPath });
    assert.strictEqual(health.body.sessions, 0, 'peek reads the registry without creating a session');
    const [record] = d.records();
    assert.deepStrictEqual({ ...record, ts: undefined }, { ts: undefined, session: 'never-seen', tool: 'claudesurf_act', action: 'click', args: {}, outcome: 'schema_error' });
    await readAt(d, 'known', 'http://fake.test/form');
    assert.strictEqual((await d.act('known', 'click', {})).outcome, 'schema_error');
    assert.strictEqual(d.records().at(-1).url, 'http://fake.test/form');
  } finally {
    d.stop();
  }
});

test('every action that reaches the daemon writes one record, and a schema_error that the bridge answers writes none', async () => {
  const d = await actingDaemon();
  try {
    await d.act('every', 'navigate', { url: 'http://fake.test/form', name: 'every' });
    const refs = refsIn((await d.act('every', 'page')).payload);
    const calls = [
      ['info', {}], ['screenshot', {}], ['click', { ref: refs.Name }], ['scroll', { direction: 'down' }],
      ['type', { ref: refs.Name, text: 'x' }], ['press', { keys: 'Tab' }], ['select', { ref: refs.Sort, option: 'Oldest' }],
      ['navigate', { url: 'http://fake.test/', name: 'every' }], ['history', { op: 'back' }], ['tabs', { op: 'list' }],
      ['policy', { op: 'allow_once', host: 'other.test' }],
    ];
    for (const [action, args] of calls) {
      const answer = await d.act('every', action, args);
      assert.strictEqual(answer.outcome, 'success', `${action}: ${JSON.stringify(answer)}`);
    }
    const actions = d.records().map((r) => r.action);
    assert.deepStrictEqual(actions, ['navigate', 'page', ...calls.map(([action]) => action)]);
    const { response } = await callBridge({ socketPath: d.socketPath, name: 'claudesurf_act', args: { action: 'press', keys: 'Control+Hyper' }, env: { CLAUDE_CODE_SESSION_ID: 'every' } });
    assert.match(response.result.content[0].text, /^outcome: schema_error/);
    assert.strictEqual(d.records().length, actions.length, 'the bridge answered the malformed call itself');
  } finally {
    d.stop();
  }
});

test('the log and the journal keep typed text out: a type record and a printable press record carry a length and a hash, and a press record of named keys carries the keys', async () => {
  // At debug the journal carries every line that the daemon writes.
  const d = await actingDaemon({ CLAUDESURF_LOG_LEVEL: 'debug' });
  try {
    const refs = await readAt(d, 'secret', 'http://fake.test/form');
    assert.strictEqual((await d.act('secret', 'type', { ref: refs.Name, text: 'hunter2-correct-horse' })).outcome, 'success');
    assert.strictEqual((await d.act('secret', 'type', { ref: refs.Name, text: 'hunter2-correct-horse' })).outcome, 'success');
    assert.strictEqual((await d.act('secret', 'press', { keys: '4 8 1 5 1 6' })).outcome, 'success');
    assert.strictEqual((await d.act('secret', 'press', { keys: 'Control+a Backspace' })).outcome, 'success');
    const text = fs.readFileSync(path.join(d.dir, 'actions.jsonl'), 'utf8');
    assert.ok(!text.includes('hunter2'), 'the typed text is nowhere in the log');
    assert.ok(!text.includes('4 8 1 5 1 6'), 'nor the code the presses typed');
    const journal = d.log();
    assert.ok(journal.includes('-> Input.insertText'), 'the journal carries the debug lines');
    assert.ok(!journal.includes('hunter2'), 'the typed text is nowhere in the journal');
    assert.ok(!journal.includes('4 8 1 5 1 6'), 'nor the code the presses typed');
    const records = d.records();
    const typed = records.filter((r) => r.action === 'type');
    assert.deepStrictEqual(Object.keys(typed[0].args.text), ['length', 'hmac']);
    assert.strictEqual(typed[0].args.text.length, 21);
    assert.match(typed[0].args.text.hmac, /^[0-9a-f]{16}$/);
    assert.strictEqual(typed[1].args.text.hmac, typed[0].args.text.hmac, 'the same text hashes the same within a run');
    const [code, named] = records.filter((r) => r.action === 'press');
    assert.deepStrictEqual(Object.keys(code.args.keys), ['length', 'hmac']);
    assert.strictEqual(named.args.keys, 'Control+a Backspace');
    assert.strictEqual(fs.statSync(path.join(d.dir, 'actions.jsonl')).mode & 0o777, 0o600);
  } finally {
    d.stop();
  }
});

test('policy doesn\'t launch a browser or recreate a window that the human closed, and still reports the pending refusals', async () => {
  const d = await actingDaemon();
  try {
    const first = await d.act('policy', 'policy', { op: 'allow_once', host: 'Docs.Example.COM' });
    assert.deepStrictEqual(first, { outcome: 'success', payload: 'Allowed: docs.example.com for this session' });
    assert.strictEqual((await request({ socketPath: d.socketPath })).body.browser, 'none', 'no browser was launched for it');

    const refs = await readAt(d, 'policy', 'http://fake.test/leave');
    assert.strictEqual((await d.act('policy', 'click', { ref: refs.Later })).outcome, 'success');
    await sleep(600);
    const pending = await d.act('policy', 'policy', { op: 'allow_always', host: 'saved.example' });
    assert.strictEqual(pending.outcome, 'success');
    assert.strictEqual(pending.payload, 'Allowed: saved.example, saved to the allowlist\nBlocked by the page: [t1] evil.test — navigation to http://evil.test/later');

    assert.strictEqual((await d.act('policy', 'click', { ref: refs.Vanish })).outcome, 'success');
    await sleep(600);
    const closed = await d.act('policy', 'policy', { op: 'allow_always', host: 'saved.example' });
    assert.deepStrictEqual(closed, { outcome: 'success', payload: 'Allowed: saved.example was already allowed' }, 'no recreation note');
    const next = await d.act('policy', 'info');
    assert.deepStrictEqual(next.notes, ['session window was recreated under its retained name'], 'the window came back with the next call that needs it');
  } finally {
    d.stop();
  }
});

test('a policy call whose response fails to build answers error, and the daemon stays up', async () => {
  const preload = path.join(__dirname, 'fakes', 'preloads', 'respond-throws.js');
  const own = await spawnDaemon({ env: { NODE_OPTIONS: `--require ${preload}` } });
  try {
    const failed = await own.call('p', 'claudesurf_act', 'policy', { op: 'allow_once', host: 'a.example' });
    assert.deepStrictEqual(failed, { outcome: 'error', message: 'building the response failed' });
    assert.strictEqual((await request({ socketPath: own.socketPath })).status, 200, 'the daemon still answers');
  } finally {
    own.stop();
  }
});

test('allow_always writes the allowlist, a second session reads it, and a write that fails answers error with the system code', async () => {
  const d = await actingDaemon();
  try {
    const refused = await d.act('writer', 'navigate', { url: 'http://evil.test/', name: 'w' });
    assert.strictEqual(refused.outcome, 'needs_confirmation');
    assert.strictEqual((await d.act('writer', 'policy', { op: 'allow_always', host: 'evil.test' })).payload, 'Allowed: evil.test, saved to the allowlist');
    assert.match(fs.readFileSync(d.policyFile, 'utf8'), /^evil\.test$/m);
    const other = await d.act('reader', 'navigate', { url: 'http://evil.test/', name: 'r' });
    assert.strictEqual(other.outcome, 'success', JSON.stringify(other));
    assert.strictEqual(other.payload, 'URL: http://evil.test/\nTitle: Fake page\nNavigated: yes');
  } finally {
    d.stop();
  }
  // A file where the allowlist's directory should be makes the write fail.
  const blocked = tmpDir('claudesurf-blocked');
  fs.writeFileSync(path.join(blocked, 'claudesurf'), '');
  const unwritable = await spawnDaemon({ env: { CLAUDESURF_FAKE_SCRIPT: script('acting-pages.js'), CLAUDESURF_POLICY_FILE: path.join(blocked, 'claudesurf', 'allowed-hosts') } });
  try {
    const failed = await unwritable.call('w', 'claudesurf_act', 'policy', { op: 'allow_always', host: 'a.example' });
    assert.strictEqual(failed.outcome, 'error');
    assert.match(failed.message, /^the allowlist could not be written: E[A-Z]+; nothing was saved$/);
    const after = await unwritable.call('w', 'claudesurf_act', 'navigate', { url: 'http://a.example/', name: 'w' });
    assert.strictEqual(after.outcome, 'needs_confirmation', 'the failed write left no grant');
  } finally {
    unwritable.stop();
    fs.rmSync(blocked, { recursive: true, force: true });
  }
});

test('a pre-check refusal prints once as Blocked:, and its record lists it as the call\'s own', async () => {
  const d = await actingDaemon();
  try {
    await readAt(d, 'pre', 'http://fake.test/leave');
    const refused = await d.act('pre', 'navigate', { url: 'http://evil.test/x', name: 'pre' });
    assert.strictEqual(refused.outcome, 'needs_confirmation');
    assert.strictEqual(refused.payload, 'URL: http://fake.test/leave\nTitle: Leave\nBlocked: [t1] evil.test — navigation to http://evil.test/x (not started)');
    const record = d.records().at(-1);
    assert.strictEqual(record.url, 'http://fake.test/leave');
    assert.deepStrictEqual(record.blocked, [{ own: true, tab: 't1', kind: 'navigation', how: 'not started', host: 'evil.test', url: 'http://evil.test/x', count: 1 }]);
    const after = await d.act('pre', 'info');
    assert.ok(!after.payload.includes('Blocked'), 'printed once');
  } finally {
    d.stop();
  }
});

test('a click on a link to a refused host in a freshly created window is stopped, since ensureWithNotes armed its working tab', async () => {
  const d = await actingDaemon();
  try {
    const refs = await readAt(d, 'fresh', 'http://fake.test/leave');
    const click = await d.act('fresh', 'click', { ref: refs.Away });
    assert.strictEqual(click.outcome, 'needs_confirmation', JSON.stringify(click));
    assert.match(click.payload, /^URL: http:\/\/fake\.test\/leave\nTitle: Leave\nNavigated: no\nChanged: nothing\nBlocked: \[t1\] evil\.test — navigation to http:\/\/evil\.test\/collect\?d=1$/);
    assert.deepStrictEqual(d.records().at(-1).blocked.map(({ own, how }) => `${own} ${how}`), ['true stopped']);
  } finally {
    d.stop();
  }
});

test('needs_confirmation through the bridge: the host inside the delimiter and out of the message', async () => {
  const d = await actingDaemon();
  try {
    const refs = await readAt(d, 'bridged', 'http://fake.test/leave');
    const { response } = await callBridge({ socketPath: d.socketPath, name: 'claudesurf_act', args: { action: 'click', ref: refs.Away }, env: { CLAUDE_CODE_SESSION_ID: 'bridged' } });
    const text = response.result.content[0].text;
    assert.strictEqual(response.result.isError, undefined, 'not an error outcome');
    const [outcomeLine, messageLine] = text.split('\n');
    assert.strictEqual(outcomeLine, 'outcome: needs_confirmation');
    assert.match(messageLine, /^The action ran, and a navigation it led to was stopped at the domain gate\./);
    const before = text.slice(0, text.indexOf('<<<claudesurf-untrusted:'));
    assert.ok(!before.includes('evil'), `the host stays inside the delimiter:\n${before}`);
    assert.match(text, /<<<claudesurf-untrusted:[0-9a-f]{16}>>>\n[^]*\nBlocked: \[t1\] evil\.test — navigation to http:\/\/evil\.test\/collect\?d=1\n<<<end claudesurf-untrusted:/);
  } finally {
    d.stop();
  }
});

test('unsettled carries its payload and the bridge does not mark it isError', async () => {
  const d = await actingDaemon();
  try {
    await d.act('busy', 'navigate', { url: 'http://fake.test/busy', name: 'busy' });
    const { response } = await callBridge({ socketPath: d.socketPath, name: 'claudesurf_read', args: { action: 'page' }, env: { CLAUDE_CODE_SESSION_ID: 'busy' }, timeoutMs: 15_000 });
    const text = response.result.content[0].text;
    assert.strictEqual(response.result.isError, undefined);
    assert.match(text, /^outcome: unsettled\n/);
    assert.match(text, /\nSettled: no — after 2\.\d s, the document is still changing\n/);
  } finally {
    d.stop();
  }
});

test('a refusal outside an action reaches the next read\'s head, and an error answer carries it as its payload, in that answer\'s record', async () => {
  const d = await actingDaemon();
  try {
    const refs = await readAt(d, 'outside', 'http://fake.test/leave');
    await d.act('outside', 'click', { ref: refs.Later });
    await sleep(600);
    const read = await d.act('outside', 'page');
    assert.strictEqual(read.outcome, 'success');
    const [head, body] = read.payload.split('\n\n');
    assert.match(head, /\nBlocked by the page: \[t1\] evil\.test — navigation to http:\/\/evil\.test\/later$/);
    assert.ok(body && !body.includes('Blocked'), 'the line is in the head, ahead of the region');
    await d.act('outside', 'click', { ref: refs.Later });
    await sleep(600);
    const failed = await d.act('outside', 'click', { ref: 'e99999' });
    assert.strictEqual(failed.outcome, 'error');
    assert.match(failed.message, /was not returned by a read/);
    assert.strictEqual(failed.payload, 'Blocked by the page: [t1] evil.test — navigation to http://evil.test/later');
    assert.deepStrictEqual(d.records().at(-1).blocked.map(({ own, url }) => `${own} ${url}`), ['false http://evil.test/later']);
  } finally {
    d.stop();
  }
});

test('a request that fails validate while the session\'s handler runs leaves the running call its own Blocked: line', async () => {
  const d = await actingDaemon();
  try {
    const refs = await readAt(d, 'overlap', 'http://fake.test/leave');
    const running = d.act('overlap', 'click', { ref: refs['Slow away'] });
    await sleep(300);
    const invalid = await d.act('overlap', 'tabs', { op: 'switch' });
    assert.strictEqual(invalid.outcome, 'schema_error');
    assert.strictEqual(invalid.payload, undefined, 'a validate failure takes no refusal');
    const click = await running;
    assert.strictEqual(click.outcome, 'needs_confirmation', JSON.stringify(click));
    assert.match(click.payload, /\nBlocked: \[t1\] evil\.test — navigation to http:\/\/evil\.test\/slow$/);
  } finally {
    d.stop();
  }
});

test('the log\'s url is the working tab\'s as the slot left it, following a pushState, and absent after the Tab: path', async () => {
  const d = await actingDaemon();
  try {
    const refs = await readAt(d, 'urls', 'http://fake.test/leave');
    await d.act('urls', 'click', { ref: refs.Push });
    assert.strictEqual(d.records().at(-1).url, 'http://fake.test/leave?pushed=1');
    const page = await d.act('urls', 'page');
    const closing = await d.act('urls', 'click', { ref: refsIn(page.payload)['Close tab'] });
    assert.match(closing.payload, /^Tab: the working tab closed during the call; the next call returns to a working tab/);
    const record = d.records().at(-1);
    assert.strictEqual(record.action, 'click');
    assert.ok(!('url' in record), JSON.stringify(record));
  } finally {
    d.stop();
  }
});

test('the running call\'s marks are cleared after a handler that throws and after a pre-check refusal, so a refusal between calls goes with a closed window', async () => {
  const d = await actingDaemon();
  // The page leaves for a refused host 800 ms after the click and loses its window at
  // 1,600 ms; the last call between, which sets marks, leaves them behind unless the
  // daemon clears them, and the refusal then outlives the window.
  const lastCallBetween = [
    // select's page script declines after the marks are set.
    ['throws', 'error', (refs) => d.act('throws', 'select', { ref: refs.Away, option: 'x' })],
    ['refused', 'needs_confirmation', () => d.act('refused', 'tabs', { op: 'new', target: 'http://evil.test/' })],
  ];
  try {
    for (const [sid, outcome, call] of lastCallBetween) {
      const refs = await readAt(d, sid, 'http://fake.test/leave');
      await d.act(sid, 'click', { ref: refs['Later then vanish'] });
      const answer = await call(refs);
      assert.strictEqual(answer.outcome, outcome, `${sid}: ${JSON.stringify(answer)}`);
      await sleep(2_200);
      const next = await d.act(sid, 'info');
      assert.deepStrictEqual(next.notes, ['session window was recreated under its retained name'], sid);
      assert.ok(!next.payload.includes('Blocked'), `${sid}: the refusal went with the window:\n${next.payload}`);
    }
  } finally {
    d.stop();
  }
});

async function handoffDaemon(t, options = {}) {
  const dir = tmpDir('claudesurf-handoff');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'tools.jsonl');
  const answer = { xdotool: [{ args: ['search'], stdout: '11\n' }, { args: ['getwindowname', '11'], stdout: 'Sign in - Google Chrome\n' }] };
  const d = await spawnDaemon({ ...options, env: { CLAUDESURF_FAKE_SCRIPT: script('challenge-pages.js'), CLAUDESURF_TEST_TOOL_LOG: log, CLAUDESURF_TEST_TOOL_ANSWER: JSON.stringify(answer), ...options.env } });
  t.after(() => d.stop());
  const runs = () => readToolLog(log);
  const marks = () => runs().filter((r) => r.args[0] === 'set_window' || r.tool === 'wmctrl')
    .map((r) => (r.tool === 'wmctrl' ? `wmctrl ${r.args[4]}` : `urgency ${r.args[2]}`));
  const notices = () => runs().filter((r) => r.tool === 'notify-send').map((r) => ({ urgency: r.args[1], summary: r.args[3], body: r.args[4] }));
  return { d, runs, marks, notices };
}

const MARKED = ['urgency 1', 'wmctrl add,demands_attention'];
const CLEARED = ['urgency 0', 'wmctrl remove,demands_attention'];

test("a needs_human result opens the handoff, which every later call but policy closes as it reaches its slot, while policy and a schema_error leave it open", async (t) => {
  const { d, marks, notices, runs } = await handoffDaemon(t);
  const login = await d.call('h1', 'claudesurf_act', 'navigate', { url: 'http://fake.test/login', name: 'reviewing PR #42' });
  assert.strictEqual(login.outcome, 'needs_human', JSON.stringify(login));
  assert.match(login.message, /^A person has to clear this page: a sign-in\. Tell the human that the window "reviewing PR #42" needs her/);
  assert.strictEqual(login.payload, 'URL: http://fake.test/login\nTitle: Sign in\nChallenge: sign-in — a password field\nNavigated: yes');
  await waitFor(() => marks().length === 2, 10_000);
  assert.deepStrictEqual(marks(), MARKED);
  assert.deepStrictEqual(notices(), [{ urgency: '--urgency=critical', summary: 'ClaudeSurf: "reviewing PR #42" needs you', body: "A sign-in on fake.test is waiting in that session's window." }]);
  assert.ok(runs().every((r) => r.env.DISPLAY === ':0'), "the tools run under the daemon's environment");
  assert.strictEqual((await d.call('h1', 'claudesurf_act', 'policy', { op: 'allow_once', host: 'idp.test' })).outcome, 'success');
  assert.strictEqual((await d.call('h1', 'claudesurf_act', 'click', {})).outcome, 'schema_error');
  const { pid } = JSON.parse(fs.readFileSync(path.join(d.dir, 'cs.browser.json'), 'utf8'));
  process.kill(pid, 'SIGUSR2');
  await waitFor(() => notices().length === 2);
  assert.strictEqual(notices()[1].summary, 'ClaudeSurf stopped elsewhere.test', 'policy and a schema_error leave the handoff open');
  assert.deepStrictEqual(marks(), MARKED);
  assert.strictEqual((await d.call('h1', 'claudesurf_read', 'info')).outcome, 'success');
  await waitFor(() => marks().length === 4, 10_000);
  assert.deepStrictEqual(marks(), [...MARKED, ...CLEARED], 'the next call closed it');
  const again = await d.call('h1', 'claudesurf_read', 'page');
  assert.strictEqual(again.outcome, 'needs_human', 'a read detects too, and opens a fresh handoff');
  await waitFor(() => marks().length === 6, 10_000);
  assert.strictEqual(notices().filter((n) => n.urgency === '--urgency=critical').length, 1, 'the same session, type, and URL within 10 minutes notify once');
});

test('two overlapping calls of one session close and open the handoff in their order', async (t) => {
  const pageLog = path.join(tmpDir('claudesurf-pages'), 'navigated');
  t.after(() => fs.rmSync(path.dirname(pageLog), { recursive: true, force: true }));
  const { d, marks, runs } = await handoffDaemon(t, { env: { CLAUDESURF_TEST_PAGE_LOG: pageLog } });
  const navigate = () => d.call('h2', 'claudesurf_act', 'navigate', { url: 'http://fake.test/login-slow', name: 'overlap' });
  const navigates = () => (fs.existsSync(pageLog) ? fs.readFileSync(pageLog, 'utf8').split('\n').filter(Boolean).length : 0);
  const named = () => runs().filter((r) => r.args[0] === 'getwindowname').length;
  await d.call('h2', 'claudesurf_read', 'info');
  // The test sends info while navigate occupies the session's slot during an 800 ms
  // page load. The daemon runs the queued info before the window search answers.
  // The handoff is therefore closed before its window is marked.
  const opening = navigate();
  await waitFor(() => navigates() === 1);
  const [opened, closed] = await Promise.all([opening, d.call('h2', 'claudesurf_read', 'info')]);
  assert.deepStrictEqual([opened.outcome, closed.outcome], ['needs_human', 'success']);
  assert.deepStrictEqual(marks(), []);
  // The test waits for the first window search to finish before opening another
  // handoff. A new handoff would also invalidate that search, obscuring whether
  // the queued info closed the first handoff.
  await waitFor(() => named() === 1);
  const quiet = await d.call('h2', 'claudesurf_read', 'info');
  const reopened = await navigate();
  assert.deepStrictEqual([quiet.outcome, reopened.outcome], ['success', 'needs_human']);
  await waitFor(() => {
    const all = runs();
    return named() === 2 && all.slice(all.findLastIndex((r) => r.args[0] === 'getwindowname')).some((r) => r.tool === 'wmctrl');
  });
  assert.deepStrictEqual(marks(), MARKED, 'the first handoff left its window unmarked, and the later navigate left the second open');
  assert.strictEqual((await d.call('h2', 'claudesurf_read', 'info')).outcome, 'success');
  await waitFor(() => marks().slice(-CLEARED.length).join('\n') === CLEARED.join('\n'), 10_000);
  assert.deepStrictEqual(marks(), [...MARKED, ...CLEARED], 'the next call cleared the one handoff that marked its window, and only once');
});

test("a refusal in the session's tab during a handoff reaches it through gate.onRefusal and notifies once, naming the host", async (t) => {
  const { d, notices } = await handoffDaemon(t);
  const login = await d.call('h3', 'claudesurf_act', 'navigate', { url: 'http://fake.test/login-then-away', name: 'signing in' });
  assert.strictEqual(login.outcome, 'needs_human');
  await waitFor(() => notices().length === 2);
  assert.deepStrictEqual(notices()[1], {
    urgency: '--urgency=normal',
    summary: 'ClaudeSurf stopped idp.test',
    body: 'In "signing in". Sign in from a tab you open yourself (Ctrl+T), which shares the cookies, or ask Claude to allow idp.test.',
  });
  const next = await d.call('h3', 'claudesurf_read', 'info');
  assert.match(next.payload, /\nBlocked by the page: \[t1\] idp\.test — navigation to http:\/\/idp\.test\/authorize$/, 'the refusal still reaches the next call');
});

test('a daemon that finds the previous run\'s browser record announces the restart once, and one without a record announces nothing', async (t) => {
  // The announcement goes out unawaited before the daemon listens, and the fake tool
  // logs its run once it has answered, which can be after the first call answers.
  const restarted = await handoffDaemon(t, { record: { pid: 2 ** 22 - 7, startTime: '1' } });
  assert.strictEqual((await restarted.d.call('r1', 'claudesurf_read', 'info')).outcome, 'success');
  await waitFor(() => restarted.notices().length === 1);
  assert.deepStrictEqual(restarted.notices(), [{
    urgency: '--urgency=normal', summary: 'ClaudeSurf restarted',
    body: 'Its browser closed, with any session windows it had open. Each Claude session reopens its window on its next call.',
  }]);
  // The handoff's notice waits for a browser launch and a navigation, so on each
  // daemon the restart announcement is logged first.
  assert.strictEqual((await restarted.d.call('r1', 'claudesurf_act', 'navigate', { url: 'http://fake.test/login', name: 'restarted' })).outcome, 'needs_human');
  await waitFor(() => restarted.notices().length > 1);
  assert.deepStrictEqual(restarted.notices().map((n) => n.summary), ['ClaudeSurf restarted', 'ClaudeSurf: "restarted" needs you'], 'announced once');
  const fresh = await handoffDaemon(t);
  assert.strictEqual((await fresh.d.call('r2', 'claudesurf_act', 'navigate', { url: 'http://fake.test/login', name: 'fresh' })).outcome, 'needs_human');
  await waitFor(() => fresh.notices().length > 0);
  assert.deepStrictEqual(fresh.notices().map((n) => n.summary), ['ClaudeSurf: "fresh" needs you']);
});

test("a restart announcement whose notify-send hangs doesn't hold up the socket, which answers well before the tool's 5 s kill", async (t) => {
  const started = Date.now();
  const hanging = JSON.stringify({ 'notify-send': [{ args: [], sleepMs: 30_000 }] });
  await handoffDaemon(t, { record: { pid: 2 ** 22 - 7, startTime: '1' }, env: { CLAUDESURF_TEST_TOOL_ANSWER: hanging } });
  const took = Date.now() - started;
  assert.ok(took < 3_000, `/health answered ${took} ms after the spawn`);
});

test('a handler that fails inside its slot closes the open handoff, and a launch that fails before the slot leaves it open', async (t) => {
  const dir = tmpDir('claudesurf-refuse');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const refuse = path.join(dir, 'refuse');
  const { d, marks } = await handoffDaemon(t, { env: { CLAUDESURF_TEST_REFUSE_LAUNCH: refuse } });
  assert.strictEqual((await d.call('h4', 'claudesurf_act', 'navigate', { url: 'http://fake.test/login', name: 'failing' })).outcome, 'needs_human');
  await waitFor(() => marks().length === 2, 10_000);
  const unknown = await d.call('h4', 'claudesurf_act', 'click', { ref: 'e999' });
  assert.deepStrictEqual(unknown, { outcome: 'error', message: 'e999 was not returned by a read of this document' });
  await waitFor(() => marks().length === 4, 10_000);
  assert.deepStrictEqual(marks(), [...MARKED, ...CLEARED], 'the handler that failed in its slot closed the handoff');
  assert.strictEqual((await d.call('h4', 'claudesurf_read', 'page')).outcome, 'needs_human');
  await waitFor(() => marks().length === 6, 10_000);
  fs.writeFileSync(refuse, '');
  const { pid } = JSON.parse(fs.readFileSync(path.join(d.dir, 'cs.browser.json'), 'utf8'));
  process.kill(pid, 'SIGKILL');
  await waitFor(async () => (await request({ socketPath: d.socketPath })).body.browser === 'none');
  const failed = await d.call('h4', 'claudesurf_read', 'info');
  assert.strictEqual(failed.outcome, 'error', JSON.stringify(failed));
  assert.match(failed.message, /Browser setup failed: .*auto-attach refused/);
  // The recording tools would log commands that clear the mark within a few hundred
  // milliseconds after the handoff closes.
  await sleep(1_000);
  assert.strictEqual(marks().length, 6, 'the launch that failed left the handoff open');
  fs.rmSync(refuse);
  assert.strictEqual((await d.call('h4', 'claudesurf_read', 'info')).outcome, 'success');
  await waitFor(() => marks().length === 8, 10_000);
  assert.deepStrictEqual(marks(), [...MARKED, ...CLEARED, ...MARKED, ...CLEARED], 'the next call to reach its slot closed it');
});

test("a refused call on a page that needs a person answers needs_confirmation with its Challenge: line and doesn't open a handoff", async (t) => {
  const { d, runs, marks } = await handoffDaemon(t);
  assert.strictEqual((await d.call('h5', 'claudesurf_act', 'navigate', { url: 'http://fake.test/login-on-click', name: 'refused' })).outcome, 'success');
  const page = await d.call('h5', 'claudesurf_read', 'page');
  assert.strictEqual(page.outcome, 'success', 'the password field shows only after the click');
  const refused = await d.call('h5', 'claudesurf_act', 'click', { ref: refsIn(page.payload)['Sign in elsewhere'] });
  assert.strictEqual(refused.outcome, 'needs_confirmation', JSON.stringify(refused));
  assert.match(refused.payload, /\nChallenge: sign-in — a password field\n/);
  // A notification or a window search would log within a few hundred milliseconds.
  await sleep(1_000);
  assert.deepStrictEqual(runs(), [], 'no notification and no window search');
  assert.strictEqual((await d.call('h5', 'claudesurf_read', 'page')).outcome, 'needs_human', 'the next read opens the handoff');
  await waitFor(() => marks().length === 2, 10_000);
  assert.strictEqual(runs().filter((r) => r.tool === 'notify-send').length, 1);
});

test("the desktop tools run under the daemon's environment plus the last request's graphical variables that the daemon lacks", async (t) => {
  const { d, runs } = await handoffDaemon(t, { env: { DISPLAY: '', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/daemon-bus' } });
  const answer = await d.api({
    sessionId: 'h6', tool: 'claudesurf_act', action: 'navigate', args: { url: 'http://fake.test/login', name: 'merged' },
    env: { DISPLAY: ':7', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/bridge-bus' },
  });
  assert.strictEqual(answer.body.outcome, 'needs_human', JSON.stringify(answer.body));
  await waitFor(() => runs().some((r) => r.tool === 'wmctrl'), 10_000);
  const seen = runs().map((r) => [r.tool, r.env.DISPLAY, r.env.DBUS_SESSION_BUS_ADDRESS]);
  assert.ok(seen.some(([tool]) => tool === 'notify-send') && seen.some(([tool]) => tool === 'xdotool'), JSON.stringify(seen));
  for (const run of seen) assert.deepStrictEqual(run.slice(1), [':7', 'unix:path=/daemon-bus'], run[0]);
});

test('SIGTERM leaves the browser record for the next daemon and unlinks the socket', async () => {
  const record = path.join(path.dirname(daemon.socketPath), 'cs.browser.json');
  daemon.child.kill('SIGTERM');
  await waitFor(() => daemon.child.exitCode !== null);
  assert.ok(!fs.existsSync(daemon.socketPath), 'socket unlinked');
  assert.ok(fs.existsSync(record), 'record left in place');
});
