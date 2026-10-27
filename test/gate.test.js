// The domain gate against the in-process fake: arming at attach and in repair, the
// paused-request handler, the backstop, the rejection rule, disarming, and the
// refusals that each path records. A running call's marks are set on the session directly,
// as the acting handlers set them.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { enableTargets } = require('../server/browser');
const refusals = require('../server/refusals');
const requests = require('../server/requests');
const tabRecords = require('../server/tab-records');
const navigation = require('../server/navigation');
const input = require('../server/input');
const { tabs } = require('../server/tabs');
const { respond } = require('../server/respond');
const { SESSION_PAGE } = require('../server/sessions');
const { Gate } = require('../server/gate');
const { fakeSession, handleOpened, readPayload, recordingLog, refsIn, waitFor } = require('./helpers');

async function setup(t, { allow = ['fake.test'], log } = {}) {
  const ctx = fakeSession({ t, allow, log });
  await enableTargets(ctx.conn);
  const session = await ctx.sessions.ensure('s1');
  const working = ctx.fake.targets.get(session.workingTargetId);
  return { ...ctx, session, working };
}

// Navigates the page in `target` by itself and resolves once the request's outcome is
// known: with the URL that it committed, recorded by the registry, or null.
function pageGoes(ctx, target, url) {
  return new Promise((resolve) => ctx.fake.navigateByPage(target, url, resolve)).then(async (committed) => {
    if (committed !== null) await waitFor(() => ctx.sessions.target(target.targetId).url === committed);
    return committed;
  });
}

// Resolves with how the gate answered a paused request: 'continue', or 'fail' and the
// error reason, as in 'fail Aborted'.
async function answerTo(fake, requestId) {
  let call;
  await waitFor(() => {
    call = fake.calls.find((c) => (c.method === 'Fetch.continueRequest' || c.method === 'Fetch.failRequest') && c.params.requestId === requestId);
    return call;
  });
  return call.method === 'Fetch.continueRequest' ? 'continue' : `fail ${call.params.errorReason}`;
}

// Raises a paused request on the target's session the way Chrome does, for a frame or
// a URL that the fake's own navigations don't make; resolves with the gate's answer.
let raised = 0;
function raise(fake, target, url, { frameId = target.targetId } = {}) {
  const requestId = `raised-${++raised}`;
  fake.emit('Fetch.requestPaused', { requestId, request: { url, method: 'GET', headers: {} }, frameId, resourceType: 'Document' }, target.sessionId);
  return answerTo(fake, requestId);
}

function marksOf(session) {
  return { seq: session.refusalCount, nextTab: session.nextTab, workingTargetId: session.workingTargetId };
}

test('a refused request of the working tab is recorded before it is failed with Aborted, and the tab stays on its page', async (t) => {
  const ctx = await setup(t);
  const { fake, sessions, session, working } = ctx;
  assert.strictEqual(await pageGoes(ctx, working, 'http://fake.test/'), 'http://fake.test/');
  const failRequest = fake.handlers.get('Fetch.failRequest');
  let recordedFirst = null;
  fake.handle('Fetch.failRequest', (p, sid, f) => {
    recordedFirst = session.refusals.length === 1;
    return failRequest(p, sid, f);
  });
  // Only the refusal moves the tab's counts after the navigation starts.
  const woken = sessions.waitUntil(working.targetId, () => session.refusalCount > 0, { timeout: 1000 });
  assert.strictEqual(await pageGoes(ctx, working, 'http://evil.test/collect?d=1'), null);
  assert.strictEqual(await woken, true, 'the refusal wakes the tab\'s waiters');
  assert.strictEqual(fake.callsTo('Fetch.failRequest')[0].params.errorReason, 'Aborted');
  assert.strictEqual(recordedFirst, true, 'the refusal is on the session before the request fails');
  assert.deepStrictEqual(session.refusals, [{
    kind: 'navigation', how: 'stopped', url: 'http://evil.test/collect?d=1', host: 'evil.test',
    targetId: working.targetId, tab: 1, opener: null, count: 1, seq: 1,
  }]);
  assert.strictEqual(sessions.target(working.targetId).url, 'http://fake.test/');
  assert.strictEqual(sessions.target(working.targetId).closing, false);
});

test('an allowed request continues, a refused redirect hop fails, and a child frame\'s document, a file: request, the identity tab\'s, and an unowned tab\'s continue whatever the host', async (t) => {
  const ctx = await setup(t);
  const { fake, sessions, session, working } = ctx;
  const continued = fake.callsTo('Fetch.continueRequest').length;
  assert.strictEqual(await pageGoes(ctx, working, 'http://www.fake.test/start'), 'http://www.fake.test/start', 'a subdomain of an entry is allowed');
  fake.site['http://fake.test/r'] = { redirect: 'http://evil.test/landing' };
  assert.strictEqual(await pageGoes(ctx, working, 'http://fake.test/r'), null);
  assert.strictEqual(fake.callsTo('Fetch.continueRequest').length - continued, 2, 'the start page and the first hop continued');
  assert.strictEqual(session.refusals.length, 1);
  assert.strictEqual(session.refusals[0].url, 'http://evil.test/landing', 'the redirect hop is the one refused');
  assert.strictEqual(sessions.target(working.targetId).url, 'http://www.fake.test/start');
  assert.strictEqual(await raise(fake, working, 'http://evil.test/ad', { frameId: 'child-frame' }), 'continue');
  assert.strictEqual(await raise(fake, working, 'file:///etc/passwd'), 'continue');
  const identity = fake.targets.get(session.identityTargetId);
  assert.strictEqual(await raise(fake, identity, 'http://evil.test/'), 'continue');
  const stray = fake.createTarget({ url: 'http://elsewhere.test/' });
  await waitFor(() => sessions.target(stray.targetId) && sessions.target(stray.targetId).windowId !== null);
  assert.strictEqual(await raise(fake, stray, 'http://evil.test/'), 'continue');
  assert.strictEqual(session.refusals.length, 1, 'none of those is a refusal');
});

test('a tab that a session page opens is attributed, numbered, and armed at attach, so its first request, before any commit, is judged as its main frame\'s: refused as a new tab and closed, its number kept on the entry', async (t) => {
  const ctx = await setup(t);
  const { fake, sessions, session, working } = ctx;
  const failRequest = fake.handlers.get('Fetch.failRequest');
  let atRefusal = null;
  fake.handle('Fetch.failRequest', (p, sid, f) => {
    const t = sessions.target(fake.bySession(sid).targetId);
    atRefusal = { mainFrameId: t.mainFrameId, committedWeb: t.committedWeb, tab: session.tabIds.get(t.targetId) };
    return failRequest(p, sid, f);
  });
  const popup = fake.openWindow(working, 'http://evil.test/pop');
  await waitFor(() => !sessions.target(popup.targetId) && session.refusals.length === 1);
  assert.deepStrictEqual(atRefusal, { mainFrameId: null, committedWeb: false, tab: 3 });
  assert.deepStrictEqual(session.refusals[0], {
    kind: 'new tab', how: 'stopped', url: 'http://evil.test/pop', host: 'evil.test',
    targetId: popup.targetId, tab: 3, opener: working.targetId, count: 1, seq: 1,
  });
  assert.ok(fake.callsTo('Target.closeTarget').some((c) => c.params.targetId === popup.targetId));
});

test('a refused request of a new tab that the gate is already closing fails without another entry or another close', async (t) => {
  const ctx = await setup(t);
  const { fake, sessions, session, working } = ctx;
  fake.handle('Target.closeTarget', () => new Promise(() => {}));
  const popup = fake.openWindow(working, 'http://evil.test/pop');
  await waitFor(() => sessions.target(popup.targetId) && sessions.target(popup.targetId).closing);
  assert.strictEqual(await raise(fake, popup, 'http://evil.test/again'), 'fail Aborted');
  assert.strictEqual(fake.callsTo('Target.closeTarget').length, 1);
  assert.deepStrictEqual(session.refusals.map(({ url, count }) => ({ url, count })), [{ url: 'http://evil.test/pop', count: 1 }]);
});

test('a tab that a frame of the working tab opens during a click is refused as the call\'s own, its opener the root page', async (t) => {
  let frame = null;
  let session = null;
  // A request of the page holds the click's settling open until the popup's refusal is
  // on the session, since the popup's attach, arming, and first request can outlast
  // the quiet window.
  const pop = (fake, page) => {
    const held = fake.networkRequest(page);
    fake.openWindow(frame, 'http://evil.test/from-frame');
    waitFor(() => session.refusals.length > 0).catch(() => {}).then(() => held.finish());
  };
  const ctx = await setupRead(t, { elements: [{ kind: 'button', label: 'Pop', visible: true, onClick: pop }] });
  ({ session } = ctx);
  const { fake, sessions, context, working, refs } = ctx;
  frame = fake.createTarget({ type: 'iframe', parent: working, url: 'http://frame.test/embed' });
  await waitFor(() => sessions.target(frame.targetId));
  const attributed = sessions.waitUntil(working.targetId, () => session.tabIds.size > 2, { timeout: 2000 });
  const result = await input.click(context, session, { ref: refs.Pop });
  assert.strictEqual(await attributed, true, 'the attribution wakes the root page\'s waiters');
  assert.deepStrictEqual(result.blocked.map(({ url, opener }) => ({ url, opener })), [{ url: 'http://evil.test/from-frame', opener: working.targetId }]);
});

test('a pop-under from the tab that tabs new identified is the call\'s own; a popup from a background session tab is not', async (t) => {
  const ctx = await setup(t);
  const { fake, sessions, session, working } = ctx;
  await pageGoes(ctx, working, 'http://fake.test/');
  const background = fake.openWindow(working, 'http://fake.test/background');
  await waitFor(() => sessions.target(background.targetId) && sessions.target(background.targetId).committedWeb);
  session.marks = marksOf(session);
  const newTab = fake.openWindow(working, 'about:blank#nonce');
  await waitFor(() => sessions.target(newTab.targetId) && sessions.target(newTab.targetId).armed);
  session.marks.newTab = newTab.targetId;
  const popUnder = fake.openWindow(newTab, 'http://evil.test/pop-under');
  const popup = fake.openWindow(background, 'http://evil.test/popup');
  await waitFor(() => session.refusals.length === 2);
  const own = refusals.takeOwn(session, session.marks);
  assert.deepStrictEqual(own.map((e) => e.targetId), [popUnder.targetId]);
  assert.deepStrictEqual(session.refusals.map((e) => e.targetId), [popup.targetId], 'the background tab\'s popup stays for a later response');
});

test('a restore onto a refused host is sent to about:blank, or closed when the tab is a new one, recorded as a restore that no call takes as its own', async (t) => {
  const ctx = await setup(t);
  const { fake, sessions, session, working } = ctx;
  await pageGoes(ctx, working, 'http://fake.test/');
  const blank = fake.openWindow(working);
  await waitFor(() => sessions.target(blank.targetId) && sessions.target(blank.targetId).armed);
  session.marks = marksOf(session);
  const restore = (target, url) => fake.emit('Page.frameNavigated', { frame: { id: target.targetId, url }, type: 'BackForwardCacheRestore' }, target.sessionId);
  restore(working, 'http://evil.test/old');
  await waitFor(() => fake.callsTo('Page.navigate').some((c) => c.sessionId === working.sessionId && c.params.url === 'about:blank'));
  restore(blank, 'http://evil.test/older');
  await waitFor(() => !sessions.target(blank.targetId));
  assert.deepStrictEqual(session.refusals.map(({ kind, how, url, tab }) => ({ kind, how, url, tab })), [
    { kind: 'restore', how: 'blanked', url: 'http://evil.test/old', tab: 1 },
    { kind: 'restore', how: 'closed', url: 'http://evil.test/older', tab: 3 },
  ]);
  assert.deepStrictEqual(refusals.takeOwn(session, session.marks), [], 'left out of the call\'s outcome');
  restore(working, 'http://fake.test/back');
  await waitFor(() => sessions.target(working.targetId).url === 'http://fake.test/back');
  assert.strictEqual(session.refusals.length, 2, 'an allowed restore passes');
});

test('a throw while judging fails the request of a gated tab and continues any other\'s', async (t) => {
  const ctx = await setup(t, { log: recordingLog() });
  const { fake, sessions, session, working, policy } = ctx;
  const allows = policy.allows;
  policy.allows = () => { throw new Error('policy store exploded'); };
  assert.strictEqual(await raise(fake, working, 'http://fake.test/'), 'fail Aborted');
  policy.allows = allows;
  const byCdpSession = sessions.byCdpSession;
  sessions.byCdpSession = () => { throw new Error('registry exploded'); };
  assert.strictEqual(await raise(fake, working, 'http://evil.test/'), 'continue');
  sessions.byCdpSession = byCdpSession;
  assert.strictEqual(session.refusals.length, 0);
  assert.strictEqual(ctx.log.lines.warn.filter((l) => /judging a paused request/.test(l)).length, 2);
});

test('Fetch.enable and the bypass go to the working tab by repair, on ensure and ensureWithNotes alike, to the tab createWindow opened, and at attach to a tab whose opener is a session\'s; not to a tab that the human opened', async (t) => {
  const ctx = await setup(t);
  const { fake, sessions, session, working } = ctx;
  const on = (target, method) => fake.calls.filter((c) => c.sessionId === target.sessionId && c.method === method);
  for (const method of ['Fetch.enable', 'Network.setBypassServiceWorker']) {
    assert.strictEqual(on(working, method).length, 1, `${method} on the tab createWindow opened`);
  }
  assert.deepStrictEqual(on(working, 'Fetch.enable')[0].params, { patterns: [{ resourceType: 'Document', requestStage: 'Request' }] });
  assert.deepStrictEqual(on(working, 'Network.setBypassServiceWorker')[0].params, { bypass: true });
  fake.destroyTarget(working.targetId);
  await waitFor(() => session.workingTargetId === null);
  // The repaired tab's arming is still in flight when its first document has loaded.
  const answer = fake.handlers.get('Network.enable');
  fake.handle('Network.enable', (p, sid, f) => new Promise((resolve) => setTimeout(() => resolve(answer(p, sid, f)), 100)));
  const { notes } = await sessions.ensureWithNotes('s1');
  assert.deepStrictEqual(notes, ['working tab was recreated']);
  const repaired = fake.targets.get(session.workingTargetId);
  assert.ok(sessions.target(repaired.targetId).armed);
  assert.strictEqual(on(repaired, 'Fetch.enable').length, 1, 'armed at its attach, from the identity page, and repair waited for that arming rather than sending another');
  const human = fake.createTarget({ url: 'http://fake.test/own' });
  const fromHuman = fake.openWindow(human, 'http://fake.test/child');
  await waitFor(() => sessions.target(fromHuman.targetId) && sessions.target(fromHuman.targetId).windowId !== null);
  await waitFor(() => fake.callsTo('Page.enable').some((c) => c.sessionId === fromHuman.sessionId));
  for (const target of [human, fromHuman]) {
    assert.deepStrictEqual(on(target, 'Fetch.enable'), [], 'a tab outside every session is never armed');
    assert.deepStrictEqual(on(target, 'Network.enable'), []);
  }
});

test('claim leaves a second working tab unowned and disarmed, bypass set back before Network.disable, and its requests continue; it stays unowned when it commits elsewhere, and a tab that was never armed is not disarmed', async (t) => {
  const ctx = await setup(t);
  const { fake, sessions, session, working } = ctx;
  const opened = fake.openWindow(working, 'http://fake.test/tab');
  await waitFor(() => sessions.target(opened.targetId) && sessions.target(opened.targetId).armed);
  const before = fake.calls.length;
  fake.navigateTarget(opened, working.url);
  await waitFor(() => sessions.target(opened.targetId).sessionId === null);
  const record = sessions.target(opened.targetId);
  assert.deepStrictEqual([record.role, record.armed, session.opened.has(opened.targetId), session.tabIds.has(opened.targetId)], [null, false, false, false]);
  const undone = fake.calls.slice(before).filter((c) => c.sessionId === opened.sessionId);
  assert.deepStrictEqual(undone.map((c) => [c.method, c.params]), [
    ['Fetch.disable', {}],
    ['Network.setBypassServiceWorker', { bypass: false }],
    ['Page.setPrerenderingAllowed', { isAllowed: true }],
    ['Network.disable', {}],
  ]);
  assert.strictEqual(await raise(fake, opened, 'http://evil.test/'), 'continue');
  fake.navigateTarget(opened, 'http://elsewhere.test/');
  await waitFor(() => sessions.target(opened.targetId).url === 'http://elsewhere.test/');
  assert.strictEqual(sessions.target(opened.targetId).sessionId, null, 'no opener branch brings it back');
  const human = fake.createTarget({ url: 'http://fake.test/own' });
  await waitFor(() => sessions.target(human.targetId) && sessions.target(human.targetId).windowId !== null);
  fake.navigateTarget(human, working.url);
  await waitFor(() => sessions.target(human.targetId).url === working.url);
  assert.deepStrictEqual(fake.calls.filter((c) => c.sessionId === human.sessionId && /disable|Bypass|Prerender/.test(c.method)), [], 'a tab arming never reached gets no disarm');
});

test('a page-opened tab that the window-state drop disowns is disarmed, its requests dropped, and its paused requests continued whatever the host', async (t) => {
  const ctx = await setup(t);
  const { fake, sessions, session, working } = ctx;
  const identity = fake.targets.get(session.identityTargetId);
  // A popup in another window doesn't keep the window state once the working and
  // identity tabs are gone.
  const popup = fake.createTarget({ url: '', windowId: 900, openerId: working.targetId, lateUrl: 'http://fake.test/pop', silentFirstCommit: true });
  await waitFor(() => sessions.target(popup.targetId) && sessions.target(popup.targetId).armed && sessions.target(popup.targetId).windowId === 900);
  const record = sessions.target(popup.targetId);
  fake.networkRequest(popup, { type: 'XHR' });
  await waitFor(() => requests.busy(record).count === 1);
  const before = fake.calls.length;
  fake.destroyTarget(working.targetId);
  fake.destroyTarget(identity.targetId);
  await waitFor(() => session.windowId === null);
  assert.deepStrictEqual([record.sessionId, record.role, record.armed], [null, null, false], 'disowned');
  assert.deepStrictEqual(fake.calls.slice(before).filter((c) => c.sessionId === popup.sessionId).map((c) => c.method), [
    'Fetch.disable', 'Network.setBypassServiceWorker', 'Page.setPrerenderingAllowed', 'Network.disable',
  ]);
  assert.strictEqual(requests.busy(record).count, 0, "the tab's requests are dropped");
  assert.strictEqual(await raise(fake, popup, 'http://evil.test/'), 'continue');
});

test('a click\'s result lacks an Opened: line for a tab that the rule is closing for a rejected Fetch.enable, and carries the rule\'s note', async (t) => {
  const elements = [{
    kind: 'button', label: 'open', visible: true,
    onClick: (fake, target) => {
      fake.networkRequest(target, { type: 'Fetch', ms: 400 });
      fake.openWindow(target, 'http://fake.test/pop');
    },
  }];
  const ctx = await setupRead(t, { elements });
  const { fake, sessions, session } = ctx;
  handleOpened(fake, 'Fetch.enable', () => { throw { code: -32000, message: 'Fetch refused' }; });
  fake.handle('Target.closeTarget', () => new Promise(() => {}));
  const result = await input.click(ctx.context, session, { ref: ctx.refs.open });
  assert.ok(!/Opened:/.test(result.head), result.head);
  assert.ok(fake.callsTo('Target.closeTarget').length === 1, 'the rule is closing the tab');
  const { envelope } = respond(sessions, session, result);
  assert.deepStrictEqual(envelope.notes, ['t3 was closed because it could not be put under the domain gate']);
});

test('a former working tab that only repair armed, moved to the opened tabs by a switch, is left open on a refusal and disarmed when claim drops it', async (t) => {
  const ctx = await setup(t);
  const { fake, sessions, session, working } = ctx;
  await pageGoes(ctx, working, 'http://fake.test/');
  const other = fake.openWindow(working, 'http://fake.test/other');
  await waitFor(() => sessions.target(other.targetId) && sessions.target(other.targetId).armed);
  tabRecords.switchWorking(sessions, session, other.targetId);
  assert.strictEqual(sessions.target(working.targetId).role, 'opened');
  assert.strictEqual(await pageGoes(ctx, working, 'http://evil.test/'), null);
  assert.deepStrictEqual([session.refusals[0].kind, sessions.target(working.targetId).closing], ['navigation', false], 'a tab that was working is not new');
  assert.ok(!fake.callsTo('Target.closeTarget').length);
  const before = fake.calls.length;
  fake.navigateTarget(working, fake.targets.get(session.identityTargetId).url.replace('role=identity', 'role=working'));
  await waitFor(() => sessions.target(working.targetId).sessionId === null);
  assert.ok(fake.calls.slice(before).some((c) => c.sessionId === working.sessionId && c.method === 'Fetch.disable'));
});

test('a working tab whose first navigation is refused is left open, a repaired one that the identity page opened included, and a pre-check of the same URL leaves the page\'s entry on the list', async (t) => {
  const ctx = await setup(t);
  const { fake, sessions, session, working, gate } = ctx;
  assert.strictEqual(await pageGoes(ctx, working, 'http://evil.test/x'), null);
  assert.ok(sessions.target(working.targetId), 'the working tab is not new, so it stays');
  fake.destroyTarget(working.targetId);
  await waitFor(() => session.workingTargetId === null);
  await sessions.ensure('s1');
  const repaired = fake.targets.get(session.workingTargetId);
  assert.ok(sessions.target(repaired.targetId).openerPage, 'opened by the identity page');
  refusals.takeRest(session);
  assert.strictEqual(await pageGoes(ctx, repaired, 'http://evil.test/x'), null);
  assert.ok(sessions.target(repaired.targetId), 'a tab that has been working is not new either');
  assert.deepStrictEqual([session.refusals[0].kind, sessions.target(repaired.targetId).closing], ['navigation', false]);
  const before = JSON.stringify(session.refusals);
  const entry = gate.check('http://evil.test/x', session, 'navigation');
  assert.deepStrictEqual(entry, { kind: 'navigation', how: 'not started', url: 'http://evil.test/x', host: 'evil.test', targetId: repaired.targetId, tab: 3, count: 1 });
  assert.strictEqual(JSON.stringify(session.refusals), before, 'the pre-check touches nothing');
  assert.strictEqual(gate.check('http://fake.test/', session, 'navigation'), null);
  assert.strictEqual(gate.check('about:blank', session, 'new tab'), null);
});

test('a refused navigate returns the working tab\'s state lines and the pre-check\'s entry as blocked, without a Page.navigate', async (t) => {
  const ctx = await setup(t);
  const { fake, session, working, context } = ctx;
  await pageGoes(ctx, working, 'http://fake.test/');
  const before = fake.callsTo('Page.navigate').length;
  const result = await navigation.navigate(context, session, { url: 'http://evil.test/', name: 'task' }, Date.now() + 10_000);
  assert.strictEqual(fake.callsTo('Page.navigate').length, before);
  assert.match(result.head, /^URL: http:\/\/fake\.test\/\nTitle: /);
  assert.deepStrictEqual(result.blocked, [{ kind: 'navigation', how: 'not started', url: 'http://evil.test/', host: 'evil.test', targetId: working.targetId, tab: 1, count: 1 }]);
  assert.deepStrictEqual(session.refusals, []);
});

test('a refusal logs at info, its repeat on the tab within a minute at debug, and a continued request at debug', async (t) => {
  const ctx = await setup(t, { log: recordingLog() });
  const { working } = ctx;
  await pageGoes(ctx, working, 'http://fake.test/');
  await pageGoes(ctx, working, 'http://evil.test/a');
  await pageGoes(ctx, working, 'http://evil.test/b');
  const { info, debug } = ctx.log.lines;
  assert.strictEqual(info.filter((l) => /gate: refused .*evil\.test/.test(l)).length, 1);
  assert.strictEqual(debug.filter((l) => /gate: refused .*evil\.test/.test(l)).length, 1);
  assert.ok(debug.some((l) => /gate: continuing http:\/\/fake\.test\//.test(l)));
});

test('the refusal log keys a repeat by tab and host, and logs at info again a minute after the refusal that logged at info', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const log = recordingLog();
  const gate = new Gate({ sessions: {}, policy: { allows: () => false }, log });
  const session = { id: 's1', workingTargetId: null, tabIds: new Map([['T1', 1], ['T2', 2]]) };
  // Runs the pre-check, which logs as a recorded refusal does, and returns the level it
  // logged at.
  const level = (targetId, host) => {
    session.workingTargetId = targetId;
    const infos = log.lines.info.length;
    gate.check(`http://${host}/`, session, 'navigation');
    return log.lines.info.length > infos ? 'info' : 'debug';
  };
  assert.strictEqual(level('T1', 'evil.test'), 'info');
  assert.strictEqual(level('T1', 'evil.test'), 'debug', 'a repeat on the tab');
  assert.strictEqual(level('T2', 'evil.test'), 'info', 'the host on another tab');
  assert.strictEqual(level('T1', 'other.test'), 'info', 'another host on the tab');
  t.mock.timers.tick(59_999);
  assert.strictEqual(level('T1', 'evil.test'), 'debug', 'a repeat just within the minute');
  t.mock.timers.tick(1);
  assert.strictEqual(level('T1', 'evil.test'), 'info', 'a minute from the info line, which the repeats between did not move');
  assert.strictEqual(level('T1', 'evil.test'), 'debug', 'and that line starts a minute of its own');
});

test('a repeat of a refusal recorded before the call counts as one that the call led to', async (t) => {
  const ctx = await setup(t);
  const { session, working } = ctx;
  await pageGoes(ctx, working, 'http://fake.test/');
  await pageGoes(ctx, working, 'http://evil.test/again');
  session.marks = marksOf(session);
  await pageGoes(ctx, working, 'http://evil.test/again');
  const own = refusals.takeOwn(session, session.marks);
  assert.deepStrictEqual(own.map(({ url, count }) => ({ url, count })), [{ url: 'http://evil.test/again', count: 2 }]);
});

test('a tab opened by window.open and then sent to a refused host by its opener is refused as new and closed', async (t) => {
  const ctx = await setup(t);
  const { fake, sessions, session, working } = ctx;
  const blank = fake.openWindow(working);
  await waitFor(() => sessions.target(blank.targetId) && sessions.target(blank.targetId).armed);
  assert.strictEqual(sessions.target(blank.targetId).committedWeb, false);
  assert.strictEqual(await pageGoes(ctx, blank, 'http://evil.test/'), null);
  await waitFor(() => !sessions.target(blank.targetId));
  assert.deepStrictEqual([session.refusals[0].kind, session.refusals[0].tab], ['new tab', 3]);
});

test('a page-opened tab whose first web page committed before Page.enable answered, without a frameNavigated, stays on its page when a later navigation is refused', async (t) => {
  const ctx = await setup(t);
  const { fake, sessions, session, working } = ctx;
  const popup = fake.openWindow(working, 'http://fake.test/pop');
  await waitFor(() => sessions.target(popup.targetId) && sessions.target(popup.targetId).committedWeb);
  assert.strictEqual(sessions.target(popup.targetId).generation, 0, 'no frameNavigated arrived');
  assert.strictEqual(await pageGoes(ctx, popup, 'http://evil.test/'), null);
  assert.strictEqual(session.refusals[0].kind, 'navigation');
  assert.ok(sessions.target(popup.targetId));
  assert.ok(!fake.callsTo('Target.closeTarget').some((c) => c.params.targetId === popup.targetId));
  // A tab whose attach already carried its URL is read for its commit too.
  const url = 'http://fake.test/named';
  const named = fake.createTarget({ url, lateUrl: url, openerId: working.targetId, windowId: working.windowId, silentFirstCommit: true });
  await waitFor(() => sessions.target(named.targetId) && sessions.target(named.targetId).armed);
  await waitFor(() => sessions.target(named.targetId).committedWeb);
});

test('a page-opened tab whose Target.setAutoAttach rejects still records its first web page from the frame-tree read', async (t) => {
  const ctx = await setup(t);
  const { fake, sessions, working } = ctx;
  fake.handle('Target.setAutoAttach', (p, sid) => {
    if (fake.bySession(sid).openerId) throw { code: -32000, message: 'auto-attach refused' };
    return {};
  });
  const popup = fake.openWindow(working, 'http://fake.test/pop');
  await waitFor(() => sessions.target(popup.targetId) && sessions.target(popup.targetId).committedWeb);
  assert.strictEqual(sessions.target(popup.targetId).url, 'http://fake.test/pop');
});

test('closeTarget rejecting clears closing on a tab still registered, for the gate\'s close and the rule\'s', async (t) => {
  const ctx = await setup(t, { log: recordingLog() });
  const { fake, sessions, working } = ctx;
  fake.handle('Target.closeTarget', () => { throw { code: -32000, message: 'cannot close' }; });
  const refused = fake.openWindow(working, 'http://evil.test/pop');
  await waitFor(() => fake.callsTo('Target.closeTarget').some((c) => c.params.targetId === refused.targetId));
  await waitFor(() => sessions.target(refused.targetId).closing === false && ctx.log.lines.warn.some((l) => l.includes(`closing ${refused.targetId}`)));
  fake.handle('Fetch.enable', (p, sid) => {
    if (fake.bySession(sid).openerId) throw { code: -32000, message: 'no Fetch here' };
    return {};
  });
  const unarmed = fake.openWindow(working, 'http://fake.test/pop');
  await waitFor(() => fake.callsTo('Target.closeTarget').some((c) => c.params.targetId === unarmed.targetId));
  await waitFor(() => sessions.target(unarmed.targetId).closing === false && ctx.log.lines.warn.some((l) => l.includes(`closing ${unarmed.targetId}`)));
});

test('the rule closes a page-opened tab after its claim step when Fetch.enable, Network.enable, or the bypass rejects, with its session note, and leaves it open with a warning when the prerendering switch does', async (t) => {
  for (const method of ['Fetch.enable', 'Network.enable', 'Network.setBypassServiceWorker', 'Page.setPrerenderingAllowed']) {
    const ctx = await setup(t, { log: recordingLog() });
    const { fake, sessions, session, working } = ctx;
    handleOpened(fake, method, () => { throw { code: -32000, message: `${method} refused` }; });
    const popup = fake.openWindow(working, 'http://fake.test/pop');
    await waitFor(() => sessions.target(popup.targetId));
    const record = sessions.target(popup.targetId);
    const outcomes = await record.ready;
    assert.ok(outcomes.some((o) => o.method === method && !o.ok), method);
    if (method === 'Page.setPrerenderingAllowed') {
      await waitFor(() => ctx.log.lines.warn.some((l) => /prerendering stays allowed/.test(l)));
      assert.strictEqual(record.armed, true, 'the switch is not needed for the flag');
      assert.ok(!fake.callsTo('Target.closeTarget').length);
      assert.deepStrictEqual(session.takeNotes(), []);
    } else {
      await waitFor(() => !sessions.target(popup.targetId));
      assert.strictEqual(record.closing, true, 'closing is set from the close, so no Opened: line names it');
      assert.ok(record.committedWeb, 'its claim step ran first');
      assert.deepStrictEqual(session.takeNotes(), ['t3 was closed because it could not be put under the domain gate']);
      assert.strictEqual(fake.callsTo('Target.closeTarget').length, 1, 'closed once');
    }
    ctx.conn.close();
  }
});

test('a tab whose Page.enable rejects, or whose frame-tree read fails, gets the rule all the same', async (t) => {
  for (const failing of ['Page.enable', 'Page.getFrameTree']) {
    const ctx = await setup(t);
    const { fake, sessions, session, working } = ctx;
    for (const method of [failing, 'Fetch.enable']) {
      handleOpened(fake, method, () => { throw { code: -32000, message: `${method} refused` }; });
    }
    const popup = fake.openWindow(working, 'http://fake.test/pop');
    await waitFor(() => fake.callsTo('Target.closeTarget').some((c) => c.params.targetId === popup.targetId));
    assert.strictEqual(session.takeNotes().length, 1, failing);
    assert.ok(sessions.target(popup.targetId) === null || sessions.target(popup.targetId).closing);
    ctx.conn.close();
  }
});

test('a page-opened tab whose Fetch.enable times out is closed by the rule; one whose Network.enable or bypass times out is left open with its flag down and a warning, and switches at once', async (t) => {
  for (const method of ['Fetch.enable', 'Network.enable', 'Network.setBypassServiceWorker']) {
    const ctx = await setup(t, { log: recordingLog() });
    const { fake, sessions, session, working, conn } = ctx;
    // A command whose caller doesn't name a timeout gets 150 ms rather than the
    // connection's 10 s.
    const send = conn.send.bind(conn);
    conn.send = (method, params, opts = {}) => send(method, params, { timeout: 150, ...opts });
    handleOpened(fake, method, () => new Promise(() => {}));
    const popup = fake.openWindow(working, 'http://fake.test/pop');
    await waitFor(() => sessions.target(popup.targetId));
    const outcomes = await sessions.target(popup.targetId).ready;
    assert.ok(outcomes.some((o) => o.method === method && o.error && o.error.name === 'TimeoutError'));
    if (method === 'Fetch.enable') {
      await waitFor(() => !sessions.target(popup.targetId));
      assert.strictEqual(session.takeNotes().length, 1);
    } else {
      await waitFor(() => ctx.log.lines.warn.some((l) => l.includes(popup.targetId) && /left open/.test(l)));
      assert.strictEqual(sessions.target(popup.targetId).armed, false);
      assert.ok(!sessions.target(popup.targetId).closing);
      assert.deepStrictEqual(session.takeNotes(), []);
      const switched = await tabs(ctx.context, session, { op: 'switch', target: 't3' });
      assert.match(switched.head, /\nWorking tab: t3$/, method);
      assert.strictEqual(session.workingTargetId, popup.targetId);
    }
    ctx.conn.close();
  }
});

test('a page-opened tab closed by its opener while its arming is in flight is skipped by the rule, and so is one that claim let go', async (t) => {
  const ctx = await setup(t);
  const { fake, sessions, session, working } = ctx;
  const held = [];
  handleOpened(fake, 'Network.enable', () => new Promise((resolve, reject) => held.push(() => reject({ message: 'Network.enable refused late' }))));
  const closedByOpener = fake.openWindow(working, 'http://fake.test/one');
  const letGo = fake.openWindow(working, 'http://fake.test/two');
  await waitFor(() => held.length === 2 && sessions.target(letGo.targetId).committedWeb);
  fake.destroyTarget(closedByOpener.targetId);
  fake.navigateTarget(letGo, working.url);
  await waitFor(() => !sessions.target(closedByOpener.targetId) && sessions.target(letGo.targetId).sessionId === null);
  const ready = sessions.target(letGo.targetId).ready;
  for (const reject of held) reject();
  await ready;
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(!fake.callsTo('Target.closeTarget').length, 'neither is closed');
  assert.deepStrictEqual(session.takeNotes(), []);
  assert.strictEqual(sessions.target(letGo.targetId).armed, false, 'and the late outcome leaves the let-go tab\'s flag down');
});

test('a disarmed tab whose arming answers late keeps its flag down', async (t) => {
  const ctx = await setup(t);
  const { fake, sessions, working } = ctx;
  let answerLate;
  handleOpened(fake, 'Network.enable', () => new Promise((resolve) => { answerLate = () => resolve({}); }));
  const popup = fake.openWindow(working, 'http://fake.test/pop');
  await waitFor(() => answerLate && sessions.target(popup.targetId).committedWeb);
  fake.navigateTarget(popup, working.url);
  await waitFor(() => sessions.target(popup.targetId).sessionId === null);
  const ready = sessions.target(popup.targetId).ready;
  answerLate();
  const outcomes = await ready;
  assert.ok(outcomes.every((o) => o.ok), 'every command answered');
  assert.strictEqual(sessions.target(popup.targetId).armed, false);
});

test('ready resolves only once the arming commands have settled', async (t) => {
  const ctx = await setup(t);
  const { fake, sessions, working } = ctx;
  let answerLate;
  handleOpened(fake, 'Network.setBypassServiceWorker', () => new Promise((resolve) => { answerLate = () => resolve({}); }));
  const popup = fake.openWindow(working, 'http://fake.test/pop');
  await waitFor(() => answerLate && fake.targets.get(popup.targetId).enabled);
  let resolved = false;
  sessions.target(popup.targetId).ready.then(() => { resolved = true; });
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(resolved, false, 'Page.enable has answered, the bypass hasn\'t');
  answerLate();
  await waitFor(() => resolved);
});

test('an identity tab whose prerendering switch and Fetch.enable reject before its frame-tree read answers is still claimed, and left open and unarmed; a repaired working tab in that order is left for repair, which arms it', async (t) => {
  const ctx = fakeSession({ t, allow: ['fake.test'], log: recordingLog() });
  await enableTargets(ctx.conn);
  const { fake, sessions } = ctx;
  // A page-opened tab's prerendering switch always rejects, and its first Fetch.enable
  // does, while its frame tree answers late.
  const refusedFetch = new Set();
  for (const method of ['Page.setPrerenderingAllowed', 'Fetch.enable']) {
    const answer = fake.handlers.get(method);
    fake.handle(method, (p, sid, f) => {
      const t = fake.bySession(sid);
      if (t.openerId && (method === 'Page.setPrerenderingAllowed' || !refusedFetch.has(t.targetId))) {
        if (method === 'Fetch.enable') refusedFetch.add(t.targetId);
        throw { code: -32000, message: `${method} refused` };
      }
      return answer(p, sid, f);
    });
  }
  const tree = fake.handlers.get('Page.getFrameTree');
  fake.handle('Page.getFrameTree', (p, sid, f) => new Promise((r) => setTimeout(() => r(tree(p, sid, f)), 30)));
  // The session page's links open tabs that commit silently, as a paused tab may, so
  // only the frame-tree read, and the claim after it, can give them their roles.
  fake.openLink = (target, role) => {
    const opened = fake.createTarget({ url: '', windowId: target.windowId, openerId: target.targetId, lateUrl: target.url.replace(/role=\w+/, `role=${role}`), silentFirstCommit: true });
    opened.firstCommit.then(() => setImmediate(() => fake.emit('Page.loadEventFired', { timestamp: 1 }, opened.sessionId)));
    return opened;
  };
  const session = await sessions.ensure('s1');
  const identity = sessions.target(session.identityTargetId);
  assert.strictEqual(identity.role, 'identity', 'claimed');
  await identity.ready;
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual([identity.armed, identity.closing], [false, false], 'left open and unarmed');
  assert.ok(ctx.log.lines.warn.some((l) => /prerendering stays allowed/.test(l)));
  fake.destroyTarget(session.workingTargetId);
  await waitFor(() => session.workingTargetId === null);
  await sessions.ensure('s1');
  const repaired = sessions.target(session.workingTargetId);
  assert.strictEqual(repaired.armed, true, 'repair armed it again');
  assert.strictEqual(fake.callsTo('Fetch.enable').filter((c) => c.sessionId === repaired.cdpSessionId).length, 2);
  assert.ok(!fake.callsTo('Target.closeTarget').length);
});

test('a working tab whose Fetch.enable rejects fails the call with error, and the next call arms it; a rejected prerendering switch passes with a warning', async (t) => {
  const ctx = fakeSession({ t, allow: ['fake.test'], log: recordingLog() });
  await enableTargets(ctx.conn);
  const { fake, sessions } = ctx;
  let failing = true;
  const answer = fake.handlers.get('Fetch.enable');
  fake.handle('Fetch.enable', (p, sid, f) => {
    if (failing && !fake.bySession(sid).openerId) throw { code: -32000, message: 'Fetch refused' };
    return answer(p, sid, f);
  });
  fake.handle('Page.setPrerenderingAllowed', () => { throw { code: -32000, message: 'unknown method' }; });
  await assert.rejects(sessions.ensureWithNotes('s1'), (e) => {
    assert.deepStrictEqual(e.envelope, { outcome: 'error', message: 'the working tab could not be put under the domain gate; call again' });
    return true;
  });
  const session = sessions.peek('s1');
  assert.strictEqual(sessions.target(session.workingTargetId).armed, false);
  failing = false;
  await sessions.ensureWithNotes('s1');
  assert.strictEqual(sessions.target(session.workingTargetId).armed, true);
  assert.ok(ctx.log.lines.warn.some((l) => /prerendering stays allowed/.test(l)));
});

test('a page-opened tab is closed when its Fetch.enable rejects even after it committed a page', async (t) => {
  const ctx = await setup(t);
  const { fake, sessions, session, working } = ctx;
  handleOpened(fake, 'Fetch.enable', () => { throw { code: -32000, message: 'Fetch refused' }; });
  const close = fake.handlers.get('Target.closeTarget');
  let committed = null;
  fake.handle('Target.closeTarget', (p, sid, f) => {
    committed = sessions.target(p.targetId).committedWeb;
    return close(p, sid, f);
  });
  const popup = fake.openWindow(working, 'http://fake.test/pop');
  await waitFor(() => !sessions.target(popup.targetId) && committed !== null);
  assert.strictEqual(committed, true, 'its page had committed when the rule closed it');
  assert.deepStrictEqual(session.takeNotes(), ['t3 was closed because it could not be put under the domain gate']);
});

test('the rule does not close again, or note, a new tab that the gate refused while its close is in flight', async (t) => {
  const ctx = await setup(t);
  const { fake, sessions, session, working } = ctx;
  const close = fake.handlers.get('Target.closeTarget');
  fake.handle('Target.closeTarget', (p, sid, f) => new Promise((resolve) => setTimeout(() => resolve(close(p, sid, f)), 100)));
  handleOpened(fake, 'Network.enable', () => { throw { code: -32000, message: 'Network.enable refused' }; });
  const popup = fake.openWindow(working, 'http://evil.test/pop');
  await waitFor(() => !sessions.target(popup.targetId));
  assert.strictEqual(fake.callsTo('Target.closeTarget').length, 1);
  assert.deepStrictEqual(session.takeNotes(), []);
  assert.strictEqual(session.refusals[0].kind, 'new tab');
});

test('a session tab that arming never reached is not sent disarm commands when the session lets it go', async (t) => {
  const ctx = fakeSession({ t, allow: ['fake.test'] });
  await enableTargets(ctx.conn);
  const { fake, sessions } = ctx;
  // Both tabs are claimed by their session-page URLs, without an ensure to arm them.
  const page = (role) => `${SESSION_PAGE}#role=${role}&session=s1&started=2026-01-01T00%3A00%3A00.000Z`;
  const working = fake.createTarget({ url: page('working') });
  const identity = fake.createTarget({ url: page('identity'), windowId: working.windowId });
  const session = sessions.get('s1');
  await waitFor(() => session.workingTargetId === working.targetId && session.identityTargetId === identity.targetId);
  assert.strictEqual(sessions.target(identity.targetId).armingSent, false);
  fake.navigateTarget(identity, 'http://elsewhere.test/');
  fake.destroyTarget(working.targetId);
  await waitFor(() => session.workingTargetId === null);
  const before = fake.calls.length;
  await sessions.ensure('s1');
  assert.strictEqual(sessions.target(identity.targetId).sessionId, null, 'the recreated window disowned it');
  assert.deepStrictEqual(fake.calls.slice(before).filter((c) => c.sessionId === identity.sessionId).map((c) => c.method), []);
});

// Navigates the working tab to `fixture` at http://fake.test/ and reads it once, so a
// click on one of its buttons has a ref and a retained render to summarize against;
// resolves with the setup's context and the read's refs.
async function setupRead(t, fixture) {
  const ctx = await setup(t);
  ctx.fake.site['http://fake.test/'] = { title: 'Fake', text: 'Fake text.', scrollY: 0, pageHeight: 1000, viewportHeight: 600, ...fixture };
  ctx.fake.site['http://fake.test/next'] = { title: 'Next', text: 'Next text.', elements: [], scrollY: 0, pageHeight: 1000, viewportHeight: 600 };
  await navigation.navigate(ctx.context, ctx.session, { url: 'http://fake.test/', name: 'n' });
  const { payload } = await readPayload(ctx.sessions, ctx.session, { maxChars: 40000, offset: 0 });
  return { ...ctx, refs: refsIn(payload) };
}

test("a refusal on another session tab during a call stays out of the call's outcome and its wait, and so does one on the working tab during the call's change summary", async (t) => {
  let background = null;
  // The background tab's navigation is refused, and then the working tab's starts, so
  // the call's wait for the working tab's document spans the refusal.
  const poke = (fake, tab) => fake.navigateByPage(background, 'http://evil.test/from-background', () => fake.navigateByPage(tab, 'http://fake.test/next'));
  const ctx = await setupRead(t, {
    elements: [
      { kind: 'button', label: 'Poke', visible: true, onClick: poke },
      { kind: 'button', label: 'Quiet', visible: true },
    ],
  });
  const { fake, sessions, session, context, working, refs } = ctx;
  background = fake.openWindow(working, 'http://fake.test/background');
  await waitFor(() => sessions.target(background.targetId) && sessions.target(background.targetId).committedWeb);
  const poked = await input.click(context, session, { ref: refs.Poke });
  await waitFor(() => session.refusals.length === 1);
  assert.deepStrictEqual(poked.blocked, [], "the background tab's refusal isn't the call's");
  assert.strictEqual(poked.outcome, undefined);
  assert.strictEqual(poked.head, 'URL: http://fake.test/next\nTitle: Next\nNavigated: yes', "and the call's wait ran on to the working tab's new document");
  assert.deepStrictEqual(session.refusals.map((e) => [e.kind, e.targetId]), [['navigation', background.targetId]], 'it stays for a later response');
  refusals.takeRest(session);
  await navigation.navigate(context, session, { url: 'http://fake.test/', name: 'n' });
  const quietRef = refsIn((await readPayload(sessions, session, { maxChars: 40000, offset: 0 })).payload).Quiet;

  // The working tab's page leaves for a refused host while the summary renders, after
  // the call took its own refusals.
  const pull = fake.handlers.get('Accessibility.getFullAXTree');
  let during = false;
  fake.handle('Accessibility.getFullAXTree', (params, sid) => {
    if (during && sid === working.sessionId) { during = false; fake.navigateByPage(working, 'http://evil.test/during-summary'); }
    return pull(params, sid);
  });
  during = true;
  const quiet = await input.click(context, session, { ref: quietRef });
  await waitFor(() => session.refusals.length === 1);
  assert.deepStrictEqual(quiet.blocked, [], "a refusal during the summary's render is no longer the call's own");
  assert.deepStrictEqual(session.refusals.map((e) => [e.kind, e.targetId, e.url]), [['navigation', working.targetId, 'http://evil.test/during-summary']]);
});

test("a click whose link navigates the working tab while its handler opens a pop-under to a refused host waits for the new document, settles there, and returns needs_confirmation under that document's state lines", async (t) => {
  const ctx = await setupRead(t, {
    elements: [{
      kind: 'link', label: 'Go on', href: 'http://fake.test/next', visible: true,
      onClick: (fake, tab) => { fake.navigateByPage(tab, 'http://fake.test/next'); fake.openWindow(tab, 'http://evil.test/pop-under'); },
    }],
  });
  const { sessions, session, context, refs } = ctx;
  const result = await input.click(context, session, { ref: refs['Go on'] });
  assert.strictEqual(result.head, 'URL: http://fake.test/next\nTitle: Next\nNavigated: yes', 'the closed pop-under gets no Opened: line, and a new document no summary');
  assert.deepStrictEqual(result.blocked.map(({ kind, how, host }) => ({ kind, how, host })), [{ kind: 'new tab', how: 'stopped', host: 'evil.test' }]);
  const { envelope } = respond(sessions, session, result);
  assert.strictEqual(envelope.outcome, 'needs_confirmation');
  assert.match(envelope.message, /^The action ran, and a navigation it led to was stopped at the domain gate\./);
  assert.match(envelope.payload, /\nBlocked: \[t\d+\] evil\.test — a new tab to http:\/\/evil\.test\/pop-under, closed$/);
  assert.ok(!envelope.message.includes('evil.test'), 'the host stays in the payload');
});

test('a click whose navigation is refused and whose page then moves to an allowed host waits for that document, as a navigate after a refused hop does', async (t) => {
  // The allowed page answers after settling would have ended, had the refusal ended
  // the wait for it too.
  let late = false;
  const toNext = (fake, tab) => { late = true; fake.navigateByPage(tab, 'http://fake.test/next'); };
  const onward = (fake, tab) => (committed) => { if (committed === null) toNext(fake, tab); };
  const ctx = await setupRead(t, {
    elements: [{ kind: 'link', label: 'Detour', visible: true, onClick: (fake, tab) => fake.navigateByPage(tab, 'http://evil.test/hop', onward(fake, tab)) }],
  });
  const { fake, session, context, refs, working } = ctx;
  fake.handle('Fetch.continueRequest', ({ requestId }) => {
    if (!late) return fake.resume(requestId, true);
    late = false;
    setTimeout(() => fake.resume(requestId, true), 800);
    return {};
  });
  const clicked = await input.click(context, session, { ref: refs.Detour });
  assert.strictEqual(clicked.head, 'URL: http://fake.test/next\nTitle: Next\nNavigated: yes', 'the refusal ended the first wait, not the second');
  assert.deepStrictEqual(clicked.blocked.map(({ kind, how, url }) => `${kind} ${how} ${url}`), ['navigation stopped http://evil.test/hop']);

  await navigation.navigate(context, session, { url: 'http://fake.test/', name: 'n' });
  fake.site['http://fake.test/go'] = { redirect: 'http://evil.test/landing' };
  const failRequest = fake.handlers.get('Fetch.failRequest');
  fake.handle('Fetch.failRequest', (p, sid, f) => {
    const answer = failRequest(p, sid, f);
    setTimeout(() => toNext(fake, working), 5);
    return answer;
  });
  const navigated = await navigation.navigate(context, session, { url: 'http://fake.test/go', name: 'n' });
  assert.strictEqual(navigated.head, 'URL: http://fake.test/next\nTitle: Next\nNavigated: yes', 'the refusal ended the first wait, not the second');
  assert.deepStrictEqual(navigated.blocked.map(({ url }) => url), ['http://evil.test/landing']);
});

test("a click that sends the page to a thank-you page and then starts a download that the gate refuses waits for the thank-you page", async (t) => {
  // The page's host comes off the allowlist after the read. Chrome pauses a
  // same-origin download link's request as the main frame's document request without
  // a navigation, here after the thank-you page's navigation started.
  let download = null;
  const ctx = await setupRead(t, {
    elements: [{
      kind: 'button', label: 'Download', visible: true,
      onClick: (fake, tab) => { fake.navigateByPage(tab, 'http://thanks.test/'); download = raise(fake, tab, 'http://fake.test/file.bin'); },
    }],
  });
  const { fake, session, context, refs, policyFile } = ctx;
  fake.site['http://thanks.test/'] = { title: 'Thanks', text: 'Thanks text.', elements: [], scrollY: 0, pageHeight: 1000, viewportHeight: 600 };
  fs.writeFileSync(policyFile, 'thanks.test\n');
  // The thank-you page answers after settling would have ended, had the download's
  // refusal ended the wait for it.
  fake.handle('Fetch.continueRequest', ({ requestId }) => {
    setTimeout(() => fake.resume(requestId, true), 500);
    return {};
  });
  const clicked = await input.click(context, session, { ref: refs.Download });
  assert.strictEqual(await download, 'fail Aborted');
  assert.strictEqual(clicked.head, 'URL: http://thanks.test/\nTitle: Thanks\nNavigated: yes');
  assert.deepStrictEqual(clicked.blocked.map(({ url }) => url), ['http://fake.test/file.bin']);
});

test("a refusal recorded right behind the DOMContentLoaded that ended one wait, before the call reads it, still ends the next wait", async (t) => {
  const ctx = await setupRead(t, {
    elements: [{ kind: 'link', label: 'On', visible: true, onClick: (fake, tab) => fake.navigateByPage(tab, 'http://fake.test/next') }],
  });
  const { fake, session, context, refs } = ctx;
  // The next document's script leaves for a refused host as it loads: its events are
  // dispatched in one go with the DOMContentLoaded, ahead of the call's next step.
  const commit = fake.commitDocument.bind(fake);
  fake.commitDocument = (target, url, opts) => {
    commit(target, url, opts);
    if (url === 'http://fake.test/next') fake.navigateByPage(target, 'http://evil.test/onload');
  };
  const started = Date.now();
  const clicked = await input.click(context, session, { ref: refs.On }, Date.now() + 8_000);
  assert.strictEqual(clicked.head, 'URL: http://fake.test/next\nTitle: Next\nNavigated: yes');
  assert.deepStrictEqual(clicked.blocked.map(({ url }) => url), ['http://evil.test/onload']);
  assert.ok(Date.now() - started < 2_000, `the refusal ended the second wait at once (${Date.now() - started} ms)`);
});

test("a refusal recorded right behind the DOMContentLoaded that ended navigate's own wait, before the call reads it, still ends the call's next wait", async (t) => {
  const ctx = await setupRead(t, { elements: [] });
  const { fake, session, context } = ctx;
  // The next document's script leaves for a refused host as it loads, as in the test
  // above, after a navigate rather than a click.
  const commit = fake.commitDocument.bind(fake);
  fake.commitDocument = (target, url, opts) => {
    commit(target, url, opts);
    if (url === 'http://fake.test/next') fake.navigateByPage(target, 'http://evil.test/onload');
  };
  const started = Date.now();
  const navigated = await navigation.navigate(context, session, { url: 'http://fake.test/next', name: 'n' }, Date.now() + 8_000);
  assert.strictEqual(navigated.head, 'URL: http://fake.test/next\nTitle: Next\nNavigated: yes');
  assert.deepStrictEqual(navigated.blocked.map(({ url }) => url), ['http://evil.test/onload']);
  assert.ok(Date.now() - started < 2_000, `the refusal ended the next wait at once (${Date.now() - started} ms)`);
});

test('a tabs switch to a page-opened tab before its rule runs awaits its ready, and answers error when its arming rejected', async (t) => {
  const ctx = await setup(t);
  const { fake, sessions, session, working, context } = ctx;
  let refuse = null;
  handleOpened(fake, 'Fetch.enable', () => new Promise((resolve, reject) => { refuse = () => reject({ message: 'Fetch refused' }); }));
  const popup = fake.openWindow(working, 'http://fake.test/pop');
  await waitFor(() => refuse && sessions.target(popup.targetId) && sessions.target(popup.targetId).committedWeb);
  let answered = false;
  const switched = tabs(context, session, { op: 'switch', target: 't3' }).finally(() => { answered = true; });
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(answered, false, "the switch waits for the tab's arming");
  refuse();
  await assert.rejects(switched, (e) => {
    assert.deepStrictEqual(e.envelope, { outcome: 'error', message: 't3 could not be put under the domain gate and is closing' });
    return true;
  });
  assert.strictEqual(session.workingTargetId, working.targetId);
});

test("a tabs new whose tab's Fetch.enable rejected answers error without a Page.navigate, and the rule closes the tab once", async (t) => {
  const ctx = await setup(t);
  const { fake, sessions, session, context } = ctx;
  handleOpened(fake, 'Fetch.enable', () => { throw { code: -32000, message: 'Fetch refused' }; });
  const opened = [];
  const openWindow = fake.openWindow.bind(fake);
  fake.openWindow = (...args) => {
    const target = openWindow(...args);
    opened.push(target);
    return target;
  };
  await assert.rejects(tabs(context, session, { op: 'new', target: 'http://fake.test/new' }), (e) => {
    assert.deepStrictEqual(e.envelope, { outcome: 'error', message: 'the new tab could not be put under the domain gate; call again' });
    return true;
  });
  const [tab] = opened;
  await waitFor(() => !sessions.target(tab.targetId));
  assert.strictEqual(fake.callsTo('Target.closeTarget').filter((c) => c.params.targetId === tab.targetId).length, 1);
  assert.ok(!fake.calls.some((c) => c.method === 'Page.navigate' && c.sessionId === tab.sessionId));
  assert.deepStrictEqual(session.takeNotes(), ['t3 was closed because it could not be put under the domain gate']);
});
