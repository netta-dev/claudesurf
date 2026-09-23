// sessions.js against the in-process fake: window creation and role claims, opener
// attribution, target preparation, iframe targets and their frame numbers, repairs,
// generations, isolated worlds and ref sets, dialogs, labels, and EOF.

const { test } = require('node:test');
const assert = require('node:assert');
const browser = require('../server/browser');
const { Sessions, SESSION_PAGE, parseSessionPage } = require('../server/sessions');
const { fakeSession, sleep, waitFor, isolatedPaths, silentLog, FAKE_CHROME } = require('./helpers');
const { Connection, ProtocolError } = require('../server/cdp');
const { FakeBrowser } = require('./fakes/fake-browser');

const { enableTargets } = browser;

async function setup() {
  const ctx = fakeSession();
  await enableTargets(ctx.conn);
  return ctx;
}

function pageUrl(sessionId, role) {
  return `${SESSION_PAGE}#role=${role}&session=${sessionId}&started=2026-01-01T00%3A00%3A00.000Z`;
}

// Attaches an out-of-process child frame of a fake target and waits for the registry
// to record it; resolves with the fake's target, whose id the registry uses too.
async function attachFrame(fake, sessions, parent, url = 'http://frame.test/child') {
  const frame = fake.createTarget({ type: 'iframe', parent, url });
  await waitFor(() => sessions.target(frame.targetId) !== null);
  await fake.waitForCall('Page.enable', (c) => c.sessionId === frame.sessionId);
  return frame;
}

function missingContext() {
  return new ProtocolError('Runtime.callFunctionOn', -32000, 'Cannot find context with specified id');
}

test('first ensure creates the window: working tab by createTarget, identity tab claimed by URL role', async () => {
  const { fake, sessions } = await setup();
  const session = await sessions.ensure('s1');
  const create = fake.callsTo('Target.createTarget');
  assert.strictEqual(create.length, 1);
  assert.deepStrictEqual({ newWindow: create[0].params.newWindow, background: create[0].params.background }, { newWindow: true, background: true });
  assert.deepStrictEqual(parseSessionPage(create[0].params.url), { role: 'working', session: 's1' });
  assert.ok(session.workingTargetId && session.identityTargetId);
  assert.notStrictEqual(session.workingTargetId, session.identityTargetId);
  const working = sessions.target(session.workingTargetId);
  const identity = sessions.target(session.identityTargetId);
  assert.strictEqual(working.role, 'working');
  assert.strictEqual(identity.role, 'identity');
  assert.strictEqual(identity.windowId, working.windowId, 'identity tab joined the same window');
  assert.strictEqual(session.windowId, working.windowId);
  const ctrl = fake.callsTo('Input.dispatchMouseEvent').filter((c) => c.params.type === 'mousePressed');
  assert.strictEqual(ctrl[0].params.modifiers, 2, 'identity tab opened by a Ctrl-click');
  assert.deepStrictEqual(session.takeNotes(), []);
  const again = await sessions.ensure('s1');
  assert.strictEqual(again, session);
  assert.strictEqual(fake.callsTo('Target.createTarget').length, 1, 'second ensure reuses the window');
});

test('overlapping first calls create one window', async () => {
  const { fake, sessions } = await setup();
  const [a, b] = await Promise.all([sessions.ensure('s1'), sessions.ensure('s1')]);
  assert.strictEqual(a, b);
  assert.strictEqual(fake.callsTo('Target.createTarget').length, 1);
});

test('every attached page target receives focus emulation, and a rejected preparation still releases it', async () => {
  const { fake, sessions } = await setup();
  let failOnce = true;
  fake.handle('Emulation.setFocusEmulationEnabled', (p, sid) => {
    if (failOnce) { failOnce = false; throw { code: -32000, message: 'nope' }; }
    return {};
  });
  const session = await sessions.ensure('s1');
  const focused = fake.callsTo('Emulation.setFocusEmulationEnabled').map((c) => c.sessionId);
  const released = fake.callsTo('Runtime.runIfWaitingForDebugger').map((c) => c.sessionId);
  for (const id of [session.workingTargetId, session.identityTargetId]) {
    const cdp = fake.targets.get(id).sessionId;
    assert.ok(focused.includes(cdp), `${id} got focus emulation`);
    assert.ok(released.includes(cdp), `${id} was released`);
  }
  assert.strictEqual(focused.length, 2);
});

test('a frame whose renderer is wedged fails every preparation command without an unhandled rejection', async () => {
  const { fake, sessions } = await setup();
  const session = await sessions.ensure('s1');
  const parent = fake.targets.get(session.workingTargetId);
  // A wedged renderer answers none of them, so the first rejection must not leave the
  // rest unawaited: node:test fails this file on the unhandled rejection that follows.
  for (const method of ['Page.enable', 'Target.setAutoAttach']) {
    fake.handle(method, (p, sid) => {
      if (fake.bySession(sid).type !== 'iframe') return {};
      return new Promise((resolve, reject) => setTimeout(() => reject(new Error(`${method} timed out`)), 10));
    });
  }
  const frame = fake.createTarget({ type: 'iframe', parent, url: 'http://frame.test/wedged' });
  await waitFor(() => sessions.target(frame.targetId) !== null);
  await sleep(60);
  assert.ok(sessions.target(frame.targetId), 'the target is recorded either way');
  assert.ok(fake.callsTo('Runtime.runIfWaitingForDebugger').some((c) => c.sessionId === frame.sessionId), 'and released, so its load is not held');
});

test('the preparation commands are queued ahead of the release, so a target that answers nothing until then still attaches', async () => {
  const { fake, sessions } = await setup();
  const session = await sessions.ensure('s1');
  // This tab answers Page.enable, the auto-attach, and the window lookup only once it
  // has been released, as a renderer paused on attach does: a handler that awaited one
  // of them first would wait for a document the pause holds back, and nothing below
  // would happen.
  const opened = fake.createTarget({ url: 'http://a.test/tab', windowId: 999, openerId: session.workingTargetId, holdUntilRelease: true });
  await waitFor(() => session.opened.has(opened.targetId), 1000);
  assert.strictEqual(sessions.target(opened.targetId).role, 'opened', 'the claim runs after the commands it queued were answered');
  assert.strictEqual(sessions.target(opened.targetId).windowId, 999, 'and the window the lookup reported is recorded');
  assert.ok(fake.targets.get(opened.targetId).enabled, 'Page.enable landed');
  assert.ok(fake.callsTo('Target.setAutoAttach').some((c) => c.sessionId === opened.sessionId));
});

test('a preparation command that fails leaves the target recorded and released, so its load is not held', async () => {
  const { fake, sessions } = await setup();
  const session = await sessions.ensure('s1');
  const working = fake.targets.get(session.workingTargetId);
  fake.handle('Page.enable', (p, sid) => {
    const t = fake.bySession(sid);
    if (t.type !== 'iframe') return {};
    return fake.afterRelease(t, () => { throw { code: -32000, message: 'the renderer is gone' }; });
  });
  const frame = fake.createTarget({ type: 'iframe', parent: working, url: 'http://frame.test/failing', holdUntilRelease: true });
  await waitFor(() => sessions.target(frame.targetId) !== null);
  await fake.waitForCall('Runtime.runIfWaitingForDebugger', (c) => c.sessionId === frame.sessionId);
  await waitFor(() => frame.released);
  assert.ok(sessions.target(frame.targetId), 'a failed preparation leaves the target in the registry');
  assert.strictEqual(sessions.target(frame.targetId).type, 'iframe');
});

test('a target that is neither a page nor a frame is released and never recorded', async () => {
  const { fake, sessions } = await setup();
  await sessions.ensure('s1');
  const worker = fake.createTarget({ type: 'worker', url: 'http://a.test/worker.js' });
  await fake.waitForCall('Runtime.runIfWaitingForDebugger', (c) => c.sessionId === worker.sessionId);
  await sleep(20);
  assert.strictEqual(sessions.target(worker.targetId), null, 'the registry holds pages and frames alone');
  assert.ok(!fake.callsTo('Page.enable').some((c) => c.sessionId === worker.sessionId), 'and nothing is enabled on it');
});

test('an iframe whose attach arrives on a session the registry does not know is released and never recorded', async () => {
  const { fake, sessions } = await setup();
  const session = await sessions.ensure('s1');
  const page = fake.createTarget({ url: 'http://a.test/tab', openerId: session.workingTargetId });
  await waitFor(() => sessions.target(page.targetId) !== null);
  // The page went before its frame's attach was delivered, so the chain the frame
  // would be numbered and owned along reaches nothing.
  fake.destroyTarget(page.targetId);
  await waitFor(() => sessions.target(page.targetId) === null);
  const orphan = fake.createTarget({ type: 'iframe', parent: page, url: 'http://frame.test/orphan' });
  await fake.waitForCall('Runtime.runIfWaitingForDebugger', (c) => c.sessionId === orphan.sessionId);
  await sleep(20);
  assert.strictEqual(sessions.target(orphan.targetId), null, 'a frame belonging to no page belongs to no session either');
  assert.ok(!fake.callsTo('Page.enable').some((c) => c.sessionId === orphan.sessionId));
});

test('a page-opened target is attributed by opener in the session window and in a popup; one with neither is unowned', async () => {
  const { fake, sessions } = await setup();
  const session = await sessions.ensure('s1');
  const inWindow = fake.createTarget({ url: 'http://a.test/tab', windowId: session.windowId, openerId: session.workingTargetId });
  const popup = fake.createTarget({ url: 'http://a.test/popup', windowId: 999, openerId: session.workingTargetId });
  const stray = fake.createTarget({ url: 'http://a.test/stray', windowId: 998 });
  await waitFor(() => session.opened.size === 2);
  assert.strictEqual(sessions.target(inWindow.targetId).role, 'opened');
  assert.strictEqual(sessions.target(inWindow.targetId).sessionId, 's1');
  assert.strictEqual(sessions.target(popup.targetId).sessionId, 's1');
  assert.strictEqual(sessions.target(popup.targetId).windowId, 999);
  await waitFor(() => sessions.target(stray.targetId) && sessions.target(stray.targetId).windowId !== null);
  assert.strictEqual(sessions.target(stray.targetId).role, null);
  assert.strictEqual(sessions.target(stray.targetId).sessionId, null);
  assert.strictEqual(session.workingTargetId, sessions.target(session.workingTargetId).targetId, 'the working tab is unchanged');
});

test('a page-opened target attached without a URL is attributed by opener on its first navigation, and its window is recorded when the reply lands', async () => {
  const { fake, sessions } = await setup();
  const session = await sessions.ensure('s1');
  const popup = fake.createTarget({ url: '', lateUrl: 'http://a.test/pop', windowId: 999, openerId: session.workingTargetId, windowDelayMs: 60 });
  await waitFor(() => session.opened.has(popup.targetId));
  assert.strictEqual(sessions.target(popup.targetId).role, 'opened');
  assert.strictEqual(sessions.target(popup.targetId).sessionId, 's1');
  assert.strictEqual(await sessions.windowOf(popup.targetId), 999);
  await waitFor(() => sessions.target(popup.targetId).windowId === 999);
});

test('working target destroyed → recreated from the identity page with a note; window re-resolved first', async () => {
  const { fake, sessions } = await setup();
  const session = await sessions.ensure('s1');
  const oldWorking = session.workingTargetId;
  fake.targets.get(session.identityTargetId).windowId = 777; // the human dragged the identity tab elsewhere
  fake.destroyTarget(oldWorking);
  await waitFor(() => session.workingTargetId === null);
  const before = fake.callsTo('Browser.getWindowForTarget').length;
  await sessions.ensure('s1');
  assert.ok(session.workingTargetId && session.workingTargetId !== oldWorking);
  assert.strictEqual(fake.callsTo('Target.createTarget').length, 1, 'no new window');
  assert.strictEqual(session.windowId, 777);
  const resolved = fake.callsTo('Browser.getWindowForTarget').slice(before);
  assert.strictEqual(resolved[0].params.targetId, session.identityTargetId, 're-resolved the identity tab\'s window before the repair');
  assert.deepStrictEqual(session.takeNotes(), ['working tab was recreated']);
  const clicks = fake.callsTo('Runtime.callFunctionOn').filter((c) => /this\.click\(\)/.test(c.params.functionDeclaration));
  assert.strictEqual(clicks.length, 1);
  assert.strictEqual(clicks[0].params.userGesture, true);
});

test('identity page navigated away and working destroyed → the whole window is recreated', async () => {
  const { fake, sessions } = await setup();
  const session = await sessions.ensure('s1');
  const identity = fake.targets.get(session.identityTargetId);
  fake.navigateTarget(identity, 'http://elsewhere.test/');
  fake.destroyTarget(session.workingTargetId);
  await waitFor(() => session.workingTargetId === null);
  const oldIdentity = session.identityTargetId;
  await sessions.ensure('s1');
  assert.strictEqual(fake.callsTo('Target.createTarget').length, 2, 'a new window');
  assert.notStrictEqual(session.identityTargetId, oldIdentity);
  assert.strictEqual(sessions.target(oldIdentity).sessionId, null, 'the navigated-away tab is left unowned');
  assert.deepStrictEqual(session.takeNotes(), ['session window was recreated']);
});

test('both destroyed → window recreated under its label; page-opened targets dropped', async () => {
  const { fake, sessions } = await setup();
  const session = await sessions.ensure('s1');
  await sessions.setLabel(session, 'my task', 'details');
  const opened = fake.createTarget({ url: 'http://a.test/tab', windowId: session.windowId, openerId: session.workingTargetId });
  await waitFor(() => session.opened.size === 1);
  fake.destroyTarget(session.workingTargetId);
  fake.destroyTarget(session.identityTargetId);
  await waitFor(() => session.windowId === null);
  assert.strictEqual(session.opened.size, 0, 'window close drops the session\'s state');
  await sessions.ensure('s1');
  assert.ok(session.windowId !== null);
  assert.deepStrictEqual(session.takeNotes(), ['session window was recreated under its retained name']);
  assert.deepStrictEqual(fake.targets.get(session.identityTargetId).label, { name: 'my task', description: 'details' }, 'label rendered on the new identity tab');
  assert.deepStrictEqual(fake.targets.get(session.workingTargetId).label, { name: 'my task', description: 'details' }, 'and on the working tab');
  assert.strictEqual(sessions.target(opened.targetId).sessionId, null, 'page-opened target stays attached but unowned');
});

test('identity destroyed alone → left absent; ensure does nothing', async () => {
  const { fake, sessions } = await setup();
  const session = await sessions.ensure('s1');
  fake.destroyTarget(session.identityTargetId);
  await waitFor(() => session.identityTargetId === null);
  const calls = fake.calls.length;
  await sessions.ensure('s1');
  assert.strictEqual(session.identityTargetId, null);
  assert.strictEqual(fake.calls.length, calls, 'no protocol traffic');
  assert.ok(session.windowId !== null);
});

test('identity tab creation fails after the working tab is up → the next ensure opens it, with a note', async () => {
  const { fake, sessions } = await setup();
  let failOnce = true;
  const mouse = fake.handlers.get('Input.dispatchMouseEvent');
  fake.handle('Input.dispatchMouseEvent', (p, sid) => {
    if (failOnce && p.type === 'mousePressed' && p.modifiers === 2) { failOnce = false; throw { code: -32000, message: 'nope' }; }
    return mouse(p, sid);
  });
  await assert.rejects(sessions.ensure('s1'), /nope/);
  const session = sessions.get('s1');
  assert.ok(session.workingTargetId, 'the working tab exists');
  assert.strictEqual(session.identityTargetId, null);
  fake.targets.get(session.workingTargetId).windowId = 777; // the human dragged the working tab elsewhere
  await sessions.ensure('s1');
  assert.ok(session.identityTargetId, 'identity tab opened');
  assert.strictEqual(session.windowId, 777, 're-resolved the working tab\'s window before the repair');
  assert.strictEqual(sessions.target(session.identityTargetId).windowId, 777);
  assert.strictEqual(fake.callsTo('Target.createTarget').length, 1, 'same window');
  assert.deepStrictEqual(session.takeNotes(), ['identity tab was recreated']);
  const calls = fake.calls.length;
  await sessions.ensure('s1');
  assert.strictEqual(fake.calls.length, calls, 'repaired once');
});

test('identity tab creation fails twice → the second ensure keeps the working tab with a note, and a third sends nothing', async () => {
  const { fake, sessions } = await setup();
  let failures = 0;
  fake.handle('Input.dispatchMouseEvent', (p) => { if (p.type === 'mousePressed' && p.modifiers === 2) { failures++; throw { code: -32000, message: 'nope' }; } return {}; });
  await assert.rejects(sessions.ensure('s1'), /nope/);
  const session = sessions.get('s1');
  const working = session.workingTargetId;
  const returned = await sessions.ensure('s1');
  assert.strictEqual(returned, session);
  assert.strictEqual(failures, 2, 'retried once');
  assert.strictEqual(session.workingTargetId, working, 'the live working tab is kept');
  assert.strictEqual(session.identityTargetId, null);
  assert.deepStrictEqual(session.takeNotes(), ['identity tab could not be recreated; it returns with the next window']);
  const calls = fake.calls.length;
  await sessions.ensure('s1');
  assert.strictEqual(fake.calls.length, calls, 'no further repair attempts');
});

test('identity tab creation fails and the working tab has left the session page → the working tab is kept and the identity tab stays absent', async () => {
  const { fake, sessions } = await setup();
  fake.handle('Input.dispatchMouseEvent', (p) => { if (p.type === 'mousePressed' && p.modifiers === 2) throw { code: -32000, message: 'nope' }; return {}; });
  await assert.rejects(sessions.ensure('s1'), /nope/);
  const session = sessions.get('s1');
  const working = session.workingTargetId;
  fake.navigateTarget(fake.targets.get(working), 'http://a.test/');
  await waitFor(() => sessions.target(working).url === 'http://a.test/');
  await sessions.ensure('s1');
  assert.strictEqual(session.workingTargetId, working, 'the live working tab is kept');
  assert.strictEqual(session.identityTargetId, null);
  assert.strictEqual(fake.callsTo('Target.createTarget').length, 1, 'no new window');
  assert.deepStrictEqual(session.takeNotes(), ['identity tab could not be recreated; it returns with the next window']);
  const calls = fake.calls.length;
  await sessions.ensure('s1');
  assert.strictEqual(fake.calls.length, calls, 'no further repair attempts');
});

test('dialogs on a target are capped at the last 20', async () => {
  const { fake, sessions } = await setup();
  const session = await sessions.ensure('s1');
  const cdp = fake.targets.get(session.workingTargetId).sessionId;
  for (let i = 0; i < 25; i++) fake.emit('Page.javascriptDialogOpening', { type: 'alert', message: `m${i}` }, cdp);
  await waitFor(() => fake.callsTo('Page.handleJavaScriptDialog').length === 25);
  const dialogs = sessions.takeDialogs(session.workingTargetId);
  assert.strictEqual(dialogs.length, 20);
  assert.strictEqual(dialogs[0].message, 'm5', 'the oldest are gone');
  assert.strictEqual(dialogs[19].message, 'm24');
  assert.deepStrictEqual(sessions.takeDialogs(session.workingTargetId), []);
});

test('ensureWithNotes hands a repair note to the request whose ensure made it, and none to an overlapping one', async () => {
  const { fake, sessions } = await setup();
  const session = await sessions.ensure('s1');
  fake.destroyTarget(session.workingTargetId);
  await waitFor(() => session.workingTargetId === null);
  const [first, second] = await Promise.all([sessions.ensureWithNotes('s1'), sessions.ensureWithNotes('s1')]);
  assert.strictEqual(first.session, session);
  assert.deepStrictEqual(first.notes, ['working tab was recreated']);
  assert.deepStrictEqual(second.notes, []);
});

test('generation increments on main-frame frameNavigated only, resetting the world', async () => {
  const { fake, sessions } = await setup();
  const session = await sessions.ensure('s1');
  const t = sessions.target(session.workingTargetId);
  const g0 = t.generation;
  const world0 = await sessions.world(t.targetId);
  assert.strictEqual(await sessions.world(t.targetId), world0, 'world cached for the generation');
  fake.emit('Page.navigatedWithinDocument', { frameId: t.targetId, url: 'http://a.test/#x' }, t.cdpSessionId);
  fake.emit('Page.frameNavigated', { frame: { id: 'child', parentId: t.targetId, url: 'http://a.test/frame' } }, t.cdpSessionId);
  await sleep(10);
  assert.strictEqual(t.generation, g0, 'same-document and child-frame navigations leave it');
  fake.navigateTarget(fake.targets.get(t.targetId), 'http://a.test/next');
  await sleep(10);
  assert.strictEqual(t.generation, g0 + 1);
  assert.strictEqual(t.url, 'http://a.test/next');
  assert.notStrictEqual(await sessions.world(t.targetId), world0, 'a new world for the new document');
});

test('a ref set survives a navigation and stops matching the generation it was read at', async () => {
  const { fake, sessions } = await setup();
  const session = await sessions.ensure('s1');
  const t = sessions.target(session.workingTargetId);
  // Each id maps to the frame of this target it was read in, null for the main frame.
  session.refs.set(t.targetId, { generation: t.generation, ids: new Map([[1, null], [2, 'child-frame']]) });
  const set = session.refs.get(t.targetId);
  fake.navigateTarget(fake.targets.get(t.targetId), 'http://a.test/next');
  await sleep(10);
  assert.strictEqual(session.refs.get(t.targetId), set, 'the set itself is left alone');
  assert.notStrictEqual(set.generation, t.generation, 'and no longer matches, so every ref in it is stale');
});

test('a dialog is answered per type and its note is taken once', async () => {
  const { fake, sessions } = await setup();
  const session = await sessions.ensure('s1');
  const t = sessions.target(session.workingTargetId);
  fake.emit('Page.javascriptDialogOpening', { type: 'confirm', message: 'Sure?' }, t.cdpSessionId);
  fake.emit('Page.javascriptDialogOpening', { type: 'beforeunload', message: '' }, t.cdpSessionId);
  await waitFor(() => fake.callsTo('Page.handleJavaScriptDialog').length === 2);
  assert.deepStrictEqual(fake.callsTo('Page.handleJavaScriptDialog').map((c) => c.params.accept), [false, true]);
  assert.deepStrictEqual(sessions.takeDialogs(t.targetId), [{ type: 'confirm', message: 'Sure?' }, { type: 'beforeunload', message: '' }]);
  assert.deepStrictEqual(sessions.takeDialogs(t.targetId), []);
});

test('setLabel passes quotes and backticks through unchanged as arguments, and keeps the description when omitted', async () => {
  const { fake, sessions } = await setup();
  const session = await sessions.ensure('s1');
  const name = 'a "quoted" `name`';
  await sessions.setLabel(session, name, 'desc');
  const render = fake.callsTo('Runtime.callFunctionOn').filter((c) => /render\(/.test(c.params.functionDeclaration)).at(-1);
  assert.deepStrictEqual(render.params.arguments, [{ value: name }, { value: 'desc' }]);
  assert.ok(!render.params.functionDeclaration.includes('quoted'), 'name is not interpolated into the source');
  assert.deepStrictEqual(fake.targets.get(session.identityTargetId).label, { name, description: 'desc' });
  await sessions.setLabel(session, ' trimmed ');
  assert.deepStrictEqual(session.label, { name: 'trimmed', description: 'desc' });
  await sessions.setLabel(session, 'trimmed', '');
  assert.deepStrictEqual(session.label, { name: 'trimmed', description: '' });
});

test('dropAll on EOF clears windows, targets, and refs but keeps labels', async () => {
  const { fake, sessions } = await setup();
  const session = await sessions.ensure('s1');
  await sessions.setLabel(session, 'kept');
  session.refs.set(session.workingTargetId, { generation: 1, ids: new Map([[1, null]]) });
  fake.close();
  await waitFor(() => session.windowId === null);
  assert.strictEqual(session.workingTargetId, null);
  assert.strictEqual(session.identityTargetId, null);
  assert.strictEqual(session.refs.size, 0);
  assert.strictEqual(sessions.target(session.workingTargetId), null);
  assert.deepStrictEqual(session.label, { name: 'kept', description: '' });
  assert.strictEqual(sessions.count, 1);
});

test('EOF while ensure waits for a role tab rejects it, and ensure on a fresh connection succeeds', async () => {
  const { fake, sessions } = await setup();
  fake.handle('Target.createTarget', () => ({ targetId: 'never-attached' }));
  const pending = sessions.ensure('s1', { deadline: Date.now() + 100 });
  await fake.waitForCall('Target.createTarget');
  fake.close();
  await assert.rejects(pending, /browser connection closed/);
  // Past the abandoned wait's deadline: its timer must not fire on a deleted key.
  await sleep(150);
  const relaunched = FakeBrowser.inProcess();
  const conn = new Connection(relaunched.readable, relaunched.writable, silentLog);
  sessions.attach(conn);
  await enableTargets(conn);
  const session = await sessions.ensure('s1');
  assert.ok(session.workingTargetId && session.identityTargetId);
  conn.close();
});

test('the session page URL round-trips through parseSessionPage and rejects look-alikes', () => {
  assert.deepStrictEqual(parseSessionPage(pageUrl('abc', 'identity')), { role: 'identity', session: 'abc' });
  assert.strictEqual(parseSessionPage('http://evil.test/session.html#role=identity&session=abc'), null);
  assert.strictEqual(parseSessionPage(`${SESSION_PAGE}?x=1#role=identity&session=abc`), null);
  assert.strictEqual(parseSessionPage(`${SESSION_PAGE}#role=boss&session=abc`), null);
  assert.strictEqual(parseSessionPage(''), null);
});

test('Sessions.attach rebinds to the new connection across a relaunch', async (t) => {
  const { profileDir } = isolatedPaths(t, 'claudesurf-relaunch');
  const sessions = new Sessions(silentLog);
  const first = await browser.launch({ binary: FAKE_CHROME, profileDir, env: {}, log: silentLog });
  sessions.attach(first.conn);
  await browser.enableTargets(first.conn);
  const session = await sessions.ensure('relaunch-session');
  const oldWindow = session.windowId;
  assert.ok(oldWindow !== null);
  await sessions.setLabel(session, 'kept', 'd');
  first.conn.close();
  await waitFor(() => session.windowId === null);
  assert.strictEqual(session.workingTargetId, null, 'EOF dropped the window');
  assert.deepStrictEqual(session.label, { name: 'kept', description: 'd' }, 'label survives EOF');
  const second = await browser.launch({ binary: FAKE_CHROME, profileDir, env: {}, log: silentLog });
  try {
    sessions.attach(second.conn);
    await browser.enableTargets(second.conn);
    const again = await sessions.ensure('relaunch-session');
    assert.strictEqual(again, session);
    assert.ok(again.windowId !== null);
    assert.ok(second.conn.closed === false);
    assert.deepStrictEqual(again.takeNotes(), ['session window was recreated under its retained name']);
  } finally {
    second.conn.close();
  }
});

test('an out-of-process frame is recorded as its own target: Page.enable and the release, no focus emulation or window lookup', async () => {
  const { fake, sessions } = await setup();
  const session = await sessions.ensure('s1');
  const working = fake.targets.get(session.workingTargetId);
  const frame = await attachFrame(fake, sessions, working);
  const record = sessions.target(frame.targetId);
  assert.strictEqual(record.type, 'iframe');
  assert.strictEqual(record.frameNumber, 1);
  assert.strictEqual(record.parentTargetId, working.targetId);
  assert.strictEqual(record.mainFrameId, frame.targetId, "an out-of-process frame's id is its target id");
  await fake.waitForCall('Runtime.runIfWaitingForDebugger', (c) => c.sessionId === frame.sessionId);
  assert.ok(!fake.callsTo('Emulation.setFocusEmulationEnabled').some((c) => c.sessionId === frame.sessionId), 'no focus emulation');
  assert.ok(!fake.callsTo('Browser.getWindowForTarget').some((c) => c.params.targetId === frame.targetId), 'no window lookup');
  assert.strictEqual(session.workingTargetId, working.targetId, 'the frame claims no role');
  assert.strictEqual(record.role, null);
  fake.destroyTarget(frame.targetId);
  await waitFor(() => sessions.target(frame.targetId) === null);
  assert.deepStrictEqual(sessions.frameTargets(working.targetId), []);
});

test('a frame attached before its first navigation is not asked for its frame tree', async () => {
  const { fake, sessions } = await setup();
  const session = await sessions.ensure('s1');
  const working = fake.targets.get(session.workingTargetId);
  const blank = fake.createTarget({ type: 'iframe', parent: working, url: '' });
  await waitFor(() => sessions.target(blank.targetId) !== null);
  await fake.waitForCall('Page.enable', (c) => c.sessionId === blank.sessionId);
  await sleep(20);
  // Its URL is in its parent's frame tree, and an ad frame that never commits would
  // hold the command for its whole timeout.
  assert.ok(!fake.callsTo('Page.getFrameTree').some((c) => c.sessionId === blank.sessionId));
  assert.strictEqual(sessions.target(blank.targetId).url, '');
});

test('frame numbers come from the root page and are never reused; each page numbers from 1', async () => {
  const { fake, sessions } = await setup();
  const session = await sessions.ensure('s1');
  const working = fake.targets.get(session.workingTargetId);
  const identity = fake.targets.get(session.identityTargetId);
  const first = await attachFrame(fake, sessions, working);
  const second = await attachFrame(fake, sessions, working);
  assert.deepStrictEqual([sessions.target(first.targetId).frameNumber, sessions.target(second.targetId).frameNumber], [1, 2]);
  fake.destroyTarget(first.targetId);
  await waitFor(() => sessions.target(first.targetId) === null);
  const third = await attachFrame(fake, sessions, working);
  assert.strictEqual(sessions.target(third.targetId).frameNumber, 3, "the destroyed frame's number stays spent");
  assert.strictEqual(sessions.frameTarget(working.targetId, 1), null, 'a gone frame answers nothing');
  assert.strictEqual(sessions.frameTarget(working.targetId, 2), sessions.target(second.targetId));
  const other = await attachFrame(fake, sessions, identity);
  assert.strictEqual(sessions.target(other.targetId).frameNumber, 1, 'the other page numbers from 1');
  assert.deepStrictEqual(sessions.frameTargets(identity.targetId).map((t) => t.targetId), [other.targetId]);
});

test('a destroyed frame target takes its ref set with it, and a destroyed page takes its frames\' too', async () => {
  const { fake, sessions } = await setup();
  const session = await sessions.ensure('s1');
  const working = fake.targets.get(session.workingTargetId);
  const alone = await attachFrame(fake, sessions, working);
  // A frame target claims no session role, so its set is found along its parent chain.
  session.refs.set(alone.targetId, { generation: 1, ids: new Map([[1, null]]) });
  fake.destroyTarget(alone.targetId);
  await waitFor(() => sessions.target(alone.targetId) === null);
  assert.strictEqual(session.refs.has(alone.targetId), false, 'the frame that went took its refs');
  const kept = await attachFrame(fake, sessions, working);
  session.refs.set(working.targetId, { generation: 1, ids: new Map([[2, null]]) });
  session.refs.set(kept.targetId, { generation: 1, ids: new Map([[3, null]]) });
  fake.destroyTarget(working.targetId);
  await waitFor(() => sessions.target(kept.targetId) === null);
  assert.strictEqual(session.refs.size, 0, "the page's own set and its frames' go together");
});

test('a nested frame records the frame target that carried its attach, and its page takes both when it is destroyed', async () => {
  const { fake, sessions } = await setup();
  const session = await sessions.ensure('s1');
  const working = fake.targets.get(session.workingTargetId);
  const outer = await attachFrame(fake, sessions, working);
  const inner = await attachFrame(fake, sessions, outer, 'http://frame.test/nested');
  assert.strictEqual(sessions.target(inner.targetId).parentTargetId, outer.targetId);
  assert.strictEqual(sessions.target(inner.targetId).frameNumber, 2, 'numbered by the root page, two levels up');
  assert.deepStrictEqual(sessions.frameTargets(working.targetId).map((t) => t.targetId), [outer.targetId, inner.targetId]);
  session.refs.set(inner.targetId, { generation: 1, ids: new Map([[1, null]]) });
  fake.destroyTarget(working.targetId);
  await waitFor(() => sessions.target(working.targetId) === null);
  assert.strictEqual(sessions.target(outer.targetId), null, "the page's frames go with it");
  assert.strictEqual(sessions.target(inner.targetId), null);
  assert.strictEqual(session.refs.has(inner.targetId), false, "and a frame two levels down takes its ref set along the chain");
});

test('a destroyed frame takes the frames inside it, and their ref sets, with it', async () => {
  const { fake, sessions } = await setup();
  const session = await sessions.ensure('s1');
  const working = fake.targets.get(session.workingTargetId);
  const outer = await attachFrame(fake, sessions, working);
  const inner = await attachFrame(fake, sessions, outer, 'http://frame.test/nested');
  session.refs.set(inner.targetId, { generation: 1, ids: new Map([[1, null]]) });
  fake.destroyTarget(outer.targetId);
  await waitFor(() => sessions.target(outer.targetId) === null);
  assert.strictEqual(sessions.target(inner.targetId), null, 'the frame inside it is gone too');
  assert.strictEqual(session.refs.has(inner.targetId), false);
  assert.strictEqual(session.workingTargetId, working.targetId, 'and the page is untouched');
});

test('the per-target auto-attach filters iframes and is sent to every page and frame target', async () => {
  const { fake, sessions } = await setup();
  const session = await sessions.ensure('s1');
  const working = fake.targets.get(session.workingTargetId);
  const frame = await attachFrame(fake, sessions, working);
  const calls = fake.callsTo('Target.setAutoAttach');
  assert.strictEqual(calls.filter((c) => !c.sessionId).length, 1, 'one browser-level call, from enableTargets');
  const perTarget = calls.filter((c) => c.sessionId);
  for (const t of [working, fake.targets.get(session.identityTargetId), frame]) {
    const sent = perTarget.find((c) => c.sessionId === t.sessionId);
    assert.ok(sent, `${t.targetId} got the per-target call`);
    assert.deepStrictEqual(sent.params, {
      autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'iframe' }],
    }, `${t.targetId}'s call carries the filter, so a frame of its own surfaces too`);
  }
});

test('worlds are kept per frame and generation, and a frame target navigating on its own drops only its own', async () => {
  const { fake, sessions } = await setup();
  const session = await sessions.ensure('s1');
  const working = fake.targets.get(session.workingTargetId);
  const t = sessions.target(working.targetId);
  const main = await sessions.world(t.targetId);
  assert.strictEqual(await sessions.world(t.targetId), main, 'the main frame is cached for the generation');
  const child = await sessions.world(t.targetId, 'same-process-child');
  assert.notStrictEqual(child, main, 'a same-process child frame gets its own world');
  assert.strictEqual(await sessions.world(t.targetId, 'same-process-child'), child);
  assert.deepStrictEqual(
    fake.callsTo('Page.createIsolatedWorld').map((c) => c.params.frameId),
    [t.targetId, 'same-process-child'],
  );
  const frame = await attachFrame(fake, sessions, working);
  const frameRecord = sessions.target(frame.targetId);
  await waitFor(() => frameRecord.generation === 1, 1000);
  const frameWorld = await sessions.world(frame.targetId);
  fake.emit('Page.frameNavigated', { frame: { id: 'grandchild', parentId: frame.targetId, url: 'http://frame.test/deep' } }, frame.sessionId);
  await sleep(10);
  assert.strictEqual(frameRecord.generation, 1, "a child of the frame's own document leaves its generation");
  fake.navigateTarget(frame, 'http://frame.test/next');
  await waitFor(() => frameRecord.generation === 2);
  assert.strictEqual(frameRecord.url, 'http://frame.test/next');
  assert.notStrictEqual(await sessions.world(frame.targetId), frameWorld, 'a new world for the new document');
  assert.strictEqual(await sessions.world(t.targetId), main, "the page's world is untouched");
});

test('withWorld retries once in a fresh, un-injected world when the context is gone, and rethrows a second failure', async () => {
  const { fake, sessions } = await setup();
  const session = await sessions.ensure('s1');
  const t = sessions.target(session.workingTargetId);
  const first = await sessions.world(t.targetId);
  const seen = [];
  const result = await sessions.withWorld(t.targetId, null, (contextId, world) => {
    seen.push({ contextId, injected: world.injected });
    world.injected = true;
    if (seen.length === 1) throw missingContext();
    return 'second attempt';
  });
  assert.strictEqual(result, 'second attempt');
  assert.strictEqual(seen.length, 2, 'one retry');
  assert.strictEqual(seen[0].contextId, first);
  assert.notStrictEqual(seen[1].contextId, first, 'the retry ran in a recreated world');
  assert.deepStrictEqual(seen.map((s) => s.injected), [false, false], 'the recreated world carries no injection');
  const before = fake.callsTo('Page.createIsolatedWorld').length;
  let attempts = 0;
  await assert.rejects(sessions.withWorld(t.targetId, null, () => { attempts++; throw missingContext(); }), /Cannot find context/);
  assert.strictEqual(attempts, 2, 'the second failure is not retried again');
  assert.strictEqual(fake.callsTo('Page.createIsolatedWorld').length - before, 1, 'one world recreated for the retry');
});

test('an error that is not a missing context is not retried', async () => {
  const { sessions } = await setup();
  const session = await sessions.ensure('s1');
  const t = sessions.target(session.workingTargetId);
  let attempts = 0;
  await assert.rejects(sessions.withWorld(t.targetId, null, () => { attempts++; throw new Error('page script failed'); }), /page script failed/);
  assert.strictEqual(attempts, 1);
});
