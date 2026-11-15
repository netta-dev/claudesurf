const { test } = require('node:test');
const assert = require('node:assert');
const input = require('../server/input');
const requests = require('../server/requests');
const network = require('../server/network');
const { settle, settledLine } = require('../server/settle');
const { navigatedSession, readPayload, recordingLog, refsIn, sleep, waitFor } = require('./helpers');
const { FRAME_URL, oneFrame, attachFrame, silenceFrame } = require('./frame-setup');

const URL = 'http://a.test/';

function page(extra = {}) {
  return {
    title: 'A', text: 'Page text.', scrollY: 0, pageHeight: 1200, viewportHeight: 600,
    elements: [{ kind: 'button', label: 'Go', visible: true, disabled: false, checked: false }],
    ...extra,
  };
}

// Resolves with a session on a navigated working tab. A test makes the page busy after
// the navigation, which runs its own settle, so a busy page holds only the settle under
// test.
async function setup(t, options = {}) {
  const ctx = await navigatedSession({ t, ...options, url: URL, site: { [URL]: page() } });
  return { ...ctx, site: ctx.fake.site[URL], tab: ctx.fake.targets.get(ctx.target.targetId) };
}

// Resolves as setup does, with one out-of-process frame at backend id 90 attached as
// its own target.
async function setupFrame(t) {
  const ctx = await setup(t);
  Object.assign(ctx.site, oneFrame());
  ctx.fake.site[FRAME_URL] = page({ title: 'Child', text: 'Frame text.', elements: [{ kind: 'button', label: 'In frame', visible: true, disabled: false, checked: false }] });
  const frameTab = await attachFrame(ctx, ctx.tab, 90);
  return { ...ctx, frameTab, frameTarget: ctx.sessions.target(frameTab.targetId), frameSite: ctx.fake.site[FRAME_URL] };
}

// Returns a busy answer whose last mutation moves every 5 ms until `stop()`.
function mutating(t) {
  let at = Date.now();
  const timer = setInterval(() => { at = Date.now(); }, 5);
  const stop = () => clearInterval(timer);
  t.after(stop);
  return { busy: () => ({ lastMutationAt: at }), stop };
}

// Makes the settle probe of one same-process frame, by its frame id, throw a protocol
// error once `failing()` holds.
function failFrameProbe(fake, frameId, failing = () => true) {
  const original = fake.handlers.get('Runtime.callFunctionOn');
  fake.handle('Runtime.callFunctionOn', (params, sid) => {
    const tab = fake.bySession(sid);
    if (/claudesurfSettle/.test(params.functionDeclaration) && tab.contexts.get(params.executionContextId) === frameId && failing()) {
      throw { code: -32000, message: 'Frame with the given id was not found.' };
    }
    return original(params, sid);
  });
}

test('a quiet page settles once the quiet window has passed since the action ended', async (t) => {
  const { sessions, target } = await setup(t);
  const from = Date.now();
  const answer = await settle(sessions, target, { from, budget: 2000 });
  assert.deepStrictEqual(answer, { settled: true });
  assert.ok(Date.now() - from >= 20, 'the 20 ms window the tests set was waited out');
});

test('a counted request in flight holds settling until the quiet window after its end, and an image doesn\'t', async (t) => {
  const { fake, sessions, target, tab } = await setup(t, { quietMs: 200 });
  const image = fake.networkRequest(tab, { type: 'Image' });
  const xhr = fake.networkRequest(tab, { type: 'XHR' });
  await waitFor(() => requests.busy(target).count === 1);
  setTimeout(() => xhr.finish(), 150);
  const started = Date.now();
  assert.deepStrictEqual(await settle(sessions, target, { budget: 2000 }), { settled: true });
  const spent = Date.now() - started;
  assert.ok(spent >= 150 + 190, `the XHR held it until it ended, and its end for the window after (${spent} ms)`);
  image.finish();
});

test('a counted request stops counting once it has been in flight for 5 s, so a long poll holds settling that long at most', async (t) => {
  const { fake, target, tab } = await setup(t);
  fake.networkRequest(tab, { type: 'Fetch' });
  await waitFor(() => requests.busy(target).count === 1);
  const { lastEventAt } = requests.busy(target);
  assert.strictEqual(requests.busy(target, Date.now() + 4_900).count, 1);
  assert.deepStrictEqual(requests.busy(target, Date.now() + 5_100), { count: 0, lastEventAt }, 'past 5 s it no longer counts');
});

test('a counted request that the action started holds its settling past 5 s, while one in flight before the action stops counting then', async (t) => {
  const { fake, context, session, site, tab, target } = await setup(t);
  const { payload } = await readPayload(context.sessions, session, { maxChars: 40000, offset: 0 });
  site.elements[0].onClick = (f, clicked) => f.networkRequest(clicked, { type: 'Fetch' });
  fake.networkRequest(tab, { type: 'XHR' });
  await waitFor(() => requests.busy(target).count === 1);
  // Date.now() stands still until the tick, so the click can't settle before it.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const clicking = input.click(context, session, { ref: refsIn(payload).Go });
  while (requests.busy(target).count < 2) await sleep(10);
  t.mock.timers.tick(5_100);
  const r = await clicking;
  assert.strictEqual(r.outcome, 'unsettled');
  assert.match(r.head, /\nSettled: no — after 5\.1 s, 1 request in flight\n/, 'the earlier request no longer counts, and the click\'s own does');
  assert.strictEqual(requests.busy(target).count, 0, 'a read counts neither past 5 s');
});

test('a request in flight before the action stays one from before it through a redirect hop, and the hop restarts its 5 s', async (t) => {
  const { fake, target, tab } = await setup(t);
  const poll = fake.networkRequest(tab, { type: 'Fetch' });
  await waitFor(() => requests.busy(target).count === 1);
  const sentAt = requests.busy(target).lastEventAt;
  const own = requests.mark();
  await sleep(300);
  poll.redirect();
  await waitFor(() => requests.busy(target).lastEventAt > sentAt);
  const hopAt = requests.busy(target).lastEventAt;
  assert.strictEqual(requests.busy(target, hopAt + 4_800, own).count, 1, 'counted 4.8 s after the hop, 5.1 s after its first send');
  assert.strictEqual(requests.busy(target, hopAt + 5_100, own).count, 0, 'and past 5 s from the hop it stops counting, as a request from before the action does');
});

test("a request that the action started stays the action's own through a redirect hop, counting past 5 s", async (t) => {
  const { fake, target, tab } = await setup(t);
  const own = requests.mark();
  const call = fake.networkRequest(tab, { type: 'Fetch' });
  await waitFor(() => requests.busy(target).count === 1);
  const sentAt = requests.busy(target).lastEventAt;
  await sleep(30);
  call.redirect();
  await waitFor(() => requests.busy(target).lastEventAt > sentAt);
  assert.strictEqual(requests.busy(target, Date.now() + 60_000, own).count, 1);
});

test('a mutation holds settling for the quiet window after it, and the line names the document', async (t) => {
  const { sessions, target, site } = await setup(t);
  const changes = mutating(t);
  site.busy = changes.busy;
  const answer = await settle(sessions, target, { budget: 300 });
  assert.strictEqual(answer.settled, false);
  assert.strictEqual(answer.reason, 'the document is still changing');
  assert.match(settledLine(answer), /^Settled: no — after 0\.[3-4] s, the document is still changing$/);
  changes.stop();
  assert.deepStrictEqual(await settle(sessions, target, { budget: 1000 }), { settled: true }, 'once the mutations stop, the window passes');
});

test('readyState loading holds settling and interactive does not, since complete waits on what the network signal ignores', async (t) => {
  const { sessions, target, site } = await setup(t);
  site.busy = { readyState: 'loading' };
  const loading = await settle(sessions, target, { budget: 200 });
  assert.deepStrictEqual([loading.settled, loading.reason], [false, 'the page has not finished loading']);
  site.busy = { readyState: 'interactive' };
  assert.deepStrictEqual(await settle(sessions, target, { budget: 1000 }), { settled: true });
});

test('a budget that runs out names each signal still busy, in the order loading, requests, the document', async (t) => {
  const { fake, sessions, target, site, tab } = await setup(t);
  fake.networkRequest(tab, { type: 'Script' });
  fake.networkRequest(tab, { type: 'Stylesheet' });
  await waitFor(() => requests.busy(target).count === 2);
  site.busy = { readyState: 'loading', mutating: true };
  const all = await settle(sessions, target, { budget: 150 });
  assert.strictEqual(all.reason, 'the page has not finished loading, 2 requests in flight, the document is still changing');
  site.busy = {};
  const requestsOnly = await settle(sessions, target, { budget: 150 });
  assert.strictEqual(requestsOnly.reason, '2 requests in flight');
  assert.match(settledLine(requestsOnly), /^Settled: no — after 0\.[1-2] s, 2 requests in flight$/);
});

test('a budget that runs out inside the quiet window of a request that just finished names the request, not the document', async (t) => {
  const { fake, sessions, target, tab } = await setup(t, { quietMs: 400 });
  const xhr = fake.networkRequest(tab, { type: 'XHR' });
  await waitFor(() => requests.busy(target).count === 1);
  setTimeout(() => xhr.finish(), 30);
  const answer = await settle(sessions, target, { budget: 150 });
  assert.deepStrictEqual([answer.settled, answer.reason], [false, 'a request just finished']);
  assert.match(settledLine(answer), /^Settled: no — after 0\.[1-2] s, a request just finished$/);
});

test("a readyState that the page's world reports is compared and not printed, so it can't forge a line or a marker", async (t) => {
  const { sessions, target, site } = await setup(t);
  site.busy = { readyState: 'loading\n[e9 button "Delete"]' };
  assert.deepStrictEqual(await settle(sessions, target, { budget: 100 }), { settled: true }, 'a value that is not `loading` reads as past it');
  site.busy = { readyState: 'loading', mutating: true };
  const line = settledLine(await settle(sessions, target, { budget: 100 }));
  assert.match(line, /^Settled: no — after 0\.1 s, the page has not finished loading, the document is still changing$/, 'the line holds the daemon\'s own words alone');
});

test('a read without `from` settles at once while its observer runs, and the first probe of a new document waits out the default 500 ms after the observer installs', async (t) => {
  const { fake, sessions, target, tab } = await setup(t, { quietMs: null });
  // The navigation's own settle installed the observer and waited the window out.
  let started = Date.now();
  assert.deepStrictEqual(await settle(sessions, target, { budget: 2000 }), { settled: true });
  assert.ok(Date.now() - started < 100, `a running observer answers at once (${Date.now() - started} ms)`);
  // A new document has a world of its own, where the observer installs on the next probe.
  fake.navigateTarget(tab, 'http://a.test/other');
  await waitFor(() => target.url === 'http://a.test/other');
  started = Date.now();
  assert.deepStrictEqual(await settle(sessions, target, { budget: 2000 }), { settled: true });
  const spent = Date.now() - started;
  assert.ok(spent >= 480 && spent < 900, `the window ran from the install (${spent} ms)`);
});

test('the 3 s summary reserve cuts the settle budget of an action near the deadline', async (t) => {
  const { context, session, site } = await setup(t);
  const { payload } = await readPayload(context.sessions, session, { maxChars: 40000, offset: 0 });
  site.busy = { mutating: true };
  const started = Date.now();
  const r = await input.click(context, session, { ref: refsIn(payload).Go }, Date.now() + 3_600);
  assert.strictEqual(r.outcome, 'unsettled');
  assert.match(r.head, /\nSettled: no — after 0\.[5-6] s, the document is still changing\nChanged: /);
  assert.ok(Date.now() - started < 3_600, 'the summary ran inside the reserve');
});

test("an action into a frame waits on that frame's observer as well as the page's", async (t) => {
  const { fake, sessions, target, site, frameTarget, frameTab, frameSite } = await setupFrame(t);
  const frameProbes = () => fake.callsTo('Runtime.callFunctionOn').filter((c) => c.sessionId === frameTab.sessionId && /claudesurfSettle/.test(c.params.functionDeclaration)).length;
  const frame = { target: frameTarget, frameId: null, label: 'the frame holding f1e42' };
  const inFrame = mutating(t);
  frameSite.busy = inFrame.busy;
  setTimeout(inFrame.stop, 200);
  const probed = frameProbes();
  assert.deepStrictEqual(await settle(sessions, target, { budget: 1000 }), { settled: true });
  assert.strictEqual(frameProbes(), probed, "the page alone doesn't watch the frame");
  let started = Date.now();
  assert.deepStrictEqual(await settle(sessions, target, { budget: 2000, frame }), { settled: true });
  assert.ok(Date.now() - started >= 100, 'the frame held it until its mutations stopped');
  assert.ok(frameProbes() > probed);

  frameSite.busy = {};
  const onPage = mutating(t);
  site.busy = onPage.busy;
  setTimeout(onPage.stop, 200);
  started = Date.now();
  assert.deepStrictEqual(await settle(sessions, target, { budget: 2000, frame }), { settled: true });
  assert.ok(Date.now() - started >= 100, 'the page held it, quiet frame and all, until its mutations stopped');
});

test('a frame probe that fails while the frame is there counts as busy, named by the label that the action gave', async (t) => {
  const { sessions, target, frameTarget, frameSite } = await setupFrame(t);
  frameSite.busy = { throws: 'the frame is wedged' };
  for (const label of ['the frame holding f1e42', 'the frame e40', 'a frame']) {
    const answer = await settle(sessions, target, { budget: 150, frame: { target: frameTarget, frameId: null, label } });
    assert.deepStrictEqual([answer.settled, answer.reason], [false, `${label} did not answer`], label);
  }
});

test("a click on an f-ref whose frame doesn't answer names the frame by the click's ref", async (t) => {
  const { context, session, frameSite } = await setupFrame(t);
  const { payload } = await readPayload(context.sessions, session, { maxChars: 40000, offset: 0 });
  const ref = refsIn(payload)['In frame'];
  assert.match(ref, /^f1e\d+$/, `the frame's button is read under its prefix:\n${payload}`);
  frameSite.busy = { throws: 'the frame is wedged' };
  const r = await input.click(context, session, { ref }, Date.now() + 3_500);
  assert.strictEqual(r.outcome, 'unsettled');
  assert.match(r.head, new RegExp(`\\nSettled: no — after 0\\.\\d s, the frame holding ${ref} did not answer\\n`));
});

test('a frame probe that times out while its frame is there counts as busy and names the frame', async (t) => {
  const { fake, sessions, target, frameTarget, frameTab } = await setupFrame(t);
  silenceFrame(fake, frameTab);
  const started = Date.now();
  const answer = await settle(sessions, target, { budget: 300, frame: { target: frameTarget, frameId: null, label: 'the frame holding f1e42' } });
  assert.deepStrictEqual([answer.settled, answer.reason], [false, 'the frame holding f1e42 did not answer']);
  assert.ok(Date.now() - started < 800, `the probe ended with the budget (${Date.now() - started} ms)`);
});

test('a frame probe that fails while the frame check fails too counts the frame as there', async (t) => {
  const { fake, sessions, target } = await setup(t);
  failFrameProbe(fake, 'FRAME-SAME');
  fake.handle('Page.getFrameTree', () => { throw { code: -32000, message: 'the renderer is wedged' }; });
  const answer = await settle(sessions, target, { budget: 150, frame: { target, frameId: 'FRAME-SAME', label: 'the frame holding e42' } });
  assert.deepStrictEqual([answer.settled, answer.reason], [false, 'the frame holding e42 did not answer']);
});

test('a same-process frame whose id now names a frame target has moved out of process, and drops its signal', async (t) => {
  const { fake, sessions, target, frameTarget } = await setupFrame(t);
  failFrameProbe(fake, frameTarget.targetId);
  const frame = { target, frameId: frameTarget.targetId, label: 'the frame holding e42' };
  assert.deepStrictEqual(await settle(sessions, target, { budget: 300, frame }), { settled: true });
});

test('a frame target destroyed during settling drops its signal while the page settles', async (t) => {
  const { fake, sessions, target, frameTarget, frameTab, frameSite } = await setupFrame(t);
  frameSite.busy = { mutating: true };
  setTimeout(() => fake.destroyTarget(frameTab.targetId), 100);
  const started = Date.now();
  const answer = await settle(sessions, target, { budget: 2000, frame: { target: frameTarget, frameId: null, label: 'the frame holding f1e42' } });
  assert.deepStrictEqual(answer, { settled: true });
  assert.ok(Date.now() - started < 1000, 'the page settled once the frame went');
});

test('a same-process frame removed during settling drops its signal through its protocol error', async (t) => {
  const { fake, sessions, target, site } = await setup(t);
  const child = 'http://a.test/child';
  site.childFrames = [{ backendId: 100, id: 'FRAME-SAME', url: child }];
  fake.site[child] = page({ busy: { mutating: true } });
  let removed = false;
  failFrameProbe(fake, 'FRAME-SAME', () => removed);
  setTimeout(() => { site.childFrames = []; removed = true; }, 100);
  const started = Date.now();
  const answer = await settle(sessions, target, { budget: 2000, frame: { target, frameId: 'FRAME-SAME', label: 'the frame holding e42' } });
  assert.deepStrictEqual(answer, { settled: true });
  const spent = Date.now() - started;
  assert.ok(spent >= 100 && spent < 1000, `the frame held it until it went (${spent} ms)`);
});

test("a probe sent at the budget's end still gets the time to answer, so the line names what was busy", async (t) => {
  const { fake, sessions, target, site } = await setup(t);
  site.busy = { mutating: true };
  const original = fake.handlers.get('Runtime.callFunctionOn');
  // Every settle probe answers 30 ms late, with the page still changing as it answers.
  fake.handle('Runtime.callFunctionOn', (params, sid) => (
    /claudesurfSettle/.test(params.functionDeclaration) ? new Promise((resolve) => setTimeout(() => resolve(original(params, sid)), 30)) : original(params, sid)
  ));
  for (let i = 0; i < 5; i++) {
    const answer = await settle(sessions, target, { budget: 120 });
    assert.deepStrictEqual([answer.settled, answer.reason], [false, 'the document is still changing'], `run ${i}`);
  }
});

function spySink(t, { throwsAt = null } = {}) {
  const calls = [];
  for (const stage of ['started', 'response', 'ended']) {
    const original = network.sink[stage];
    t.after(() => { network.sink[stage] = original; });
    network.sink[stage] = (target, ...rest) => {
      calls.push([stage, target.targetId, stage === 'ended' ? rest[1] : undefined]);
      if (stage === throwsAt) throw new Error(`the sink threw at ${stage}`);
      return original(target, ...rest);
    };
  }
  return calls;
}

test("requests.js hands each request's stages to the sink as it ends, and settling's counts come out as they would without it", async (t) => {
  const { fake, sessions, target, tab } = await setup(t);
  const calls = spySink(t);
  const finished = fake.networkRequest(tab, { type: 'Fetch' });
  const failed = fake.networkRequest(tab, { type: 'XHR' });
  const hopped = fake.networkRequest(tab, { type: 'Script' });
  hopped.redirect();
  await waitFor(() => requests.busy(target).count === 3);
  finished.finish();
  failed.finish(true);
  await waitFor(() => requests.busy(target).count === 1);
  fake.navigateTarget(tab, 'http://a.test/next');
  await waitFor(() => requests.busy(target).count === 0);
  const ends = calls.filter(([stage]) => stage === 'ended').map(([, , how]) => how);
  assert.deepStrictEqual(ends, ['redirect', 'finished', 'failed', 'ended by a navigation']);
  assert.strictEqual(calls.filter(([stage]) => stage === 'started').length, 4, 'a redirect hop starts a record of its own');
  assert.strictEqual(calls.filter(([stage]) => stage === 'response').length, 1, 'only the finished request had a response');
  assert.deepStrictEqual(await settle(sessions, target, { budget: 1000 }), { settled: true });
});

test("a sink that throws at a commit and at a frame's attach leaves settling's counts, the backstop's refusal, and the frame's registration in place", async (t) => {
  const { fake, sessions, session, target, tab, log } = await setup(t, { allow: ['a.test'], log: recordingLog() });
  const calls = spySink(t, { throwsAt: 'ended' });
  fake.networkRequest(tab, { type: 'Script', url: 'http://a.test/old.js' });
  fake.networkRequest(tab, { type: 'Document', url: 'http://frame.test/', frameId: `T${fake.nextTarget}` });
  await waitFor(() => requests.busy(target).count === 2);
  fake.createTarget({ type: 'iframe', parent: tab, url: 'http://frame.test/' });
  await waitFor(() => sessions.frameTargets(target.targetId).length === 1);
  assert.strictEqual(requests.busy(target).count, 1, "the frame's document request ended at its attach");
  fake.emit('Page.frameNavigated', { frame: { id: tab.targetId, url: 'http://evil.test/', loaderId: 'restored' }, type: 'BackForwardCacheRestore' }, tab.sessionId);
  await waitFor(() => session.refusals.some((e) => e.kind === 'restore'));
  assert.strictEqual(requests.busy(target).count, 0, "the old document's request ended at the commit");
  assert.strictEqual(target.url, 'http://evil.test/', 'the commit was recorded');
  assert.deepStrictEqual(calls.filter(([stage]) => stage === 'ended').map(([, , how]) => how), ['continued in a cross-site frame', 'ended by a navigation']);
  assert.strictEqual(log.lines.warn.filter((l) => /network capture of T\d+ at ended: Error: the sink threw at ended/.test(l)).length, 2, 'each throw is logged at warn');
});

test("nothing reaches the sink for a tab whose arming didn't go out", async (t) => {
  const { fake, target, tab } = await setup(t);
  const calls = spySink(t);
  target.armingSent = false;
  const request = fake.networkRequest(tab, { type: 'Fetch' });
  await waitFor(() => requests.busy(target).count === 1);
  request.finish();
  await waitFor(() => requests.busy(target).count === 0);
  target.armingSent = true;
  assert.deepStrictEqual(calls, []);
});
