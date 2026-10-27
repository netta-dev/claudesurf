// action-log.js: one record per call, typed text reduced to a length and a keyed hash,
// the file's mode, its rotation, and a failed write that warns.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ActionLog } = require('../server/action-log');
const { tmpDir, recordingLog, silentLog, modesIgnored } = require('./helpers');

// Returns an action log at a fresh path, removed when the test ends.
function actionLog(t, options = {}) {
  const dir = tmpDir('claudesurf-action-log');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'claudesurf', 'actions.jsonl');
  return { log: new ActionLog({ file, log: silentLog, ...options }), file, dir };
}

const records = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));

test('a record carries the call\'s fields in order, without url or blocked when there are none', (t) => {
  const { log, file } = actionLog(t);
  log.record({ sessionId: 's1', tool: 'claudesurf_read', action: 'info', args: {}, outcome: 'success' });
  const [record] = records(file);
  assert.deepStrictEqual(Object.keys(record), ['ts', 'session', 'tool', 'action', 'args', 'outcome']);
  assert.match(record.ts, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
});

test('a record keeps the URL verbatim and lists every refusal that the response carried', (t) => {
  const { log, file } = actionLog(t);
  log.record({
    sessionId: 's1', tool: 'claudesurf_act', action: 'navigate',
    args: { url: 'https://app.example/login?next=/x', name: 'n' },
    url: 'https://docs.example/start', outcome: 'needs_confirmation',
    blocked: [
      { own: true, tab: 3, kind: 'navigation', how: 'stopped', host: 'evil.example', url: 'https://evil.example/x', count: 1, seq: 4, targetId: 'T3', opener: null },
      { own: false, tab: 5, kind: 'new tab', how: 'stopped', host: 'ads.example', url: 'https://ads.example/', count: 2, seq: 2, targetId: 'T5', opener: 'T3' },
    ],
  });
  const [record] = records(file);
  assert.deepStrictEqual(Object.keys(record), ['ts', 'session', 'tool', 'action', 'args', 'url', 'outcome', 'blocked']);
  assert.deepStrictEqual(record.args, { url: 'https://app.example/login?next=/x', name: 'n' });
  assert.strictEqual(record.url, 'https://docs.example/start');
  assert.deepStrictEqual(record.blocked, [
    { own: true, tab: 't3', kind: 'navigation', how: 'stopped', host: 'evil.example', url: 'https://evil.example/x', count: 1 },
    { own: false, tab: 't5', kind: 'new tab', how: 'stopped', host: 'ads.example', url: 'https://ads.example/', count: 2 },
  ]);
});

test('type\'s text is its length and an HMAC: equal for equal text within a log, different under a new key', (t) => {
  const { log, file } = actionLog(t);
  for (const text of ['hunter2 secret', 'hunter2 secret', 'other']) log.record({ sessionId: 's1', tool: 'claudesurf_act', action: 'type', args: { ref: 'e4', text }, outcome: 'success' });
  const [first, second, third] = records(file).map((r) => r.args);
  assert.strictEqual(first.ref, 'e4');
  assert.strictEqual(first.text.length, 14);
  assert.match(first.text.hmac, /^[0-9a-f]{16}$/);
  assert.deepStrictEqual(second.text, first.text);
  assert.notStrictEqual(third.text.hmac, first.text.hmac);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('hunter2'), 'the text is in no record');
  const { log: restarted, file: other } = actionLog(t);
  restarted.record({ sessionId: 's1', tool: 'claudesurf_act', action: 'type', args: { ref: 'e4', text: 'hunter2 secret' }, outcome: 'success' });
  assert.notStrictEqual(records(other)[0].args.text.hmac, first.text.hmac, 'a new key gives another value');
});

test('a typed text\'s length counts characters, so one outside the Basic Multilingual Plane counts once', (t) => {
  const { log, file } = actionLog(t);
  log.record({ sessionId: 's1', tool: 'claudesurf_act', action: 'type', args: { ref: 'e4', text: 'a\u{1F512}b' }, outcome: 'success' });
  assert.strictEqual(records(file)[0].args.text.length, 3);
});

test('press keys are hashed when a press types a character, Space included, and kept verbatim otherwise', (t) => {
  const { log, file } = actionLog(t);
  const keys = ['1 2 3 4 5 6', 'Space', 'Shift+a', 'Enter', 'Control+a Backspace', 'Shift+Tab', 'Bogus+'];
  for (const k of keys) log.record({ sessionId: 's1', tool: 'claudesurf_act', action: 'press', args: { keys: k }, outcome: 'success' });
  const recorded = records(file).map((r) => r.args.keys);
  // A list that the grammar refuses, the last, is hashed, as it might be typed text.
  for (const i of [0, 1, 2, 6]) {
    assert.strictEqual(recorded[i].length, [...keys[i]].length, keys[i]);
    assert.match(recorded[i].hmac, /^[0-9a-f]{16}$/, keys[i]);
  }
  assert.deepStrictEqual(recorded.slice(3, 6), ['Enter', 'Control+a Backspace', 'Shift+Tab']);
});

test('the file is created 0600 in a 0700 directory', (t) => {
  const { log, file } = actionLog(t);
  log.record({ sessionId: 's1', tool: 'claudesurf_read', action: 'info', args: {}, outcome: 'success' });
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  assert.strictEqual(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
});

test('a record that would pass the size cap renames the file to .1, replacing an earlier one, and starts a new file', (t) => {
  const fields = { sessionId: 's1', tool: 'claudesurf_act', action: 'scroll', outcome: 'success' };
  // Every record below is this long, so the cap holds three of them exactly.
  const recordBytes = Buffer.byteLength(`${JSON.stringify({ ts: new Date().toISOString(), session: 's1', tool: 'claudesurf_act', action: 'scroll', args: { direction: 'down', amount: 1 }, outcome: 'success' })}\n`);
  const { log, file } = actionLog(t, { maxBytes: 3 * recordBytes });
  const call = (i) => log.record({ ...fields, args: { direction: 'down', amount: i } });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.1`, 'an earlier generation\n');
  for (let i = 1; i <= 3; i++) call(i);
  assert.strictEqual(fs.statSync(file).size, 3 * recordBytes, 'a file at the cap is kept');
  call(4);
  const rotated = fs.readFileSync(`${file}.1`, 'utf8');
  assert.ok(!rotated.includes('an earlier generation'), 'the earlier .1 was replaced');
  assert.deepStrictEqual(rotated.trim().split('\n').map((line) => JSON.parse(line).args.amount), [1, 2, 3]);
  assert.deepStrictEqual(records(file).map((r) => r.args.amount), [4]);
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
});

test('a first record longer than the cap is written to a new file, with nothing renamed', (t) => {
  const warnings = recordingLog();
  const { log, file } = actionLog(t, { log: warnings, maxBytes: 10 });
  log.record({ sessionId: 's1', tool: 'claudesurf_read', action: 'info', args: {}, outcome: 'success' });
  assert.deepStrictEqual(warnings.lines.warn, []);
  assert.strictEqual(records(file).length, 1);
  assert.ok(!fs.existsSync(`${file}.1`), 'no .1 was made');
});

test('the size cap defaults to 10 MiB', (t) => {
  const { log, file } = actionLog(t);
  const cap = 10 * 1024 * 1024;
  const call = () => log.record({ sessionId: 's1', tool: 'claudesurf_read', action: 'info', args: {}, outcome: 'success' });
  const recordBytes = Buffer.byteLength(`${JSON.stringify({ ts: new Date().toISOString(), session: 's1', tool: 'claudesurf_read', action: 'info', args: {}, outcome: 'success' })}\n`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  // The sparse file lets the test write a few hundred bytes rather than 10 MiB.
  fs.truncateSync(file, cap - recordBytes);
  call();
  assert.strictEqual(fs.statSync(file).size, cap, 'a record that brings the file to the cap is appended');
  assert.ok(!fs.existsSync(`${file}.1`));
  fs.truncateSync(file, cap - recordBytes + 1);
  call();
  assert.strictEqual(fs.statSync(`${file}.1`).size, cap - recordBytes + 1, 'a record that would pass the cap by a byte renames the file');
  assert.strictEqual(fs.statSync(file).size, recordBytes);
});

test('a write that fails warns and does not throw', { skip: modesIgnored }, (t) => {
  const dir = tmpDir('claudesurf-action-log');
  fs.chmodSync(dir, 0o500);
  t.after(() => { fs.chmodSync(dir, 0o700); fs.rmSync(dir, { recursive: true, force: true }); });
  const warnings = recordingLog();
  const log = new ActionLog({ file: path.join(dir, 'claudesurf', 'actions.jsonl'), log: warnings });
  log.record({ sessionId: 's1', tool: 'claudesurf_read', action: 'info', args: {}, outcome: 'success' });
  assert.strictEqual(warnings.lines.warn.length, 1);
  assert.match(warnings.lines.warn[0], /^action log .*actions\.jsonl: EACCES/);
});
