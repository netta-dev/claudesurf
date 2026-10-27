// Settling against real Chrome (headless) over the fixture pages: a read and a click
// that wait out the requests and the changes that a page makes as it fills itself in, and
// the ones that run out of time, with the reasons they print. The quiet window is the
// default 500 ms.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const input = require('../../server/input');
const requests = require('../../server/requests');
const { liveBinary, liveBrowser, readPayload, refsIn, sleep, waitFor } = require('../helpers');
const { serve } = require('../fixtures/serve');

const skip = liveBinary() ? false : 'no Chrome binary found';

let live, site, sessions, context, session;
before(async () => {
  if (skip) return;
  live = await liveBrowser();
  site = await serve();
  ({ sessions, context } = live);
  session = await sessions.ensure('live-settle');
});
after(async () => {
  if (skip) return;
  site.close();
  await live.close();
});

// Navigates the working tab and resolves at the new document's DOMContentLoaded,
// without the settling that an acting call ends with, so the read that follows is the
// first wait on the document.
async function load(page) {
  const t = sessions.target(session.workingTargetId);
  const { generation } = t;
  await sessions.send(t.targetId, 'Page.navigate', { url: `${site.base}/${page}` });
  await waitFor(() => t.generation > generation && t.loadedGeneration === t.generation, 10000);
}

function readAll() {
  return readPayload(sessions, session, { maxChars: 40000, offset: 0 });
}

// Starts busy.html's fetch of /busy.json, whose response never ends, by a script click
// without the settling that an acting call ends with, and resolves once the request
// counts.
async function startBusyFetch() {
  const t = sessions.target(session.workingTargetId);
  const { count } = requests.busy(t);
  await sessions.callInWorld(t.targetId, 'function () { document.getElementById("fetch-busy").click(); }');
  await waitFor(() => requests.busy(t).count > count);
}

const statusText = () => sessions.callInWorld(session.workingTargetId, 'function () { return document.getElementById("status").textContent; }');

test('an image whose response never ends leaves a read settled, since images are not counted', { skip, timeout: 20000 }, async () => {
  await load('leave.html');
  const { head, payload, outcome } = await readAll();
  assert.strictEqual(outcome, undefined, `the read settled:\n${head}`);
  assert.ok(!/^Settled:/m.test(head), 'so its head carries no Settled: line');
  assert.match(payload, /^# Leave$/m, 'and the page rendered');
});

test('a page that keeps changing leaves a read and a click unsettled once their budgets run out', { skip, timeout: 30000 }, async () => {
  await load('busy.html');
  const read = await readAll();
  assert.strictEqual(read.outcome, 'unsettled');
  assert.match(read.head, /^Settled: no — after 2\.\d s, the document is still changing$/m, read.head);
  assert.match(read.payload, /Tick \d+/, 'and the read renders the page regardless');
  const clicked = await input.click(context, session, { ref: refsIn(read.payload)['Fetch busy'] });
  assert.strictEqual(clicked.outcome, 'unsettled');
  // The button also starts a request that never ends, which is the click's own.
  assert.match(clicked.head, /^Settled: no — after 5\.\d s, 1 request in flight, the document is still changing$/m, clicked.head);
});

test('a page that rewrites only attributes, as an animation that restyles every frame does, leaves a read settled', { skip, timeout: 20000 }, async () => {
  await load('busy.html?attributes=1');
  await sleep(300);
  const { head, outcome } = await readAll();
  assert.strictEqual(outcome, undefined, `the read settled:\n${head}`);
  assert.ok(!/^Settled:/m.test(head));
  const tick = await sessions.callInWorld(session.workingTargetId, 'function () { return Number(document.getElementById("tick").dataset.frame); }');
  assert.ok(tick > 2, `the page kept restyling as it was read (frame ${tick})`);
});

test('a request that a click started holds the click for its whole budget, since it is the action\'s own', { skip, timeout: 30000 }, async () => {
  await load('busy.html?quiet=1');
  const read = await readAll();
  assert.strictEqual(read.outcome, undefined, read.head);
  const clicked = await input.click(context, session, { ref: refsIn(read.payload)['Fetch busy'] });
  assert.strictEqual(clicked.outcome, 'unsettled');
  assert.match(clicked.head, /^Settled: no — after 5\.\d s, 1 request in flight$/m, clicked.head);
});

test('a request in flight holds a read until it is five seconds old, and stops counting then', { skip, timeout: 30000 }, async () => {
  await load('busy.html?quiet=1');
  const started = Date.now();
  await startBusyFetch();
  const early = await readAll();
  assert.strictEqual(early.outcome, 'unsettled');
  assert.match(early.head, /^Settled: no — after 2\.\d s, 1 request in flight$/m, early.head);
  await sleep(Math.max(0, started + requests.STALE_MS + 100 - Date.now()));
  const late = await readAll();
  assert.strictEqual(late.outcome, undefined, `the request still in flight no longer counts:\n${late.head}`);
  assert.ok(!/^Settled:/m.test(late.head));
});

test('a read and a click wait for the request that a page fills itself in from, and for the changes it makes in its shadow roots too', { skip, timeout: 30000 }, async () => {
  await load('skeleton.html');
  // The page asks for its content as it loads and gets it 1.5 s later, and the quiet
  // window adds 0.5 s. A read made half a second in still starts on the placeholders,
  // and its 2 s budget has room to spare.
  await sleep(500);
  assert.strictEqual(await statusText(), 'Loading…', 'the read starts while the placeholders show');
  const read = await readAll();
  assert.strictEqual(read.outcome, undefined, `the read settled:\n${read.head}`);
  assert.match(read.payload, /Loaded content: alpha/);
  assert.match(read.payload, /Shadow content: beta/, "and so did the content filled into the custom element's open shadow root");
  assert.ok(!read.payload.includes('Loading…') && !read.payload.includes('Card loading…'), `rather than the placeholders:\n${read.payload}`);
  const clicked = await input.click(context, session, { ref: refsIn(read.payload).Reload });
  assert.strictEqual(clicked.outcome, undefined, `the click settled:\n${clicked.head}`);
  assert.ok(!/^Settled:/m.test(clicked.head));
  assert.match(clicked.body, /^\+ Reloaded content: gamma$/m, `its change summary carries the reloaded content:\n${clicked.body}`);
  assert.match(clicked.body, /^\+ Shadow content: delta$/m);
  assert.ok(!clicked.body.includes('Loading…'), 'and none of the placeholders the page put back on the way');
});

test('a read waits for an open shadow root that keeps changing after the request has ended and the light DOM has gone quiet', { skip, timeout: 20000 }, async () => {
  await load('shadow-late.html');
  // The request ends 200 ms in and the shadow root changes 500, 800, and 1,100 ms in,
  // so the read settles about 1.6 s in, within its 2 s budget; a read that saw only
  // the light DOM would settle about 0.7 s in, on an earlier step.
  const read = await readAll();
  assert.strictEqual(read.outcome, undefined, `the read settled:\n${read.head}`);
  assert.match(read.payload, /Shadow content: final/, `the read waited for the shadow root's last step:\n${read.payload}`);
  assert.ok(!/Feed (loading…|step)/.test(read.payload), 'rather than an earlier one');
});

test("a request that the tab's previous document left in flight doesn't hold the next document's read", { skip, timeout: 20000 }, async () => {
  await load('busy.html?quiet=1');
  await startBusyFetch();
  await load('busy.html?quiet=1');
  const { head, outcome } = await readAll();
  assert.strictEqual(outcome, undefined, `the read settled:\n${head}`);
  assert.ok(!/^Settled:/m.test(head));
});
