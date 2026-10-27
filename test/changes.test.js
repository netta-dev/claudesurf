// changes.js against the in-process fake: the change summary and a `since` read's
// diff — what each says when the renders can't be compared, how each maps a render
// that failed, and the Changed: line and hunks of a render that didn't.

const { test, mock } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { TimeoutError, ConnectionClosedError } = require('../server/cdp');
const { OutcomeError } = require('../server/action-support');
const retained = require('../server/retained');
const { renderChanges } = require('../server/changes');
const { RenderError, DocumentChangedError } = require('../server/region');
const { navigatedSession, readPayload, refsIn } = require('./helpers');
const { FRAME_URL, attachFrame } = require('./frame-setup');
const { bareNode } = require('./fixtures/ax/nodes');

const URL = 'http://a.test/';

// Returns a fake-site fixture with two lines of text and a tree that holds one button
// in a main landmark; `extra`'s fields replace the defaults.
function page(extra = {}) {
  return {
    title: 'A', text: 'First line.\n\nSecond line.', scrollY: 0, pageHeight: 1200, viewportHeight: 600,
    tree: [
      bareNode(1, 'RootWebArea', 'A', { childIds: ['2'] }),
      bareNode(2, 'main', '', { childIds: ['3'] }),
      bareNode(3, 'button', 'Go'),
    ],
    elements: [{ kind: 'button', label: 'Go', backendNodeId: 3, visible: true, disabled: false, checked: false }],
    ...extra,
  };
}

// Navigates the working tab to `fixture` and reads it with `read`, which leaves its
// retained render; a null `read` skips the read. Resolves with the setup's context,
// the read's answer as `first`, and `changes(source, deadline)`.
async function setup(t, fixture = page(), read = {}) {
  const ctx = await navigatedSession({ t, url: URL, site: { [URL]: fixture } });
  const { session, target } = ctx;
  // A scoped read takes a ref that an earlier read returned.
  if (read && read.scope) await readPayload(ctx.sessions, session, { maxChars: 40000, offset: 0 });
  const first = read === null ? null : await readPayload(ctx.sessions, session, { maxChars: 40000, offset: 0, ...read });
  const changes = (source = 'summary', deadline = Date.now() + 20_000) => renderChanges(ctx.sessions, session, target, { source, deadline });
  return { ...ctx, site: fixture, first, changes, tab: ctx.fake.targets.get(target.targetId) };
}

// Holds the next tree pull of the target `tab` until the deadline, or lets `act` run in
// its place.
function onTreePull(fake, tab, act) {
  const original = fake.handlers.get('Accessibility.getFullAXTree');
  let once = true;
  fake.handle('Accessibility.getFullAXTree', (params, sid) => {
    if (once && sid === tab.sessionId) { once = false; return act(params, sid, original); }
    return original(params, sid);
  });
}

// This test runs first in this file: renderSource() keeps its result once it succeeds, so a later test
// could not make the libraries unreadable. The retained render is planted rather than
// read, since a read would build the renderer.
test('a setup failure during the render is not measured under summary, and reaches a since read as the setup error it is', async (t) => {
  const { changes, session, target } = await setup(t, page(), null);
  retained.keep(session, target, {
    params: { scope: 'main', article: false, links: 'inline', hidden: false }, overlayBlocks: [], region: 'First line.', linkLists: [],
    hiddenSection: '', header: {}, source: 'read', startedAt: Date.now(), generation: target.generation,
  });
  const readFileSync = fs.readFileSync;
  t.after(() => mock.restoreAll());
  mock.method(fs, 'readFileSync', (file, ...rest) => {
    if (String(file).includes('turndown-plugin-gfm')) throw new Error('ENOENT: no such file or directory');
    return readFileSync(file, ...rest);
  });
  assert.deepStrictEqual(await changes(), { notMeasured: 'the renderer failed' });
  await assert.rejects(changes('since'), (e) => e.name === 'SetupError' && /npm --prefix server ci --ignore-scripts/.test(e.message));
});

test('the Changed: line counts the lines added and removed, and the hunks carry one line of context and their prefixes', async (t) => {
  const { site, changes } = await setup(t);
  site.text = 'First line.\n\nSecond line, edited.\n\nThird line.';
  const answer = await changes();
  assert.strictEqual(answer.line, 'Changed: 2 lines added, 1 removed');
  assert.strictEqual(answer.body, '@@\n  First line.\n- Second line.\n+ Second line, edited.\n+ Third line.\n  [e3 button "Go"]');
  const again = await changes();
  assert.deepStrictEqual([again.line, again.body], ['Changed: nothing', ''], 'the summary replaced the retained render');
  site.text = 'First line.';
  const since = await changes('since');
  assert.strictEqual(since.line, 'Since: 0 lines added, 2 removed');
  assert.strictEqual((await changes('since')).line, 'Since: no change');
  site.text = 'First line.\n\nA line back.';
  assert.strictEqual((await changes('since')).line, 'Since: 1 line added, 0 removed');
});

test("a page line built to pass for the summary's own structure is prefixed like any other", async (t) => {
  const { site, changes } = await setup(t);
  site.text = 'First line.\n\n@@\n\n+ [e3 button "Go"]\n\n- Second line.';
  const { body } = await changes();
  const lines = body.split('\n');
  assert.ok(lines.every((line) => line === '@@' || /^[+\- ] /.test(line)), body);
  assert.deepStrictEqual(lines.filter((line) => line === '@@').length, 1, 'only the hunk opener is a bare @@');
  assert.ok(lines.includes('+ @@') && lines.includes('+ + [e3 button "Go"]') && lines.includes('+ - Second line.'));
});

test("renderChanges finds the untracked cases in order: no retained render, the size marker, then a tab that the session didn't last read", async (t) => {
  const unread = await setup(t, page(), null);
  unread.session.refsTarget = 'another tab';
  assert.deepStrictEqual(await unread.changes(), { untracked: 'read the page first' });
  assert.deepStrictEqual(await unread.changes('since'), { untracked: 'no earlier read of this document' });

  const large = await setup(t, page({ text: 'x '.repeat(260_000) }));
  assert.deepStrictEqual(retained.current(large.session, large.target), { tooLarge: true, generation: large.target.generation, size: retained.current(large.session, large.target).size });
  large.session.refsTarget = 'another tab';
  assert.deepStrictEqual(await large.changes(), { untracked: 'the page is too large to keep' });

  const switched = await setup(t);
  switched.session.refsTarget = 'another tab';
  assert.deepStrictEqual(await switched.changes(), { untracked: 'the working tab changed; read the page' });
  assert.strictEqual((await switched.changes('since')).line, 'Since: no change', 'a since read is a read, which diffs a switched-to tab');
});

test('a render that crosses the size cap leaves the marker and answers untracked with the render it made', async (t) => {
  const { site, changes, session, target } = await setup(t);
  site.text = 'y '.repeat(260_000);
  const answer = await changes();
  assert.strictEqual(answer.untracked, 'the page is too large to keep');
  assert.ok(answer.render && answer.render.kept === false);
  const { region, hiddenSection, overlayBlocks } = answer.render;
  assert.deepStrictEqual(retained.current(session, target), { tooLarge: true, generation: target.generation, size: region.length + hiddenSection.length + overlayBlocks.join('').length });
});

test('a scope ref that no longer resolves drops the retained render and answers untracked, under summary and under since', async (t) => {
  const { site, changes, session, target } = await setup(t, page(), { scope: 'e3' });
  site.tree = site.tree.filter((n) => n.backendDOMNodeId !== 3);
  site.tree[1].childIds = [];
  assert.deepStrictEqual(await changes(), { untracked: 'the scope e3 is gone; read the page again' });
  assert.strictEqual(retained.current(session, target), null, 'the retained render went with its scope');
  const again = await setup(t, page(), { scope: 'e3' });
  again.site.tree = again.site.tree.filter((n) => n.backendDOMNodeId !== 3);
  assert.deepStrictEqual(await again.changes('since'), { untracked: 'the scope e3 is gone' });
  assert.strictEqual(retained.current(again.session, again.target), null, 'and so did the one a since read diffed against');
});

test("a ref root that goes between the tree pull and the render answers untracked rather than diffing the body, and the main root's loss as a changed document", async (t) => {
  const scoped = await setup(t, page(), { scope: 'e3' });
  scoped.site.lostRoot = true;
  assert.deepStrictEqual(await scoped.changes(), { untracked: 'the scope e3 is gone; read the page again' });
  const main = await setup(t);
  main.site.lostRoot = true;
  assert.deepStrictEqual(await main.changes(), { notMeasured: 'the document changed while it was rendered' });
  await assert.rejects(main.changes('since'), DocumentChangedError);
});

test('a ref scope whose document a navigation replaced during the tree pull or the render is a changed document rather than a scope that went, and the retained render stays', async (t) => {
  // Each navigates the tab as its step answers; the render then reports its root lost,
  // as the page script does when its root isn't in the document.
  const during = {
    pull: (ctx) => onTreePull(ctx.fake, ctx.tab, (params, sid, original) => {
      const nodes = original(params, sid);
      ctx.fake.navigateTarget(ctx.tab, URL);
      return nodes;
    }),
    render: (ctx) => {
      const original = ctx.fake.handlers.get('Runtime.callFunctionOn');
      ctx.fake.handle('Runtime.callFunctionOn', (params, sid) => {
        if (/claudesurfRender\(/.test(params.functionDeclaration)) ctx.fake.navigateTarget(ctx.tab, URL);
        return original(params, sid);
      });
    },
  };
  for (const [step, navigateDuring] of Object.entries(during)) {
    for (const source of ['summary', 'since']) {
      const ctx = await setup(t, page(), { scope: 'e3' });
      const kept = ctx.session.retained.get(ctx.target.targetId);
      ctx.site.lostRoot = true;
      navigateDuring(ctx);
      const answer = ctx.changes(source);
      if (source === 'summary') assert.deepStrictEqual(await answer, { notMeasured: 'the document changed while it was rendered' }, step);
      else await assert.rejects(answer, DocumentChangedError, step);
      assert.strictEqual(ctx.session.retained.get(ctx.target.targetId), kept, `${step}, ${source}`);
    }
  }
});

test("a render that throws is not measured under summary, and fails a since read", async (t) => {
  const { site, changes } = await setup(t);
  site.render = () => { throw new Error('Cannot read properties of null'); };
  assert.deepStrictEqual(await changes(), { notMeasured: 'the renderer failed' });
  await assert.rejects(changes('since'), RenderError);
});

test("a render that times out is not measured because the deadline passed, and so is a tree pull that does", async (t) => {
  const { fake, site, changes, tab } = await setup(t);
  site.render = () => new Promise(() => {});
  const original = fake.handlers.get('Runtime.callFunctionOn');
  fake.handle('Runtime.callFunctionOn', (params, sid) => (/claudesurfRender\(/.test(params.functionDeclaration) ? new Promise(() => {}) : original(params, sid)));
  assert.deepStrictEqual(await changes('summary', Date.now() + 300), { notMeasured: 'the deadline passed' });
  fake.handle('Runtime.callFunctionOn', original);
  delete site.render;
  onTreePull(fake, tab, () => new Promise(() => {}));
  assert.deepStrictEqual(await changes('summary', Date.now() + 300), { notMeasured: 'the deadline passed' });
  onTreePull(fake, tab, () => new Promise(() => {}));
  await assert.rejects(changes('since', Date.now() + 300), TimeoutError, 'a since read takes the daemon\'s mapping');
});

test("a document that changes during the render is not measured, and fails a since read", async (t) => {
  const { fake, changes, tab } = await setup(t);
  onTreePull(fake, tab, (params, sid, original) => {
    const nodes = original(params, sid);
    fake.navigateTarget(tab, URL);
    return nodes;
  });
  assert.deepStrictEqual(await changes(), { notMeasured: 'the document changed while it was rendered' });
  const again = await setup(t);
  onTreePull(again.fake, again.tab, (params, sid, original) => {
    const nodes = original(params, sid);
    again.fake.navigateTarget(again.tab, URL);
    return nodes;
  });
  await assert.rejects(again.changes('since'), DocumentChangedError);
});

test("a hidden=true render whose walk's stashed array went is a document that changed: not measured under summary, the retained render kept, and an error under since", async (t) => {
  const fixture = page();
  fixture.elements.push({ kind: 'button', label: 'Shade', backendNodeId: 4, visible: false, disabled: false, checked: false });
  const { fake, changes, session, target } = await setup(t, fixture, { hidden: true });
  const kept = retained.current(session, target);
  assert.match(kept.hiddenSection, /\[e4\] button "Shade"/);
  const evaluate = fake.handlers.get('Runtime.evaluate');
  fake.handle('Runtime.evaluate', (params, sid) => (params.expression === 'globalThis.__claudesurfElements' ? { result: { type: 'undefined' } } : evaluate(params, sid)));
  assert.deepStrictEqual(await changes(), { notMeasured: 'the document changed while it was rendered' });
  assert.strictEqual(retained.current(session, target), kept);
  await assert.rejects(changes('since'), DocumentChangedError);
});

test("a protocol error from the page's own tree pull is not measured because the renderer failed", async (t) => {
  const { fake, changes, tab } = await setup(t);
  onTreePull(fake, tab, () => { throw { code: -32000, message: 'Accessibility is not enabled' }; });
  assert.deepStrictEqual(await changes(), { notMeasured: 'the renderer failed' });
  onTreePull(fake, tab, () => { throw { code: -32000, message: 'Accessibility is not enabled' }; });
  await assert.rejects(changes('since'), /Accessibility is not enabled/, 'a since read takes the daemon\'s mapping');
});

test('a failure after the working tab closed, or after the pipe closed, reaches the caller rather than answering', async (t) => {
  const { fake, changes, tab } = await setup(t);
  onTreePull(fake, tab, () => { fake.destroyTarget(tab.targetId); return new Promise(() => {}); });
  await assert.rejects(changes('summary', Date.now() + 300), TimeoutError, "the pull the tab's close left unanswered");
  const piped = await setup(t);
  onTreePull(piped.fake, piped.tab, () => { piped.fake.close(); return new Promise(() => {}); });
  await assert.rejects(piped.changes('summary', Date.now() + 2_000), ConnectionClosedError);
  const gone = await setup(t);
  onTreePull(gone.fake, gone.tab, () => { gone.fake.destroyTarget(gone.tab.targetId); throw { code: -32000, message: 'Target closed' }; });
  await assert.rejects(gone.changes(), /Target closed/, 'a protocol error from a tab that went is no summary of it');
  const ends = [[(ctx) => ctx.fake.destroyTarget(ctx.tab.targetId), TimeoutError], [(ctx) => ctx.fake.close(), ConnectionClosedError]];
  for (const [end, error] of ends) {
    const since = await setup(t);
    onTreePull(since.fake, since.tab, () => { end(since); return new Promise(() => {}); });
    await assert.rejects(since.changes('since', Date.now() + 2_000), error, 'and so does a since read');
  }
});

// Sets up a page holding one out-of-process frame at backend id 90, attaches the frame,
// and reads the page with the scope that `scopeOf(refs, payload)` picks from a first
// read, so the retained render is frame-scoped. Resolves with the setup's context, the
// frame's fake target, and the scope.
async function setupFrame(t, scopeOf) {
  const fixture = page({
    tree: [
      bareNode(1, 'RootWebArea', 'A', { childIds: ['2'] }),
      bareNode(2, 'main', '', { childIds: ['90'] }),
      { nodeId: '90', role: { value: 'Iframe' }, name: { value: '' }, backendDOMNodeId: 90 },
    ],
    elements: [],
    childFrames: [{ backendId: 90, url: FRAME_URL }],
  });
  const ctx = await setup(t, fixture, null);
  ctx.fake.site[FRAME_URL] = page({ title: 'Child', text: 'Frame text.' });
  const frameTab = await attachFrame(ctx, ctx.tab, 90);
  const first = await readPayload(ctx.sessions, ctx.session, { maxChars: 40000, offset: 0 });
  const scope = scopeOf(refsIn(first.payload), first.payload);
  await readPayload(ctx.sessions, ctx.session, { maxChars: 40000, offset: 0, scope });
  return { ...ctx, frameTab, scope };
}

test("a scoped frame target that goes during the summary's render answers untracked, as its scope is gone", async (t) => {
  const { fake, changes, frameTab, scope } = await setupFrame(t, (refs) => refs.Go);
  assert.match(scope, /^f1e\d+$/);
  onTreePull(fake, frameTab, () => { fake.destroyTarget(frameTab.targetId); return new Promise(() => {}); });
  assert.deepStrictEqual(await changes(), { untracked: `the scope ${scope} is gone; read the page again` });
});

test('a tree pull that times out for a ref read inside a frame is not measured because the deadline passed', async (t) => {
  const { fake, changes, frameTab } = await setupFrame(t, (refs) => refs.Go);
  onTreePull(fake, frameTab, () => new Promise(() => {}));
  assert.deepStrictEqual(await changes('summary', Date.now() + 2_500), { notMeasured: 'the deadline passed' });
});

test("a summary over an <iframe> scope whose frame isn't readable is not measured, and keeps the retained render", async (t) => {
  const { fake, changes, frameTab, session, target } = await setupFrame(t, () => 'e90');
  const kept = retained.current(session, target);
  onTreePull(fake, frameTab, () => { throw { code: -32000, message: 'Frame with the given id was not found.' }; });
  assert.deepStrictEqual(await changes(), { notMeasured: 'the frame e90 was not readable' });
  assert.strictEqual(retained.current(session, target), kept);
  onTreePull(fake, frameTab, () => { throw { code: -32000, message: 'Frame with the given id was not found.' }; });
  await assert.rejects(changes('since'), (e) => e instanceof OutcomeError && e.envelope.message === 'the frame at e90 is not readable; read the page around it instead', 'a since read answers the error a read does');
  assert.strictEqual(retained.current(session, target), kept);
});

test("a same-process frame's tree pull that fails after the frame went answers untracked", async (t) => {
  const fixture = page({
    tree: [bareNode(1, 'RootWebArea', 'A', { childIds: ['100'] }), { nodeId: '100', role: { value: 'Iframe' }, name: { value: '' }, backendDOMNodeId: 100 }],
    elements: [], childFrames: [{ backendId: 100, id: 'FRAME-SAME', url: 'http://a.test/child' }],
  });
  const ctx = await setup(t, fixture, { scope: 'e100' });
  ctx.fake.site['http://a.test/child'] = page({ title: 'Child', text: 'Child text.' });
  await readPayload(ctx.sessions, ctx.session, { maxChars: 40000, offset: 0, scope: 'e100' });
  const original = ctx.fake.handlers.get('Accessibility.getFullAXTree');
  ctx.fake.handle('Accessibility.getFullAXTree', (params, sid) => {
    if (!params.frameId) return original(params, sid);
    fixture.childFrames = [];
    throw { code: -32000, message: 'Frame with the given id was not found.' };
  });
  assert.deepStrictEqual(await ctx.changes(), { untracked: 'the scope e100 is gone; read the page again' });
});

// Returns a page() fixture whose dialog overlay e50 renders `dialog` and whose region
// renders `text`.
function withDialog(text, dialog) {
  const fixture = page({ text });
  fixture.tree[0].childIds.push('50');
  fixture.tree.push(bareNode(50, 'dialog', 'Confirm', { childIds: ['51'] }), bareNode(51, 'button', 'OK'));
  fixture.elements.push({ kind: 'button', label: 'OK', backendNodeId: 51, visible: true, disabled: false, checked: false });
  fixture.overlays = { e50: { text: dialog } };
  return fixture;
}

test("the overlays are diffed apart from the region, their hunks first, each cut at its own size", async (t) => {
  // Each has about 3,400 characters of new lines: the whole block, past the region's cut.
  const lines = (prefix) => Array.from({ length: 70 }, (unused, i) => `${prefix} line ${i} of a length that fills it.`).join('\n\n');
  const { site, changes } = await setup(t, withDialog('Region before.', 'Dialog before.'));
  site.text = lines('Region');
  site.overlays.e50.text = lines('Dialog');
  const { line, body } = await changes();
  assert.strictEqual(line, 'Changed: 140 lines added, 2 removed');
  const split = body.indexOf('\n@@\n- Region before.');
  assert.ok(split > 0, body);
  const [overlayPart, regionPart] = [body.slice(0, split), body.slice(split + 1)];
  assert.ok(overlayPart.startsWith('@@\n  [e50 dialog "Confirm"]\n- Dialog before.\n+ Dialog line 0'), 'the dialog prints first');
  assert.ok(!overlayPart.includes('more changed'), `the dialog's ${overlayPart.length} characters fit the overlays' 4,000 whole`);
  assert.ok(overlayPart.includes('+ Dialog line 69') && overlayPart.endsWith('  [e51 button "OK"]'), 'its button included');
  const regionCut = regionPart.slice(0, regionPart.indexOf('\n… '));
  assert.ok(regionCut.length <= 3000 && regionCut.length > 2500, `the region's are cut at 3,000 (${regionCut.length})`);
  assert.match(regionPart, /\n… \d+ more changed lines; read the page for the rest$/);
});

test("a summary cuts the overlays' hunks on a line at 4,000 characters and the region's at 3,000, and a since diff cuts neither", async (t) => {
  const lines = (prefix, n) => Array.from({ length: n }, (unused, i) => `${prefix} line ${String(i).padStart(3, '0')} of a length that fills it.`).join('\n\n');
  // The two dialogs each fit a block's 4,000 characters, but their combined lines exceed it.
  const fixture = withDialog('Region before.', 'Dialog before.');
  fixture.tree[0].childIds.push('60');
  fixture.tree.push(bareNode(60, 'dialog', 'Second'));
  fixture.overlays.e60 = { text: 'Second before.' };
  const { site, changes } = await setup(t, fixture);
  site.text = lines('Region', 100);
  site.overlays.e50.text = lines('Dialog', 60);
  site.overlays.e60.text = lines('Second', 60);
  const since = await changes('since');
  assert.ok(!since.body.includes('more changed'), `a since diff is cut by max_chars alone (${since.body.length} characters)`);
  assert.ok(['+ Dialog line 059', '+ Second line 059', '+ Region line 099'].every((line) => since.body.includes(line)), since.body);
  site.text = lines('Region again', 100);
  site.overlays.e50.text = lines('Dialog again', 60);
  site.overlays.e60.text = lines('Second again', 60);
  const { body } = await changes();
  const [overlayPart, regionPart] = body.split(/\n… \d+ more changed lines; read the page for the rest\n/);
  // A printed line is some 54 characters, so a cut stops within one line of its cap.
  assert.ok(overlayPart.startsWith('@@\n  [e50 dialog "Confirm"]') && overlayPart.length <= 4000 && overlayPart.length > 4000 - 55, `the overlays' are cut at 4,000 (${overlayPart.length})`);
  const regionCut = regionPart.slice(0, regionPart.indexOf('\n… '));
  assert.ok(regionCut.startsWith('@@\n- Region line 000') && regionCut.length <= 3000 && regionCut.length > 3000 - 55, `the region's at 3,000 (${regionCut.length})`);
  assert.match(regionPart, /\n… \d+ more changed lines; read the page for the rest$/);
});

test('the diff gives up past 1,000 edits: a region of 500 lines rewritten is listed, and one of 500 lines replaced by 501 is not', async (t) => {
  const many = (prefix, n) => Array.from({ length: n }, (unused, i) => `${prefix}${i}`).join('\n\n');
  const { site, changes } = await setup(t, page({ text: many('Before ', 500) }));
  site.text = many('After ', 500);
  assert.strictEqual((await changes()).line, 'Changed: 500 lines added, 500 removed');
  site.text = many('Again ', 501);
  assert.strictEqual((await changes()).line, 'Changed: most of the page (501 lines differ); read the page');
});

test("past the region's edit cap the body holds the overlays' hunks alone, and past theirs it says so", async (t) => {
  const many = (prefix, n = 1200) => Array.from({ length: n }, (unused, i) => `${prefix}${i}`).join('\n\n');
  const { site, changes } = await setup(t, withDialog(many('Before '), 'Dialog before.'));
  site.text = many('After ');
  site.overlays.e50.text = 'Dialog after.';
  const answer = await changes();
  assert.strictEqual(answer.line, 'Changed: most of the page (1200 lines differ); read the page');
  assert.strictEqual(answer.gaveUp, true);
  assert.strictEqual(answer.body, '@@\n  [e50 dialog "Confirm"]\n- Dialog before.\n+ Dialog after.\n  [e51 button "OK"]');

  // Two dialogs, each of 600 short lines that all change, pass the overlays' own edit
  // cap, though each block is under its 4,000 characters.
  const two = withDialog('Region before.', many('a', 600));
  two.tree[0].childIds.push('60');
  two.tree.push(bareNode(60, 'dialog', 'Second'));
  two.overlays.e60 = { text: many('c', 600) };
  const pair = await setup(t, two);
  pair.site.overlays.e50.text = many('b', 600);
  pair.site.overlays.e60.text = many('d', 600);
  pair.site.text = 'Region after.';
  const overlaysOff = await pair.changes();
  assert.strictEqual(overlaysOff.line, 'Changed: 1 line added, 1 removed', 'the region is counted alone');
  assert.strictEqual(overlaysOff.body, '… the overlays changed too much to list; read the page\n@@\n- Region before.\n+ Region after.\n  [e3 button "Go"]');
  pair.site.overlays.e50.text = many('a', 600);
  pair.site.overlays.e60.text = many('c', 600);
  pair.site.text = 'Region after.\n\nRegion added.';
  assert.strictEqual((await pair.changes()).line, 'Changed: 1 line added, 0 removed', 'a region that only gained lines is counted alone');
  pair.site.overlays.e50.text = many('b', 600);
  pair.site.overlays.e60.text = many('d', 600);
  pair.site.text = 'Region after.';
  assert.strictEqual((await pair.changes()).line, 'Changed: 0 lines added, 1 removed', 'and so is one that only lost lines');
  pair.site.overlays.e50.text = many('a', 600);
  pair.site.overlays.e60.text = many('c', 600);
  const overlaysOnly = await pair.changes();
  assert.strictEqual(overlaysOnly.line, 'Changed: most of the overlays (1203 lines differ); read the page', 'a region that stayed puts no count of nothing beside them');
  assert.strictEqual(overlaysOnly.body, '… the overlays changed too much to list; read the page');
  pair.site.overlays.e50.text = many('b', 600);
  pair.site.overlays.e60.text = many('d', 600);
  assert.strictEqual((await pair.changes('since')).line, 'Since: most of the overlays changed (1203 lines differ)');
  pair.site.overlays.e50.text = many('a', 600);
  pair.site.overlays.e60.text = many('c', 600);
  pair.site.text = many('Region ');
  const both = await pair.changes();
  assert.match(both.line, /^Changed: most of the page \(\d+ lines differ\); read the page$/);
  assert.strictEqual(both.body, '… the overlays changed too much to list; read the page');
  assert.strictEqual((await pair.changes('since')).line, 'Since: no change');
});
