const { test } = require('node:test');
const assert = require('node:assert');
const { Ring, issued, readAfter, printEntries } = require('../server/ring');

test('a ring keeps its last `cap` entries, oldest out, and numbers each from the one daemon-wide counter', () => {
  const ring = new Ring(3);
  const other = new Ring(3);
  const first = issued();
  const a = ring.push({ text: 'a' });
  const b = other.push({ text: 'b' });
  const c = ring.push({ text: 'c' });
  assert.deepStrictEqual([a.n, b.n, c.n], [first + 1, first + 2, first + 3], 'one counter numbers both lists');
  assert.strictEqual(issued(), first + 3);
  ring.push({ text: 'd' });
  ring.push({ text: 'e' });
  assert.deepStrictEqual(ring.after(0).entries.map((e) => e.text), ['c', 'd', 'e'], 'the oldest went past the cap');
});

test('after(n) returns the entries numbered above n, oldest first, and the highest number dropped above n', () => {
  const ring = new Ring(2);
  const [a, b, c] = ['a', 'b', 'c'].map((text) => ring.push({ text }));
  assert.deepStrictEqual(ring.after(a.n - 1), { entries: [b, c], missedThrough: a.n }, 'a cursor below the drop missed it');
  assert.deepStrictEqual(ring.after(a.n), { entries: [b, c], missedThrough: null }, 'a cursor at the drop missed nothing');
  assert.deepStrictEqual(ring.after(b.n), { entries: [c], missedThrough: null });
  assert.deepStrictEqual(ring.after(c.n), { entries: [], missedThrough: null });
  assert.deepStrictEqual(new Ring(5).after(0), { entries: [], missedThrough: null });
});

test("readAfter gives the Missed: line for a drop and for a cursor from before a restart, which lists every entry kept, and Next: is issued() as it reads", () => {
  const ring = new Ring(2);
  const [a, b, c] = ['a', 'b', 'c'].map((text) => ring.push({ text }));
  assert.deepStrictEqual(readAfter(ring, a.n - 1), { entries: [b, c], missed: `Missed: the tab dropped entries up to [${a.n}]`, next: issued() });
  assert.deepStrictEqual(readAfter(ring, b.n), { entries: [c], missed: null, next: issued() });
  const stale = issued() + 100;
  assert.deepStrictEqual(readAfter(ring, stale), { entries: [b, c], missed: `Missed: the daemon restarted since after=${stale}`, next: issued() });
  assert.deepStrictEqual(readAfter(null, 0), { entries: [], missed: null, next: issued() }, 'a tab that never captured reads as empty');
});

test("printEntries prints within 40,000 characters, cuts at the entry that doesn't fit or whose text is null, and gives a cut's after as its Next:", async () => {
  const entries = [{ n: 7, size: 20_000 }, { n: 9, size: 19_999 }, { n: 12, size: 1 }, { n: 13, size: 1 }];
  const text = (entry) => 'x'.repeat(entry.size);
  const full = await printEntries(entries.slice(0, 2), 50, text);
  assert.deepStrictEqual({ ...full, lines: full.lines.map((line) => line.length) }, { lines: [20_000, 19_999], printed: 2, used: 40_001, next: 50 }, 'two lines and the break between them fill the budget exactly');
  const over = await printEntries([entries[0], { n: 9, size: 20_000 }], 50, text);
  assert.deepStrictEqual([over.lines[1], over.printed, over.next], ['… 1 more; call again with after=8', 1, 8], 'a character more is cut');
  const after = await printEntries(entries.slice(0, 3), 50, text);
  assert.deepStrictEqual([after.lines[2], after.printed, after.next], ['… 1 more; call again with after=11', 2, 11]);
  const used = [];
  const declined = await printEntries(entries.slice(2), 50, (entry, sofar) => { used.push(sofar); return entry.n === 13 ? null : 'a'; });
  assert.deepStrictEqual(declined, { lines: ['a', '… 1 more; call again with after=12'], printed: 1, used: 2, next: 12 });
  assert.deepStrictEqual(used, [0, 2], 'each text learns the characters printed before it');
});
