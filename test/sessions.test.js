// sessions.js against the in-process fake: window creation and role claims, opener
// attribution, target preparation, repairs, generations and ref sets, dialogs, labels,
// and EOF.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const browser = require('../server/browser');
const { Sessions, SESSION_PAGE, parseSessionPage } = require('../server/sessions');
const { fakeSession, sleep, waitFor, tmpDir, silentLog, FAKE_CHROME } = require('./helpers');

const { enableTargets } = browser;

async function setup() {
  const ctx = fakeSession();
  await enableTargets(ctx.conn);
  return ctx;
}

function pageUrl(sessionId, role) {
  return `${SESSION_PAGE}#role=${role}&session=${sessionId}&started=2026-01-01T00%3A00%3A00.000Z`;
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

test('ref sets merge across reads of one generation and are replaced on a new one', async () => {
  const { fake, sessions } = await setup();
  const session = await sessions.ensure('s1');
  const t = sessions.target(session.workingTargetId);
  session.refs.set(t.targetId, { generation: t.generation, ids: new Set([1, 2]) });
  const set = session.refs.get(t.targetId);
  for (const id of [2, 3]) set.ids.add(id);
  assert.deepStrictEqual([...set.ids], [1, 2, 3]);
  fake.navigateTarget(fake.targets.get(t.targetId), 'http://a.test/next');
  await sleep(10);
  assert.notStrictEqual(session.refs.get(t.targetId).generation, t.generation, 'the old set no longer matches');
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
  session.refs.set(session.workingTargetId, { generation: 1, ids: new Set([1]) });
  fake.close();
  await waitFor(() => session.windowId === null);
  assert.strictEqual(session.workingTargetId, null);
  assert.strictEqual(session.identityTargetId, null);
  assert.strictEqual(session.refs.size, 0);
  assert.strictEqual(sessions.target(session.workingTargetId), null);
  assert.deepStrictEqual(session.label, { name: 'kept', description: '' });
  assert.strictEqual(sessions.count, 1);
});

test('the session page URL round-trips through parseSessionPage and rejects look-alikes', () => {
  assert.deepStrictEqual(parseSessionPage(pageUrl('abc', 'identity')), { role: 'identity', session: 'abc' });
  assert.strictEqual(parseSessionPage('http://evil.test/session.html#role=identity&session=abc'), null);
  assert.strictEqual(parseSessionPage(`${SESSION_PAGE}?x=1#role=identity&session=abc`), null);
  assert.strictEqual(parseSessionPage(`${SESSION_PAGE}#role=boss&session=abc`), null);
  assert.strictEqual(parseSessionPage(''), null);
});

test('Sessions.attach rebinds to the new connection across a relaunch', async () => {
  const dir = tmpDir('claudesurf-relaunch');
  process.env.CLAUDESURF_SOCKET = path.join(dir, 'cs.sock');
  const profileDir = path.join(dir, 'profile');
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
