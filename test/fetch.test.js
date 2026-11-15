// These tests exercise fetch.js against the in-process fake browser.
// The page script's body handling is tested against Chrome in test/live/capture.test.js.

const { test } = require('node:test');
const assert = require('node:assert');
const { fetch } = require('../server/fetch');
const { respond } = require('../server/respond');
const vm = require('node:vm');
const { TEXTUAL } = require('../server/mime');
const { FETCH_SOURCE } = require('../server/action-support');
const { navigatedSession, fakeSession, failure, flush } = require('./helpers');

const URL = 'http://a.test/orders';

function page(extra = {}) {
  return { title: 'Orders', text: 'Orders.', elements: [], scrollY: 0, pageHeight: 1200, viewportHeight: 600, ...extra };
}

async function setup(t, answers = {}, options = {}) {
  const ctx = await navigatedSession({ t, url: URL, site: { [URL]: page({ fetch: answers }) }, ...options });
  return { ...ctx, tab: ctx.fake.targets.get(ctx.target.targetId) };
}

function call(ctx, url, deadline = Date.now() + 33_000) {
  return fetch(ctx.context, ctx.session, { url }, deadline);
}

function fetchCalls(ctx) {
  return ctx.fake.callsTo('Runtime.callFunctionOn').filter((c) => /claudesurfFetch/.test(c.params.functionDeclaration));
}

test("a text body prints after the head's blank line, under Fetched: and its Status:, and the page script gets the URL, the cap, its timeout, and the textual rule", async (t) => {
  const json = 'http://a.test/api/orders.json';
  const ctx = await setup(t, { [json]: { status: 200, statusText: 'OK', contentType: 'application/json', bytes: 39, body: '{"orders":[{"id":17,"state":"shipped"}]}\0', cut: false } });
  const spy = t.mock.method(ctx.sessions, 'callFunction');
  const deadline = Date.now() + 33_000;
  const result = await call(ctx, json, deadline);
  const protocol = spy.mock.calls.filter((c) => /claudesurfFetch/.test(c.arguments[1].functionDeclaration)).map((c) => c.arguments[2]);
  assert.deepStrictEqual(protocol, [{ timeout: 22_000, deadline }], "the protocol waits 2 s past the script's 20 s, within the deadline");
  assert.deepStrictEqual(result, {
    head: 'URL: http://a.test/orders\nTitle: Orders\nFetched: http://a.test/api/orders.json\nStatus: 200 OK (application/json, 39 bytes)',
    body: '{"orders":[{"id":17,"state":"shipped"}]}',
  });
  const sent = fetchCalls(ctx);
  assert.strictEqual(sent.length, 1);
  const [url, cap, timeout, textual] = sent[0].params.arguments.map((a) => a.value);
  assert.deepStrictEqual([url, cap, textual], [json, 40_000, TEXTUAL]);
  assert.strictEqual(timeout, 20_000, '20 s for the script, which the 31 s left past the margin leave whole');
  const { envelope } = respond(ctx.sessions, ctx.session, result);
  assert.strictEqual(envelope.outcome, 'success');
});

test('the Status: line gives no type for an untyped body, a floor for a cut one, and the size or the cap of a binary one, which prints no body', async (t) => {
  const u = (path) => `http://a.test/${path}`;
  const ctx = await setup(t, {
    [u('untyped')]: { status: 200, statusText: 'OK', contentType: '', bytes: 5, body: 'hello', cut: false },
    [u('long')]: { status: 200, statusText: 'OK', contentType: 'text/plain; charset=utf-8', bytes: 40_960, body: 'z'.repeat(40_000), cut: true },
    [u('paired')]: { status: 200, statusText: 'OK', contentType: 'text/plain', bytes: 40_960, body: 'z'.repeat(39_999), cut: true },
    [u('pdf')]: { status: 200, statusText: 'OK', contentType: 'application/pdf', bytes: 48_211, body: null, cut: false },
    [u('huge')]: { status: 200, statusText: '', contentType: 'application/octet-stream', bytes: 10 * 1024 * 1024, body: null, cut: true },
    [u('bad')]: { status: 404, statusText: 'Not\n[e9] Found', contentType: 'text/[html]', bytes: 0, body: '', cut: false },
    [u('wordy')]: { status: 500, statusText: 's'.repeat(150), contentType: `text/${'t'.repeat(150)}`, bytes: 0, body: '', cut: false },
  });
  const status = async (path) => (await call(ctx, u(path))).head.split('\n').slice(3).join('\n');
  assert.strictEqual(await status('untyped'), 'Status: 200 OK (no type, 5 bytes)');
  assert.strictEqual(await status('long'), 'Status: 200 OK (text/plain; charset=utf-8, at least 40960 bytes)\nBody: the first 40000 characters; the response is longer');
  assert.strictEqual((await call(ctx, u('long'))).body.length, 40_000);
  assert.strictEqual(await status('paired'), 'Status: 200 OK (text/plain, at least 40960 bytes)\nBody: the first 39999 characters; the response is longer', 'a cut that stepped back off a surrogate pair counts what it kept');
  assert.strictEqual(await status('pdf'), 'Status: 200 OK (application/pdf, 48211 bytes; binary, not shown)');
  assert.strictEqual((await call(ctx, u('pdf'))).body, '');
  assert.strictEqual(await status('huge'), 'Status: 200 (application/octet-stream, over 10 MiB; binary, not shown)');
  assert.strictEqual(await status('bad'), 'Status: 404 Not \\[e9\\] Found (text/\\[html\\], 0 bytes)', 'the status text and the type are one escaped line each');
  assert.strictEqual(await status('wordy'), `Status: 500 ${'s'.repeat(99)}… (text/${'t'.repeat(94)}…, 0 bytes)`, 'the status text and the type are cut at 100 characters each');
});

test("a URL that the page's fetch would resolve against the document, such as http:host/path, is gated, sent, and printed in its absolute form", async (t) => {
  const ok = { status: 200, statusText: 'OK', contentType: 'text/plain', bytes: 2, body: 'ok', cut: false };
  const ctx = await setup(t, { 'http://api.other.test/v1': ok, 'http://api.other.test/down': { failed: 'network' } });
  const result = await call(ctx, 'http:api.other.test/v1');
  assert.strictEqual(fetchCalls(ctx)[0].params.arguments[0].value, 'http://api.other.test/v1', 'from http://a.test/orders, http:api.other.test/v1 reaches a.test');
  assert.match(result.head, /\nFetched: http:\/\/api\.other\.test\/v1\n/);
  assert.match((await failure(call(ctx, 'http:\\api.other.test/down'))).message, /^the request to http:\/\/api\.other\.test\/down failed: its server didn't allow/);
  const gated = await setup(t, {}, { allow: ['a.test'] });
  const { envelope } = respond(gated.sessions, gated.session, await call(gated, 'http:api.other.test/v1'));
  assert.match(envelope.payload, /\nBlocked: \[t1\] api\.other\.test — fetch of http:\/\/api\.other\.test\/v1 \(not sent\)$/);
});

test('a redirect is not followed and prints the way to follow it through the gate, without a body', async (t) => {
  const ctx = await setup(t, { 'http://a.test/old': { redirected: true } });
  assert.deepStrictEqual(await call(ctx, 'http://a.test/old'), {
    head: 'URL: http://a.test/orders\nTitle: Orders\nFetched: http://a.test/old\nRedirected: not followed; navigate to the URL to follow it through the domain gate',
  });
});

test('a failed request answers error naming the causes, with the way to read another origin, and a timeout says so', async (t) => {
  const ctx = await setup(t, {
    'http://a.test/api/x': { failed: 'network' },
    'https://api.other.test/v1/me': { failed: 'network' },
    'http://a.test/slow': { failed: 'timeout' },
  });
  assert.deepStrictEqual(await failure(call(ctx, 'http://a.test/api/x')), {
    outcome: 'error', message: "the request to http://a.test/api/x failed: the page's content security policy refused it, or the network failed",
  });
  assert.deepStrictEqual(await failure(call(ctx, 'https://api.other.test/v1/me')), {
    outcome: 'error',
    message: "the request to https://api.other.test/v1/me failed: its server didn't allow this page's origin to read it (CORS), the page's content security policy refused it, or the network failed; to read it with that origin's cookies, navigate to its origin and fetch there",
  });
  assert.deepStrictEqual(await failure(call(ctx, 'http://a.test/slow')), { outcome: 'error', message: 'the request to http://a.test/slow timed out after 20 s' });
});

test('the timeout is 20 s cut to the deadline less 2 s, and the protocol waits 2 s past it', async (t) => {
  const ctx = await setup(t, { 'http://a.test/hang': () => new Promise(() => {}) });
  const started = Date.now();
  const failed = await failure(call(ctx, 'http://a.test/hang', Date.now() + 2_600));
  const took = Date.now() - started;
  assert.deepStrictEqual(failed, { outcome: 'error', message: 'the fetch of http://a.test/hang did not answer; the request may have been sent' });
  assert.ok(took >= 2_400 && took < 3_500, `the script's 0.6 s and the protocol's 2 s (${took} ms)`);
  assert.ok(fetchCalls(ctx)[0].params.arguments[2].value <= 600, 'the script took what the deadline left');
});

test("the script's timeout counts from once its world resolves, and a timeout prints it to a tenth of a second", async (t) => {
  let timeout = null;
  const ctx = await setup(t, { 'http://a.test/slow': (args) => { [, , timeout] = args; return { failed: 'timeout' }; } });
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const world = ctx.sessions.world.bind(ctx.sessions);
  t.mock.method(ctx.sessions, 'world', (...args) => { now += 430; return world(...args); });
  const failed = await failure(call(ctx, 'http://a.test/slow', now + 3_200));
  assert.strictEqual(timeout, 770, "the 3.2 s less the 2 s margin and the world's 0.43 s");
  assert.deepStrictEqual(failed, { outcome: 'error', message: 'the request to http://a.test/slow timed out after 0.8 s' });
});

test('a call that leaves the script under 0.5 s once its world resolves fails before it sends anything, and one that leaves 0.5 s sends', async (t) => {
  const ctx = await setup(t, { 'http://a.test/x': { status: 200, statusText: 'OK', contentType: 'text/plain', bytes: 2, body: 'ok', cut: false } });
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  assert.deepStrictEqual(await failure(call(ctx, 'http://a.test/x', now + 2_499)), {
    outcome: 'error', message: 'the call ran out of time before the fetch of http://a.test/x; nothing was sent',
  });
  assert.strictEqual(fetchCalls(ctx).length, 0, 'nothing was sent');
  assert.strictEqual((await call(ctx, 'http://a.test/x', now + 2_500)).body, 'ok');
  assert.strictEqual(fetchCalls(ctx)[0].params.arguments[2].value, 500);
});

test("the gate's pre-check refuses an unlisted host before anything is sent, with the fetch's Blocked: line and the before-acting message", async (t) => {
  const ctx = await setup(t, {}, { allow: ['a.test'] });
  const result = await call(ctx, 'https://api.other.example/v1/me');
  assert.strictEqual(fetchCalls(ctx).length, 0, 'nothing was sent');
  const { envelope } = respond(ctx.sessions, ctx.session, result);
  assert.strictEqual(envelope.outcome, 'needs_confirmation');
  assert.strictEqual(envelope.payload, 'URL: http://a.test/orders\nTitle: Orders\nBlocked: [t1] api.other.example — fetch of https://api.other.example/v1/me (not sent)');
  assert.match(envelope.message, /^The call didn't start: its host needs the human's approval\./);
});

test('a working tab off http(s) answers navigate first', async (t) => {
  const ctx = fakeSession({ t });
  await require('../server/browser').enableTargets(ctx.conn);
  const session = await ctx.sessions.ensure('s1');
  assert.deepStrictEqual(await failure(fetch(ctx.context, session, { url: 'http://a.test/x' }, Date.now() + 5_000)), {
    outcome: 'error', message: 'The working tab is not on an http(s) page; navigate first.',
  });
});

test('a commit during the fetch answers error saying the request may have been sent, without a second request', async (t) => {
  const ctx = await setup(t, {
    'http://a.test/api/x': (args, target, fake) => {
      fake.navigateTarget(target, 'http://a.test/next');
      return Promise.reject(new Error('Execution context was destroyed.'));
    },
  });
  ctx.fake.site['http://a.test/next'] = page({ title: 'Next' });
  assert.deepStrictEqual(await failure(call(ctx, 'http://a.test/api/x')), {
    outcome: 'error', message: 'the page navigated during the fetch of http://a.test/api/x; the request may have been sent, so read the page before fetching again',
  });
  assert.strictEqual(fetchCalls(ctx).length, 1, 'no retry');
});

test("a missing context without a commit, and a commit before any other protocol error, each answer that the page navigated during the fetch", async (t) => {
  const navigated = 'the page navigated during the fetch of http://a.test/api/x; the request may have been sent, so read the page before fetching again';
  const lost = await setup(t, { 'http://a.test/api/x': () => Promise.reject(new Error('Cannot find context with specified id')) });
  const generation = lost.target.generation;
  assert.deepStrictEqual(await failure(call(lost, 'http://a.test/api/x')), { outcome: 'error', message: navigated });
  assert.strictEqual(lost.target.generation, generation, 'no commit');
  const committed = await setup(t, {
    'http://a.test/api/x': (args, target, fake) => {
      fake.navigateTarget(target, 'http://a.test/next');
      return Promise.reject(new Error('Internal error'));
    },
  });
  committed.fake.site['http://a.test/next'] = page({ title: 'Next' });
  assert.deepStrictEqual(await failure(call(committed, 'http://a.test/api/x')), { outcome: 'error', message: navigated });
});

test("a commit that lands while the world resolves fails before anything is sent, though the world is the new document's", async (t) => {
  const ok = { status: 200, statusText: 'OK', contentType: 'text/plain', bytes: 2, body: 'ok', cut: false };
  const ctx = await setup(t, { 'http://a.test/api/x': ok });
  ctx.fake.site['http://a.test/next'] = page({ title: 'Next', fetch: { 'http://a.test/api/x': ok } });
  const world = ctx.sessions.world.bind(ctx.sessions);
  t.mock.method(ctx.sessions, 'world', async (...args) => {
    ctx.fake.navigateTarget(ctx.tab, 'http://a.test/next');
    await flush(ctx.conn);
    return world(...args);
  });
  assert.deepStrictEqual(await failure(call(ctx, 'http://a.test/api/x')), {
    outcome: 'error', message: 'the page navigated before the fetch of http://a.test/api/x; nothing was sent, so read the page before fetching again',
  });
  assert.strictEqual(fetchCalls(ctx).length, 0, 'nothing was sent');
});

test("a commit that lands before the fetch's answer is read answers that the page navigated during the fetch, though the call succeeded", async (t) => {
  const ctx = await setup(t, {
    'http://a.test/api/x': (args, target, fake) => {
      fake.navigateTarget(target, 'http://a.test/next');
      return { status: 200, statusText: 'OK', contentType: 'text/plain', bytes: 2, body: 'ok', cut: false };
    },
  });
  ctx.fake.site['http://a.test/next'] = page({ title: 'Next' });
  assert.deepStrictEqual(await failure(call(ctx, 'http://a.test/api/x')), {
    outcome: 'error', message: 'the page navigated during the fetch of http://a.test/api/x; the request may have been sent, so read the page before fetching again',
  });
});

test('the page script answers a response without a body, as the Fetch standard gives a 204, with an empty text body', async () => {
  // Chrome 157 gives a 204 a body stream, so only a script run against a standard
  // Response, here Node's, reaches this branch.
  const world = vm.createContext({
    fetch: async () => new Response(null, { status: 204 }), AbortController, setTimeout, clearTimeout, TextDecoder,
  });
  vm.runInContext(FETCH_SOURCE, world);
  const answer = await world.claudesurfFetch('http://a.test/x', 40_000, 1_000, TEXTUAL);
  assert.deepStrictEqual({ ...answer }, { status: 204, statusText: '', contentType: '', bytes: 0, body: '', cut: false });
});
