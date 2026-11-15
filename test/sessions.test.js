// sessions.js against the in-process fake: window creation and role claims, opener
// attribution, target preparation, iframe targets and their frame numbers, repairs,
// generations, isolated worlds and ref sets, dialogs, labels, and EOF.

const { test } = require('node:test');
const assert = require('node:assert');
const browser = require('../server/browser');
const { Sessions, SESSION_PAGE, parseSessionPage } = require('../server/sessions');
const { fakeSession, sleep, flush, waitFor, isolatedPaths, silentLog, recordingLog, FAKE_CHROME } = require('./helpers');
const { Connection, ProtocolError } = require('../server/cdp');
const { FakeBrowser } = require('./fakes/fake-browser');
const refusals = require('../server/refusals');
const requests = require('../server/requests');
const retained = require('../server/retained');
const tabRecords = require('../server/tab-records');

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

test('the tab is attributed and numbered at attach, and its commands, arming first, are queued ahead of the release, so a target that answers nothing until then still attaches', async () => {
  const { fake, sessions } = await setup();
  const session = await sessions.ensure('s1');
  const release = fake.handlers.get('Runtime.runIfWaitingForDebugger');
  let atRelease = null;
  fake.handle('Runtime.runIfWaitingForDebugger', (p, sid, f) => {
    const t = fake.bySession(sid);
    if (t && t.openerId) {
      const record = sessions.target(t.targetId);
      atRelease = { role: record.role, tab: session.tabIds.get(t.targetId), enabled: t.enabled };
    }
    return release(p, sid, f);
  });
  // This tab answers Page.enable, the auto-attach, and the window lookup only once it
  // has been released, as a renderer paused on attach does: a handler that awaited one
  // of them first would wait for a document the pause holds back, and nothing below
  // would happen.
  const opened = fake.createTarget({ url: 'http://a.test/tab', windowId: 999, openerId: session.workingTargetId, holdUntilRelease: true });
  await waitFor(() => sessions.target(opened.targetId) && sessions.target(opened.targetId).windowId === 999, 1000);
  assert.deepStrictEqual(atRelease, { role: 'opened', tab: 3, enabled: false }, 'attributed and numbered before any of its commands answered');
  const sent = fake.calls.filter((c) => c.sessionId === opened.sessionId).map((c) => c.method);
  assert.deepStrictEqual(sent.slice(0, sent.indexOf('Runtime.runIfWaitingForDebugger') + 1), [
    'Network.enable', 'Network.setBypassServiceWorker', 'Page.setPrerenderingAllowed', 'Console.enable', 'Log.enable',
    'Page.enable', 'Target.setAutoAttach', 'Emulation.setFocusEmulationEnabled', 'Runtime.runIfWaitingForDebugger',
  ]);
  assert.strictEqual(sessions.target(opened.targetId).role, 'opened');
  assert.ok(fake.targets.get(opened.targetId).enabled, 'Page.enable landed');
  await waitFor(() => sessions.target(opened.targetId).armed);
});

test('a tab attributed at attach is armed and released though a waiter on its opener throws as the attribution wakes it, and a later throw in the handler is logged rather than left unhandled', async (t) => {
  const log = recordingLog();
  const ctx = fakeSession({ log });
  t.after(() => ctx.conn.close());
  await enableTargets(ctx.conn);
  const { fake, sessions } = ctx;
  const session = await sessions.ensure('s1');
  const opener = session.workingTargetId;
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  // The predicate passes the check that waitUntil makes at once and throws on the next,
  // the one that the attribution's wake-up runs.
  let checks = 0;
  sessions.waitUntil(opener, () => { if (checks++ > 0) throw new Error('a broken predicate'); return false; }, { timeout: 2_000 }).catch(() => {});
  const woken = fake.createTarget({ url: 'http://a.test/woken', windowId: session.windowId, openerId: opener });
  await fake.waitForCall('Runtime.runIfWaitingForDebugger', (c) => c.sessionId === woken.sessionId);
  const sent = fake.calls.filter((c) => c.sessionId === woken.sessionId).map((c) => c.method);
  assert.ok(sent.indexOf('Network.enable') >= 0 && sent.indexOf('Network.enable') < sent.indexOf('Runtime.runIfWaitingForDebugger'), `armed ahead of its release: ${sent}`);
  // A throw after the handler's first await rejects the promise that it returned.
  sessions.claim = () => { throw new Error('a broken claim'); };
  const late = fake.createTarget({ url: 'http://a.test/late', windowId: session.windowId, openerId: opener });
  await waitFor(() => log.lines.error.some((line) => line.includes('a broken claim')));
  await sleep(20);
  assert.ok(fake.targets.get(late.targetId).released);
  assert.deepStrictEqual(unhandled.map(String), []);
});

test('a target whose attach step throws before its commands are queued is still released, so its navigation is not wedged', async (t) => {
  const log = recordingLog();
  const ctx = fakeSession({ log });
  t.after(() => ctx.conn.close());
  await enableTargets(ctx.conn);
  const { fake, sessions } = ctx;
  const session = await sessions.ensure('s1');
  sessions.attribute = () => { throw new Error('a broken attribution'); };
  const opened = fake.createTarget({ url: 'http://a.test/tab', windowId: session.windowId, openerId: session.workingTargetId });
  await waitFor(() => log.lines.error.some((line) => line.includes('a broken attribution')));
  await sleep(20);
  assert.ok(fake.targets.get(opened.targetId).released);
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
  await waitFor(() => session.opened.size === 2 && sessions.target(popup.targetId).windowId !== null);
  assert.strictEqual(sessions.target(inWindow.targetId).role, 'opened');
  assert.strictEqual(sessions.target(inWindow.targetId).sessionId, 's1');
  assert.strictEqual(sessions.target(popup.targetId).sessionId, 's1');
  assert.strictEqual(sessions.target(popup.targetId).windowId, 999);
  await waitFor(() => sessions.target(stray.targetId) && sessions.target(stray.targetId).windowId !== null);
  assert.strictEqual(sessions.target(stray.targetId).role, null);
  assert.strictEqual(sessions.target(stray.targetId).sessionId, null);
  assert.strictEqual(session.workingTargetId, sessions.target(session.workingTargetId).targetId, 'the working tab is unchanged');
});

test('a page-opened target attached without a URL is attributed by opener at attach, before its first navigation, and its window is recorded when the reply lands', async () => {
  const { fake, sessions } = await setup();
  const session = await sessions.ensure('s1');
  const release = fake.handlers.get('Runtime.runIfWaitingForDebugger');
  let atRelease = null;
  fake.handle('Runtime.runIfWaitingForDebugger', (p, sid, f) => {
    const record = sessions.target(fake.bySession(sid).targetId);
    if (record && record.openerId) atRelease = { role: record.role, url: record.url, generation: record.generation };
    return release(p, sid, f);
  });
  const popup = fake.createTarget({ url: '', lateUrl: 'http://a.test/pop', windowId: 999, openerId: session.workingTargetId, windowDelayMs: 60 });
  await waitFor(() => session.opened.has(popup.targetId));
  await waitFor(() => atRelease !== null);
  assert.deepStrictEqual(atRelease, { role: 'opened', url: '', generation: 0 }, 'attributed while the first document is still held back');
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

test('when both tabs are destroyed, the window is recreated under its label, and a popup left in another window is disowned', async () => {
  const { fake, sessions } = await setup();
  const session = await sessions.ensure('s1');
  await sessions.setLabel(session, 'my task', 'details');
  const opened = fake.createTarget({ url: 'http://a.test/tab', windowId: 4242, openerId: session.workingTargetId });
  await waitFor(() => session.opened.size === 1 && sessions.target(opened.targetId).windowId === 4242);
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

test('an out-of-process frame is recorded as its own target: Page.enable, focus emulation, and the release, without a window lookup', async () => {
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
  assert.ok(fake.callsTo('Emulation.setFocusEmulationEnabled').some((c) => c.sessionId === frame.sessionId), 'focus emulation, since a frame takes keys');
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

test('the per-target auto-attach filters iframes and workers and is sent to every page and frame target', async () => {
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
      autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
      filter: [{ type: 'iframe' }, { type: 'worker' }, { type: 'shared_worker' }, { type: 'service_worker' }],
    }, `${t.targetId}'s call carries the filter, so a frame of its own surfaces too, and a worker that the pause holds is released`);
  }
});

test('a worker that attaches is released and detached, and left out of the registry', async () => {
  const { fake, sessions } = await setup();
  const session = await sessions.ensure('s1');
  const working = fake.targets.get(session.workingTargetId);
  const worker = fake.createTarget({ type: 'worker', parent: working, url: 'blob:http://a.test/w' });
  await fake.waitForCall('Target.detachFromTarget', (c) => c.params.sessionId === worker.sessionId);
  assert.ok(fake.callsTo('Runtime.runIfWaitingForDebugger').some((c) => c.sessionId === worker.sessionId), 'released');
  assert.deepStrictEqual(fake.calls.filter((c) => c.sessionId === worker.sessionId).map((c) => c.method), ['Runtime.runIfWaitingForDebugger']);
  assert.strictEqual(sessions.target(worker.targetId), null);
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

test('ready resolves once Page.enable settles: with null for a tab not armed at attach, with arming\'s outcomes for one that was, and with null for a target that goes first', async () => {
  const { fake, sessions } = await setup();
  const session = await sessions.ensure('s1');
  assert.strictEqual(await sessions.target(session.workingTargetId).ready, null, 'createTarget opened the working tab, which has no opener to arm it at attach');
  const opened = fake.createTarget({ url: 'http://a.test/tab', openerId: session.workingTargetId });
  await waitFor(() => sessions.target(opened.targetId));
  const outcomes = await sessions.target(opened.targetId).ready;
  assert.deepStrictEqual(outcomes.map((o) => [o.method, o.ok]), [
    ['Network.enable', true], ['Network.setBypassServiceWorker', true], ['Page.setPrerenderingAllowed', true],
  ]);
  fake.handle('Page.enable', (p, sid) => {
    if (fake.bySession(sid).url === 'http://a.test/rejects') throw { code: -32000, message: 'no' };
    if (fake.bySession(sid).url === 'http://a.test/hangs') return new Promise(() => {});
    return {};
  });
  const rejecting = fake.createTarget({ url: 'http://a.test/rejects', openerId: session.workingTargetId });
  await waitFor(() => sessions.target(rejecting.targetId));
  assert.strictEqual((await sessions.target(rejecting.targetId).ready).length, 3, 'a rejected Page.enable resolves it too');
  const hanging = fake.createTarget({ url: 'http://a.test/hangs', openerId: session.workingTargetId });
  await waitFor(() => sessions.target(hanging.targetId));
  const ready = sessions.target(hanging.targetId).ready;
  fake.destroyTarget(hanging.targetId);
  assert.strictEqual(await ready, null, 'the destruction resolves it with no outcomes');
});

test("arming: Network.enable with capture's body buffers, the bypass, prerendering off, and capture's Console and Log are queued before the release of a tab a session page opened, and awaited by repair for the working tab; Fetch.enable goes only under an interceptor", async () => {
  for (const allow of [undefined, ['a.test']]) {
    const ctx = fakeSession({ allow });
    await enableTargets(ctx.conn);
    const { fake, sessions } = ctx;
    const session = await sessions.ensure('s1');
    const working = sessions.target(session.workingTargetId);
    const on = (target) => fake.calls.filter((c) => c.sessionId === fake.targets.get(target).sessionId).map((c) => c.method);
    assert.ok(working.armed, 'repair armed the working tab before ensure returned');
    assert.deepStrictEqual(fake.callsTo('Network.enable').find((c) => c.sessionId === working.cdpSessionId).params, { maxTotalBufferSize: 10 * 1024 * 1024, maxResourceBufferSize: 1024 * 1024 });
    assert.ok(['Console.enable', 'Log.enable'].every((method) => on(working.targetId).includes(method)), "repair's arming enables capture on the working tab");
    const opened = fake.createTarget({ url: 'http://a.test/tab', openerId: working.targetId, holdUntilRelease: true });
    await waitFor(() => sessions.target(opened.targetId) && sessions.target(opened.targetId).armed);
    const sent = on(opened.targetId);
    const released = sent.indexOf('Runtime.runIfWaitingForDebugger');
    for (const method of ['Network.enable', 'Network.setBypassServiceWorker', 'Page.setPrerenderingAllowed', 'Console.enable', 'Log.enable']) {
      assert.ok(sent.indexOf(method) !== -1 && sent.indexOf(method) < released, `${method} queued before the release`);
    }
    for (const target of [working.targetId, opened.targetId]) {
      const prerender = fake.callsTo('Page.setPrerenderingAllowed').filter((c) => c.sessionId === fake.targets.get(target).sessionId);
      assert.deepStrictEqual(prerender.map((c) => c.params), [{ isAllowed: false }], 'prerendering is switched off');
    }
    assert.strictEqual(on(working.targetId).includes('Fetch.enable'), Boolean(allow), 'Fetch.enable on the working tab only under an interceptor');
    assert.strictEqual(sent.includes('Fetch.enable'), Boolean(allow), 'and on the opened tab likewise');
    if (allow) assert.ok(sent.indexOf('Fetch.enable') < released);
    const stray = fake.createTarget({ url: 'http://a.test/stray' });
    await waitFor(() => sessions.target(stray.targetId) && sessions.target(stray.targetId).windowId !== null);
    assert.ok(!on(stray.targetId).includes('Network.enable'), 'a tab opened outside every session is never armed');
    ctx.conn.close();
  }
});

test("repair's wait for the arming that a repaired working tab's attach queued ends at the call's deadline", async () => {
  const { fake, sessions } = await setup();
  const session = await sessions.ensure('s1');
  const identity = session.identityTargetId;
  // The tab that the identity page opens never answers its Network.enable.
  const enable = fake.handlers.get('Network.enable');
  fake.handle('Network.enable', (p, sid, f) => (fake.bySession(sid).openerId === identity ? new Promise(() => {}) : enable(p, sid, f)));
  fake.destroyTarget(session.workingTargetId);
  await waitFor(() => session.workingTargetId === null);
  const started = Date.now();
  await assert.rejects(sessions.ensureWithNotes('s1', { deadline: started + 1_000 }), (e) => {
    assert.deepStrictEqual(e.envelope, { outcome: 'error', message: 'the working tab could not be put under the domain gate; call again' });
    return true;
  });
  const spent = Date.now() - started;
  assert.ok(spent < 2_000, `the call spent ${spent} ms against its 1,000 ms deadline`);
});

test('a pushState moves a page target\'s URL and counts as its landing; a child frame\'s does neither, and a frame target keeps its own URL', async () => {
  const { fake, sessions } = await setup();
  const session = await sessions.ensure('s1');
  const working = fake.targets.get(session.workingTargetId);
  fake.navigateTarget(working, 'http://a.test/');
  const t = sessions.target(working.targetId);
  await waitFor(() => t.url === 'http://a.test/');
  const frame = await attachFrame(fake, sessions, working);
  fake.navigateTarget(frame, 'http://frame.test/child');
  await waitFor(() => sessions.target(frame.targetId).url === 'http://frame.test/child');
  fake.emit('Page.navigatedWithinDocument', { frameId: 'child', url: 'http://a.test/child#x' }, t.cdpSessionId);
  fake.emit('Page.navigatedWithinDocument', { frameId: frame.targetId, url: 'http://frame.test/moved' }, frame.sessionId);
  fake.emit('Page.navigatedWithinDocument', { frameId: t.targetId, url: 'http://a.test/settings' }, t.cdpSessionId);
  await waitFor(() => t.url === 'http://a.test/settings');
  assert.strictEqual(t.sameDocument, 1, "the child frame's event isn't the page's landing");
  assert.strictEqual(sessions.target(frame.targetId).url, 'http://frame.test/child');
  assert.strictEqual(sessions.target(frame.targetId).sameDocument, 1, 'a frame target counts its own');
});

test('tab numbers count from 1 and survive a role claim; tab records go with their target, the window, and EOF, and aren\'t reused', async () => {
  const { fake, sessions } = await setup();
  const session = await sessions.ensure('s1');
  assert.strictEqual(session.tabIds.get(session.workingTargetId), 1);
  assert.strictEqual(session.tabIds.get(session.identityTargetId), 2, 'numbered when attributed by opener, and kept by its claim');
  const opened = fake.createTarget({ url: 'http://a.test/tab', windowId: 4242, openerId: session.workingTargetId });
  await waitFor(() => session.tabIds.get(opened.targetId) === 3);
  fake.destroyTarget(opened.targetId);
  await waitFor(() => !sessions.target(opened.targetId));
  assert.ok(!session.tabIds.has(opened.targetId), 'a closed tab leaves the records');
  fake.destroyTarget(session.workingTargetId);
  fake.destroyTarget(session.identityTargetId);
  await waitFor(() => session.windowId === null);
  assert.strictEqual(session.tabIds.size, 0, 'the window state takes the rest');
  await sessions.ensure('s1');
  assert.deepStrictEqual([...session.tabIds.values()], [4, 5], 'a recreated window\'s tabs take new numbers');
  fake.close();
  await waitFor(() => session.windowId === null);
  assert.strictEqual(session.tabIds.size, 0, 'and EOF takes them all');
  assert.strictEqual(session.nextTab, 6, 'while the counter survives');
});

test('a refusal outlives its tab, and goes with the window state and on EOF unless a call is running', async () => {
  const { fake, sessions } = await setup();
  const session = await sessions.ensure('s1');
  const opened = fake.createTarget({ url: 'http://a.test/tab', windowId: 4242, openerId: session.workingTargetId });
  await waitFor(() => session.tabIds.has(opened.targetId));
  const refuse = (s, targetId) => refusals.record(s, { kind: 'navigation', how: 'stopped', url: 'http://b.test/', host: 'b.test', targetId, tab: s.tabIds.get(targetId) });
  refuse(session, opened.targetId);
  fake.destroyTarget(opened.targetId);
  await waitFor(() => !sessions.target(opened.targetId));
  assert.strictEqual(session.refusals.length, 1, 'kept past its tab');
  session.marks = { seq: 0, nextTab: session.nextTab, workingTargetId: session.workingTargetId };
  fake.destroyTarget(session.workingTargetId);
  fake.destroyTarget(session.identityTargetId);
  await waitFor(() => session.windowId === null);
  assert.strictEqual(session.refusals.length, 1, 'a running call keeps the list through the window state\'s drop');
  session.marks = null;
  await sessions.ensure('s1');
  assert.deepStrictEqual(session.refusals, [], 'the next window recreation takes it');
  refuse(session, session.workingTargetId);
  session.droppedRefusals = 2;
  fake.close();
  await waitFor(() => session.windowId === null);
  assert.deepStrictEqual([session.refusals, session.droppedRefusals], [[], 0], 'and so does EOF');
  assert.strictEqual(session.refusalCount, 2, 'while the counter survives, so a seq stays past every mark');

  const during = await setup();
  const running = await during.sessions.ensure('s1');
  refuse(running, running.workingTargetId);
  running.marks = { seq: 0, nextTab: running.nextTab, workingTargetId: running.workingTargetId };
  during.fake.close();
  await waitFor(() => running.windowId === null);
  assert.strictEqual(running.refusals.length, 1, 'an EOF during a call keeps the list too');
});

test('the window state lasts while a session tab remains in the window, a tab whose window is still unknown included; the next call then recreates the window, disowning and disarming that tab', async () => {
  const { fake, sessions } = await setup();
  const session = await sessions.ensure('s1');
  const inWindow = fake.createTarget({ url: 'http://a.test/tab', windowId: session.windowId, openerId: session.workingTargetId });
  // Its window lookup answers late, so the registry hasn't recorded its window yet.
  const pending = fake.createTarget({ url: 'http://a.test/pending', windowId: 4242, openerId: session.workingTargetId, windowDelayMs: 500 });
  await waitFor(() => sessions.target(inWindow.targetId) && sessions.target(inWindow.targetId).armed);
  await waitFor(() => sessions.target(pending.targetId) && session.opened.has(pending.targetId));
  fake.destroyTarget(inWindow.targetId);
  fake.destroyTarget(session.workingTargetId);
  fake.destroyTarget(session.identityTargetId);
  await waitFor(() => session.identityTargetId === null);
  assert.strictEqual(sessions.target(pending.targetId).windowId, null);
  assert.ok(session.windowId !== null, 'the tab whose lookup is pending counts as in the window');
  await waitFor(() => sessions.target(pending.targetId).windowId === 4242);
  const before = fake.calls.length;
  await sessions.ensure('s1');
  assert.strictEqual(fake.callsTo('Target.createTarget').length, 2, 'no identity page to return through, so the window is recreated');
  assert.strictEqual(sessions.target(pending.targetId).sessionId, null, 'and the tab left behind is disowned');
  const undone = fake.calls.slice(before).filter((c) => c.sessionId === pending.sessionId).map((c) => c.method);
  assert.deepStrictEqual(undone, ['Fetch.disable', 'Network.setBypassServiceWorker', 'Page.setPrerenderingAllowed', 'Network.disable', 'Console.disable', 'Log.disable'], 'and disarmed');
});

test("a session's tab that reaches the session page of its other role keeps the role it holds, its number, and its arming", async () => {
  const { fake, sessions } = await setup();
  const session = await sessions.ensure('s1');
  const working = session.workingTargetId;
  await waitFor(() => sessions.target(working).armed);
  fake.navigateTarget(fake.targets.get(working), pageUrl('s1', 'identity'));
  await waitFor(() => parseSessionPage(sessions.target(working).url) !== null);
  const t = sessions.target(working);
  assert.deepStrictEqual({ role: t.role, sessionId: t.sessionId, armed: t.armed }, { role: 'working', sessionId: 's1', armed: true });
  assert.strictEqual(session.tabIds.get(working), 1);
  const { notes } = await sessions.ensureWithNotes('s1');
  assert.deepStrictEqual(notes, [], 'the next call has nothing to repair');
  assert.strictEqual(session.workingTargetId, working);
});

test('repair returns to the most recent live earlier working tab with a note, skipping one that claim let go, before the identity page\'s working link', async () => {
  const { fake, sessions } = await setup();
  const session = await sessions.ensure('s1');
  const first = session.workingTargetId;
  const open = async (name) => {
    const target = fake.createTarget({ url: `http://a.test/${name}`, windowId: session.windowId, openerId: session.workingTargetId });
    await waitFor(() => sessions.target(target.targetId) && sessions.target(target.targetId).armed);
    return target.targetId;
  };
  const second = await open('second');
  const third = await open('third');
  const fourth = await open('fourth');
  tabRecords.switchWorking(sessions, session, second);
  tabRecords.switchWorking(sessions, session, third);
  tabRecords.switchWorking(sessions, session, fourth);
  assert.deepStrictEqual(session.earlierWorking, [first, second, third]);
  assert.strictEqual(sessions.target(first).role, 'opened', 'the old working tab joins the opened tabs');
  // The third tab goes back to the session page, where claim lets it go as a second
  // working tab.
  fake.navigateTarget(fake.targets.get(third), fake.targets.get(first).url);
  await waitFor(() => sessions.target(third).sessionId === null);
  fake.destroyTarget(fourth);
  await waitFor(() => session.workingTargetId === null);
  await sessions.ensure('s1');
  assert.strictEqual(session.workingTargetId, second, 'the let-go entry is skipped, and of the two live ones the more recent is taken');
  assert.deepStrictEqual(session.takeNotes(), ['the working tab closed; t3 is the working tab again']);
  fake.destroyTarget(first);
  fake.destroyTarget(second);
  await waitFor(() => session.workingTargetId === null);
  await sessions.ensure('s1');
  assert.deepStrictEqual(session.takeNotes(), ['working tab was recreated'], 'an empty stack falls through to the identity page');
});

test("tab records list the working tab first and the rest by number, each tab or popup by the window the registry recorded, and latestIn finds the most recent live earlier working tab in the session's window", async () => {
  const { fake, sessions } = await setup();
  const session = await sessions.ensure('s1');
  const first = session.workingTargetId;
  const popup = fake.createTarget({ url: 'http://a.test/popup', windowId: 4242, openerId: first });
  const tab = fake.createTarget({ url: 'http://a.test/tab', windowId: session.windowId, openerId: first, windowDelayMs: 100 });
  const next = fake.createTarget({ url: 'http://a.test/next', windowId: session.windowId, openerId: first });
  await waitFor(() => [popup, next].every((t) => sessions.target(t.targetId) && sessions.target(t.targetId).armed) && sessions.target(tab.targetId));
  tabRecords.switchWorking(sessions, session, next.targetId);
  assert.strictEqual(sessions.target(tab.targetId).windowId, null, 'its window lookup has not answered yet');
  assert.deepStrictEqual(await tabRecords.tabs(sessions, session), [
    { id: 't5', targetId: next.targetId, kind: 'working' },
    { id: 't1', targetId: first, kind: 'tab' },
    { id: 't2', targetId: session.identityTargetId, kind: 'identity' },
    { id: 't3', targetId: popup.targetId, kind: 'popup' },
    { id: 't4', targetId: tab.targetId, kind: 'tab' },
  ]);
  assert.strictEqual(await tabRecords.latestIn(sessions, session), first);
  assert.deepStrictEqual(session.earlierWorking, [first], 'latestIn leaves the stack as it is');
  tabRecords.switchWorking(sessions, session, popup.targetId);
  tabRecords.switchWorking(sessions, session, first);
  assert.deepStrictEqual(session.earlierWorking, [next.targetId, popup.targetId]);
  assert.strictEqual(await tabRecords.latestIn(sessions, session), next.targetId, 'the more recent popup in another window is passed over');
  tabRecords.switchWorking(sessions, session, tab.targetId);
  assert.strictEqual(await tabRecords.latestIn(sessions, session), first, 'and of two tabs in the window, the more recent is found');
});

test('the Network events of a tab are kept per target, its counted requests capped at 1,000, and an image left uncounted', async () => {
  const { fake, sessions } = await setup();
  const session = await sessions.ensure('s1');
  const tab = fake.targets.get(session.workingTargetId);
  const t = sessions.target(tab.targetId);
  const started = [];
  for (let i = 0; i < 1_005; i++) started.push(fake.networkRequest(tab, { type: 'XHR' }));
  await waitFor(() => requests.busy(t).count === 1_000);
  // The image takes the oldest request's place in the store and doesn't count.
  fake.networkRequest(tab, { type: 'Image' });
  await waitFor(() => requests.busy(t).count === 999);
  started.at(-1).finish();
  await waitFor(() => requests.busy(t).count === 998, 1000);
  started.at(-2).finish(true);
  await waitFor(() => requests.busy(t).count === 997, 1000, 'a failed request ends as a finished one does');
});

test("a frame's document request that the page's session carried ends when the frame attaches as a target of its own", async () => {
  const { fake, sessions } = await setup();
  const session = await sessions.ensure('s1');
  const tab = fake.targets.get(session.workingTargetId);
  const t = sessions.target(tab.targetId);
  const frameId = `T${fake.nextTarget}`;
  fake.emit('Network.requestWillBeSent', { requestId: 'frame-doc', type: 'Document', frameId, request: { url: 'http://frame.test/' } }, tab.sessionId);
  await waitFor(() => requests.busy(t).count === 1);
  const woken = sessions.waitUntil(t.targetId, (target) => requests.busy(target).count === 0, { timeout: 1000 });
  const frame = fake.createTarget({ type: 'iframe', parent: tab, url: 'http://frame.test/' });
  assert.strictEqual(frame.targetId, frameId);
  assert.strictEqual(await woken, true, "the frame's attach ends it and wakes the page's waiters");
});

test('a waiter whose predicate throws fails with the throw, which is logged, and the waiters after it still run', async (t) => {
  const log = recordingLog();
  const ctx = fakeSession({ log });
  t.after(() => ctx.conn.close());
  await enableTargets(ctx.conn);
  const { fake, sessions } = ctx;
  const session = await sessions.ensure('s1');
  const tab = fake.targets.get(session.workingTargetId);
  const loads = sessions.target(tab.targetId).loads;
  // The predicate passes the check that waitUntil makes at once and throws on the next.
  let checks = 0;
  const broken = sessions.waitUntil(tab.targetId, () => { if (checks++ > 0) throw new Error('a broken predicate'); return false; }, { timeout: 2_000 });
  const after = sessions.waitUntil(tab.targetId, (target) => target.loads > loads, { timeout: 2_000 });
  fake.emit('Page.loadEventFired', {}, tab.sessionId);
  assert.strictEqual(await after, true, 'the waiter after the broken one ran on the same event');
  await assert.rejects(broken, /a broken predicate/);
  assert.ok(log.lines.warn.some((line) => line.includes('a broken predicate')), log.lines.warn.join('\n'));
});

test('DOMContentLoaded marks the document it fired in as loaded, and a back-forward cache restore counts as a load and as DOMContentLoaded', async () => {
  const { fake, sessions } = await setup();
  const session = await sessions.ensure('s1');
  const tab = fake.targets.get(session.workingTargetId);
  const t = sessions.target(tab.targetId);
  const before = { loads: t.loads, generation: t.generation };
  fake.navigateTarget(tab, 'http://a.test/');
  await waitFor(() => t.loads === before.loads + 1);
  assert.strictEqual(t.loadedGeneration, before.generation + 1);
  const woken = sessions.waitUntil(t.targetId, (target) => target.loadedGeneration === before.generation + 2, { timeout: 1000 });
  fake.emit('Page.frameNavigated', { frame: { id: tab.targetId, url: 'http://a.test/back' }, type: 'BackForwardCacheRestore' }, tab.sessionId);
  assert.strictEqual(await woken, true, "the restore wakes the tab's waiters");
  assert.deepStrictEqual(
    { loads: t.loads, generation: t.generation, loadedGeneration: t.loadedGeneration },
    { loads: before.loads + 2, generation: before.generation + 2, loadedGeneration: before.generation + 2 },
  );
  fake.emit('Page.frameNavigated', { frame: { id: tab.targetId, url: 'http://a.test/next' }, type: 'Navigation' }, tab.sessionId);
  await waitFor(() => t.generation === before.generation + 3);
  assert.strictEqual(t.loadedGeneration, before.generation + 2, 'a plain commit waits for its own event');
  fake.emit('Page.domContentEventFired', { timestamp: 1 }, tab.sessionId);
  await waitFor(() => t.loadedGeneration === before.generation + 3);
});

test('a retained render goes with its tab, the window state, and EOF, and a render over the cap leaves a size marker in its place', async () => {
  const { fake, sessions } = await setup();
  const session = await sessions.ensure('s1');
  const render = (region) => ({ params: {}, overlayBlocks: [], region, linkLists: [], hiddenSection: '', header: {}, source: 'read', startedAt: Date.now() });
  const keep = (targetId, region = 'Region.') => retained.keep(session, sessions.target(targetId), { ...render(region), generation: sessions.target(targetId).generation });
  assert.strictEqual(keep(session.workingTargetId, 'x'.repeat(500_001)), false, 'past the cap the render is not kept');
  assert.deepStrictEqual(retained.current(session, sessions.target(session.workingTargetId)), { tooLarge: true, generation: sessions.target(session.workingTargetId).generation, size: 500_001 });
  const opened = fake.createTarget({ url: 'http://a.test/tab', windowId: fake.targets.get(session.workingTargetId).windowId, openerId: session.workingTargetId });
  await waitFor(() => sessions.target(opened.targetId));
  assert.strictEqual(keep(opened.targetId), true);
  assert.strictEqual(keep(session.workingTargetId), true);
  fake.destroyTarget(opened.targetId);
  await waitFor(() => !sessions.target(opened.targetId));
  assert.deepStrictEqual([...session.retained.keys()], [session.workingTargetId], 'a closed tab takes its render');
  fake.destroyTarget(session.workingTargetId);
  fake.destroyTarget(session.identityTargetId);
  await waitFor(() => session.windowId === null);
  assert.strictEqual(session.retained.size, 0, 'the window state takes the rest');
  await sessions.ensure('s1');
  keep(session.workingTargetId);
  fake.close();
  await waitFor(() => session.windowId === null);
  assert.strictEqual(session.retained.size, 0, 'and so does EOF');
});

test("a tab's in-flight requests go when it is destroyed and when it is disarmed", async () => {
  const { fake, sessions } = await setup();
  const session = await sessions.ensure('s1');
  const working = sessions.target(session.workingTargetId);
  // The session lets go of a popup in a window of its own once the session's window has
  // closed.
  const opened = fake.createTarget({ url: 'http://a.test/tab', windowId: 4242, openerId: working.targetId });
  await waitFor(() => sessions.target(opened.targetId) && sessions.target(opened.targetId).armed);
  const t = sessions.target(opened.targetId);
  fake.networkRequest(fake.targets.get(working.targetId), { type: 'Fetch' });
  fake.networkRequest(opened, { type: 'Fetch' });
  await waitFor(() => requests.busy(working).count === 1 && requests.busy(t).count === 1);
  fake.destroyTarget(working.targetId);
  await waitFor(() => !sessions.target(working.targetId));
  assert.strictEqual(requests.busy(working).count, 0, 'destroyed');
  fake.destroyTarget(session.identityTargetId);
  await waitFor(() => t.sessionId === null);
  assert.strictEqual(requests.busy(t).count, 0, 'disarmed');
});

test("a new document's commit ends the requests that its tab's earlier document left in flight, and keeps its own", async () => {
  const { fake, sessions } = await setup();
  const session = await sessions.ensure('s1');
  const tab = fake.targets.get(session.workingTargetId);
  const t = sessions.target(tab.targetId);
  const send = (requestId, loaderId, type) => fake.emit('Network.requestWillBeSent', { requestId, loaderId, type, request: { url: 'http://a.test/x' } }, tab.sessionId);
  send('old-1', 'L-old', 'Fetch');
  send('old-2', 'L-old', 'Fetch');
  fake.announce(tab, 'http://a.test/next');
  // Chrome sends a document's own request under its loader id, as its request id too.
  send(tab.loaderId, tab.loaderId, 'Document');
  await waitFor(() => requests.busy(t).count === 3);
  fake.commitDocument(tab, 'http://a.test/next');
  await waitFor(() => t.url === 'http://a.test/next');
  assert.strictEqual(requests.busy(t).count, 1);
});

test("the registry records the loader id that a main-frame commit carries, and a silent first commit's from the frame-tree read", async () => {
  const { fake, sessions, conn } = await setup();
  const session = await sessions.ensure('s1');
  const tab = fake.targets.get(session.workingTargetId);
  const t = sessions.target(tab.targetId);
  assert.strictEqual(t.loaderId, tab.documentLoaderId, "the working tab's first commit");
  fake.navigateTarget(tab, 'http://a.test/next');
  await waitFor(() => t.url === 'http://a.test/next');
  assert.strictEqual(t.loaderId, tab.documentLoaderId);
  assert.notStrictEqual(t.loaderId, null);
  fake.emit('Page.frameNavigated', { frame: { id: 'CHILD', parentId: tab.targetId, url: 'http://child.test/', loaderId: 'child-loader' }, type: 'Navigation' }, tab.sessionId);
  await flush(conn);
  assert.strictEqual(t.loaderId, tab.documentLoaderId, "a child frame's commit leaves it alone");
  const opened = fake.openWindow(tab, 'http://a.test/popup');
  await waitFor(() => sessions.target(opened.targetId) && sessions.target(opened.targetId).url === 'http://a.test/popup');
  assert.strictEqual(sessions.target(opened.targetId).loaderId, opened.documentLoaderId, 'read from the frame tree, since the commit sent no event');
});

test('a main-frame download is kept on the tab, the last ten, each with the download count after it; a child frame\'s is not', async () => {
  const { fake, sessions, conn } = await setup();
  const session = await sessions.ensure('s1');
  const tab = fake.targets.get(session.workingTargetId);
  const t = sessions.target(tab.targetId);
  for (let i = 1; i <= 12; i++) fake.emit('Page.downloadWillBegin', { frameId: tab.targetId, url: `http://a.test/f${i}`, suggestedFilename: `f${i}.bin` }, tab.sessionId);
  fake.emit('Page.downloadWillBegin', { frameId: 'CHILD', url: 'http://a.test/child.bin', suggestedFilename: 'child.bin' }, tab.sessionId);
  await flush(conn);
  assert.strictEqual(t.downloads, 12);
  assert.deepStrictEqual(t.downloadLog.map((d) => d.n), [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.deepStrictEqual(t.downloadLog.at(-1), { n: 12, url: 'http://a.test/f12', file: 'f12.bin' });
});

test("forget drops a tab's captured requests and console entries with its in-flight requests", async (t) => {
  const network = require('../server/network');
  const consoleCapture = require('../server/console-capture');
  const dropped = [];
  for (const [name, module] of [['network', network], ['console', consoleCapture]]) {
    const original = module.drop;
    t.after(() => { module.drop = original; });
    module.drop = (target) => { dropped.push([name, target.targetId]); return original(target); };
  }
  const { fake, sessions } = await setup();
  const session = await sessions.ensure('s1');
  const opened = fake.openWindow(fake.targets.get(session.workingTargetId), 'http://a.test/popup');
  await waitFor(() => sessions.target(opened.targetId));
  dropped.length = 0;
  fake.destroyTarget(opened.targetId);
  await waitFor(() => !sessions.target(opened.targetId));
  assert.deepStrictEqual([...new Set(dropped.filter(([, id]) => id === opened.targetId).map(([name]) => name))].sort(), ['console', 'network']);
});
