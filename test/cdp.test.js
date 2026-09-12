const { test } = require('node:test');
const assert = require('node:assert');
const { PassThrough } = require('stream');
const { Connection, ProtocolError, TimeoutError, ConnectionClosedError } = require('../server/cdp');
const { silentLog } = require('./helpers');

// A raw stream pair: `fromBrowser` is what the daemon reads, `toBrowser` what it writes.
function pair() {
  const fromBrowser = new PassThrough();
  const toBrowser = new PassThrough();
  const conn = new Connection(fromBrowser, toBrowser, silentLog);
  const sent = [];
  toBrowser.setEncoding('utf8');
  toBrowser.on('data', (chunk) => { for (const raw of chunk.split('\0')) if (raw) sent.push(JSON.parse(raw)); });
  const reply = (message) => fromBrowser.write(JSON.stringify(message) + '\0');
  return { conn, fromBrowser, toBrowser, sent, reply };
}

function tick() { return new Promise((r) => setImmediate(r)); }

test('correlates replies by id and frames messages across chunk boundaries', async () => {
  const { conn, fromBrowser, sent } = pair();
  const a = conn.send('Browser.getVersion');
  const b = conn.send('Target.getTargets');
  await tick();
  assert.deepStrictEqual(sent.map((m) => m.method), ['Browser.getVersion', 'Target.getTargets']);
  const replies = JSON.stringify({ id: sent[1].id, result: { targetInfos: [] } }) + '\0' + JSON.stringify({ id: sent[0].id, result: { product: 'Chrome/1' } }) + '\0';
  // Two messages, split mid-message and delivered in three chunks.
  fromBrowser.write(replies.slice(0, 10));
  fromBrowser.write(replies.slice(10, 40));
  fromBrowser.write(replies.slice(40));
  assert.deepStrictEqual(await a, { product: 'Chrome/1' });
  assert.deepStrictEqual(await b, { targetInfos: [] });
});

test('routes sessionId on commands and rejects protocol errors', async () => {
  const { conn, sent, reply } = pair();
  const p = conn.send('Page.navigate', { url: 'x' }, { sessionId: 'S1' });
  await tick();
  assert.strictEqual(sent[0].sessionId, 'S1');
  assert.deepStrictEqual(sent[0].params, { url: 'x' });
  reply({ id: sent[0].id, sessionId: 'S1', error: { code: -32000, message: 'Cannot navigate' } });
  await assert.rejects(p, (e) => e instanceof ProtocolError && e.method === 'Page.navigate' && /Cannot navigate/.test(e.message));
});

test('times out per command and by absolute deadline', async () => {
  const { conn } = pair();
  await assert.rejects(conn.send('Slow.one', {}, { timeout: 30 }), TimeoutError);
  const started = Date.now();
  await assert.rejects(conn.send('Slow.two', {}, { timeout: 10000, deadline: Date.now() + 30 }), TimeoutError);
  assert.ok(Date.now() - started < 1000, 'deadline bounded the wait');
});

test('dispatches events with their sessionId and supports waitFor', async () => {
  const { conn, reply } = pair();
  const seen = [];
  const off = conn.on('Page.loadEventFired', (params, sessionId) => seen.push([params.timestamp, sessionId]));
  const waited = conn.waitFor('Page.loadEventFired', (p, sid) => sid === 'S2');
  reply({ method: 'Page.loadEventFired', params: { timestamp: 1 }, sessionId: 'S1' });
  reply({ method: 'Page.loadEventFired', params: { timestamp: 2 }, sessionId: 'S2' });
  await tick();
  assert.deepStrictEqual(seen, [[1, 'S1'], [2, 'S2']]);
  assert.deepStrictEqual(await waited, { timestamp: 2 });
  off();
  reply({ method: 'Page.loadEventFired', params: { timestamp: 3 }, sessionId: 'S1' });
  await tick();
  assert.strictEqual(seen.length, 2, 'unsubscribed handler is not called');
});

test('EOF rejects pending sends, fires close handlers, and refuses new sends', async () => {
  const { conn, fromBrowser } = pair();
  let closed = 0;
  conn.onClose(() => { closed++; });
  const pending = conn.send('Browser.getVersion');
  fromBrowser.end();
  await assert.rejects(pending, ConnectionClosedError);
  assert.strictEqual(closed, 1);
  assert.ok(conn.closed);
  await assert.rejects(conn.send('Browser.getVersion'), ConnectionClosedError);
});

test('a pipe error closes the connection like EOF', async () => {
  const { conn, fromBrowser } = pair();
  const pending = conn.send('Browser.getVersion');
  const err = new Error('reset'); err.code = 'ECONNRESET';
  fromBrowser.destroy(err);
  await assert.rejects(pending, ConnectionClosedError);
  assert.ok(conn.closed);
});
