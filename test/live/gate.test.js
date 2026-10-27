// The domain gate against Chrome, headless, with 127.0.0.1 allowed and 127.0.0.2, which
// Chrome treats as another site, refused: every way that leave.html leaves for the
// other site, from its own document and from its cross-site frame; the result of a
// click that opened a refused tab; a back-forward cache restore, which arrives without
// a request, asked for by history and started by the page; and a service worker that
// would otherwise answer a navigation before the gate saw it.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const navigation = require('../../server/navigation');
const input = require('../../server/input');
const read = require('../../server/read');
const refusals = require('../../server/refusals');
const { respond } = require('../../server/respond');
const { liveBinary, liveBrowser, readPayload, refsIn, waitFor, sleep } = require('../helpers');
const { serve } = require('../fixtures/serve');

const skip = liveBinary() ? false : 'no Chrome binary found';
let live;
let site;
let session;

before(async () => {
  if (skip) return;
  site = await serve();
  live = await liveBrowser({ allow: ['127.0.0.1'] });
  session = await live.sessions.ensure('live-gate');
});

after(async () => {
  if (skip) return;
  await live.close();
  site.close();
});

function literal(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function allow(...hosts) {
  fs.writeFileSync(live.policyFile, hosts.map((host) => `${host}\n`).join(''));
}

function working() {
  return live.sessions.target(session.workingTargetId);
}

function navigate(url) {
  return navigation.navigate(live.context, session, { url, name: 'gate' }, Date.now() + 30_000);
}

async function evaluate(targetId, expression) {
  const { result, exceptionDetails } = await live.sessions.send(targetId, 'Runtime.evaluate', { expression, userGesture: true, awaitPromise: true, returnByValue: true });
  if (exceptionDetails) throw new Error(`${expression}: ${exceptionDetails.text}`);
  return result.value;
}

// Clicks an element of the document in `targetId` with a user gesture, as the agent's
// scripted click does.
function click(targetId, id) {
  return evaluate(targetId, `document.getElementById(${JSON.stringify(id)}).click()`);
}

// Resolves with the cross-site frame of leave.html, once its own document is ready to
// be clicked: parsed, since its image's response never ends and holds the load event
// back.
async function crossSiteFrame() {
  let frame;
  await waitFor(async () => {
    [frame] = live.sessions.frameTargets(session.workingTargetId);
    return frame && await evaluate(frame.targetId, `document.readyState !== 'loading' && Boolean(document.getElementById('blank'))`).catch(() => false);
  }, 10_000);
  return frame;
}

async function leavePage(to) {
  const url = `${site.base}/leave.html?to=${encodeURIComponent(to)}`;
  await navigate(url);
  assert.strictEqual(working().url, url);
  return url;
}

// Resolves with the one refusal that the step led to, once the gate has recorded it.
async function refusalOf(step) {
  refusals.takeRest(session);
  await step();
  await waitFor(() => session.refusals.length > 0, 8000);
  await sleep(100);
  const { entries } = refusals.takeRest(session);
  assert.strictEqual(entries.length, 1, JSON.stringify(entries));
  return entries[0];
}

const ways = [
  ['a link', (page) => click(page, 'link'), 'navigation'],
  ['a 302', (page) => click(page, 'redirect'), 'navigation'],
  ['a target=_blank link', (page) => click(page, 'blank'), 'new tab'],
  ['a target=_blank link with noopener', (page) => click(page, 'blank-noopener'), 'new tab'],
  ['a window.open', (page) => click(page, 'open'), 'new tab'],
  ['a window.open from a timer 3 s after the click', (page) => click(page, 'open-later'), 'new tab'],
];
const fromFrame = [
  ['a target=_blank link in the cross-site frame', (frame) => click(frame, 'blank'), 'new tab'],
  ['a window.open in the cross-site frame', (frame) => click(frame, 'open'), 'new tab'],
  ['the cross-site frame setting top.location', (frame) => click(frame, 'top'), 'navigation'],
];

test('every way that leave.html leaves for a refused host is stopped: the page stays, the refusal is recorded, and a new tab is closed', { skip, timeout: 120_000 }, async () => {
  const destination = `${site.crossBase}/other`;
  for (const [way, act, kind] of [...ways, ...fromFrame]) {
    const url = await leavePage(site.crossBase);
    const page = session.workingTargetId;
    const actor = fromFrame.some(([name]) => name === way) ? (await crossSiteFrame()).targetId : page;
    const entry = await refusalOf(() => act(actor));
    assert.deepStrictEqual([entry.kind, entry.how, entry.host, entry.url], [kind, 'stopped', '127.0.0.2', destination], way);
    if (kind === 'new tab') {
      assert.strictEqual(entry.opener, page, `${way}: the opener is the page, a frame counting through it`);
      assert.ok(entry.tab > session.tabIds.get(page), `${way}: the tab was numbered at its attach`);
      await waitFor(() => !live.sessions.target(entry.targetId), 5000);
    } else {
      assert.deepStrictEqual([entry.targetId, entry.tab], [page, session.tabIds.get(page)], way);
    }
    assert.strictEqual(working().url, url, `${way}: the page is unchanged`);
    assert.strictEqual(await evaluate(page, 'document.title'), 'Leave', way);
  }
});

test('the same ways toward the allowed host go through', { skip, timeout: 120_000 }, async () => {
  const destination = `${site.base}/other`;
  for (const [way, act, kind] of [...ways, ...fromFrame]) {
    await leavePage(site.base);
    const page = session.workingTargetId;
    const actor = fromFrame.some(([name]) => name === way) ? (await crossSiteFrame()).targetId : page;
    const opened = new Set(session.opened);
    await act(actor);
    if (kind === 'navigation') {
      await waitFor(() => working().url === destination, 8000);
    } else {
      await waitFor(() => [...session.opened].some((id) => !opened.has(id) && live.sessions.target(id).url === destination), 8000);
    }
    assert.deepStrictEqual(session.refusals, [], way);
  }
});

test("a back-forward cache restore onto a host taken off the list is refused by history's pre-check, and the page doesn't move", { skip, timeout: 60_000 }, async () => {
  allow('127.0.0.1', '127.0.0.2');
  refusals.takeRest(session);
  await navigate(`${site.crossBase}/other`);
  await navigate(`${site.base}/other`);
  allow('127.0.0.1');
  const t = working();
  const { generation } = t;
  const { currentIndex } = await live.sessions.send(t.targetId, 'Page.getNavigationHistory');
  const result = await navigation.history(live.context, session, { op: 'back' }, Date.now() + 30_000);
  assert.deepStrictEqual(result.blocked.map(({ kind, how, host, url }) => ({ kind, how, host, url })), [
    { kind: 'navigation', how: 'not started', host: '127.0.0.2', url: `${site.crossBase}/other` },
  ]);
  await sleep(500);
  assert.strictEqual(working(), t, 'the working tab stays');
  assert.deepStrictEqual([t.url, t.generation], [`${site.base}/other`, generation], 'on the document it was on');
  assert.strictEqual((await live.sessions.send(t.targetId, 'Page.getNavigationHistory')).currentIndex, currentIndex, 'at the same history entry');
  assert.deepStrictEqual(session.refusals, [], 'and the backstop had nothing to stop');
  assert.strictEqual(respond(live.sessions, session, result).envelope.outcome, 'needs_confirmation');
});

test('a back-forward cache restore onto a host taken off the list, started by the page after the call returned, is sent to about:blank by the backstop and reported on the next call', { skip, timeout: 60_000 }, async () => {
  allow('127.0.0.1', '127.0.0.2');
  refusals.takeRest(session);
  await navigate(`${site.crossBase}/other`);
  await navigate(`${site.base}/other`);
  allow('127.0.0.1');
  await evaluate(session.workingTargetId, 'setTimeout(() => history.back(), 300), true');
  await waitFor(() => session.refusals.length > 0, 8000);
  assert.deepStrictEqual(session.refusals.map(({ kind, how, url }) => ({ kind, how, url })), [
    { kind: 'restore', how: 'blanked', url: `${site.crossBase}/other` },
  ]);
  await waitFor(() => working().url === 'about:blank', 5000);
  const next = respond(live.sessions, session, await read.pageInfo(live.sessions, session, {}));
  assert.match(next.envelope.payload, new RegExp(`^Blocked by the page: \\[t${session.tabIds.get(session.workingTargetId)}\\] 127\\.0\\.0\\.2 — the tab reached ${literal(`${site.crossBase}/other`)} without a request the gate could see, so it went to about:blank$`, 'm'));
  assert.deepStrictEqual(session.refusals, []);
});

test('a service worker that answers a path in a tab that the gate doesn\'t arm is bypassed in the armed tabs, so a link to that path and a new tab opened to it are refused once the host is off the list', { skip, timeout: 60_000 }, async () => {
  allow('127.0.0.1');
  refusals.takeRest(session);
  const worker = `${site.base}/worker.html`;
  const { targetId: own } = await live.conn.send('Target.createTarget', { url: worker });
  await waitFor(() => live.sessions.target(own) && live.sessions.target(own).loads > 0, 10_000);
  assert.strictEqual(live.sessions.target(own).armingSent, false, 'a tab of the human\'s own is not armed');
  assert.strictEqual(await evaluate(own, 'window.registered'), true);
  await click(own, 'only');
  await waitFor(async () => await evaluate(own, 'document.title').catch(() => '') === 'From the worker', 10_000);

  await navigate(worker);
  assert.strictEqual(await evaluate(session.workingTargetId, 'window.registered'), true);
  allow('example.com');
  const followed = await refusalOf(() => click(session.workingTargetId, 'only'));
  assert.deepStrictEqual([followed.kind, followed.url], ['navigation', `${site.base}/sw-only`]);
  assert.strictEqual(working().url, worker);
  const opened = await refusalOf(() => click(session.workingTargetId, 'blank'));
  assert.deepStrictEqual([opened.kind, opened.url], ['new tab', `${site.base}/sw-only`], 'the bypass covers a new tab\'s first navigation');
  await live.conn.send('Target.closeTarget', { targetId: own });
});

test('a click that opened a refused tab returns needs_confirmation, its Blocked: line naming the closed tab', { skip, timeout: 60_000 }, async () => {
  allow('127.0.0.1');
  refusals.takeRest(session);
  await leavePage(site.crossBase);
  const { payload } = await readPayload(live.sessions, session, { maxChars: 40000, offset: 0 });
  const ref = refsIn(payload)['Open the other site in a new tab'];
  assert.ok(ref, payload);
  // The tab that the click opens takes the next number.
  const closedTab = session.nextTab;
  const result = await input.click(live.context, session, { ref }, Date.now() + 30_000);
  assert.deepStrictEqual(result.blocked.map(({ kind, how, host }) => ({ kind, how, host })), [{ kind: 'new tab', how: 'stopped', host: '127.0.0.2' }]);
  assert.ok(!/\nOpened: /.test(result.head), `the closed tab gets no Opened: line:\n${result.head}`);
  const { envelope } = respond(live.sessions, session, result);
  assert.strictEqual(envelope.outcome, 'needs_confirmation');
  assert.match(envelope.payload, new RegExp(`\nBlocked: \\[t${closedTab}\\] 127\\.0\\.0\\.2 — a new tab to ${literal(`${site.crossBase}/other`)}, closed$`, 'm'), envelope.payload);
  assert.strictEqual(working().url, `${site.base}/leave.html?to=${encodeURIComponent(site.crossBase)}`, 'the page the click ran on stays');
});
