// These tests check capture and fetch against headless Chrome with 127.0.0.1
// and 127.0.0.2 as separate sites.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const navigation = require('../../server/navigation');
const consoleCapture = require('../../server/console-capture');
const arming = require('../../server/arming');
const network = require('../../server/network');
const { fetch } = require('../../server/fetch');
const { liveBinary, liveBrowser, failure, waitFor } = require('../helpers');
const { serve } = require('../fixtures/serve');

const skip = liveBinary() ? false : 'no Chrome binary found';
let live;
let site;
let session;

before(async () => {
  if (skip) return;
  site = await serve();
  live = await liveBrowser();
  session = await live.sessions.ensure('live-capture');
});

after(async () => {
  if (skip) return;
  await live.close();
  site.close();
});

function open(path) {
  return navigation.navigate(live.context, session, { url: `${site.base}${path}`, name: 'capture' }, Date.now() + 30_000);
}

async function evaluate(expression) {
  const { result, exceptionDetails } = await live.sessions.send(session.workingTargetId, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (exceptionDetails) throw new Error(`${expression}: ${exceptionDetails.text}`);
  return result.value;
}

function fetched(url, deadline = Date.now() + 30_000) {
  return fetch(live.context, session, { url }, deadline);
}

test("console lists a page's calls and Chrome's 404, while the page's stack hook never runs", { skip }, async () => {
  await open('/throws');
  await waitFor(async () => (await consoleCapture.read(live.context, session, { after: 0 }, Date.now() + 30_000)).body.includes('404'), 5_000);
  const { body } = await consoleCapture.read(live.context, session, { after: 0 }, Date.now() + 30_000);
  assert.match(body, /^\[\d+\] log http:\/\/127\.0\.0\.1:\d+\/throws:\d+:\d+ hello \\\[object Object\\\]$/m);
  assert.match(body, /^\[\d+\] error http:\/\/127\.0\.0\.1:\d+\/throws:\d+:\d+ Error: save failed: 500$/m);
  assert.match(body, /^\[\d+\] error \(chrome network\) Failed to load resource: the server responded with a status of 404 \(Not Found\) http:\/\/127\.0\.0\.1:\d+\/missing\.png$/m);
  assert.strictEqual(await evaluate('window.hookCalls'), 0, 'Error.prepareStackTrace never ran');
  assert.ok(!/boom|rejected|Uncaught/.test(body), `the page's uncaught exception and rejection aren't listed, as the tool description says:\n${body}`);
});

test("arming a tab whose capture is already on records nothing again, since Chrome replays a domain's stored messages only when the domain turns on", { skip }, async () => {
  await open('/throws');
  await waitFor(async () => (await consoleCapture.read(live.context, session, { after: 0 }, Date.now() + 30_000)).body.includes('404'), 5_000);
  const before = (await consoleCapture.read(live.context, session, { after: 0 }, Date.now() + 30_000)).body;
  const t = live.sessions.target(session.workingTargetId);
  await arming.arm(live.sessions, t, { deadline: Date.now() + 10_000 });
  // arming.arm doesn't await Console.enable and Log.enable; Chrome answers this command
  // after both, and sends each enable's replay ahead of its answer.
  await live.sessions.send(t.targetId, 'Page.getFrameTree', {});
  assert.strictEqual((await consoleCapture.read(live.context, session, { after: 0 }, Date.now() + 30_000)).body, before);
});

test('network lists a fetch and prints its body under a filter, and records a form post without its body', { skip }, async () => {
  await open('/other');
  await evaluate("fetch('/data.json').then((r) => r.text())");
  await waitFor(async () => /data\.json \(/.test((await network.read(live.context, session, { filter: 'data.json', after: 0 }, Date.now() + 30_000)).body), 5_000);
  const { body } = await network.read(live.context, session, { filter: 'data.json', after: 0 }, Date.now() + 30_000);
  assert.match(body, /^\[\d+\] GET 200 fetch http:\/\/127\.0\.0\.1:\d+\/data\.json \(application\/json, \d+ B transferred, \d+ ms\)\n {4}\{\n {4}  "items": \[/);
  assert.match(body, /"name": "alpha"/);

  await open('/signin');
  const posted = live.sessions.waitUntil(session.workingTargetId, (t) => t.url.endsWith('/post'), { timeout: 10_000 });
  await evaluate("document.querySelector('[name=user]').value = 'alice'; document.querySelector('[name=pw]').value = 'hunter2'; document.querySelector('form').submit(); true");
  assert.ok(await posted);
  await waitFor(async () => /POST 200 document [^\n]*\/post \(/.test((await network.read(live.context, session, { after: 0 }, Date.now() + 30_000)).body), 5_000);
  const all = await network.read(live.context, session, { filter: '/post', after: 0 }, Date.now() + 30_000);
  assert.match(all.body, /^\[\d+\] POST 200 document http:\/\/127\.0\.0\.1:\d+\/post \(text\/html, /m);
  assert.match(all.body, /\n {4}<!doctype html><title>Posted<\/title>/, "the response's body prints");
  assert.ok(!all.body.includes('hunter2'), `the post body stays out of the list:\n${all.body}`);
});

test('fetch cuts a long text body at 40,000 characters and gives its size as a floor', { skip }, async () => {
  await open('/other');
  const { head, body } = await fetched(`${site.base}/long`);
  assert.match(head, /\nFetched: http:\/\/127\.0\.0\.1:\d+\/long\nStatus: 200 OK \(text\/plain; charset=utf-8, at least \d+ bytes\)\nBody: the first 40000 characters; the response is longer$/);
  assert.strictEqual(body.length, 40_000);
  const emoji = await fetched(`${site.base}/long-emoji`);
  assert.match(emoji.head, /\nFetched: http:\/\/127\.0\.0\.1:\d+\/long-emoji\nStatus: 200 OK \(text\/plain; charset=utf-8, at least \d+ bytes\)\nBody: the first 39999 characters; the response is longer$/);
  assert.strictEqual(emoji.body, 'x'.repeat(39_999), 'the cut steps back off the emoji rather than split it');
});

test('fetch prints a text body of exactly 40,000 characters whole, and counts a binary body of exactly 10 MiB', { skip }, async () => {
  await open('/other');
  const text = await fetched(`${site.base}/long?chars=40000`);
  assert.match(text.head, /\nStatus: 200 OK \(text\/plain; charset=utf-8, 40000 bytes\)$/);
  assert.strictEqual(text.body.length, 40_000);
  const binary = await fetched(`${site.base}/binary?mib=10&type=application/octet-stream`);
  assert.match(binary.head, /\nStatus: 200 OK \(application\/octet-stream, 10485760 bytes; binary, not shown\)$/);
});

test('fetch counts a typed and an untyped binary body, stops past 10 MiB, and counts a body that leaves the decoder partway, its valid prefix included', { skip }, async () => {
  await open('/other');
  const status = async (path) => (await fetched(`${site.base}${path}`)).head.split('\n').find((line) => line.startsWith('Status: '));
  assert.strictEqual(await status('/binary?mib=0.01&type=application/octet-stream'), 'Status: 200 OK (application/octet-stream, 10486 bytes; binary, not shown)');
  assert.strictEqual(await status('/binary?mib=0.01'), 'Status: 200 OK (no type, 10486 bytes; binary, not shown)');
  assert.strictEqual(await status('/binary?mib=11&type=application/octet-stream'), 'Status: 200 OK (application/octet-stream, over 10 MiB; binary, not shown)');
  assert.strictEqual(await status('/mixed'), `Status: 200 OK (no type, ${'valid text first, '.length * 100 + 4096} bytes; binary, not shown)`);
});

test('fetch counts a body of 40,000 characters that ends inside a character as cut, since the character it ends with is left out', { skip }, async () => {
  await open('/other');
  const { head, body } = await fetched(`${site.base}/long-partial`);
  assert.match(head, /\nStatus: 200 OK \(text\/plain; charset=utf-8, at least 40002 bytes\)\nBody: the first 40000 characters; the response is longer$/);
  assert.strictEqual(body, 'x'.repeat(40_000));
});

test('fetch answers a body that never ends once it passes the cap, or 10 MiB after it leaves the decoder, and closes the rest', { skip }, async () => {
  await open('/other');
  const started = Date.now();
  const text = await fetched(`${site.base}/endless-text`);
  assert.match(text.head, /\nStatus: 200 OK \(text\/plain; charset=utf-8, at least \d+ bytes\)\nBody: the first 40000 characters; the response is longer$/);
  const mixed = await fetched(`${site.base}/endless-mixed`);
  assert.match(mixed.head, /\nStatus: 200 OK \(no type, over 10 MiB; binary, not shown\)$/);
  assert.ok(Date.now() - started < 5_000, `both answered well before the 20 s timeout (${Date.now() - started} ms)`);
  await waitFor(() => site.served.aborted.includes('/endless-text') && site.served.aborted.includes('/endless-mixed'), 3_000);
});

test('fetch gives up at its timeout on a response whose headers come late and on one whose body never ends', { skip }, async () => {
  await open('/other');
  for (const path of ['/delay?ms=30000', '/busy.json']) {
    const started = Date.now();
    const failed = await failure(fetched(`${site.base}${path}`, Date.now() + 4_000));
    assert.strictEqual(failed.outcome, 'error', path);
    assert.match(failed.message, / timed out after (1\.\d|2) s$/, `${path}: what the 4 s less the margin left once the world resolved`);
    assert.ok(Date.now() - started < 3_500, `${path}: aborted at 2 s (${Date.now() - started} ms)`);
  }
});

test("fetch reads as text a body whose Content-Type carries parameters or capitals, and an untyped UTF-8 body", { skip }, async () => {
  await open('/other');
  assert.deepStrictEqual((await fetched(`${site.base}/typed-text`)).body, 'typed text with a charset');
  const capitals = await fetched(`${site.base}/typed-text?type=${encodeURIComponent('Text/Plain')}`);
  assert.strictEqual(capitals.body, 'typed text with a charset', 'the type is judged in any case');
  assert.match(capitals.head, /\nStatus: 200 OK \(Text\/Plain, 25 bytes\)$/);
  const untyped = await fetched(`${site.base}/untyped`);
  assert.strictEqual(untyped.body, 'héllo, untyped wörld');
  assert.match(untyped.head, /\nStatus: 200 OK \(no type, 22 bytes\)$/);
});

test('fetch decodes a text body by the charset that its Content-Type names', { skip }, async () => {
  await open('/other');
  const latin = await fetched(`${site.base}/latin1`);
  assert.strictEqual(latin.body, 'café');
  assert.match(latin.head, /\nStatus: 200 OK \(text\/plain; charset=iso-8859-1, 4 bytes\)$/);
});

test("fetch sends the page's cookies to its own origin, SameSite=Strict included", { skip }, async () => {
  await open('/cookie');
  const { body } = await fetched(`${site.base}/echo`);
  const { cookie } = JSON.parse(body);
  assert.match(cookie, /strict=s1/);
  assert.match(cookie, /sid=abc123/);
});

test("fetch of another site fails without CORS, and with CORS that leaves out credentials, naming the way to read it there, and succeeds when its server allows the page's origin with them", { skip }, async () => {
  await open('/other');
  const refused = await failure(fetched(`${site.crossBase}/echo`));
  assert.strictEqual(refused.outcome, 'error');
  assert.match(refused.message, /\(CORS\).*navigate to its origin and fetch there$/);
  const uncredentialed = await failure(fetched(`${site.crossBase}/cors-uncredentialed`));
  assert.match(uncredentialed.message, /\(CORS\)/, 'a request that carries the cookies needs Access-Control-Allow-Credentials');
  const allowed = await fetched(`${site.crossBase}/cors-echo`);
  assert.strictEqual(JSON.parse(allowed.body).origin, site.base, "the request carries the page's origin");
});

test('fetch sends http:host/path to the host that the gate read, whatever <base href> the page set', { skip }, async () => {
  await open('/other');
  await evaluate(`document.head.insertAdjacentHTML('afterbegin', '<base href="${site.crossBase}/sub/">'); true`);
  const { body } = await fetched(`http:${site.base.slice('http://'.length)}/echo`);
  assert.strictEqual(JSON.parse(body).origin, null, 'a same-origin GET');
  assert.ok(!site.served.cross.some((p) => p.startsWith('/sub/')), `the base's host got no request: ${site.served.cross}`);
});

test('fetch goes past the HTTP cache, so a response that the cache may keep reads fresh each time', { skip }, async () => {
  await open('/other');
  const first = (await fetched(`${site.base}/counted`)).body;
  const second = (await fetched(`${site.base}/counted`)).body;
  assert.match(first, /^request \d+$/);
  assert.notStrictEqual(second, first);
});

test("fetch is under the page's content security policy: a connect-src of 'self' refuses another site even when its server allows the page", { skip }, async () => {
  await open('/other');
  assert.match((await fetched(`${site.crossBase}/cors-echo`)).head, /\nStatus: 200 OK /, 'the same fetch from a page without the policy succeeds');
  await open('/csp');
  const refused = await failure(fetched(`${site.crossBase}/cors-echo`));
  assert.strictEqual(refused.outcome, 'error');
  assert.match(refused.message, /the page's content security policy refused it/);
  assert.match((await fetched(`${site.base}/echo`)).head, /\nStatus: 200 OK /, 'its own origin is still allowed');
});

test("fetch doesn't follow a redirect to another site, whose server never hears from it", { skip }, async () => {
  await open('/other');
  const result = await fetched(`${site.base}/redir?to=${encodeURIComponent(`${site.crossBase}/never-reached`)}`);
  assert.match(result.head, /\nRedirected: not followed; navigate to the URL to follow it through the domain gate$/);
  assert.ok(!site.served.cross.includes('/never-reached'), 'the redirect target got no request');
});
