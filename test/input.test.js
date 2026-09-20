// input.js against the in-process fake: the click outcome mapping and the
// Navigated/Opened lines; navigate and scroll payloads.

const { test } = require('node:test');
const assert = require('node:assert');
const { enableTargets } = require('../server/browser');
const input = require('../server/input');
const read = require('../server/read');
const { OutcomeError } = require('../server/action-support');
const { fakeSession, sleep, waitFor } = require('./helpers');

async function setup(pages = {}) {
  const ctx = fakeSession();
  await enableTargets(ctx.conn);
  Object.assign(ctx.fake.site, pages);
  const session = await ctx.sessions.ensure('s1');
  await input.navigate(ctx.sessions, session, { url: 'http://a.test/', name: 'n' });
  const { payload } = await read.readPage(ctx.sessions, session, { maxChars: 40000, offset: 0, hidden: true });
  const refs = {};
  for (const m of payload.matchAll(/\[(e\d+)\] \w+ "([^"]*)"/g)) refs[m[2]] = m[1];
  return { ...ctx, session, refs, target: ctx.sessions.target(session.workingTargetId) };
}

function page(elements, extra = {}) {
  return { title: 'A', text: 'text', elements, scrollY: 0, pageHeight: 1200, viewportHeight: 600, ...extra };
}

async function outcome(promise) {
  try { return { ok: await promise }; } catch (e) {
    if (e instanceof OutcomeError) return { fail: e.envelope };
    throw e;
  }
}

test('navigate labels the session, loads, and returns the page state', async () => {
  const { fake, sessions, session } = await setup({ 'http://a.test/': page([]), 'http://b.test/': page([], { title: 'B' }) });
  const { payload } = await input.navigate(sessions, session, { url: 'http://b.test/', name: 'renamed', description: 'd' });
  assert.strictEqual(payload, 'URL: http://b.test/\nTitle: B');
  assert.deepStrictEqual(session.label, { name: 'renamed', description: 'd' });
  assert.deepStrictEqual(fake.targets.get(session.identityTargetId).label, { name: 'renamed', description: 'd' });
  fake.site['http://c.test/'] = { errorText: 'net::ERR_NAME_NOT_RESOLVED' };
  const { fail } = await outcome(input.navigate(sessions, session, { url: 'http://c.test/', name: 'renamed' }));
  assert.strictEqual(fail.outcome, 'error');
  assert.match(fail.message, /ERR_NAME_NOT_RESOLVED/);
});

test('page, click, and scroll refuse a non-http document while navigate and info work there', async () => {
  const ctx = fakeSession();
  await enableTargets(ctx.conn);
  const session = await ctx.sessions.ensure('s1');
  for (const p of [read.readPage(ctx.sessions, session, { maxChars: 10, offset: 0, hidden: false }), input.click(ctx.sessions, session, 'e1', {}), input.scroll(ctx.sessions, session, 'down', 10, {})]) {
    const { fail } = await outcome(p);
    assert.strictEqual(fail.outcome, 'error');
    assert.match(fail.message, /navigate first/);
  }
  const info = await read.pageInfo(ctx.sessions, session, {});
  assert.match(info.payload, /^URL: file:\/\/.*session\.html#role=working/);
  assert.match(info.payload, /\nSession: \(unnamed\)$/);
});

test('info reports a closed identity tab', async () => {
  const { fake, sessions, session } = await setup({ 'http://a.test/': page([]) });
  fake.destroyTarget(session.identityTargetId);
  await waitFor(() => session.identityTargetId === null);
  const info = await read.pageInfo(sessions, session, {});
  assert.strictEqual(info.payload, 'URL: http://a.test/\nTitle: A\nScroll: 0 of 1200 (viewport 600)\nSession: n\nIdentity tab: closed');
});

test('click outcome mapping: stale generation, unread ref, detached node, disabled, hidden under trusted', async () => {
  const elements = [
    { kind: 'button', label: 'fine', visible: true },
    { kind: 'button', label: 'off', disabled: true, visible: true },
    { kind: 'button', label: 'ghost', visible: false },
    { kind: 'button', label: 'gone', visible: true },
  ];
  const { fake, sessions, session, refs, target } = await setup({ 'http://a.test/': page(elements) });
  let r = await outcome(input.click(sessions, session, 'e9999', {}));
  assert.strictEqual(r.fail.outcome, 'error');
  assert.match(r.fail.message, /was not returned by a read/);
  r = await outcome(input.click(sessions, session, refs.off, {}));
  assert.match(r.fail.message, /is disabled/);
  r = await outcome(input.click(sessions, session, refs.ghost, { trusted: true }));
  assert.match(r.fail.message, /is hidden; a trusted click/);
  r = await outcome(input.click(sessions, session, refs.ghost, {}));
  assert.ok(r.ok, 'a scripted click reaches a hidden element');
  elements[3].detached = true;
  r = await outcome(input.click(sessions, session, refs.gone, {}));
  assert.strictEqual(r.fail.outcome, 'error');
  assert.match(r.fail.message, /no longer resolves/);
  fake.navigateTarget(fake.targets.get(target.targetId), 'http://a.test/');
  await sleep(10);
  r = await outcome(input.click(sessions, session, refs.fine, {}));
  assert.strictEqual(r.fail.outcome, 'stale_ref');
  assert.match(r.fail.message, /^e\d+: the document changed/);
});

test('a scripted click that navigates reports Navigated: yes with the new page; one that does not, Navigated: no', async () => {
  const elements = [
    { kind: 'link', label: 'go', href: 'http://a.test/next', visible: true, onClick: (fake, t) => fake.navigateTarget(t, 'http://a.test/next') },
    { kind: 'button', label: 'noop', visible: true },
  ];
  const { fake, sessions, session, refs } = await setup({ 'http://a.test/': page(elements), 'http://a.test/next': page([], { title: 'Next' }) });
  const noop = await input.click(sessions, session, refs.noop, {});
  assert.strictEqual(noop.payload, 'URL: http://a.test/\nTitle: A\nNavigated: no');
  const call = fake.callsTo('Runtime.callFunctionOn').filter((c) => /claudesurfClick/.test(c.params.functionDeclaration)).at(-1);
  assert.strictEqual(call.params.userGesture, true);
  assert.deepStrictEqual(call.params.arguments, [{ value: 'scripted' }]);
  const go = await input.click(sessions, session, refs.go, {});
  assert.strictEqual(go.payload, 'URL: http://a.test/next\nTitle: Next\nNavigated: yes');
});

test('a navigation that starts but does not load within the budget is reported as started', async () => {
  const elements = [{
    kind: 'link', label: 'slow', href: 'http://a.test/slow', visible: true,
    onClick: (fake, t) => fake.emit('Page.frameStartedNavigating', { frameId: t.targetId, url: 'http://a.test/slow', navigationType: 'differentDocument' }, t.sessionId),
  }];
  const { sessions, session, refs } = await setup({ 'http://a.test/': page(elements) });
  // The load wait stops 2 s before the deadline, so this budget ends it after ~300 ms.
  const started = Date.now();
  const r = await input.click(sessions, session, refs.slow, { deadline: Date.now() + 2_300 });
  assert.ok(Date.now() - started < 1_500, 'the load wait honoured the deadline');
  assert.strictEqual(r.payload, 'URL: http://a.test/\nTitle: A\nNavigated: started (the new page has not finished loading)');
});

test('a click whose page opens a tab or a popup reports Opened:', async () => {
  const elements = [
    { kind: 'link', label: 'tab', visible: true, onClick: (fake, t) => fake.createTarget({ url: 'http://a.test/tab', windowId: t.windowId, openerId: t.targetId }) },
    { kind: 'button', label: 'popup', visible: true, onClick: (fake, t) => fake.createTarget({ url: 'http://a.test/pop', windowId: 4242, openerId: t.targetId }) },
  ];
  const { sessions, session, refs } = await setup({ 'http://a.test/': page(elements) });
  const tab = await input.click(sessions, session, refs.tab, {});
  assert.strictEqual(tab.payload, 'URL: http://a.test/\nTitle: A\nNavigated: no\nOpened: a new tab (not the working tab)');
  const popup = await input.click(sessions, session, refs.popup, {});
  assert.strictEqual(popup.payload, 'URL: http://a.test/\nTitle: A\nNavigated: no\nOpened: a popup window (not the working tab)');
  assert.strictEqual(session.opened.size, 2);
});

test('a popup attached without a URL, whose window reply lands after its first navigation, still reads as a popup', async () => {
  const elements = [
    { kind: 'button', label: 'popup', visible: true, onClick: (fake, t) => fake.createTarget({ url: '', lateUrl: 'http://a.test/pop', windowId: 4242, openerId: t.targetId, windowDelayMs: 60 }) },
  ];
  const { sessions, session, refs } = await setup({ 'http://a.test/': page(elements) });
  const started = Date.now();
  const popup = await input.click(sessions, session, refs.popup, {});
  assert.strictEqual(popup.payload, 'URL: http://a.test/\nTitle: A\nNavigated: no\nOpened: a popup window (not the working tab)');
  assert.ok(Date.now() - started < 300, 'the click wait stayed short');
  const [id] = [...session.opened];
  assert.strictEqual(sessions.target(id).windowId, 4242);
});

test('navigate to a denied download is an error and leaves the page; a fragment navigate returns the new URL promptly', async () => {
  const { sessions, session } = await setup({ 'http://a.test/': page([]), 'http://a.test/file.bin': { download: true } });
  const started = Date.now();
  const download = await outcome(input.navigate(sessions, session, { url: 'http://a.test/file.bin', name: 'n' }));
  assert.strictEqual(download.fail.outcome, 'error');
  assert.match(download.fail.message, /was a download, which is denied; the page is unchanged/);
  assert.ok(Date.now() - started < 1000, 'the download event ended the wait');
  const fragment = await input.navigate(sessions, session, { url: 'http://a.test/#part', name: 'n' });
  assert.strictEqual(fragment.payload, 'URL: http://a.test/#part\nTitle: A');
  assert.ok(Date.now() - started < 1000, 'the same-document event ended the wait');
});

test('a trusted click hit-tests, refuses a covered element, and dispatches real mouse events', async () => {
  const elements = [
    { kind: 'button', label: 'under', visible: true },
    { kind: 'div', label: 'cover', visible: true, covering: true },
  ];
  const { fake, sessions, session, refs } = await setup({ 'http://a.test/': page(elements) });
  const { fail } = await outcome(input.click(sessions, session, refs.under, { trusted: true }));
  assert.match(fail.message, /covered by another element/);
  assert.strictEqual(fake.callsTo('Input.dispatchMouseEvent').filter((c) => c.params.modifiers === undefined).length, 0);
  elements[1].covering = false;
  elements[0].covering = true;
  const ok = await input.click(sessions, session, refs.under, { trusted: true });
  assert.match(ok.payload, /Navigated: no$/);
  const events = fake.callsTo('Input.dispatchMouseEvent').filter((c) => c.params.modifiers === undefined).map((c) => c.params.type);
  assert.deepStrictEqual(events, ['mouseMoved', 'mousePressed', 'mouseReleased']);
});

test('a trusted click hit-tests in document coordinates, and a hit test that finds nothing is an error naming the point', async () => {
  const elements = [{ kind: 'button', label: 'far', visible: true }];
  const { fake, sessions, session, refs } = await setup({ 'http://a.test/': page(elements, { scrollY: 300 }) });
  await input.click(sessions, session, refs.far, { trusted: true });
  const hit = fake.callsTo('DOM.getNodeForLocation').at(-1).params;
  assert.deepStrictEqual({ x: hit.x, y: hit.y }, { x: 30, y: 315 }, 'quad centre plus the scroll offset');
  const pressed = fake.callsTo('Input.dispatchMouseEvent').find((c) => c.params.type === 'mousePressed' && c.params.modifiers === undefined).params;
  assert.deepStrictEqual({ x: pressed.x, y: pressed.y }, { x: 30, y: 15 }, 'mouse events stay in viewport coordinates');
  fake.handle('DOM.getNodeForLocation', () => { throw { code: -32000, message: 'No node found at given location' }; });
  const { fail } = await outcome(input.click(sessions, session, refs.far, { trusted: true }));
  assert.strictEqual(fail.outcome, 'error');
  assert.match(fail.message, /^e\d+ has no hit-testable point/);
});

test('a read whose document changes during the walk is an error, and the read after it succeeds', async () => {
  const { fake, sessions, session, target } = await setup({ 'http://a.test/': page([{ kind: 'button', label: 'b', visible: true }]) });
  const call = fake.handlers.get('Runtime.callFunctionOn');
  let once = true;
  fake.handle('Runtime.callFunctionOn', (p, sid) => {
    if (once && /claudesurfWalk/.test(p.functionDeclaration)) { once = false; fake.navigateTarget(fake.targets.get(target.targetId), 'http://a.test/'); }
    return call(p, sid);
  });
  const { fail } = await outcome(read.readPage(sessions, session, { maxChars: 40000, offset: 0, hidden: true }));
  assert.strictEqual(fail.outcome, 'error');
  assert.match(fail.message, /document changed while it was being read/);
  assert.strictEqual(fake.callsTo('Runtime.getProperties').length, 1, 'no getProperties after the change');
  const { payload } = await read.readPage(sessions, session, { maxChars: 40000, offset: 0, hidden: true });
  assert.match(payload, /\[e\d+\] button "b"/);
});

test('read and click release their remote object groups', async () => {
  const { fake, sessions, session, refs } = await setup({ 'http://a.test/': page([{ kind: 'button', label: 'b', visible: true }]) });
  await input.click(sessions, session, refs.b, { trusted: true });
  const groups = fake.callsTo('Runtime.releaseObjectGroup').map((c) => c.params.objectGroup);
  assert.deepStrictEqual(groups, ['claudesurf-read', 'claudesurf-click']);
  const resolved = fake.callsTo('DOM.resolveNode').map((c) => c.params.objectGroup);
  assert.ok(resolved.length >= 2 && resolved.every((g) => g === 'claudesurf-click'));
  assert.strictEqual(fake.callsTo('Runtime.evaluate').find((c) => /__claudesurfElements/.test(c.params.expression)).params.objectGroup, 'claudesurf-read');
});

test('scroll returns the position line', async () => {
  const { sessions, session } = await setup({ 'http://a.test/': page([]) });
  const { payload } = await input.scroll(sessions, session, 'down', 250, {});
  assert.strictEqual(payload, 'URL: http://a.test/\nTitle: A\nScroll: 250 of 1200 (viewport 600)');
});
