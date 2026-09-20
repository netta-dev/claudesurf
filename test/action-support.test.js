// The page-script sources action-support.js assembles: the shared state snippet is spliced
// into the walk and click scripts, and each result is one parseable function.

const { test } = require('node:test');
const assert = require('node:assert');
const { WALK_SOURCE, CLICK_SOURCE, SCROLL_SOURCE } = require('../server/action-support');

test('walk and click each carry one copy of claudesurfState and no include marker', () => {
  for (const source of [WALK_SOURCE, CLICK_SOURCE]) {
    assert.strictEqual((source.match(/function claudesurfState\(/g) || []).length, 1);
    assert.ok(!source.includes('@include'), 'marker replaced');
  }
  assert.ok(!SCROLL_SOURCE.includes('claudesurfState'));
});

test('each source is a single function declaration', () => {
  for (const [name, source] of [['claudesurfWalk', WALK_SOURCE], ['claudesurfClick', CLICK_SOURCE], ['claudesurfScroll', SCROLL_SOURCE]]) {
    const fn = new Function(`return (${source});`)();
    assert.strictEqual(typeof fn, 'function');
    assert.strictEqual(fn.name, name);
  }
});
