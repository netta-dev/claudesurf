// refusals.js: a session's list of domain-gate refusals — recording and merging, the
// drop of a full list, and the two takes that split it between the call that led to a
// refusal and the next response.

const { test } = require('node:test');
const assert = require('node:assert');
const { Sessions } = require('../server/sessions');
const refusals = require('../server/refusals');
const { silentLog } = require('./helpers');

function session() {
  return new Sessions(silentLog).get('s1');
}

// Returns a stopped navigation on the working tab T1, numbered 1, unless `fields` says
// otherwise.
function entry(fields = {}) {
  return { kind: 'navigation', how: 'stopped', url: 'https://evil.test/', host: 'evil.test', targetId: 'T1', tab: 1, opener: null, ...fields };
}

const urls = (list) => list.map((e) => e.url);

test('record stamps each entry with the raised counter', () => {
  const s = session();
  refusals.record(s, entry({ url: 'https://evil.test/a' }));
  refusals.record(s, entry({ url: 'https://evil.test/b' }));
  assert.deepStrictEqual(s.refusals.map((e) => [e.url, e.seq, e.count]), [['https://evil.test/a', 1, 1], ['https://evil.test/b', 2, 1]]);
  assert.strictEqual(s.refusalCount, 2);
});

test('a repeat merges only on the same tab, kind, how, and URL, raising the count and restamping seq', () => {
  const s = session();
  refusals.record(s, entry());
  refusals.record(s, entry({ tab: 2, targetId: 'T2' }));
  refusals.record(s, entry({ kind: 'new tab' }));
  refusals.record(s, entry({ how: 'not started' }));
  refusals.record(s, entry({ url: 'https://evil.test/other' }));
  assert.strictEqual(s.refusals.length, 5, 'a difference in any one of the four is a new entry');
  refusals.record(s, entry());
  refusals.record(s, entry());
  assert.strictEqual(s.refusals.length, 5);
  const [merged] = s.refusals;
  assert.deepStrictEqual({ count: merged.count, seq: merged.seq }, { count: 3, seq: 7 }, 'the merged entry carries the latest seq');
  assert.strictEqual(s.refusalCount, 7);
});

test('takeOwn takes the refusals that the running call led to and leaves the rest', () => {
  const s = session();
  refusals.record(s, entry({ url: 'https://before.test/' }));
  const marks = { seq: s.refusalCount, nextTab: 3, workingTargetId: 'T1', newTab: null };
  refusals.record(s, entry({ url: 'https://own.test/' }));
  refusals.record(s, entry({ kind: 'new tab', url: 'https://popunder.test/', targetId: 'T5', tab: 3, opener: 'T1' }));
  refusals.record(s, entry({ kind: 'restore', how: 'blanked', url: 'https://restored.test/' }));
  refusals.record(s, entry({ url: 'https://other-tab.test/', targetId: 'T2', tab: 2 }));
  refusals.record(s, entry({ kind: 'new tab', url: 'https://other-opener.test/', targetId: 'T6', tab: 4, opener: 'T2' }));
  refusals.record(s, entry({ kind: 'new tab', url: 'https://earlier-tab.test/', targetId: 'T7', tab: 2, opener: 'T1' }));
  assert.deepStrictEqual(urls(refusals.takeOwn(s, marks)), ['https://own.test/', 'https://popunder.test/']);
  assert.deepStrictEqual(urls(s.refusals), [
    'https://before.test/', 'https://restored.test/', 'https://other-tab.test/', 'https://other-opener.test/', 'https://earlier-tab.test/',
  ], 'recorded before the call, a restore, another tab, its popup, and a tab numbered before the call stay');
});

test('with newTab set, the new tab and what it opened are the call\'s own; the old working tab and its popup are not, and drop first', () => {
  const s = session();
  const marks = { seq: 0, nextTab: 3, workingTargetId: 'T1', newTab: 'T3' };
  refusals.record(s, entry({ url: 'https://new-tab-hop.test/', targetId: 'T3', tab: 3 }));
  refusals.record(s, entry({ kind: 'new tab', url: 'https://popunder.test/', targetId: 'T4', tab: 4, opener: 'T3' }));
  refusals.record(s, entry({ url: 'https://old-tab.test/', targetId: 'T1', tab: 1 }));
  refusals.record(s, entry({ kind: 'new tab', url: 'https://old-popup.test/', targetId: 'T5', tab: 5, opener: 'T1' }));
  s.marks = marks;
  for (let i = 0; i < 16; i++) refusals.record(s, entry({ kind: 'new tab', url: `https://own-${i}.test/`, targetId: 'T4', tab: 4, opener: 'T3' }));
  assert.strictEqual(s.refusals.length, 20, 'the list is full at its cap');
  refusals.record(s, entry({ url: 'https://one-more.test/', targetId: 'T3', tab: 3 }));
  assert.ok(!urls(s.refusals).includes('https://old-tab.test/'), 'the full list dropped the old working tab\'s entry');
  assert.ok(urls(s.refusals).includes('https://new-tab-hop.test/'), 'ahead of the new tab\'s older one');
  refusals.record(s, entry({ url: 'https://another.test/', targetId: 'T3', tab: 3 }));
  assert.ok(!urls(s.refusals).includes('https://old-popup.test/'), 'and then the old tab\'s popup');
  const own = urls(refusals.takeOwn(s, marks));
  assert.deepStrictEqual(own.slice(0, 2), ['https://new-tab-hop.test/', 'https://popunder.test/']);
  assert.strictEqual(own.length, 20);
  assert.deepStrictEqual(s.refusals, []);
});

test('a full list without a running call drops its oldest entry and counts it', () => {
  const s = session();
  for (let i = 1; i <= 21; i++) refusals.record(s, entry({ url: `https://evil.test/${i}` }));
  assert.strictEqual(s.refusals.length, 20);
  assert.strictEqual(s.refusals[0].url, 'https://evil.test/2');
  assert.strictEqual(s.droppedRefusals, 1);
});

test('a full list drops by seq, not by list order, so a repeat restamped since keeps its place', () => {
  const s = session();
  for (let i = 1; i <= 20; i++) refusals.record(s, entry({ url: `https://evil.test/${i}` }));
  refusals.record(s, entry({ url: 'https://evil.test/1' }));
  refusals.record(s, entry({ url: 'https://evil.test/21' }));
  assert.deepStrictEqual(urls(s.refusals).slice(0, 2), ['https://evil.test/1', 'https://evil.test/3'], 'the second entry, now the lowest seq, went');
  assert.strictEqual(s.refusals[0].count, 2);
});

test('a full list during a call drops the oldest entry that the call can\'t claim, or the oldest when it can claim them all', () => {
  const s = session();
  s.marks = { seq: 0, nextTab: 9, workingTargetId: 'T1', newTab: null };
  refusals.record(s, entry({ url: 'https://own-first.test/' }));
  for (let i = 1; i <= 19; i++) refusals.record(s, entry({ url: `https://elsewhere.test/${i}`, targetId: 'T2', tab: 2 }));
  refusals.record(s, entry({ url: 'https://own-second.test/' }));
  assert.ok(urls(s.refusals).includes('https://own-first.test/'), 'the call\'s own entry survives');
  assert.ok(!urls(s.refusals).includes('https://elsewhere.test/1'), 'the oldest of another tab\'s went');

  const all = session();
  all.marks = { seq: 0, nextTab: 9, workingTargetId: 'T1', newTab: null };
  for (let i = 1; i <= 21; i++) refusals.record(all, entry({ url: `https://own.test/${i}` }));
  assert.strictEqual(all.refusals[0].url, 'https://own.test/2', 'every entry is the call\'s, so the oldest went');
  assert.strictEqual(all.droppedRefusals, 1);
});

test('takeRest takes every entry left with the dropped count, and resets both', () => {
  const s = session();
  for (let i = 1; i <= 22; i++) refusals.record(s, entry({ url: `https://evil.test/${i}` }));
  const { entries, dropped } = refusals.takeRest(s);
  assert.strictEqual(entries.length, 20);
  assert.strictEqual(dropped, 2);
  assert.deepStrictEqual(refusals.takeRest(s), { entries: [], dropped: 0 });
  assert.strictEqual(s.refusalCount, 22, 'the counter goes on, so a later seq stays past every mark');
});
