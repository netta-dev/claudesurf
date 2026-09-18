// input.js against the in-process fake: the click outcome mapping and the
// Navigated/Opened lines; navigate and scroll payloads.

const { test } = require('node:test');
const assert = require('node:assert');
const { enableTargets } = require('../server/browser');
const input = require('../server/input');
const read = require('../server/read');
const { fakeSession, sleep } = require('./helpers');

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
    if (e instanceof read.OutcomeError) return { fail: e.envelope };
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

test('scroll returns the position line', async () => {
  const { sessions, session } = await setup({ 'http://a.test/': page([]) });
  const { payload } = await input.scroll(sessions, session, 'down', 250, {});
  assert.strictEqual(payload, 'URL: http://a.test/\nTitle: A\nScroll: 250 of 1200 (viewport 600)');
});
