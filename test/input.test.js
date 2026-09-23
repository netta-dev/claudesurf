// input.js against the in-process fake: the click outcome mapping and the
// Navigated/Opened lines; navigate and scroll payloads.

const { test } = require('node:test');
const assert = require('node:assert');
const { enableTargets } = require('../server/browser');
const input = require('../server/input');
const read = require('../server/read');
const { OutcomeError } = require('../server/action-support');
const { fakeSession, refsIn, sleep, waitFor } = require('./helpers');

async function setup(pages = {}) {
  const ctx = fakeSession();
  await enableTargets(ctx.conn);
  Object.assign(ctx.fake.site, pages);
  const session = await ctx.sessions.ensure('s1');
  await input.navigate(ctx.sessions, session, { url: 'http://a.test/', name: 'n' });
  const { payload } = await read.readPage(ctx.sessions, session, { maxChars: 40000, offset: 0, hidden: true });
  return { ...ctx, session, payload, refs: refsIn(payload), target: ctx.sessions.target(session.workingTargetId) };
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

test('a read whose document changes mid-render is an error, and the read after it succeeds', async () => {
  const { fake, sessions, session, target } = await setup({ 'http://a.test/': page([{ kind: 'button', label: 'b', visible: true }]) });
  const call = fake.handlers.get('Runtime.callFunctionOn');
  let once = true;
  fake.handle('Runtime.callFunctionOn', (p, sid) => {
    if (once && /claudesurfRender/.test(p.functionDeclaration)) { once = false; fake.navigateTarget(fake.targets.get(target.targetId), 'http://a.test/'); }
    return call(p, sid);
  });
  const { fail } = await outcome(read.readPage(sessions, session, { maxChars: 40000, offset: 0, hidden: true }));
  assert.strictEqual(fail.outcome, 'error');
  assert.match(fail.message, /document changed while it was being read/);
  assert.strictEqual(fake.callsTo('Runtime.callFunctionOn').filter((c) => /claudesurfWalk/.test(c.params.functionDeclaration)).length, 1, 'no hidden walk after the change');
  const { payload } = await read.readPage(sessions, session, { maxChars: 40000, offset: 0, hidden: true });
  assert.match(payload, /\[e\d+ button "b"\]/);
});

test('a click releases the remote objects it resolved', async () => {
  const { fake, sessions, session, refs } = await setup({ 'http://a.test/': page([{ kind: 'button', label: 'b', visible: true }]) });
  await input.click(sessions, session, refs.b, { trusted: true });
  const groups = fake.callsTo('Runtime.releaseObjectGroup').map((c) => c.params.objectGroup);
  assert.strictEqual(groups.at(-1), 'claudesurf-click');
  const resolved = fake.callsTo('DOM.resolveNode').filter((c) => c.params.objectGroup === 'claudesurf-click');
  assert.strictEqual(resolved.length, 2, 'the ref and the node the hit test found');
});

test('a click releases its objects even when it has spent its deadline', async () => {
  const { fake, sessions, session, refs } = await setup({ 'http://a.test/': page([{ kind: 'button', label: 'b', visible: true }]) });
  // The release answers late, so a click that abandoned it at its own spent deadline
  // would finish before the browser had let the nodes go.
  const order = [];
  fake.handle('Runtime.releaseObjectGroup', ({ objectGroup }) => new Promise((resolve) => setTimeout(() => {
    order.push(objectGroup);
    resolve({});
  }, 100)));
  // The state lines after the click never arrive, so the request deadline ends the
  // click, and the release in its finally runs with none of the budget left.
  const original = fake.handlers.get('Runtime.callFunctionOn');
  fake.handle('Runtime.callFunctionOn', (params, sid) => (
    /claudesurfScroll/.test(params.functionDeclaration) ? new Promise(() => {}) : original(params, sid)
  ));
  await assert.rejects(input.click(sessions, session, refs.b, { deadline: Date.now() + 500 }), /Runtime.callFunctionOn timed out/);
  order.push('click returned');
  assert.deepStrictEqual(order, ['claudesurf-click', 'click returned']);
});

// A page holding one out-of-process frame, read so both targets have ref sets.
async function setupFrame() {
  const tree = [
    { nodeId: 'n0', role: { value: 'RootWebArea' }, name: { value: 'A' }, childIds: ['n1'] },
    { nodeId: 'n1', role: { value: 'Iframe' }, name: { value: '' }, backendDOMNodeId: 90 },
  ];
  const ctx = await setup({
    'http://a.test/': page([{ kind: 'button', label: 'page', visible: true }], {
      tree, childFrames: [{ backendId: 90, url: 'http://frame.test/child' }],
    }),
    'http://frame.test/child': page([{ kind: 'button', label: 'in frame', visible: true }], { title: 'Child', text: 'frame text' }),
  });
  const parent = ctx.fake.targets.get(ctx.session.workingTargetId);
  const frame = ctx.fake.attachFrame(parent, 90);
  // Its first document has to commit before the read, or the frameNavigated that
  // follows makes the refs the read returned stale.
  await waitFor(() => ctx.sessions.target(frame.targetId) && ctx.sessions.target(frame.targetId).generation > 0);
  const { payload } = await read.readPage(ctx.sessions, ctx.session, { maxChars: 40000, offset: 0 });
  return { ...ctx, frame, refs: refsIn(payload), payload };
}

test('anything that is not a ref is an error naming the two forms', async () => {
  const { sessions, session } = await setup({ 'http://a.test/': page([]) });
  for (const bad of ['e', 'f1', '42', 'e42x', 'f-1e2', '']) {
    const { fail } = await outcome(input.click(sessions, session, bad, {}));
    assert.strictEqual(fail.outcome, 'error', bad);
    assert.match(fail.message, /is not a ref; refs look like e42, or f1e42 inside a frame$/, bad);
  }
});

test('an f-ref clicks in its own frame target, and a trusted click there is refused', async () => {
  const { fake, sessions, session, refs, frame } = await setupFrame();
  const ref = refs['in frame'];
  assert.match(ref, /^f1e\d+$/, 'a frame read returns prefixed refs');
  const r = await input.click(sessions, session, ref, {});
  assert.strictEqual(r.payload, 'URL: http://a.test/\nTitle: A\nNavigated: no', "the state lines stay the page's");
  const clicked = fake.callsTo('Runtime.callFunctionOn').filter((c) => /claudesurfClick/.test(c.params.functionDeclaration)).at(-1);
  assert.strictEqual(clicked.sessionId, frame.sessionId, "the click ran on the frame's protocol session");
  const refused = await outcome(input.click(sessions, session, ref, { trusted: true }));
  assert.strictEqual(refused.fail.outcome, 'error');
  assert.match(refused.fail.message, /inside a cross-site frame, where trusted clicks are not supported yet/);
});

test('a bare ref recorded against a same-process frame resolves in that frame\'s world', async () => {
  const { fake, sessions, session, target } = await setup({ 'http://a.test/': page([{ kind: 'button', label: 'b', visible: true }]) });
  const id = [...session.refs.get(target.targetId).ids.keys()][0];
  session.refs.set(target.targetId, { generation: target.generation, ids: new Map([[id, 'CHILD-FRAME']]) });
  await input.click(sessions, session, `e${id}`, {});
  const world = fake.callsTo('Page.createIsolatedWorld').at(-1);
  assert.strictEqual(world.params.frameId, 'CHILD-FRAME');
  const resolved = fake.callsTo('DOM.resolveNode').at(-1);
  assert.strictEqual(resolved.params.backendNodeId, id);
  const { contexts } = fake.targets.get(target.targetId);
  assert.strictEqual(contexts.get(resolved.params.executionContextId), 'CHILD-FRAME', "the frame's context, not the page's");
});

test('a trusted click on such a ref resolves the node it hit in that frame\'s world too', async () => {
  const { fake, sessions, session, target } = await setup({ 'http://a.test/': page([{ kind: 'button', label: 'b', visible: true }]) });
  const id = [...session.refs.get(target.targetId).ids.keys()][0];
  session.refs.set(target.targetId, { generation: target.generation, ids: new Map([[id, 'CHILD-FRAME']]) });
  const r = await input.click(sessions, session, `e${id}`, { trusted: true });
  assert.match(r.payload, /Navigated: no$/);
  const { contexts } = fake.targets.get(target.targetId);
  const resolved = fake.callsTo('DOM.resolveNode').filter((c) => c.params.objectGroup === 'claudesurf-click');
  assert.deepStrictEqual(
    resolved.map((c) => contexts.get(c.params.executionContextId)),
    ['CHILD-FRAME', 'CHILD-FRAME'],
    'the ref and the hit node share a world; callFunctionOn takes its target and its argument from one',
  );
});

test('a ref whose frame discarded its world is resolved again in a fresh one', async () => {
  const { fake, sessions, session, target } = await setup({ 'http://a.test/': page([{ kind: 'button', label: 'b', visible: true }]) });
  const id = [...session.refs.get(target.targetId).ids.keys()][0];
  session.refs.set(target.targetId, { generation: target.generation, ids: new Map([[id, 'CHILD-FRAME']]) });
  // A same-process frame that navigated on its own leaves the page's generation alone,
  // so the missing context is the only signal that its world is gone.
  const resolveNode = fake.handlers.get('DOM.resolveNode');
  let once = true;
  fake.handle('DOM.resolveNode', (params, sid) => {
    if (!once) return resolveNode(params, sid);
    once = false;
    throw { code: -32000, message: 'Cannot find context with specified id' };
  });
  const r = await input.click(sessions, session, `e${id}`, {});
  assert.match(r.payload, /Navigated: no$/);
  const worlds = fake.callsTo('Page.createIsolatedWorld').filter((c) => c.params.frameId === 'CHILD-FRAME');
  assert.strictEqual(worlds.length, 2, 'the world was recreated for the retry');
});

test('a frame that is gone, one whose document moved on, and an id it never returned', async () => {
  const { fake, sessions, session, refs, frame } = await setupFrame();
  const inFrame = refs['in frame'];
  const unread = await outcome(input.click(sessions, session, 'f1e9999', {}));
  assert.strictEqual(unread.fail.outcome, 'error');
  assert.match(unread.fail.message, /was not returned by a read of this document/);
  const never = await outcome(input.click(sessions, session, 'f7e1', {}));
  assert.strictEqual(never.fail.outcome, 'error', 'a frame number never assigned reads as a ref never returned');
  assert.match(never.fail.message, /^f7e1 was not returned by a read of this document/);
  const zero = await outcome(input.click(sessions, session, 'f0e1', {}));
  assert.strictEqual(zero.fail.outcome, 'error', 'frame numbers start at 1, so f0 was never assigned either');
  assert.match(zero.fail.message, /^f0e1 was not returned by a read of this document/);
  const page = sessions.target(session.workingTargetId);
  const next = await outcome(input.click(sessions, session, `f${page.nextFrameNumber}e1`, {}));
  assert.strictEqual(next.fail.outcome, 'error', 'the counter itself has not been handed out, so it reads the same way');
  assert.match(next.fail.message, new RegExp(`^f${page.nextFrameNumber}e1 was not returned by a read of this document`));
  fake.navigateTarget(fake.targets.get(frame.targetId), 'http://frame.test/child');
  await waitFor(() => sessions.target(frame.targetId).generation > 1);
  const moved = await outcome(input.click(sessions, session, inFrame, {}));
  assert.strictEqual(moved.fail.outcome, 'stale_ref');
  assert.match(moved.fail.message, /the frame's document changed since it was read/);
  fake.destroyTarget(frame.targetId);
  await waitFor(() => !sessions.target(frame.targetId));
  const gone = await outcome(input.click(sessions, session, inFrame, {}));
  assert.strictEqual(gone.fail.outcome, 'stale_ref');
  assert.match(gone.fail.message, /the frame it was read in is gone/);
});

test('an f-ref is stale from the page\'s own navigation, before Chrome has destroyed the frame target', async () => {
  const { fake, sessions, session, refs, target } = await setupFrame();
  // Chrome destroys a page's frame targets after its frameNavigated, so in this window
  // the frame target still stands, at the generation the read left it, for a document
  // the page has left.
  fake.navigateTarget(fake.targets.get(target.targetId), 'http://a.test/');
  await waitFor(() => target.generation > 1);
  const { fail } = await outcome(input.click(sessions, session, refs['in frame'], {}));
  assert.strictEqual(fail.outcome, 'stale_ref');
  assert.match(fail.message, /the frame it was read in is gone; read the page again/);
});

test('scroll returns the position line', async () => {
  const { sessions, session } = await setup({ 'http://a.test/': page([]) });
  const { payload } = await input.scroll(sessions, session, 'down', 250, {});
  assert.strictEqual(payload, 'URL: http://a.test/\nTitle: A\nScroll: 250 of 1200 (viewport 600)');
});
