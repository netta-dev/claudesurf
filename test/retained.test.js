// retained.js: the size cap on a kept render, and the size marker that stands in for a
// render past it.

const { test } = require('node:test');
const assert = require('node:assert');
const retained = require('../server/retained');

test('a render is kept up to 500,000 characters of region, hidden section, overlay blocks, and link lists together, and past that leaves a marker of its size', () => {
  const session = { retained: new Map() };
  const tab = { targetId: 'T1', generation: 3 };
  const keep = (region, hiddenSection = '', overlayBlocks = [], linkLists = []) => retained.keep(session, tab, {
    params: { scope: 'main', article: false, links: 'inline', hidden: false }, overlayBlocks, region, linkLists,
    hiddenSection, header: {}, source: 'read', startedAt: 0, generation: 3,
  });
  const chars = (n) => 'x'.repeat(n);
  assert.strictEqual(keep(chars(500_000)), true, 'a region at the cap is kept');
  assert.strictEqual(retained.current(session, tab).region.length, 500_000);
  assert.strictEqual(keep(chars(500_001)), false, 'one character past it is not');
  assert.deepStrictEqual(retained.current(session, tab), { tooLarge: true, generation: 3, size: 500_001 });
  assert.strictEqual(keep(chars(400_000), chars(50_000), [chars(30_000), chars(20_000)]), true, 'the three parts together at the cap');
  assert.strictEqual(keep(chars(400_000), chars(100_001)), false, 'the hidden section counts');
  assert.deepStrictEqual(retained.current(session, tab), { tooLarge: true, generation: 3, size: 500_001 });
  assert.strictEqual(keep(chars(400_000), '', [chars(50_000), chars(50_001)]), false, 'and so does every overlay block');
  assert.deepStrictEqual(retained.current(session, tab), { tooLarge: true, generation: 3, size: 500_001 });
  const link = (ref, urlChars) => ({ ref, url: chars(urlChars) });
  assert.strictEqual(keep(chars(400_000), '', [], [[link('e1', 49_998)], [link('e2', 49_998)]]), true, 'link lists at the cap');
  assert.strictEqual(keep(chars(400_000), '', [], [[link('e1', 49_998)], [link('e2', 49_999)]]), false, 'and each link list counts, by its URLs and refs');
  assert.deepStrictEqual(retained.current(session, tab), { tooLarge: true, generation: 3, size: 500_001 });
});
