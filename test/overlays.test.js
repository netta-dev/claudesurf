// overlays.js against the in-process fake: which picked overlays render as blocks and
// in what order, the four-block and eight-call limits, the skips, the cut, and what a
// block returns for the read around it.

const { test } = require('node:test');
const assert = require('node:assert');
const { Snapshot } = require('../server/snapshot');
const { TargetGoneError } = require('../server/sessions');
const { renderOverlayBlocks } = require('../server/overlays');
const { navigatedSession } = require('./helpers');
const { bareNode } = require('./fixtures/ax/nodes');

const URL = 'http://a.test/';

// Navigates to a page whose tree holds `overlays`, each [backendId, role, name, extra],
// under the root after a main landmark, and whose overlay renders are the ones that
// `answers` describes by ref. Resolves with the setup's context, `render()`, and
// `calls()`, the overlay render calls made so far.
async function setup(t, overlays, answers = {}, extra = {}) {
  const tree = [
    bareNode(1, 'RootWebArea', 'A', { childIds: ['2', ...overlays.map(([id]) => String(id))] }),
    bareNode(2, 'main', ''),
    ...overlays.map(([id, role, name, more = {}]) => bareNode(id, role, name, more)),
    ...(extra.nodes || []),
  ];
  const fixture = { title: 'A', text: 'Main text.', tree, elements: extra.elements || [], overlays: answers, scrollY: 0, pageHeight: 1000, viewportHeight: 600 };
  const ctx = await navigatedSession({ t, url: URL, site: { [URL]: fixture } });
  const { target } = ctx;
  const snapshot = new Snapshot(tree);
  const page = { target, frameId: null, prefix: '', index: 0, label: 'page', snapshot, rootBackendId: null, generation: target.generation };
  const render = () => renderOverlayBlocks(ctx.sessions, page, snapshot.overlays, { links: 'inline' });
  const calls = () => ctx.fake.callsTo('Runtime.callFunctionOn').filter((c) => /claudesurfRender\(/.test(c.params.functionDeclaration) && c.params.arguments[0].value.overlay);
  return { ...ctx, snapshot, render, calls };
}

test('dialogs and alert dialogs take the render slots first, then the rest in tree order', async (t) => {
  const { render } = await setup(t, [
    [10, 'status', 'Saved'], [11, 'menu', 'Page menu'], [12, 'dialog', 'Confirm'], [13, 'alert', 'Error'], [14, 'alertdialog', 'Warning'],
  ], { e10: { text: 'Saved.' }, e11: { text: 'Menu.' }, e12: { text: 'Confirm?' }, e13: { text: 'Error!' }, e14: { text: 'Careful.' } });
  const { overlayBlocks, more } = await render();
  assert.deepStrictEqual(overlayBlocks.map((b) => b.ref), ['e12', 'e14', 'e10', 'e11']);
  assert.deepStrictEqual(more, ['e13'], 'the fifth is past the four blocks');
  assert.deepStrictEqual(overlayBlocks.map((b) => b.markdown), ['Confirm?', 'Careful.', 'Saved.', 'Menu.']);
});

test('at most four blocks render from at most eight calls, and the overlays past either limit are named by ref', async (t) => {
  const overlays = Array.from({ length: 12 }, (unused, i) => [20 + i, 'status', `Status ${i}`]);
  const answers = Object.fromEntries(overlays.map(([id], i) => [`e${id}`, i < 6 ? { hidden: true } : { text: `Status ${i} text.` }]));
  const { render, calls } = await setup(t, overlays, answers);
  const { overlayBlocks, more } = await render();
  assert.strictEqual(calls().length, 8, 'six skips and two blocks spent the eight calls');
  assert.deepStrictEqual(overlayBlocks.map((b) => b.ref), ['e26', 'e27']);
  assert.deepStrictEqual(more, ['e28', 'e29', 'e30', 'e31'], 'each overlay past the calls counts as one more');
  const four = await setup(t, overlays.slice(0, 6), Object.fromEntries(overlays.slice(0, 6).map(([id]) => [`e${id}`, { text: 'x' }])));
  const blocks = await four.render();
  assert.deepStrictEqual([blocks.overlayBlocks.length, blocks.more], [4, ['e24', 'e25']]);
  assert.strictEqual(four.calls().length, 4, 'no call is spent past the four blocks');
});

test('a root that is hidden, gone, or a screen-reader announcement is skipped without counting toward the blocks or the more list', async (t) => {
  const { render } = await setup(t, [
    [10, 'status', 'Faded'], [11, 'dialog', 'Gone'], [12, 'alert', 'Route announced'], [13, 'status', 'Empty'], [14, 'status', 'Shown'],
  ], { e10: { hidden: true }, e11: { lost: true }, e12: { tiny: true }, e13: { text: '' }, e14: { text: 'Shown text.' } });
  const { overlayBlocks, more } = await render();
  assert.deepStrictEqual(overlayBlocks.map((b) => b.ref), ['e14']);
  assert.deepStrictEqual(more, []);
});

test("a block is cut on a line at 4,000 characters of its own text, says so, and keeps only the refs left in it", async (t) => {
  const line = 'A line of the dialog that fills it. '.repeat(3);
  const text = Array.from({ length: 60 }, () => line).join('\n');
  const markdown = `[e11 button "Early"]\n${text}\n[e12 button "Late"]`;
  const { render } = await setup(t, [[10, 'dialog', 'Long', { childIds: ['11', '12'] }]], {
    e10: (options, descriptors) => ({ markdown, links: [], chain: 'ref', refs: ['e11', 'e12'], hiddenRefs: [], article: null }),
  }, { nodes: [bareNode(11, 'button', 'Early'), bareNode(12, 'button', 'Late')] });
  const [block] = (await render()).overlayBlocks;
  const [kept, closing] = [block.markdown.slice(0, block.markdown.lastIndexOf('\n')), block.markdown.slice(block.markdown.lastIndexOf('\n') + 1)];
  assert.ok(markdown.startsWith(kept) && markdown[kept.length] === '\n', `the block's own text is cut at a line end (${kept.length})`);
  assert.strictEqual(kept.length, markdown.lastIndexOf('\n', 4000), 'the last one within 4,000 characters');
  assert.strictEqual(kept.split('\n').at(-1), line, 'so its last line is whole');
  assert.strictEqual(closing, '… cut; scope=e10 reads it whole');
  assert.deepStrictEqual(block.refs, ['e11'], 'the control past the cut stays counted');
});

test("a block whose render throws renders as not readable, and a render whose target went fails the read", async (t) => {
  const { render } = await setup(t, [[10, 'dialog', 'Broken'], [11, 'status', 'Fine']], { e10: { throws: 'boom' }, e11: { text: 'Fine.' } });
  const { overlayBlocks } = await render();
  assert.deepStrictEqual(overlayBlocks.map(({ ref, unreadable, markdown }) => ({ ref, unreadable: Boolean(unreadable), markdown })), [
    { ref: 'e10', unreadable: true, markdown: '' },
    { ref: 'e11', unreadable: false, markdown: 'Fine.' },
  ]);
  // The first block's render closes the tab, so the second finds its target gone.
  const gone = await setup(t, [[10, 'dialog', 'Closer'], [11, 'status', 'After']], {
    e10: (options, descriptors, tab) => { gone.fake.destroyTarget(tab.targetId); return { markdown: 'x', links: [], chain: 'ref', refs: [], hiddenRefs: [], article: null }; },
    e11: { text: 'After.' },
  });
  await assert.rejects(gone.render(), TargetGoneError);
});

test('a block returns its links, and its hidden controls apart from the refs it rendered', async (t) => {
  const elements = [
    { kind: 'link', label: 'Help', href: 'http://a.test/help', backendNodeId: 11, visible: true },
    { kind: 'button', label: 'Hidden', backendNodeId: 12, visible: false },
  ];
  const { render } = await setup(t, [[10, 'dialog', 'With links', { childIds: ['11', '12'] }]], { e10: { text: 'Dialog text.' } }, {
    elements,
    nodes: [
      bareNode(11, 'link', 'Help', { properties: [{ name: 'url', value: { value: 'http://a.test/help' } }] }),
      bareNode(12, 'button', 'Hidden'),
    ],
  });
  const [block] = (await render()).overlayBlocks;
  assert.deepStrictEqual(block.links, [{ ref: 'e11', url: 'http://a.test/help' }]);
  assert.deepStrictEqual(block.hiddenRefs, ['e12']);
  assert.deepStrictEqual(block.refs, ['e11']);
  assert.match(block.markdown, /^Dialog text\.\n\n\[Help\]\(http:\/\/a\.test\/help\)\[e11\]$/);
});
