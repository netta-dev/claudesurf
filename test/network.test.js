const { test } = require('node:test');
const assert = require('node:assert');
const network = require('../server/network');
const requests = require('../server/requests');
const arming = require('../server/arming');
const { issued } = require('../server/ring');
const { TEXTUAL } = require('../server/mime');
const { navigatedSession, recordingLog, flush, waitFor } = require('./helpers');

const URL = 'http://a.test/';

function page(extra = {}) {
  return { title: 'A', text: 'Page text.', elements: [], scrollY: 0, pageHeight: 1200, viewportHeight: 600, ...extra };
}

async function setup(t, site = {}, options = {}) {
  const ctx = await navigatedSession({ t, url: URL, site: { [URL]: page(), ...site }, ...options });
  return { ...ctx, tab: ctx.fake.targets.get(ctx.target.targetId) };
}

function read(ctx, args = {}, deadline) {
  return network.read(ctx.context, ctx.session, { after: 0, ...args }, deadline);
}

function finished(ctx, options) {
  const request = ctx.fake.networkRequest(ctx.tab, options);
  request.finish(options.failed);
  return request;
}

test("a record follows its request through a redirect, a finish, a failure, a main-frame commit, and a frame's own attach, and is numbered as it ends", async (t) => {
  const ctx = await setup(t, { 'http://a.test/next': page({ title: 'Next' }) });
  const hops = ctx.fake.networkRequest(ctx.tab, { type: 'Fetch', url: 'http://a.test/api/old', status: 200, mimeType: 'application/json', encodedDataLength: 87 });
  hops.redirect('http://a.test/api/new');
  finished(ctx, { type: 'Image', url: 'http://cdn.test/x.png', failed: { errorText: 'net::ERR_ABORTED', canceled: true } });
  hops.finish();
  ctx.fake.networkRequest(ctx.tab, { type: 'Document', url: 'http://frame.test/', frameId: `T${ctx.fake.nextTarget}` });
  ctx.fake.createTarget({ type: 'iframe', parent: ctx.tab, url: 'http://frame.test/' });
  await waitFor(() => ctx.sessions.frameTargets(ctx.target.targetId).length === 1);
  ctx.fake.networkRequest(ctx.tab, { type: 'Script', url: 'http://a.test/old.js' });
  await flush(ctx.conn);
  ctx.fake.navigateTarget(ctx.tab, 'http://a.test/next');
  await waitFor(() => ctx.target.url === 'http://a.test/next');
  const { head, body } = await read(ctx);
  const lines = body.split('\n');
  assert.strictEqual(lines.length, 5, body);
  assert.match(lines[0], /^\[(\d+)\] GET 302 fetch http:\/\/a\.test\/api\/old \(redirect\)$/);
  assert.match(lines[1], /^\[\d+\] GET — image http:\/\/cdn\.test\/x\.png failed: net::ERR_ABORTED \(canceled\)$/);
  assert.match(lines[2], /^\[\d+\] GET 200 fetch http:\/\/a\.test\/api\/new \(application\/json, 87 B transferred, \d+ ms\)$/);
  assert.match(lines[3], /^\[\d+\] GET — document http:\/\/frame\.test\/ \(continued in a cross-site frame\)$/);
  assert.match(lines[4], /^\[\d+\] GET — script http:\/\/a\.test\/old\.js \(ended by a navigation\)$/);
  const numbers = lines.map((line) => Number(/^\[(\d+)\]/.exec(line)[1]));
  assert.deepStrictEqual(numbers, [...numbers].sort((a, b) => a - b), 'numbered in the order they ended');
  assert.match(head, /^URL: http:\/\/a\.test\/next\nTitle: Next\nRequests: 5 entries after 0; the tab keeps its last 500 ended\nNext: after=\d+$/);
});

test('a request sent again under its id without a redirect response ends its first hop as a redirect, with nothing logged', async (t) => {
  const log = recordingLog();
  const ctx = await setup(t, {}, { log });
  const request = ctx.fake.networkRequest(ctx.tab, { type: 'Fetch', url: 'http://a.test/first' });
  ctx.fake.emit('Network.requestWillBeSent', {
    requestId: request.requestId, loaderId: ctx.tab.documentLoaderId, frameId: ctx.tab.targetId, type: 'Fetch',
    request: { url: 'http://a.test/again', method: 'GET', headers: {} }, timestamp: 0, wallTime: Date.now() / 1000,
  }, ctx.tab.sessionId);
  request.finish();
  await flush(ctx.conn);
  const [first, again] = (await read(ctx)).body.split('\n');
  assert.match(first, /^\[\d+\] GET — fetch http:\/\/a\.test\/first \(redirect\)$/);
  assert.match(again, /^\[\d+\] GET 200 fetch http:\/\/a\.test\/again \(0 B transferred, \d+ ms\)$/);
  assert.deepStrictEqual(log.lines.warn.filter((line) => /network capture/.test(line)), []);
});

test("a request that started before the tab's arming went out is neither listed in flight nor recorded as it ends, with nothing logged", async (t) => {
  const log = recordingLog();
  const ctx = await setup(t, {}, { log });
  ctx.target.armingSent = false;
  const early = ctx.fake.networkRequest(ctx.tab, { url: 'http://a.test/early' });
  await flush(ctx.conn);
  ctx.target.armingSent = true;
  assert.strictEqual((await read(ctx)).body, '', 'not in flight');
  early.finish();
  await flush(ctx.conn);
  assert.strictEqual((await read(ctx)).body, '', 'not recorded');
  assert.deepStrictEqual(log.lines.warn.filter((line) => /network capture/.test(line)), []);
});

test('an entry line prints a status of 0, a transferred size rounded to whole bytes, and no size when Chrome sends none', async (t) => {
  const ctx = await setup(t);
  finished(ctx, { url: 'http://a.test/zero', status: 0 });
  finished(ctx, { url: 'http://a.test/fraction', encodedDataLength: 1234.6 });
  const unsized = ctx.fake.networkRequest(ctx.tab, { url: 'http://a.test/unsized' });
  await flush(ctx.conn);
  ctx.fake.emit('Network.loadingFinished', { requestId: unsized.requestId, timestamp: 0 }, ctx.tab.sessionId);
  await flush(ctx.conn);
  const [zero, fraction, none] = (await read(ctx)).body.split('\n');
  assert.match(zero, /^\[\d+\] GET 0 xhr http:\/\/a\.test\/zero \(0 B transferred, \d+ ms\)$/);
  assert.match(fraction, /^\[\d+\] GET 200 xhr http:\/\/a\.test\/fraction \(1235 B transferred, \d+ ms\)$/);
  assert.match(none, /^\[\d+\] GET — xhr http:\/\/a\.test\/unsized \(\d+ ms\)$/);
});

test('a request in flight prints unnumbered after the numbered ones on each read, at most 20, and once it ends it is numbered above the earlier read\'s Next:', async (t) => {
  const ctx = await setup(t);
  finished(ctx, { url: 'http://a.test/done' });
  const poll = ctx.fake.networkRequest(ctx.tab, { type: 'Fetch', url: 'http://a.test/api/poll' });
  await flush(ctx.conn);
  const first = await read(ctx);
  assert.match(first.body, /^\[\d+\] GET 200 xhr http:\/\/a\.test\/done \([^)]*\)\n\[in flight\] GET — fetch http:\/\/a\.test\/api\/poll \(\d+\.\d s so far\)$/);
  const next = Number(/Next: after=(\d+)/.exec(first.head)[1]);
  poll.finish();
  await flush(ctx.conn);
  const second = await read(ctx, { after: next });
  assert.match(second.body, new RegExp(`^\\[${next + 1}\\] GET 200 fetch http://a\\.test/api/poll \\(0 B transferred, \\d+ ms\\)$`), 'numbered just above the earlier cursor');
  for (let i = 0; i < 22; i++) ctx.fake.networkRequest(ctx.tab, { url: `http://a.test/hang/${i}` });
  await flush(ctx.conn);
  const many = (await read(ctx, { after: issued() })).body.split('\n');
  assert.strictEqual(many.filter((line) => line.startsWith('[in flight] ')).length, 20);
  assert.strictEqual(many.at(-1), '… and 2 more in flight');
  ctx.fake.networkRequest(ctx.tab, { type: 'Fetch', url: 'http://a.test/api/poll?n=2' });
  await flush(ctx.conn);
  const filtered = await read(ctx, { filter: 'API/POLL', after: issued() });
  assert.match(filtered.body, /^\[in flight\] GET — fetch http:\/\/a\.test\/api\/poll\?n=2 \(\d+\.\d s so far\)$/, 'a filter keeps the one matching request among those in flight');
});

test("a record keeps neither the request's headers and post data nor the response's headers", async (t) => {
  const ctx = await setup(t);
  const post = ctx.fake.networkRequest(ctx.tab, {
    type: 'XHR', method: 'POST', url: 'http://a.test/login', postData: 'user=alice&pw=hunter2',
    headers: { Authorization: 'Bearer s3cret', Cookie: 'sid=abc', 'Proxy-Authorization': 'Basic x' },
  });
  await flush(ctx.conn);
  const [record] = requests.inFlight(ctx.target);
  assert.strictEqual(record.requestId, post.requestId, 'the request id is kept for a body');
  post.finish();
  await flush(ctx.conn);
  const kept = JSON.stringify(record);
  for (const secret of ['hunter2', 's3cret', 'sid=abc', 'Basic x', 'sid=secret', 'headers', 'postData']) assert.ok(!kept.includes(secret), `${secret} stays out of the record: ${kept}`);
  const { body } = await read(ctx, { filter: 'login' });
  assert.ok(!/hunter2|s3cret|sid=/.test(body), body);
});

test('requests.js hands over a record at each way a request ends but an eviction or a drop with the tab', async (t) => {
  const ctx = await setup(t);
  const evicted = ctx.fake.networkRequest(ctx.tab, { url: 'http://a.test/first' });
  for (let i = 0; i < 1_000; i++) ctx.fake.networkRequest(ctx.tab, { url: `http://a.test/filler/${i}` });
  evicted.finish();
  await flush(ctx.conn);
  assert.strictEqual((await read(ctx, { filter: '/first' })).body, '', 'an evicted entry ends unrecorded');
  const dropped = ctx.fake.networkRequest(ctx.tab, { url: 'http://a.test/dropped' });
  await flush(ctx.conn);
  requests.drop(ctx.target);
  dropped.finish();
  await flush(ctx.conn);
  assert.strictEqual((await read(ctx, { filter: '/dropped' })).body, '', 'a dropped entry ends unrecorded');
});

test("the tab's records go when the registry forgets it and when arming disarms it, and nothing is recorded once disarmed", async (t) => {
  const forgotten = await setup(t);
  finished(forgotten, { url: 'http://a.test/x' });
  await flush(forgotten.conn);
  assert.match((await read(forgotten)).head, /Requests: 1 entry after 0/);
  forgotten.sessions.forget(forgotten.target);
  assert.match((await read(forgotten)).head, /Requests: 0 entries after 0/);

  const disarmed = await setup(t);
  finished(disarmed, { url: 'http://a.test/x' });
  await flush(disarmed.conn);
  arming.disarm(disarmed.sessions, disarmed.target);
  assert.match((await read(disarmed)).head, /Requests: 0 entries after 0/);
  disarmed.tab.networkEnabled = true;
  finished(disarmed, { url: 'http://a.test/after' });
  await flush(disarmed.conn);
  assert.match((await read(disarmed)).head, /Requests: 0 entries after 0/, 'an event after disarming leaves nothing behind');
});

test('a MIME type is textual by its part before any `;`, trimmed and in any case, and the pattern matches no empty type', () => {
  const textual = new RegExp(TEXTUAL.source, TEXTUAL.flags);
  for (const type of ['text/html', ' Text/Plain ; charset=utf-8', 'application/json', 'APPLICATION/XML', 'application/javascript', 'application/x-www-form-urlencoded', 'application/problem+json', 'image/svg+xml']) {
    assert.ok(textual.test(type), type);
  }
  for (const type of ['', 'application/octet-stream', 'image/png', 'application/jsonp', 'text', 'application/pdf; x=text/html']) {
    assert.ok(!textual.test(type), type);
  }
});

test('under a filter, an XHR, fetch, or document that finished prints its body when its type is textual or empty, and a binary, evicted, or empty body says so', async (t) => {
  const bodies = {
    'http://a.test/api/json': '{"ok":1}',
    'http://a.test/api/untyped': 'plain words',
    'http://a.test/api/bin': { body: Buffer.from([1, 2, 3, 4, 5]).toString('base64'), base64Encoded: true },
    'http://a.test/api/long': 'x'.repeat(5_000),
    'http://a.test/api/style': 'p {}',
    'http://a.test/api/empty': '',
    'http://a.test/api/reserved': '\0',
  };
  const ctx = await setup(t, { [URL]: page({ bodies }) });
  finished(ctx, { type: 'Fetch', url: 'http://a.test/api/json', mimeType: 'application/json' });
  finished(ctx, { type: 'XHR', url: 'http://a.test/api/untyped', mimeType: '' });
  finished(ctx, { type: 'Fetch', url: 'http://a.test/api/bin', mimeType: '' });
  finished(ctx, { type: 'Fetch', url: 'http://a.test/api/gone', mimeType: 'text/plain' });
  finished(ctx, { type: 'Fetch', url: 'http://a.test/api/long', mimeType: 'text/plain' });
  finished(ctx, { type: 'Stylesheet', url: 'http://a.test/api/style', mimeType: 'text/css' });
  finished(ctx, { type: 'Fetch', url: 'http://a.test/api/octet', mimeType: 'application/octet-stream' });
  finished(ctx, { type: 'Fetch', url: 'http://a.test/api/failed', mimeType: 'text/plain', failed: true });
  finished(ctx, { type: 'Fetch', url: 'http://a.test/api/empty', mimeType: 'text/plain' });
  finished(ctx, { type: 'Fetch', url: 'http://a.test/api/reserved', mimeType: 'text/plain' });
  await flush(ctx.conn);
  const { body } = await read(ctx, { filter: 'API' });
  const blocks = body.split(/\n(?=\[)/);
  assert.strictEqual(blocks.length, 10, body);
  assert.match(blocks.pop(), /api\/reserved [^\n]*\n {4}\(empty body\)$/, 'a body of reserved characters alone is empty once they are stripped');
  assert.match(blocks.pop(), /api\/empty [^\n]*\n {4}\(empty body\)$/);
  assert.match(blocks[0], /api\/json [^\n]*\n {4}\{"ok":1\}$/);
  assert.match(blocks[1], /api\/untyped [^\n]*\n {4}plain words$/, 'an empty type counts as textual');
  assert.match(blocks[2], /api\/bin [^\n]*\n {4}\(binary body, 5 bytes\)$/);
  assert.match(blocks[3], /api\/gone [^\n]*\n {4}\(body not kept\)$/);
  assert.match(blocks[4], new RegExp(`api/long [^\\n]*\\n {4}x{3999}…$`), 'cut at 4,000 characters');
  for (const plain of blocks.slice(5)) assert.ok(!plain.includes('\n'), `no body: ${plain}`);
  assert.ok(!(await read(ctx)).body.includes('{"ok":1}'), 'a read without a filter prints no body');
});

test('each line terminator in a body starts an indented line, so no body line can pose as an entry', async (t) => {
  const ctx = await setup(t, { [URL]: page({ bodies: { 'http://a.test/t': 'a\r\nb\rc\nd\ve\ff\u0085g\u2028h\u2029[99] GET 200 xhr http://evil/\0\uE000' } }) });
  finished(ctx, { type: 'Fetch', url: 'http://a.test/t', mimeType: 'text/plain' });
  await flush(ctx.conn);
  const [, ...bodyLines] = (await read(ctx, { filter: '/t' })).body.split('\n');
  assert.deepStrictEqual(bodyLines, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', '[99] GET 200 xhr http://evil/'].map((line) => `    ${line}`));
});

test("a read is cut at a record whose body the deadline leaves unread, and the cut's after and Next: continue with it", async (t) => {
  const ctx = await setup(t, { [URL]: page({ bodies: { 'http://a.test/b/1': 'one', 'http://a.test/b/2': () => new Promise(() => {}), 'http://a.test/b/3': 'three' } }) });
  for (const n of [1, 2, 3]) finished(ctx, { type: 'Fetch', url: `http://a.test/b/${n}`, mimeType: 'text/plain' });
  await flush(ctx.conn);
  const all = (await read(ctx)).body.split('\n').map((line) => Number(/^\[(\d+)\]/.exec(line)[1]));
  ctx.fake.networkRequest(ctx.tab, { type: 'Fetch', url: 'http://a.test/b/flying' });
  await flush(ctx.conn);
  const started = Date.now();
  const cut = await read(ctx, { filter: '/b/' }, Date.now() + 1_500);
  const took = Date.now() - started;
  assert.ok(took >= 450 && took < 1_000, `the body read gave up a second before the deadline (${took} ms)`);
  assert.match(cut.body, new RegExp(`^\\[${all[0]}\\] GET 200 fetch http://a\\.test/b/1 \\(text/plain, 0 B transferred, \\d+ ms\\)\n {4}one\n… 2 more; call again with after=${all[1] - 1}$`));
  assert.match(cut.head, new RegExp(`Requests: 1 entry after 0, filter "/b/"; the tab keeps its last 500 ended\nNext: after=${all[1] - 1}$`));
});

test('a filtered read whose body deadline has already passed cuts at the first body without asking Chrome for it', async (t) => {
  const ctx = await setup(t, { [URL]: page({ bodies: { 'http://a.test/b/1': 'one' } }) });
  finished(ctx, { type: 'Fetch', url: 'http://a.test/b/1', mimeType: 'text/plain' });
  await flush(ctx.conn);
  const n = Number(/^\[(\d+)\]/.exec((await read(ctx)).body)[1]);
  // The test fixes Date.now() so the body deadline equals the current time,
  // one second before the call's deadline.
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const cut = await read(ctx, { filter: '/b/' }, now + 1_000);
  assert.strictEqual(cut.body, `… 1 more; call again with after=${n - 1}`);
  await flush(ctx.conn);
  assert.deepStrictEqual(ctx.fake.callsTo('Network.getResponseBody'), []);
});

test('a filtered read past its 40,000-character budget is cut at the record whose body would not fit', async (t) => {
  const bodies = {};
  for (let i = 0; i < 12; i++) bodies[`http://a.test/big/${i}`] = 'y'.repeat(4_000);
  const ctx = await setup(t, { [URL]: page({ bodies }) });
  for (let i = 0; i < 12; i++) finished(ctx, { type: 'Fetch', url: `http://a.test/big/${i}`, mimeType: 'text/plain' });
  await flush(ctx.conn);
  const lines = (await read(ctx)).body.split('\n');
  const nine = lines.slice(0, 9).reduce((sum, line) => sum + line.length + 1 + 4_004 + 1, 0);
  const fits = 40_000 - nine - lines[9].length - 1 - 4;
  for (const [size, printed] of [[fits, 10], [fits + 1, 9]]) {
    ctx.fake.site[URL].bodies['http://a.test/big/9'] = 'y'.repeat(size);
    const { head, body } = await read(ctx, { filter: '/big/' });
    const cut = body.lastIndexOf('\n… ');
    assert.strictEqual(body.slice(0, cut).split('\n').filter((line) => /^\[\d+\]/.test(line)).length, printed, `a tenth body of ${size}`);
    if (printed === 10) assert.strictEqual(cut, 40_000, 'the ten records fill the budget exactly');
    assert.strictEqual(body.slice(cut + 1), `… ${12 - printed} more; call again with after=${Number(/^\[(\d+)\]/.exec(lines[printed])[1]) - 1}`);
    assert.match(head, new RegExp(`Requests: ${printed} entries after 0`));
  }
});

test("an uncut answer's Next: is issued() as it scans, past a filter's unprinted entries, and comes back below a stale cursor from before a restart, with a Missed: line", async (t) => {
  const ctx = await setup(t);
  finished(ctx, { url: 'http://a.test/keep' });
  finished(ctx, { url: 'http://a.test/skip' });
  await flush(ctx.conn);
  const filtered = await read(ctx, { filter: 'keep' });
  assert.strictEqual(filtered.body.split('\n').filter((line) => line.startsWith('[')).length, 1);
  assert.match(filtered.head, new RegExp(`Next: after=${issued()}$`));
  const stale = issued() + 1_000;
  const restarted = await read(ctx, { after: stale });
  assert.strictEqual(restarted.body.split('\n').length, 2, 'every entry kept is listed');
  assert.match(restarted.head, new RegExp(`Requests: 2 entries after ${stale}; the tab keeps its last 500 ended\nMissed: the daemon restarted since after=${stale}\nNext: after=${issued()}$`));
});

test("a record that ends while the read waits on a body leaves that answer's in-flight lines, is numbered above its Next:, and prints in the next read", async (t) => {
  let release;
  const ctx = await setup(t, { [URL]: page({ bodies: { 'http://a.test/slow': () => new Promise((resolve) => { release = () => resolve({ body: 'late', base64Encoded: false }); }) } }) });
  finished(ctx, { type: 'Fetch', url: 'http://a.test/slow', mimeType: 'text/plain' });
  const meanwhile = ctx.fake.networkRequest(ctx.tab, { type: 'Fetch', url: 'http://a.test/slow-too' });
  await flush(ctx.conn);
  const reading = read(ctx, { filter: 'slow' });
  await waitFor(() => release);
  meanwhile.finish();
  await flush(ctx.conn);
  release();
  const answer = await reading;
  const next = Number(/Next: after=(\d+)/.exec(answer.head)[1]);
  assert.match(answer.body, new RegExp(`^\\[${next}\\] GET 200 fetch http://a\\.test/slow \\(text/plain, 0 B transferred, \\d+ ms\\)\n {4}late$`), 'the record that ended meanwhile is no longer in flight');
  const later = await read(ctx, { filter: 'slow-too', after: next });
  assert.match(later.body, new RegExp(`^\\[${next + 1}\\] GET 200 fetch http://a\\.test/slow-too \\(0 B transferred, \\d+ ms\\)\n {4}\\(body not kept\\)$`));
});

test('in-flight lines that would pass the budget fold into their count line, which leaves the answer uncut', async (t) => {
  const ctx = await setup(t);
  const long = (i) => `http://a.test/${String(i).padStart(4, '0')}${'p'.repeat(990)}`;
  // Two in-flight lines fit in the budget after the completed records.
  // Three in-flight lines exceed the remaining budget.
  for (let i = 0; i < 36; i++) finished(ctx, { url: long(i) });
  for (let i = 0; i < 5; i++) ctx.fake.networkRequest(ctx.tab, { url: long(100 + i) });
  await flush(ctx.conn);
  const { head, body } = await read(ctx);
  const lines = body.split('\n');
  assert.strictEqual(lines.filter((line) => /^\[\d+\]/.test(line)).length, 36, 'every numbered record printed');
  assert.match(lines[36], /^\[in flight\] GET — xhr http:\/\/a\.test\/0100p+… \(\d+\.\d s so far\)$/);
  assert.match(lines[37], /^\[in flight\] GET — xhr http:\/\/a\.test\/0101p+… \(\d+\.\d s so far\)$/);
  assert.strictEqual(lines.length, 39, 'two in-flight lines fit, then the count line');
  assert.strictEqual(lines.at(-1), '… and 3 more in flight');
  assert.match(head, new RegExp(`Next: after=${issued()}$`), 'uncut');
});

test('an in-flight line that fills the budget to its last character prints', async (t) => {
  const ctx = await setup(t);
  const long = (i) => `http://a.test/${String(i).padStart(4, '0')}${'p'.repeat(990)}`;
  for (let i = 0; i < 38; i++) finished(ctx, { url: long(i) });
  await flush(ctx.conn);
  const used = (await read(ctx)).body.length + 1;
  // An in-flight line is its prefix, its URL, and its age, under 10 s here.
  const urlChars = 40_000 - used - '[in flight] GET — xhr '.length - ' (0.0 s so far)'.length;
  assert.ok(urlChars > 'http://a.test/'.length && urlChars <= 1_000, `a URL of ${urlChars} characters prints whole`);
  ctx.fake.networkRequest(ctx.tab, { url: `http://a.test/${'f'.repeat(urlChars - 'http://a.test/'.length)}` });
  await flush(ctx.conn);
  const { head, body } = await read(ctx);
  assert.strictEqual(body.length, 40_000);
  assert.match(body.split('\n').at(-1), /^\[in flight\] GET — xhr http:\/\/a\.test\/f+ \(\d\.\d s so far\)$/);
  assert.match(head, new RegExp(`Next: after=${issued()}$`));
});

test("a cursor below the highest number the tab's list dropped adds a Missed: line naming it", async (t) => {
  const ctx = await setup(t);
  const start = issued();
  for (let i = 0; i < 502; i++) finished(ctx, { url: `http://a.test/${i}` });
  await flush(ctx.conn);
  const { head } = await read(ctx, { after: start });
  assert.match(head, new RegExp(`Missed: the tab dropped entries up to \\[${start + 2}\\]\n`));
  assert.ok(!(await read(ctx, { after: start + 2 })).head.includes('Missed:'));
});

test("the filter's echo is one capped line with its brackets escaped", async (t) => {
  const ctx = await setup(t);
  const { head } = await read(ctx, { filter: `a\n[e9]${'z'.repeat(200)}` });
  const line = head.split('\n').find((l) => l.startsWith('Requests: '));
  assert.strictEqual(line, `Requests: 0 entries after 0, filter "a \\[e9\\]${'z'.repeat(93)}…"; the tab keeps its last 500 ended`);
});

test("the main frame's document responses keep their challenge headers by loader id, ten at most, and a frame's or a subresource's don't count", async (t) => {
  const ctx = await setup(t, {
    'http://a.test/cf': page({ status: 403, headers: { 'CF-Mitigated': 'challenge' } }),
    ...Object.fromEntries(Array.from({ length: 10 }, (unused, i) => [`http://a.test/p${i}`, page({ status: 200 })])),
  });
  finished(ctx, { type: 'Document', url: 'http://a.test/child', frameId: 'CHILD', loaderId: 'child-loader', responseHeaders: { 'cf-mitigated': 'challenge' } });
  await flush(ctx.conn);
  assert.strictEqual(network.documentSignal(ctx.target), null, "a child frame's document leaves a plain page plain");
  const plainLoader = ctx.target.loaderId;
  ctx.target.loaderId = 'child-loader';
  assert.strictEqual(network.documentSignal(ctx.target), null, "the child frame's headers weren't kept");
  ctx.target.loaderId = plainLoader;
  ctx.fake.navigateTarget(ctx.tab, 'http://a.test/cf');
  await waitFor(() => ctx.target.url === 'http://a.test/cf');
  await flush(ctx.conn);
  const cfLoader = ctx.target.loaderId;
  assert.strictEqual(network.documentSignal(ctx.target), 'cloudflare');
  finished(ctx, { type: 'XHR', url: 'http://a.test/cf/poll', responseHeaders: {} });
  await flush(ctx.conn);
  assert.strictEqual(network.documentSignal(ctx.target), 'cloudflare', "the page's own XHR under the document's loader id leaves its headers");
  for (let i = 0; i < 9; i++) {
    ctx.fake.navigateTarget(ctx.tab, `http://a.test/p${i}`);
    await waitFor(() => ctx.target.url === `http://a.test/p${i}`);
  }
  await flush(ctx.conn);
  assert.strictEqual(network.documentSignal(ctx.target), null);
  ctx.target.loaderId = cfLoader;
  assert.strictEqual(network.documentSignal(ctx.target), 'cloudflare', 'kept among the last ten');
  ctx.fake.navigateTarget(ctx.tab, 'http://a.test/p9');
  await waitFor(() => ctx.target.url === 'http://a.test/p9');
  await flush(ctx.conn);
  ctx.target.loaderId = cfLoader;
  assert.strictEqual(network.documentSignal(ctx.target), null, 'the eleventh pushed it out');
});

test('each page-controlled field of an entry line is sanitized, and a protocol word prints as lowercase letters alone', async (t) => {
  const ctx = await setup(t);
  finished(ctx, { method: 'GET X\n[e1]', type: 'CSP-Violation Report', url: `http://a.test/a b(c)[d]\n${'q'.repeat(1_100)}`, mimeType: 'text/[x]\nhtml', encodedDataLength: 12 });
  finished(ctx, { url: 'http://a.test/f', failed: { errorText: 'net::ERR\n[e2] BLOCKED', blockedReason: 'csp\n[e3]' } });
  finished(ctx, { method: 'M'.repeat(20), url: 'http://a.test/m', mimeType: `text/${'x'.repeat(150)}` });
  finished(ctx, { method: 'M'.repeat(21), url: 'http://a.test/n' });
  finished(ctx, { type: '', url: 'http://a.test/untyped' });
  await flush(ctx.conn);
  const [first, second, third, fourth, fifth] = (await read(ctx)).body.split('\n');
  assert.match(fifth, /^\[\d+\] GET 200 other http:\/\/a\.test\/untyped /, 'a record without a type prints as other');
  assert.match(third, new RegExp(`^\\[\\d+\\] ${'M'.repeat(20)} 200 xhr http://a\\.test/m \\(text/${'x'.repeat(94)}…, 0 B transferred, \\d+ ms\\)$`), 'a 20-character method prints, and a MIME type is cut at 100 characters');
  assert.match(fourth, /^\[\d+\] \? 200 xhr http:\/\/a\.test\/n /, 'a 21-character method prints as ?');
  assert.match(first, /^\[\d+\] \? 200 cspviolationreport http:\/\/a\.test\/a%20b%28c%29%5Bd%5D%0Aq+… \(text\/\\\[x\\\] html, 12 B transferred, \d+ ms\)$/);
  assert.strictEqual(first.slice(first.indexOf('http://'), first.indexOf(' (text')).length, 1_000, 'a URL is cut at 1,000 characters');
  assert.match(second, /^\[\d+\] GET — xhr http:\/\/a\.test\/f failed: net::ERR \\\[e2\\\] BLOCKED \(blocked: csp \\\[e3\\\]\)$/);
});

test('a filter matches the URL as its line prints it too, escapes included', async (t) => {
  const ctx = await setup(t);
  finished(ctx, { url: 'http://a.test/a b(c)' });
  await flush(ctx.conn);
  for (const filter of ['a b(c)', 'A%20B%28C%29']) {
    assert.match((await read(ctx, { filter })).body, /^\[\d+\] GET 200 xhr http:\/\/a\.test\/a%20b%28c%29 \([^)]*\)\n {4}\(body not kept\)$/, filter);
  }
});

test("a record keeps its URL's first 2,000 characters, which print as the whole URL would and which a filter matches within", async (t) => {
  const ctx = await setup(t);
  const kept = `http://a.test/${'u'.repeat(1_982)}tail`;
  const request = ctx.fake.networkRequest(ctx.tab, { url: `${kept}${'v'.repeat(10_000)}gone` });
  await flush(ctx.conn);
  assert.strictEqual(requests.inFlight(ctx.target)[0].url, kept);
  request.finish();
  await flush(ctx.conn);
  const { body } = await read(ctx, { filter: 'tail' });
  assert.strictEqual(body.slice(body.indexOf('http://'), body.indexOf(' (')), `${kept.slice(0, 999)}…`);
  assert.strictEqual((await read(ctx, { filter: 'gone' })).body, '', 'past the kept characters');
});

test('a tab without captures reads as empty', async (t) => {
  const ctx = await setup(t);
  const empty = await read(ctx);
  assert.match(empty.head, /^URL: http:\/\/a\.test\/\nTitle: A\nRequests: 0 entries after 0; the tab keeps its last 500 ended\nNext: after=\d+$/);
  assert.strictEqual(empty.body, '');
});
