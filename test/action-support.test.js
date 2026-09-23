// The page-script sources action-support.js assembles: the shared state snippet is spliced
// into the walk and click scripts, each result is one parseable function, and the
// renderer's source is the libraries plus render.js, evaluable as one script.

const { test, mock } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const Module = require('node:module');
const vm = require('node:vm');
const { WALK_SOURCE, CLICK_SOURCE, SCROLL_SOURCE, renderSource, stateLines } = require('../server/action-support');

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

// Before the test that succeeds: a successful renderSource() is kept, so a later test
// could no longer make the libraries unreadable.
test('a library the renderer cannot read is a setup error naming the install command', (t) => {
  const readFileSync = fs.readFileSync;
  t.after(() => mock.restoreAll());
  mock.method(fs, 'readFileSync', (file, ...rest) => {
    if (String(file).includes('turndown-plugin-gfm')) throw new Error('ENOENT: no such file or directory');
    return readFileSync(file, ...rest);
  });
  assert.throws(() => renderSource(), (e) => {
    assert.strictEqual(e.name, 'SetupError');
    assert.match(e.message, /turndown-plugin-gfm/);
    assert.match(e.message, /npm --prefix server ci --ignore-scripts/);
    return true;
  });
});

// Also before the test that succeeds: a library a release made unresolvable — one that
// gains an exports map, say — is the other half of the setup error.
test('a library that cannot be resolved is a setup error naming it and the install command', (t) => {
  const resolveFilename = Module._resolveFilename;
  t.after(() => mock.restoreAll());
  mock.method(Module, '_resolveFilename', function resolve(request, ...rest) {
    if (String(request).startsWith('@mozilla/readability')) throw new Error(`Cannot find module '${request}'`);
    return resolveFilename.call(this, request, ...rest);
  });
  assert.throws(() => renderSource(), (e) => {
    assert.strictEqual(e.name, 'SetupError');
    assert.match(e.message, /needs @mozilla\/readability\/Readability\.js, which is not installed/);
    assert.match(e.message, /npm --prefix server ci --ignore-scripts/);
    return true;
  });
});

test('the renderer source carries the libraries and render.js, and binds each name a world needs', (t) => {
  const source = renderSource();
  t.after(() => mock.restoreAll());
  const readFileSync = mock.method(fs, 'readFileSync');
  assert.strictEqual(renderSource(), source);
  assert.strictEqual(readFileSync.mock.callCount(), 0, 'built once and kept, since a read asks for it per unit');
  assert.strictEqual((source.match(/function claudesurfState\(/g) || []).length, 1, 'one copy of the state snippet');
  assert.strictEqual((source.match(/function claudesurfMasked\(/g) || []).length, 1);
  assert.ok(!source.includes('@include'), 'marker replaced');
  // An isolated world evaluates it as a script, where a declaration binds a global.
  const world = vm.createContext({});
  vm.runInNewContext(source, world);
  for (const name of ['claudesurfRender', 'Readability', 'isProbablyReaderable', 'TurndownService']) {
    assert.strictEqual(typeof world[name], 'function', name);
  }
  assert.strictEqual(typeof world.turndownPluginGfm.tables, 'function');
});

test('safeUrl drops a NUL and the filler on its own, whatever path a URL reached it by', () => {
  const { safeUrl } = require('../server/action-support');
  assert.strictEqual(safeUrl('http://a.test/\u0000x\uE000y'), 'http://a.test/xy');
});

test('the URL and Title lines are safe against a page that writes a marker into either', () => {
  const lines = stateLines('http://a.test/x)[e7](', 'The title] [Sign out](/logout)[e7]\u0000\ue000\u2028tail');
  assert.strictEqual(
    lines,
    'URL: http://a.test/x%29%5Be7%5D%28\nTitle: The title\\] \\[Sign out\\](/logout)\\[e7\\] tail',
    "the two characters the renderer reserves — the placeholder's NUL and the filler — are gone with the rest",
  );
  assert.ok(!/(?<!\\)\[e7[ \]]/.test(lines), 'no live marker survives in either header line');
});
