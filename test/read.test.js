// The read pipeline against the in-process fake: the header lines each parameter adds,
// the hidden list, the ref set the units fill, and the object groups a read releases.

const { test, mock } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const input = require('../server/input');
const retained = require('../server/retained');
const { OutcomeError } = require('../server/action-support');
const { ConnectionClosedError } = require('../server/cdp');
const { navigatedSession, readPayload, recordingLog, refsIn, waitFor } = require('./helpers');
const { attachFrame } = require('./frame-setup');
const { bareNode } = require('./fixtures/ax/nodes');

const URL = 'http://a.test/';

// A page the fake serves: `elements` is what the walk finds and, through the tree the
// fake derives from them, what a read finds too.
function page(elements, extra = {}) {
  return { title: 'A', text: 'First paragraph.\n\nSecond paragraph.', elements, scrollY: 0, pageHeight: 1200, viewportHeight: 600, ...extra };
}

function control(kind, label, extra = {}) {
  return { kind, label, disabled: false, checked: false, visible: true, ...extra };
}

async function setup(t, fixture, options = {}) {
  const ctx = await navigatedSession({ ...options, t, url: URL, site: { [URL]: fixture } });
  const call = (args = {}) => readPayload(ctx.sessions, ctx.session, { maxChars: 40000, offset: 0, ...args });
  return { ...ctx, call };
}

// A page holding `count` out-of-process frames, each with its own page behind it.
function framedPage(count, content = (i) => `Frame ${i} text.`) {
  const childFrames = [];
  const tree = [{ nodeId: 'n0', role: { value: 'RootWebArea' }, name: { value: 'A' }, childIds: [] }];
  for (let i = 0; i < count; i++) {
    const backendId = 100 + i;
    tree[0].childIds.push(`f${i}`);
    tree.push({ nodeId: `f${i}`, role: { value: 'Iframe' }, name: { value: '' }, backendDOMNodeId: backendId });
    childFrames.push({ backendId, url: `http://frame.test/${i}` });
  }
  const site = {};
  for (let i = 0; i < count; i++) site[`http://frame.test/${i}`] = page([control('link', `Link ${i}`, { href: `http://frame.test/${i}/away` })], { title: `Frame ${i}`, text: content(i) });
  return { page: page([], { tree, childFrames }), site };
}

// Reads `page` with `count` frames attached to it, each as its own target.
async function setupFrames(t, count, content, options = {}) {
  const fixture = framedPage(count, content);
  const ctx = await setup(t, fixture.page, options);
  Object.assign(ctx.fake.site, fixture.site);
  const parent = ctx.fake.targets.get(ctx.session.workingTargetId);
  for (let i = 0; i < count; i++) {
    await attachFrame(ctx, parent, 100 + i);
  }
  return ctx;
}

// A page holding one same-process child frame: a frame of the page's own renderer,
// which the frame tree names and the target registry never sees. `frameId` null leaves
// that frame with no id, so describeNode answers without one, as it does for an
// <iframe> holding no document at all.
async function setupSameProcessFrame(t, { frameId = 'FRAME-SAME' } = {}, options = {}) {
  const tree = [
    { nodeId: 'n0', role: { value: 'RootWebArea' }, name: { value: 'A' }, childIds: ['n1'] },
    { nodeId: 'n1', role: { value: 'Iframe' }, name: { value: '' }, backendDOMNodeId: 100 },
  ];
  const child = 'http://a.test/child';
  const entry = { backendId: 100, url: child };
  if (frameId) entry.id = frameId;
  const ctx = await setup(t, page([], { tree, text: 'The page around the frame.', childFrames: [entry] }), options);
  ctx.fake.site[child] = page([control('button', 'In frame', { backendNodeId: 55 })], { title: 'Child', text: 'Same-process frame text.' });
  return ctx;
}

// A page holding one frame, which holds one frame, and so on `depth` levels down, each
// level a site of its own and so a target of its own.
function nestedPage(depth) {
  const url = (level) => `http://frame.test/level${level}`;
  const holder = (title, text, backendId, child) => page([], {
    title,
    text,
    tree: [
      { nodeId: 'n0', role: { value: 'RootWebArea' }, name: { value: title }, childIds: ['n1'] },
      { nodeId: 'n1', role: { value: 'Iframe' }, name: { value: '' }, backendDOMNodeId: backendId },
    ],
    childFrames: [{ backendId, url: child }],
  });
  const site = {};
  for (let level = 1; level < depth; level++) site[url(level)] = holder(`Level ${level}`, `Level ${level} text.`, 200 + level, url(level + 1));
  site[url(depth)] = page([], { title: `Level ${depth}`, text: `Level ${depth} text.` });
  return { page: holder('A', 'The page around the frames.', 200, url(1)), site };
}

// Reads a page whose frames nest `depth` levels, each attached as its own target.
async function setupNested(t, depth, options = {}) {
  const fixture = nestedPage(depth);
  const ctx = await setup(t, fixture.page, options);
  Object.assign(ctx.fake.site, fixture.site);
  let parent = ctx.fake.targets.get(ctx.session.workingTargetId);
  for (let level = 0; level < depth; level++) {
    parent = await attachFrame(ctx, parent, 200 + level);
  }
  return ctx;
}

// What a target's ref set holds, copied out: the read merges into the set in place, so
// only its contents say whether a failed read left it alone.
function snapshotOf(session, t) {
  const set = session.refs.get(t.targetId);
  return set && { generation: set.generation, ids: [...set.ids] };
}

// The read's own info lines about frames, apart from the session lines around them.
function frameLines(log) {
  return log.lines.info.filter((line) => line.startsWith('frame '));
}

async function outcome(promise) {
  try { return { ok: await promise }; } catch (e) {
    if (e instanceof OutcomeError) return { fail: e.envelope };
    throw e;
  }
}

// First in this file: renderSource() keeps its result once it succeeds, so a later test
// could not make the libraries unreadable.
test('a library the renderer cannot read fails the read as a setup error, not as a DOM shape it cannot handle', async (t) => {
  const readFileSync = fs.readFileSync;
  t.after(() => mock.restoreAll());
  mock.method(fs, 'readFileSync', (file, ...rest) => {
    if (String(file).includes('turndown-plugin-gfm')) throw new Error('ENOENT: no such file or directory');
    return readFileSync(file, ...rest);
  });
  const { call } = await setup(t, page([control('button', 'Go')]));
  await assert.rejects(call(), (e) => {
    // daemon.js renders this one as setup_error; anything else would be `error`.
    assert.strictEqual(e.name, 'SetupError');
    assert.match(e.message, /turndown-plugin-gfm/);
    assert.match(e.message, /npm --prefix server ci --ignore-scripts/);
    return true;
  });
});

test('the header is the state lines and the scope, then a blank line, then the render', async (t) => {
  const { call } = await setup(t, page([control('button', 'Go')]));
  const { payload } = await call();
  assert.strictEqual(payload, [
    'URL: http://a.test/',
    'Title: A',
    'Scope: body',
    '',
    'First paragraph.',
    '',
    'Second paragraph.',
    '',
    '[e10 button "Go"]',
  ].join('\n'));
});

test('a page with a main landmark renders it and reports what it left out, by ref and by count', async (t) => {
  const tree = [
    { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'A' }, childIds: ['2', '4'] },
    { nodeId: '2', role: { value: 'navigation' }, name: { value: 'Site' }, backendDOMNodeId: 20, childIds: ['3'] },
    { nodeId: '3', role: { value: 'link' }, name: { value: 'Away' }, backendDOMNodeId: 21, properties: [{ name: 'url', value: { value: 'http://a.test/away' } }] },
    { nodeId: '4', role: { value: 'main' }, name: { value: '' }, backendDOMNodeId: 40, childIds: ['5'] },
    { nodeId: '5', role: { value: 'button' }, name: { value: 'Go' }, backendDOMNodeId: 41 },
  ];
  const { call, session, target } = await setup(t, page([control('button', 'Go', { backendNodeId: 41 })], { tree }));
  const { payload } = await call();
  const lines = payload.split('\n');
  assert.strictEqual(lines[2], 'Scope: main (omitted: navigation "Site" [e20] 1 link; scope=e20 expands one, scope=all everything)');
  assert.ok(payload.includes('[e41 button "Go"]'));
  assert.ok(!payload.includes('e21'), 'the omitted link has no marker');
  assert.deepStrictEqual([...session.refs.get(target.targetId).ids.keys()], [21, 41, 20, 40], 'every node of the tree is clickable');
  const all = await call({ scope: 'all' });
  assert.strictEqual(all.payload.split('\n')[2], 'Scope: all', 'nothing is omitted from the whole body');
  assert.ok(all.payload.includes('[e20 navigation "Site"]'), 'and the landmarks carry boundary markers');
  const scoped = await call({ scope: 'e20' });
  assert.strictEqual(scoped.payload.split('\n')[2], 'Scope: e20 (omitted: main [e40] 1 button; scope=e40 expands one, scope=all everything)');
  assert.ok(scoped.payload.includes('[Away](http://a.test/away)[e21]'));
});

test('a tree node without a DOM node behind it is neither described, recorded, nor named by the omission line', async (t) => {
  const tree = [
    { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'A' }, childIds: ['2', '4', '5'] },
    // Chrome reports nodes with no DOM node behind them: there is nothing to resolve
    // for one and no ref to name it by.
    { nodeId: '2', role: { value: 'navigation' }, name: { value: 'Ghost' }, childIds: ['3'] },
    { nodeId: '3', role: { value: 'link' }, name: { value: 'Away' }, backendDOMNodeId: 21 },
    { nodeId: '4', role: { value: 'Iframe' }, name: { value: '' } },
    { nodeId: '5', role: { value: 'main' }, name: { value: '' }, backendDOMNodeId: 40, childIds: ['6', '7'] },
    { nodeId: '6', role: { value: 'button' }, name: { value: 'Go' }, backendDOMNodeId: 41 },
    { nodeId: '7', role: { value: 'button' }, name: { value: 'Ghost button' } },
  ];
  const { call, fake, session, target } = await setup(t, page([control('button', 'Go', { backendNodeId: 41 })], { tree }));
  const { payload } = await call({ scope: 'all' });
  assert.ok(!payload.includes('undefined'), `no marker names a ref that is no id:\n${payload}`);
  assert.ok(fake.callsTo('DOM.resolveNode').every((c) => c.params.backendNodeId !== undefined), 'and nothing was resolved for it');
  assert.deepStrictEqual([...session.refs.get(target.targetId).ids.keys()], [21, 41, 40], 'nor is it in the ref set');
  assert.strictEqual(payload.split('\n')[2], 'Scope: all', 'and the ghost control is counted as dropped as little as it was rendered');
  // Under a scope the report measures against, a landmark or a frame with no ref would
  // otherwise be offered as [eundefined], the recourse at the end included.
  const scoped = await call({ scope: 'main' });
  assert.strictEqual(
    scoped.payload.split('\n')[2],
    'Scope: main (omitted: 1 link elsewhere; scope=all shows everything)',
    "the ghost landmark is no line of the report, the link under it falls to the page's own count, "
    + 'and the ghost control inside the scope is no dropped one',
  );
});

test('a read that outlived its document leaves the ref set at the generation it was read', async (t) => {
  const { call, context, fake, session, target } = await setup(t, page([control('button', 'Go')]));
  const first = await call();
  const ref = refsIn(first.payload).Go;
  const set = snapshotOf(session, target);
  const original = fake.handlers.get('Runtime.callFunctionOn');
  let once = true;
  fake.handle('Runtime.callFunctionOn', (params, sid) => {
    if (once && /claudesurfRender/.test(params.functionDeclaration)) {
      once = false;
      fake.navigateTarget(fake.targets.get(target.targetId), URL);
    }
    return original(params, sid);
  });
  const { fail } = await outcome(call());
  assert.strictEqual(fail.outcome, 'error');
  assert.match(fail.message, /document changed while it was being read/);
  assert.deepStrictEqual(snapshotOf(session, target), set, 'the set stays as the last good read filed it, at a generation the new document doesn\'t match');
  const clicked = await outcome(input.click(context, session, { ref }));
  assert.strictEqual(clicked.fail.outcome, 'stale_ref', 'and a ref from before it is stale');
});

test("a ref-scoped read whose page commits a new document during the page's tree pull is a stale ref, for a ref in the page and for one inside a frame", async (t) => {
  const navigateDuringPull = ({ fake, session }) => {
    const tab = fake.targets.get(session.workingTargetId);
    const pull = fake.handlers.get('Accessibility.getFullAXTree');
    let once = true;
    fake.handle('Accessibility.getFullAXTree', (params, sid) => {
      const nodes = pull(params, sid);
      if (once && sid === tab.sessionId && !params.frameId) { once = false; fake.navigateTarget(tab, URL); }
      return nodes;
    });
  };
  const ctx = await setup(t, page([control('button', 'Go')]));
  const ref = refsIn((await ctx.call()).payload).Go;
  navigateDuringPull(ctx);
  const inPage = await outcome(ctx.call({ scope: ref }));
  assert.deepStrictEqual(inPage.fail, { outcome: 'stale_ref', message: `${ref}: the document changed since it was read; read the page again` });

  const framed = await setupFrames(t, 1);
  const inFrame = refsIn((await framed.call()).payload)['Link 0'];
  navigateDuringPull(framed);
  const viaFrame = await outcome(framed.call({ scope: inFrame }));
  assert.deepStrictEqual(viaFrame.fail, { outcome: 'stale_ref', message: `${inFrame}: the frame it was read in is gone; read the page again` });
});

test('a scope ref that a read didn\'t return, and one that the tree has since lost, are both errors', async (t) => {
  const fixture = page([control('button', 'Go', { backendNodeId: 7 })]);
  const { call, fake } = await setup(t, fixture);
  const unread = await outcome(call({ scope: 'e999' }));
  assert.strictEqual(unread.fail.outcome, 'error');
  assert.match(unread.fail.message, /^e999 was not returned by a read of this document/);
  await call();
  fake.site[URL].tree = fixture.tree.filter((node) => node.backendDOMNodeId !== 7);
  const gone = await outcome(call({ scope: 'e7' }));
  assert.strictEqual(gone.fail.outcome, 'error');
  assert.match(gone.fail.message, /^e7 is not in this document any more/);
});

test('hidden controls are always counted, and the ones that Chrome pruned from the tree arrive with hidden=true', async (t) => {
  // Chrome keeps a zero-opacity control in the tree and prunes a display:none one, so
  // the walk finds two hidden elements where the tree holds one.
  const elements = [
    control('button', 'Go', { backendNodeId: 1 }),
    control('link', 'Ghost', { backendNodeId: 2, visible: false }),
    control('button', 'Pruned', { backendNodeId: 3, visible: false }),
  ];
  const tree = [
    { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'A' }, childIds: ['2', '3'] },
    { nodeId: '2', role: { value: 'button' }, name: { value: 'Go' }, backendDOMNodeId: 1 },
    { nodeId: '3', role: { value: 'link' }, name: { value: 'Ghost' }, backendDOMNodeId: 2 },
  ];
  const { call, session, target } = await setup(t, page(elements, { tree }));
  const { payload } = await call();
  assert.match(payload, /\nHidden: 2 controls on the page \(hidden=true lists them\)\n/);
  assert.ok(!payload.includes('## Hidden elements'));
  assert.ok(!payload.includes('[e2 link'), 'a control the render reported as hidden gets no marker');
  const ids = () => [...session.refs.get(target.targetId).ids.keys()];
  assert.deepStrictEqual(ids(), [1, 2], 'a tree control the page calls hidden is clickable from any read');
  const shown = await call({ hidden: true });
  assert.match(shown.payload, /\nHidden: 2 controls on the page \(listed at the end\)\n/);
  assert.ok(shown.payload.endsWith('## Hidden elements (2)\n[e2] link "Ghost" (hidden)\n[e3] button "Pruned" (hidden)'));
  assert.deepStrictEqual(ids(), [1, 2, 3], 'the pruned one joins the set only once it is listed');
});

test("a hidden=true read and a since read over it, against a renderer that never answers the hidden list's release, end by the request deadline", async (t) => {
  const { call, fake } = await setup(t, page([control('button', 'Go'), control('button', 'Shade', { visible: false })]));
  await call({ hidden: true });
  const release = fake.handlers.get('Runtime.releaseObjectGroup');
  fake.handle('Runtime.releaseObjectGroup', (params, sid, f) => (params.objectGroup === 'claudesurf-read-hidden' ? new Promise(() => {}) : release(params, sid, f)));
  for (const args of [{ hidden: true }, { since: true }]) {
    const from = fake.calls.length;
    const started = Date.now();
    const answer = await call({ ...args, deadline: started + 1_000 });
    const spent = Date.now() - started;
    assert.match(answer.payload, args.since ? /\nSince: no change\n/ : /\n## Hidden elements \(1\)\n/);
    assert.ok(fake.calls.slice(from).some((c) => c.method === 'Runtime.releaseObjectGroup' && c.params.objectGroup === 'claudesurf-read-hidden'), `${Object.keys(args)[0]} walked the hidden list`);
    assert.ok(spent < 1_600, `the ${Object.keys(args)[0]} read spent ${spent} ms against its 1,000 ms deadline`);
  }
});

test('the hidden ids of a read that a navigation overtook carry the generation they were read at', async (t) => {
  const other = 'http://a.test/elsewhere';
  const { call, context, fake, session, target } = await setup(t, page([
    control('button', 'Go', { backendNodeId: 1 }),
    control('button', 'Shade', { backendNodeId: 2, visible: false }),
  ]));
  fake.site[other] = page([control('button', 'Another', { backendNodeId: 3 })], { title: 'B', text: 'Another document.' });
  const first = await call({ hidden: true });
  const shade = refsIn(first.payload).Shade;
  const generation = target.generation;
  const original = fake.handlers.get('DOM.describeNode');
  let once = true;
  fake.handle('DOM.describeNode', (params, sid) => {
    const answer = original(params, sid);
    // The navigation follows the read of the walk's stashed handles, so the ids the
    // list resolved are the old document's and are merged into the set after it.
    if (once) { once = false; fake.navigateTarget(fake.targets.get(target.targetId), other); }
    return answer;
  });
  const { fail } = await outcome(call({ hidden: true }));
  assert.strictEqual(fail.outcome, 'error');
  assert.match(fail.message, /document changed while it was being read/);
  assert.strictEqual(snapshotOf(session, target).generation, generation, 'the set stayed at the generation the walk read its ids at');
  const clicked = await outcome(input.click(context, session, { ref: shade }));
  assert.strictEqual(clicked.fail.outcome, 'stale_ref', 'so a hidden ref of that read is stale rather than a click into the new document');
});

test("the walk's elements go with the document, so a read that lost them says so rather than describing another document's nodes", async (t) => {
  const other = 'http://a.test/elsewhere';
  // The third control is one Chrome prunes from the tree, so the hidden list is the
  // only thing that would put its id in the set.
  const tree = [
    { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'A' }, childIds: ['2', '3'] },
    { nodeId: '2', role: { value: 'button' }, name: { value: 'Go' }, backendDOMNodeId: 1 },
    { nodeId: '3', role: { value: 'button' }, name: { value: 'Shade' }, backendDOMNodeId: 2 },
  ];
  const { call, fake, session, target } = await setup(t, page([
    control('button', 'Go', { backendNodeId: 1 }),
    control('button', 'Shade', { backendNodeId: 2, visible: false }),
    control('button', 'Pruned', { backendNodeId: 3, visible: false }),
  ], { tree }));
  fake.site[other] = page([control('button', 'Another', { backendNodeId: 4 })], { title: 'B', text: 'Another document.' });
  const original = fake.handlers.get('Runtime.callFunctionOn');
  fake.handle('Runtime.callFunctionOn', (params, sid) => {
    const answer = original(params, sid);
    // The navigation lands between the walk and the read of the array it stashed,
    // which lives in the world the new document discarded.
    if (/claudesurfWalk/.test(params.functionDeclaration)) fake.navigateTarget(fake.targets.get(target.targetId), other);
    return answer;
  });
  const { fail } = await outcome(call({ hidden: true }));
  assert.strictEqual(fail.outcome, 'error');
  assert.match(fail.message, /document changed while it was being read/);
  assert.strictEqual(fake.callsTo('Runtime.getProperties').length, 0, 'there was no array to read the handles from');
  assert.deepStrictEqual(
    snapshotOf(session, target).ids.map(([id]) => id),
    [1, 2],
    'and the set holds what the tree gave the render, with nothing from a list that was never resolved',
  );
});

test('the hidden section is part of the region, so max_chars cuts it and an offset reaches it', async (t) => {
  const { call } = await setup(t, page([control('button', 'Go'), control('button', 'Shade', { visible: false })]));
  const whole = await call({ hidden: true });
  const region = whole.payload.split('\n\n').slice(1).join('\n\n');
  const cut = await call({ hidden: true, maxChars: region.indexOf('## Hidden') - 2 });
  assert.ok(!cut.payload.includes('## Hidden elements'), 'the section was cut');
  assert.match(cut.payload, /\[Showing characters 0–\d+ of \d+\. Pass offset=\d+ for the next part\.\]/);
  const next = Number(cut.payload.match(/Pass offset=(\d+)/)[1]);
  const rest = await call({ hidden: true, offset: next });
  assert.ok(rest.payload.includes('## Hidden elements (1)'));
  assert.match(rest.payload, /\[Showing characters \d+–\d+ of \d+\.\]/, 'nothing left to ask for');
});

test('links=index moves the URLs to a trailing list and the header says where it starts', async (t) => {
  const elements = [control('link', 'Home', { href: 'http://a.test/home' }), control('link', 'Same', { href: 'http://a.test/home' })];
  const { call } = await setup(t, page(elements));
  const { payload } = await call({ links: 'index' });
  const offset = Number(payload.match(/^Links: 1 \(index at offset (\d+)\)$/m)[1]);
  const region = payload.slice(payload.indexOf('\n\n') + 2);
  assert.strictEqual(region.slice(offset), '## Links\n[e10, e11] http://a.test/home');
  assert.ok(!payload.includes('](http://a.test/home)'), 'no URL is left in the prose');
});

test('find returns the matching blocks with their offsets, and pages by block', async (t) => {
  const { call } = await setup(t, page([control('button', 'Go')]));
  const { payload } = await call({ find: 'SECOND' });
  assert.strictEqual(payload, [
    'URL: http://a.test/',
    'Title: A',
    'Scope: body',
    'Find: "SECOND" — 1 block',
    '',
    '[offset 18]',
    'Second paragraph.',
  ].join('\n'));
  const nothing = await call({ find: 'absent' });
  assert.strictEqual(nothing.payload.split('\n').at(-1), 'Find: "absent" — 0 blocks');
  const cut = await call({ find: 'paragraph', maxChars: 20 });
  assert.match(cut.payload, /Narrow find, or read without it from offset 0\.\]/);
  // A cut past the second block's mark resumes at that block rather than at the first,
  // since the mark is the offset the follow-up read without find is to pass.
  const second = await call({ find: 'paragraph', maxChars: 45 });
  assert.match(second.payload, /Narrow find, or read without it from offset 18\.\]/);
  assert.ok(second.payload.endsWith('[offset 18]'), `the block the mark opens is what was cut:\n${second.payload}`);
});

test('a find read resumes at a block it delivered, not at an [offset N] line the page wrote', async (t) => {
  // A fenced block is the one place page text reaches the payload unescaped, so a line
  // the page wrote in the daemon's own mark form arrives whole; here it is a block of
  // its own, delivered before the cut, with the third block's mark past it.
  const text = 'Findable first.\n\n```\n[offset 999]\nFindable fence\n```\n\nFindable second.';
  const { call } = await setup(t, page([], { text }));
  const whole = await call({ find: 'Findable' });
  const region = whole.payload.slice(whole.payload.indexOf('\n\n') + 2);
  const cut = await call({ find: 'Findable', maxChars: region.lastIndexOf('[offset ') - 1 });
  assert.ok(cut.payload.includes('[offset 999]'), `the page's own line is in the region:\n${cut.payload}`);
  assert.match(cut.payload, /Narrow find, or read without it from offset 17\.\]/, 'and the resume offset is the mark the daemon wrote');
  const rest = await call({ offset: 17 });
  assert.ok(rest.payload.includes('Findable fence'), 'which is where the block the cut stopped at begins');
});

test('find narrows the links index to the blocks it delivered, drops the hidden section, and searches neither', async (t) => {
  const elements = [
    control('link', 'Inside a.test', { href: 'http://a.test/in' }),
    control('button', 'Shade', { visible: false }),
  ];
  const { call } = await setup(t, page(elements, { text: 'Findable paragraph.' }));
  // The needle is in the index line as well as in the prose block that carries the ref.
  const { payload } = await call({ find: 'a.test', links: 'index', hidden: true });
  assert.match(payload, /\nFind: "a.test" — 1 block\n/, 'the index is appended after find has run, so it is no block of the page');
  assert.match(payload, /\nLinks: 1\n/, 'with no offset, which a find read cannot pass');
  assert.match(payload, /\nHidden: 1 control on the page \(not listed under find\)\n/, 'the count still prints');
  assert.ok(!payload.includes('## Hidden elements'), 'the list is no block of the page either');
  assert.ok(payload.endsWith('[offset 21]\n[Inside a.test][e10]\n\n## Links\n[e10] http://a.test/in'), payload);
  assert.ok(!payload.includes('Findable paragraph.'), 'only the matching block is in the region');
});

test('find does not take an escaped bracket in page text for a marker when it narrows the links index', async (t) => {
  const elements = [control('link', 'Real', { href: 'http://a.test/real' })];
  // Turndown escapes a page's own brackets, so `\[e10 button "x"\]` in the prose is text, not a marker.
  const { call } = await setup(t, page(elements, { text: 'Mentions \\[e10 button "x"\\] in prose.' }));
  const { payload } = await call({ find: 'Mentions', links: 'index' });
  assert.match(payload, /\nFind: "Mentions" — 1 block\n/);
  assert.ok(!payload.includes('http://a.test/real'), `the escaped mention brings no URL into the index: ${payload}`);
});

test('article=true reports the extraction, and a page without one falls back to the scope', async (t) => {
  const found = await setup(t, page([], { article: { title: 'The scroll bar', byline: 'By Ada' } }));
  const hit = await found.call({ article: true });
  assert.match(hit.payload, /\nScope: readability\nArticle: "The scroll bar" by "Ada"$/m);
  const none = await setup(t, page([]));
  const miss = await none.call({ article: true });
  assert.match(miss.payload, /\nScope: body\nArticle: none found\n/);
});

test('article=true falls back to the chain step the scope reached rather than to the body', async (t) => {
  const tree = [
    { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'A' }, childIds: ['2'] },
    { nodeId: '2', role: { value: 'main' }, name: { value: '' }, backendDOMNodeId: 40, childIds: ['3'] },
    { nodeId: '3', role: { value: 'button' }, name: { value: 'Go' }, backendDOMNodeId: 41 },
  ];
  const { call } = await setup(t, page([control('button', 'Go', { backendNodeId: 41 })], { tree }));
  const { payload } = await call({ article: true });
  assert.match(payload, /\nScope: main\nArticle: none found\n/, `the main landmark is what rendered:\n${payload}`);
});

test('article=true resolves the whole page, so a control outside the scope that Readability keeps renders', async (t) => {
  const tree = [
    { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'A' }, childIds: ['2', '4'] },
    { nodeId: '2', role: { value: 'navigation' }, name: { value: 'Site' }, backendDOMNodeId: 20, childIds: ['3'] },
    { nodeId: '3', role: { value: 'link' }, name: { value: 'Away' }, backendDOMNodeId: 21, properties: [{ name: 'url', value: { value: 'http://a.test/away' } }] },
    { nodeId: '4', role: { value: 'main' }, name: { value: '' }, backendDOMNodeId: 40, childIds: ['5'] },
    { nodeId: '5', role: { value: 'button' }, name: { value: 'Go' }, backendDOMNodeId: 41 },
  ];
  const elements = [control('button', 'Go', { backendNodeId: 41 }), control('link', 'Away', { backendNodeId: 21, href: 'http://a.test/away' })];
  const { call } = await setup(t, page(elements, { tree, article: { title: 'The scroll bar', byline: 'By Ada' } }));
  const { payload } = await call({ article: true });
  assert.ok(payload.includes('[Away](http://a.test/away)[e21]'), `the link outside main is resolved and marked:\n${payload}`);
  assert.strictEqual(payload.split('\n')[2], 'Scope: readability', 'and nothing is reported omitted');
});

test('a renderer exception fails the read with the recourses, and its text, which the page can shape, goes to the journal alone', async (t) => {
  const { call, fake, log } = await setup(t, page([control('button', 'Go')]), { log: recordingLog() });
  fake.site[URL].render = () => { throw new Error('Cannot read properties of null'); };
  const { fail } = await outcome(call({ article: true }));
  assert.strictEqual(fail.outcome, 'error');
  assert.strictEqual(fail.message, 'Rendering the page failed. Try scope=all or scope=<ref> for another subtree, article=false, or screenshot.');
  assert.ok(log.lines.info.some((line) => line.includes('Cannot read properties of null')), 'the exception is in the journal');
});

test('a read releases the object group of every unit it resolved nodes in', async (t) => {
  const { call, fake } = await setup(t, page([control('button', 'Go'), control('button', 'Shade', { visible: false })]));
  await call({ hidden: true });
  const groups = fake.callsTo('Runtime.releaseObjectGroup').map((c) => c.params.objectGroup);
  assert.deepStrictEqual(groups, ['claudesurf-read-0', 'claudesurf-read-hidden']);
  const resolved = fake.callsTo('DOM.resolveNode').map((c) => c.params.objectGroup);
  assert.ok(resolved.length > 0 && resolved.every((g) => g === 'claudesurf-read-0'));
});

test('a release that the browser refuses is logged and doesn\'t reach the caller', async (t) => {
  const { call, fake, log } = await setup(t, page([control('button', 'Go')]), { log: recordingLog() });
  fake.handle('Runtime.releaseObjectGroup', () => { throw { code: -32000, message: 'Cannot find context with specified id' }; });
  const { payload } = await call();
  assert.ok(payload.endsWith('[e10 button "Go"]'), `the read delivered what it rendered:\n${payload}`);
  assert.deepStrictEqual(log.lines.debug.filter((line) => line.startsWith('releasing ')), [
    'releasing claudesurf-read-0: Runtime.releaseObjectGroup: Cannot find context with specified id',
  ], 'a caller on its way out learns of it from the log alone');
});

test('the hidden list sends the release of its element handles though the read has spent its deadline, and the read ends by it', async (t) => {
  const { call, fake } = await setup(t, page([control('button', 'Go'), control('button', 'Shade', { visible: false })]));
  const release = fake.handlers.get('Runtime.releaseObjectGroup');
  fake.handle('Runtime.releaseObjectGroup', (params, sid, f) => (params.objectGroup === 'claudesurf-read-hidden' ? new Promise(() => {}) : release(params, sid, f)));
  // The walk's handles are taken and then the read runs out of time reading them.
  fake.handle('DOM.describeNode', () => new Promise(() => {}));
  const from = fake.calls.length;
  const started = Date.now();
  await assert.rejects(call({ hidden: true, deadline: started + 600 }), /DOM.describeNode timed out/);
  const spent = Date.now() - started;
  assert.ok(spent < 1_500, `the read spent ${spent} ms against its 600 ms deadline`);
  await waitFor(() => fake.calls.slice(from).some((c) => c.method === 'Runtime.releaseObjectGroup' && c.params.objectGroup === 'claudesurf-read-hidden'), 1_000);
});

test('the renderer source is evaluated once per world and the second read reuses it', async (t) => {
  const { call, fake, target } = await setup(t, page([control('button', 'Go')]));
  await call();
  await call();
  const injections = fake.callsTo('Runtime.evaluate').filter((c) => /claudesurfRender/.test(c.params.expression));
  assert.strictEqual(injections.length, 1, 'the 140 KB of libraries goes in once per document');
  fake.navigateTarget(fake.targets.get(target.targetId), URL);
  await call();
  assert.strictEqual(fake.callsTo('Runtime.evaluate').filter((c) => /claudesurfRender/.test(c.params.expression)).length, 2, 'a new document gets its own');
});

test('a library that throws as it is evaluated fails the read, and the next read evaluates it again', async (t) => {
  const { call, fake, log } = await setup(t, page([control('button', 'Go')]), { log: recordingLog() });
  const original = fake.handlers.get('Runtime.evaluate');
  let throwing = true;
  fake.handle('Runtime.evaluate', (params, sid) => {
    // Runtime.evaluate answers an exception in its result rather than as a protocol
    // error, so the answer is the only thing that says the libraries are there.
    if (throwing && /claudesurfRender/.test(params.expression)) {
      return { result: { type: 'object' }, exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: TurndownService is not a constructor' } } };
    }
    return original(params, sid);
  });
  const { fail } = await outcome(call());
  assert.strictEqual(fail.outcome, 'error');
  assert.match(fail.message, /^Rendering the page failed\. /);
  assert.ok(log.lines.info.some((line) => /the renderer's libraries did not evaluate.*TurndownService is not a constructor/.test(line)), 'the exception is in the journal');
  throwing = false;
  const { payload } = await call();
  assert.ok(payload.endsWith('[e10 button "Go"]'), `the world was left uninjected, so the next read evaluates them again:\n${payload}`);
  assert.strictEqual(fake.callsTo('Runtime.evaluate').filter((c) => /claudesurfRender/.test(c.params.expression)).length, 2);
});

test('a document that renders nothing reads as no text rather than as an empty payload', async (t) => {
  const { call } = await setup(t, page([], { text: '' }));
  const { payload } = await call();
  assert.ok(payload.endsWith('\n\n(no readable text; use screenshot)'));
});

test('a frame renders inline under its own ref prefix, and its links join the index', async (t) => {
  const { call, session, sessions } = await setupFrames(t, 2);
  const { payload } = await call({ links: 'index' });
  assert.match(payload, /\[e100 frame http:\/\/frame\.test\/0 cross-site\]\nFrame 0 text\.\n\n\[Link 0\]\[f1e\d+\]\n\[\/frame\]/);
  assert.match(payload, /\[e101 frame http:\/\/frame\.test\/1 cross-site\]/);
  assert.match(payload, /## Links\n\[f1e\d+\] http:\/\/frame\.test\/0\/away\n\[f2e\d+\] http:\/\/frame\.test\/1\/away$/);
  const [first] = sessions.frameTargets(session.workingTargetId);
  assert.deepStrictEqual([...session.refs.get(first.targetId).ids.values()], [null], "a frame's refs live in its own target's set");
});

test('past the eight-frame limit a frame says so instead of rendering', async (t) => {
  const { call, log } = await setupFrames(t, 9, undefined, { log: recordingLog() });
  const { payload } = await call();
  assert.strictEqual(payload.match(/cross-site\]/g).length, 8, 'eight frames rendered, in document order');
  assert.match(payload, /\[e108 frame http:\/\/frame\.test\/8 \(not read: frame limit\)\]/);
  assert.ok(!payload.includes('Frame 8 text.'));
  assert.deepStrictEqual(
    frameLines(log),
    ['frame e108 (http://frame.test/8) is past the 8-frame limit of this read'],
    'the cap is nowhere in the payload but the ninth frame\'s own line, so it is in the log',
  );
});

test('a frame whose unit fails renders as not readable, and the page is delivered anyway', async (t) => {
  const { call, fake, log } = await setupFrames(t, 2, undefined, { log: recordingLog() });
  fake.site['http://frame.test/1'].render = () => { throw new Error('the renderer fell over'); };
  const { payload } = await call();
  assert.match(payload, /\[e100 frame http:\/\/frame\.test\/0 cross-site\]\nFrame 0 text\./);
  assert.match(payload, /\[e101 frame http:\/\/frame\.test\/1 \(not readable\)\]/);
  assert.deepStrictEqual(
    frameLines(log),
    ['frame e101 (http://frame.test/1) is not readable: Runtime.callFunctionOn: the renderer fell over'],
    'what went wrong is in the log, since the payload says only that it did',
  );
});

test('an iframe outside the scope is listed by ref as a frame that the read did not enter', async (t) => {
  const fixture = framedPage(1);
  fixture.page.tree[0].childIds.unshift('m');
  fixture.page.tree.push({ nodeId: 'm', role: { value: 'main' }, name: { value: '' }, backendDOMNodeId: 50, childIds: [] });
  const ctx = await setup(t, fixture.page);
  Object.assign(ctx.fake.site, fixture.site);
  const parent = ctx.fake.targets.get(ctx.session.workingTargetId);
  await attachFrame(ctx, parent, 100);
  const { payload } = await ctx.call();
  assert.strictEqual(payload.split('\n')[2], 'Scope: main (omitted: frames not read: [e100]; scope=all shows everything)');
  assert.ok(!payload.includes('Frame 0 text.'), 'a frame outside the scope is not pulled');
  const all = await ctx.call({ scope: 'all' });
  assert.ok(all.payload.includes('Frame 0 text.'));
});

test('scope on an iframe ref reads that frame alone', async (t) => {
  const { call } = await setupFrames(t, 1);
  await call();
  const { payload } = await call({ scope: 'e100' });
  assert.ok(payload.includes('Frame 0 text.'));
  assert.ok(!payload.includes('[e100 frame'), 'the frame is the whole region, not a block inside the page');
  assert.match(payload.split('\n')[2], /^Scope: e100$/);
});

test('scope on a same-process frame ref reads that frame, whose refs stay the page target\'s', async (t) => {
  const { call, session, target } = await setupSameProcessFrame(t);
  const whole = await call();
  assert.match(whole.payload, /\[e100 frame http:\/\/a\.test\/child\]\nSame-process frame text\./, 'no site of its own, so no cross-site tag');
  const { payload } = await call({ scope: 'e100' });
  assert.strictEqual(payload.split('\n')[2], 'Scope: e100');
  assert.ok(payload.includes('Same-process frame text.'), `the frame is the whole region:\n${payload}`);
  assert.ok(payload.includes('[e55 button "In frame"]'), 'with bare refs, since it shares the page\'s renderer');
  assert.ok(!payload.includes('The page around the frame.'), 'and nothing of the page around it');
  assert.strictEqual(session.refs.get(target.targetId).ids.get(55), 'FRAME-SAME', "its ids are in the page's set, against the frame they were read in");
});

test('a same-process frame that navigates under its own render renders as not readable, and the page is delivered anyway', async (t) => {
  const { call, fake, log } = await setupSameProcessFrame(t, {}, { log: recordingLog() });
  const original = fake.handlers.get('DOM.resolveNode');
  fake.handle('DOM.resolveNode', (params, sid) => {
    // The frame navigated between its tree pull and its render's resolve, which its
    // parent's generation does not move: every node the old tree found resolves
    // against a document that no longer has it.
    if (params.backendNodeId === 55) throw { code: -32000, message: 'No node with given id found' };
    return original(params, sid);
  });
  const { payload } = await call();
  assert.match(payload, /\[e100 frame http:\/\/a\.test\/child \(not readable\)\]/, `the page is delivered, with the frame degraded in its place:\n${payload}`);
  assert.match(payload, /The page around the frame\./);
  assert.deepStrictEqual(
    frameLines(log),
    ['frame e100 (http://a.test/child) is not readable: its document changed while it was being read'],
  );
});

test('scope on an <iframe> ref without a document behind it is an error naming the recourse', async (t) => {
  const { call } = await setupSameProcessFrame(t, { frameId: null });
  const whole = await call();
  assert.match(whole.payload, /\[e100 frame \(not readable\)\]/, 'the default read says so where the frame would be');
  const { fail } = await outcome(call({ scope: 'e100' }));
  assert.strictEqual(fail.outcome, 'error');
  assert.strictEqual(fail.message, 'the frame at e100 is not readable; read the page around it instead');
});

test("a scope on a frame the page's own session cannot read is an error naming the recourse", async (t) => {
  const { call, fake, log } = await setupSameProcessFrame(t, {}, { log: recordingLog() });
  const original = fake.handlers.get('Accessibility.getFullAXTree');
  fake.handle('Accessibility.getFullAXTree', (params, sid) => {
    // A cross-site frame whose target has not attached yet is in the frame tree and
    // nowhere else, so the read asks the page's session for its tree and Chrome
    // refuses the frame id.
    if (params.frameId === 'FRAME-SAME') throw { code: -32000, message: 'Frame with the given id is not part of the target' };
    return original(params, sid);
  });
  const whole = await call();
  assert.match(whole.payload, /\[e100 frame http:\/\/a\.test\/child \(not readable\)\]/, 'the default read says so where the frame would be');
  const { fail } = await outcome(call({ scope: 'e100' }));
  assert.strictEqual(fail.outcome, 'error');
  assert.strictEqual(fail.message, 'the frame at e100 is not readable; read the page around it instead');
  assert.strictEqual(
    frameLines(log).at(-1),
    'frame e100 (http://a.test/child) is not readable: Accessibility.getFullAXTree: Frame with the given id is not part of the target',
    'what the browser said is in the log, since the payload names the recourse alone',
  );
});

test('a frame-scoped read records the refs that its omission line offers, so a scope on one of them resolves', async (t) => {
  const ctx = await setupFrames(t, 1);
  await ctx.call();
  // The page rewrites itself around the frame, so the landmark the next read's
  // omission line names is one no read has returned before.
  ctx.fake.site[URL].tree.push({ nodeId: 'late', role: { value: 'navigation' }, name: { value: 'Late' }, backendDOMNodeId: 60 });
  ctx.fake.site[URL].tree[0].childIds.push('late');
  const framed = await ctx.call({ scope: 'e100' });
  assert.ok(framed.payload.includes('Frame 0 text.'), 'the frame is what rendered');
  assert.match(framed.payload.split('\n')[2], /navigation "Late" \[e60\]/, 'and the page around it is offered by ref');
  const expanded = await ctx.call({ scope: 'e60' });
  assert.strictEqual(expanded.payload.split('\n')[2], 'Scope: e60 (omitted: frames not read: [e100]; scope=all shows everything)');
});

test('a frame that the page hides is neither rendered nor named as one that the read did not enter', async (t) => {
  const ctx = await setupFrames(t, 1);
  ctx.fake.site[URL].childFrames[0].hidden = true;
  const { payload } = await ctx.call({ scope: 'all' });
  assert.ok(!payload.includes('[e100 frame'), `no block and no line for it:\n${payload}`);
  assert.ok(!payload.includes('Frame 0 text.'));
  assert.strictEqual(payload.split('\n')[2], 'Scope: all', 'a hidden frame is left out of the omission line, as a hidden control is');
});

test('a frame whose placeholder was swallowed by the prose around it is left unread and named by ref', async (t) => {
  const ctx = await setupFrames(t, 1);
  const { fake } = ctx;
  // An <iframe> inside a link or a control: the frame rule ran and reported the ref,
  // and then the rule around it dropped the placeholder with the rest of its content,
  // so the frame's own render would have nowhere to go.
  fake.site[URL].render = (options, descriptors) => {
    const answer = fake.renderAnswer(fake.site[URL], options, descriptors);
    return { ...answer, markdown: answer.markdown.replace('\u0000frame:e100\u0000', '[Wrapper](/wrapper)[e50]') };
  };
  const { payload } = await ctx.call({ scope: 'all' });
  assert.ok(!payload.includes('Frame 0 text.'), `nothing of the frame reaches the payload:\n${payload}`);
  assert.strictEqual(
    payload.split('\n')[2],
    'Scope: all (dropped: frames not read: [e100])',
    'so the read names it by ref instead, as it names one outside the scope',
  );
  assert.strictEqual(
    fake.calls.filter((call) => call.method === 'Accessibility.getFullAXTree').length,
    1,
    "and spends none of the read's frame budget pulling its tree",
  );
});

test('a forged placeholder in the page\'s own prose does not inline or count a hidden frame', async (t) => {
  const ctx = await setupFrames(t, 1);
  const { fake } = ctx;
  ctx.fake.site[URL].childFrames[0].hidden = true;
  // A page can spell the frame placeholder in text no rule emitted it for — the raw
  // text of a fenced code block, say — without the frame's own rule ever running for
  // it; the candidate list still carries every iframe the tree found, hidden or not.
  ctx.fake.site[URL].render = (options, descriptors) => {
    const answer = fake.renderAnswer(fake.site[URL], options, descriptors);
    return { ...answer, markdown: `${answer.markdown}\n\n\`\`\`\n\u0000frame:e100\u0000\n\`\`\`` };
  };
  const { payload } = await ctx.call({ scope: 'all' });
  assert.ok(!payload.includes('Frame 0 text.'), `the hidden frame is not rendered just because its placeholder text appears in prose:\n${payload}`);
  assert.strictEqual(payload.split('\n')[2], 'Scope: all', 'the hidden frame is still left out of the omission line, as a real one would be');
});

test("a frame past the cut that its parent's own inlining takes is left unread", async (t) => {
  const ctx = await setupNested(t, 2);
  // Both documents render past the 8,000 characters a read inlines of a frame, with
  // the <iframe> after that point in each. The page's own render is the region, which
  // max_chars alone cuts; the frame's is inlined under the frame cap.
  const long = (text) => `${text}\n${'x'.repeat(9_000)}`;
  ctx.fake.site[URL].text = long('The page around the frames.');
  ctx.fake.site['http://frame.test/level1'].text = long('Level 1 text.');
  const { payload } = await ctx.call();
  assert.ok(payload.includes('Level 1 text.'), `the page's own frame is read past its eight-thousandth character:\n${payload}`);
  assert.match(payload, /\(frame content cut: \d+ more characters; scope=e200 reads it whole\)/, 'and inlined cut');
  assert.ok(!payload.includes('Level 2 text.'), 'so the frame inside it could reach no payload and is nowhere in this one');
  assert.strictEqual(
    ctx.fake.calls.filter((call) => call.method === 'Accessibility.getFullAXTree').length,
    2,
    "and the read spends none of its frame budget on it: the page's tree and the frame's are the only two pulled",
  );
});

test('frames nest three levels deep, and one a level further says it is past the limit', async (t) => {
  const { call, log } = await setupNested(t, 4, { log: recordingLog() });
  const { payload } = await call();
  assert.match(payload, /\[e200 frame http:\/\/frame\.test\/level1 cross-site\]/);
  for (const level of [1, 2, 3]) assert.ok(payload.includes(`Level ${level} text.`), `level ${level} rendered:\n${payload}`);
  assert.match(payload, /\[f3e203 frame http:\/\/frame\.test\/level4 \(not read: frame limit\)\]/);
  assert.ok(!payload.includes('Level 4 text.'), 'the fourth level is named, not read');
  assert.deepStrictEqual(frameLines(log), ['frame f3e203 (http://frame.test/level4) is past the 3-level limit of this read']);
});

test("a frame whose frame tree never answers costs a frame's budget, not the whole request's", async (t) => {
  const { call, fake } = await setupNested(t, 2);
  const original = fake.handlers.get('Page.getFrameTree');
  // The page answers for its own frames; the frame inside it never does, as a wedged
  // renderer would not.
  fake.handle('Page.getFrameTree', (params, sid) => (fake.bySession(sid).type === 'iframe' ? new Promise(() => {}) : original(params, sid)));
  const started = Date.now();
  const { payload } = await call({ deadline: started + 2_300 });
  const spent = Date.now() - started;
  assert.match(payload, /\[e200 frame http:\/\/frame\.test\/level1 cross-site\]\nLevel 1 text\./, `the frame that answered is delivered:\n${payload}`);
  assert.match(payload, /\[f1e201 frame http:\/\/frame\.test\/level2 cross-site\]/, 'and the frame inside it by the URL its own target carries');
  assert.ok(spent < 2_000, `the read spent ${spent} ms, which is the frame unit's 300 ms rather than the request's 2,300`);
});

test("a scope on a frame whose page never answers for its frames costs a frame's budget too", async (t) => {
  const { call, fake } = await setupFrames(t, 1);
  await call();
  const original = fake.handlers.get('Page.getFrameTree');
  // The scoped read asks the page which frame the <iframe> holds, for the URL a
  // same-process frame has nowhere else; a wedged renderer never answers.
  let stalling = false;
  fake.handle('Page.getFrameTree', (params, sid) => (
    stalling && fake.bySession(sid).type === 'page' ? new Promise(() => {}) : original(params, sid)
  ));
  stalling = true;
  const started = Date.now();
  const { payload } = await call({ scope: 'e100', deadline: started + 2_300 });
  const spent = Date.now() - started;
  assert.ok(payload.includes('Frame 0 text.'), `the frame is what rendered, by the URL its own target carries:\n${payload}`);
  assert.ok(spent < 2_000, `the read spent ${spent} ms, which is the frame unit's 300 ms rather than the request's 2,300`);
});

test('a frame unit that runs out of time still releases the objects it resolved', async (t) => {
  const { call, fake, log } = await setupFrames(t, 1, undefined, { log: recordingLog() });
  const original = fake.handlers.get('Runtime.callFunctionOn');
  fake.handle('Runtime.callFunctionOn', (params, sid) => {
    const t = fake.bySession(sid);
    if (t.type === 'iframe' && /claudesurfRender/.test(params.functionDeclaration)) return new Promise(() => {});
    return original(params, sid);
  });
  // The release answers late, so a read that abandoned it at the unit's spent deadline
  // would finish before the browser had let the nodes go.
  const order = [];
  fake.handle('Runtime.releaseObjectGroup', ({ objectGroup }) => new Promise((resolve) => setTimeout(() => {
    order.push(objectGroup);
    resolve({});
  }, 150)));
  const { payload } = await call({ deadline: Date.now() + 2_300 });
  order.push('read returned');
  assert.match(payload, /\[e100 frame http:\/\/frame\.test\/0 \(not readable\)\]/);
  assert.deepStrictEqual(order, ['claudesurf-read-0', 'claudesurf-read-1', 'read returned'], "the frame unit's release was awaited");
  assert.deepStrictEqual(frameLines(log).map((line) => line.replace(/timed out.*/, 'timed out')), [
    'frame e100 (http://frame.test/0) is not readable: Runtime.callFunctionOn timed out',
  ], 'the budget it spent is in the log, since the payload says only that it was not readable');
  assert.deepStrictEqual(log.lines.debug.filter((line) => line.startsWith('releasing ')), [], 'and none of them failed');
});

test('a frame-scoped read counts the whole page as outside it when the page tree no longer shows its <iframe>', async (t) => {
  const tree = [
    { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'A' }, childIds: ['2', '3', '5'] },
    { nodeId: '2', role: { value: 'navigation' }, name: { value: 'Site' }, backendDOMNodeId: 20 },
    { nodeId: '3', role: { value: 'main' }, name: { value: '' }, backendDOMNodeId: 40, childIds: ['4'] },
    { nodeId: '4', role: { value: 'button' }, name: { value: 'Go' }, backendDOMNodeId: 41 },
    { nodeId: '5', role: { value: 'Iframe' }, name: { value: '' }, backendDOMNodeId: 100 },
  ];
  const ctx = await setup(t, page([control('button', 'Go', { backendNodeId: 41 })], { tree, childFrames: [{ backendId: 100, url: 'http://frame.test/0' }] }));
  ctx.fake.site['http://frame.test/0'] = page([control('button', 'In frame')], { title: 'Frame', text: 'Frame text.' });
  await attachFrame(ctx, ctx.fake.targets.get(ctx.session.workingTargetId), 100);
  const first = await ctx.call({ scope: 'all' });
  const ref = refsIn(first.payload)['In frame'];
  // The page rewrites itself around the frame, so the <iframe> its tree held is gone.
  ctx.fake.site[URL].tree = tree.filter((node) => node.backendDOMNodeId !== 100);
  const { payload } = await ctx.call({ scope: ref });
  assert.ok(payload.includes('Frame text.'), 'the frame is still what rendered');
  assert.strictEqual(payload.split('\n')[2], `Scope: ${ref} (omitted: navigation "Site" [e20], main [e40] 1 button; scope=e40 expands one, scope=all everything)`);
});

test('a read logs each unit at debug, and a renderer exception at info', async (t) => {
  const { call, fake, log } = await setupFrames(t, 1, undefined, { log: recordingLog() });
  await call();
  const debug = log.lines.debug.join('\n');
  assert.match(debug, /^page: \d+ tree nodes in \d+ ms$/m);
  assert.match(debug, /^page: \d+ nodes resolved in \d+ ms, rendered in \d+ ms$/m);
  assert.match(debug, /^frame e100: \d+ tree nodes in \d+ ms$/m);
  assert.match(debug, /^frame e100: \d+ nodes resolved in \d+ ms, rendered in \d+ ms$/m);
  fake.site[URL].render = () => { throw new Error('the renderer fell over'); };
  await outcome(call());
  assert.ok(log.lines.info.some((line) => /the renderer fell over/.test(line)), 'the exception is in the log');
});

test('a frame-scoped read stamps the frame\'s ref set with the frame\'s own generation, so a click on what it returned resolves', async (t) => {
  const { call, context, session } = await setupFrames(t, 1);
  await call();
  const { payload } = await call({ scope: 'e100' });
  const ref = refsIn(payload)['Link 0'];
  assert.match(ref, /^f1e\d+$/);
  const clicked = await outcome(input.click(context, session, { ref }));
  assert.ok(clicked.ok, `a ref of the frame-scoped read is clickable: ${JSON.stringify(clicked.fail)}`);
});

test('a frame-scoped read whose frame navigates mid-read is an error, and leaves the set that the read before it left', async (t) => {
  const { call, fake, sessions, session } = await setupFrames(t, 1);
  await call();
  const [frame] = sessions.frameTargets(session.workingTargetId);
  const set = snapshotOf(session, frame);
  const original = fake.handlers.get('Runtime.callFunctionOn');
  fake.handle('Runtime.callFunctionOn', (params, sid) => {
    const t = fake.bySession(sid);
    if (t.type === 'iframe' && /claudesurfRender/.test(params.functionDeclaration)) {
      fake.navigateTarget(t, 'http://frame.test/0');
    }
    return original(params, sid);
  });
  const { fail } = await outcome(call({ scope: 'e100' }));
  assert.strictEqual(fail.outcome, 'error');
  assert.match(fail.message, /document changed while it was being read/);
  assert.deepStrictEqual(snapshotOf(session, frame), set, 'the set the last good read left is untouched');
});

test('a frame-scoped read whose frame navigates after its refs were recorded is an error, not a payload of the old document', async (t) => {
  const { call, fake, sessions, session } = await setupFrames(t, 1);
  await call();
  const [frame] = sessions.frameTargets(session.workingTargetId);
  const original = fake.handlers.get('Runtime.callFunctionOn');
  fake.handle('Runtime.callFunctionOn', (params, sid) => {
    // The hidden walk runs on the page once the frame's refs are recorded.
    const t = fake.bySession(sid);
    if (t.type === 'page' && /claudesurfWalk/.test(params.functionDeclaration)) fake.navigateTarget(fake.targets.get(frame.targetId), 'http://frame.test/0');
    return original(params, sid);
  });
  const { fail } = await outcome(call({ scope: 'e100' }));
  assert.strictEqual(fail.outcome, 'error');
  assert.match(fail.message, /document changed while it was being read/);
});

test('a frame-scoped read whose page navigates during the hidden walk is an error, not a payload of two documents', async (t) => {
  const { call, fake, target } = await setupFrames(t, 1);
  await call();
  const original = fake.handlers.get('Runtime.callFunctionOn');
  fake.handle('Runtime.callFunctionOn', (params, sid) => {
    // The URL, Title and Hidden lines are the page's, and the walk takes the last of
    // them; a navigation here would leave them naming a different document from the one
    // the region renders.
    if (/claudesurfWalk/.test(params.functionDeclaration)) fake.navigateTarget(fake.targets.get(target.targetId), URL);
    return original(params, sid);
  });
  const { fail } = await outcome(call({ scope: 'e100' }));
  assert.strictEqual(fail.outcome, 'error');
  assert.match(fail.message, /document changed while it was being read/);
});

test('a frame whose own document changes during its render is not readable, and the page is delivered', async (t) => {
  const { call, fake, sessions, session } = await setupFrames(t, 2);
  await call();
  const [, second] = sessions.frameTargets(session.workingTargetId);
  const original = fake.handlers.get('Runtime.callFunctionOn');
  fake.handle('Runtime.callFunctionOn', (params, sid) => {
    const t = fake.bySession(sid);
    if (t.targetId === second.targetId && /claudesurfRender/.test(params.functionDeclaration)) {
      fake.navigateTarget(t, 'http://frame.test/1');
    }
    return original(params, sid);
  });
  const { payload } = await call();
  assert.match(payload, /\[e101 frame http:\/\/frame\.test\/1 \(not readable\)\]/);
  assert.match(payload, /\[e100 frame http:\/\/frame\.test\/0 cross-site\]\nFrame 0 text\./, 'the rest of the read is delivered');
});

// Counts the page script's render calls that a fake answered so far, overlay blocks
// apart.
function renderCalls(fake, { overlay = false } = {}) {
  return fake.callsTo('Runtime.callFunctionOn')
    .filter((c) => /claudesurfRender\(/.test(c.params.functionDeclaration))
    .filter((c) => Boolean(c.params.arguments[0].value.overlay) === overlay).length;
}

test('a read returns its header lines as the head and its region as the body, and leaves the outcome unset for a settled page', async (t) => {
  const { call } = await setup(t, page([control('button', 'Go')]));
  const result = await call();
  assert.strictEqual(result.head, 'URL: http://a.test/\nTitle: A\nScope: body');
  assert.strictEqual(result.body, 'First paragraph.\n\nSecond paragraph.\n\n[e10 button "Go"]');
  assert.strictEqual(result.outcome, undefined);
});

test('a read of a page still busy after 2 s returns the whole read as unsettled, its Settled: line after the state lines', async (t) => {
  const { call, fake } = await setup(t, page([control('button', 'Go')]));
  fake.site[URL].busy = { mutating: true };
  const started = Date.now();
  const result = await call();
  assert.ok(Date.now() - started >= 2000, 'the read waited its 2 s');
  assert.strictEqual(result.outcome, 'unsettled');
  assert.strictEqual(result.head, 'URL: http://a.test/\nTitle: A\nSettled: no — after 2.0 s, the document is still changing\nScope: body');
  assert.match(result.body, /\[e10 button "Go"\]$/);
});

test('a read and a change summary render through the same pipeline, so the summary of an unchanged page retains the read\'s region', async (t) => {
  const { call, context, session, target } = await setup(t, page([control('button', 'Go')]));
  const read = await call();
  assert.strictEqual(retained.current(session, target).source, 'read');
  const click = await input.click(context, session, { ref: refsIn(read.payload).Go });
  assert.match(click.head, /\nChanged: nothing$/);
  const kept = retained.current(session, target);
  assert.strictEqual(kept.source, 'summary');
  assert.strictEqual(kept.region, read.body, 'the summary\'s render is the read\'s region');
});

// Returns prose of `n` lines, long enough to be paged.
function lines(prefix, n) {
  return Array.from({ length: n }, (unused, i) => `${prefix} line ${i}.`).join('\n\n');
}

test('a paging read that matches the retained render slices it without settling or rendering again, and one that doesn\'t renders again', async (t) => {
  const { call, fake } = await setup(t, page([control('button', 'Go')], { text: lines('Prose', 20) }));
  const first = await call({ maxChars: 80 });
  const next = Number(first.payload.match(/Pass offset=(\d+)/)[1]);
  const whole = first.body + (await call({ maxChars: 40000, offset: next })).body;
  const renders = renderCalls(fake);
  // A settle wait would run out on this; a paging read doesn't wait.
  fake.site[URL].busy = { readyState: 'loading' };
  const started = Date.now();
  const paged = await call({ maxChars: 80, offset: next });
  assert.ok(Date.now() - started < 500, 'no settle wait');
  assert.strictEqual(renderCalls(fake), renders, 'no render');
  assert.strictEqual(paged.outcome, undefined);
  assert.ok(!/\nPaged:/.test(paged.head), `a plain read the page hasn't changed since needs no note:\n${paged.head}`);
  assert.ok(whole.startsWith(first.body + paged.body), 'the slice continues where the read was cut');
  fake.site[URL].busy = {};
  await call({ maxChars: 80, offset: next, links: 'index' });
  assert.strictEqual(renderCalls(fake), renders + 1, 'other parameters render again');
});

test('a paging read notes the page changed since the render that it slices when the observer saw a mutation after it', async (t) => {
  const { call, fake } = await setup(t, page([control('button', 'Go')], { text: lines('Prose', 20) }));
  const first = await call({ maxChars: 80 });
  const next = Number(first.payload.match(/Pass offset=(\d+)/)[1]);
  fake.site[URL].busy = { lastMutationAt: Date.now() + 1 };
  const paged = await call({ maxChars: 80, offset: next });
  assert.match(paged.head, /\nPaged: from the read \d+ s ago; the page has changed since, so read without offset for its current state\nScope: body$/);
});

test('a paging read after an action names the action\'s render, and after a since read the since read\'s', async (t) => {
  const { call, context, session } = await setup(t, page([control('button', 'Go')], { text: lines('Prose', 20) }));
  const first = await call({ maxChars: 80 });
  const next = Number(first.payload.match(/Pass offset=(\d+)/)[1]);
  await input.click(context, session, { ref: 'e10' });
  const afterAction = await call({ maxChars: 80, offset: next });
  assert.match(afterAction.head, /\nPaged: from the render the last action made \d+ s ago\n/);
  await call({ since: true });
  const afterSince = await call({ maxChars: 80, offset: next });
  assert.match(afterSince.head, /\nPaged: from the render the last since read made \d+ s ago\n/);
});

test('a paging read takes a mutation that the observer saw before the render it slices for no change', async (t) => {
  const { call, fake, session, target } = await setup(t, page([control('button', 'Go')], { text: lines('Prose', 20) }));
  const first = await call({ maxChars: 80 });
  const next = Number(first.payload.match(/Pass offset=(\d+)/)[1]);
  fake.site[URL].busy = { lastMutationAt: retained.current(session, target).startedAt - 1 };
  const paged = await call({ maxChars: 80, offset: next });
  assert.ok(!/\nPaged:/.test(paged.head), `a page that changed before the read was rendered needs no note:\n${paged.head}`);
});

test('a paging read whose probe of the page fails slices the render all the same, without a note that the page changed', async (t) => {
  const { call, fake } = await setup(t, page([control('button', 'Go')], { text: lines('Prose', 20) }));
  const first = await call({ maxChars: 80 });
  const next = Number(first.payload.match(/Pass offset=(\d+)/)[1]);
  fake.site[URL].busy = { throws: 'the observer broke' };
  const paged = await call({ maxChars: 80, offset: next });
  assert.ok(paged.body.length > 0, 'the slice was delivered');
  assert.ok(!/\nPaged:/.test(paged.head), paged.head);
});

test('a paging read gives the age of the render that it slices in seconds', async (t) => {
  const { call, session, target } = await setup(t, page([control('button', 'Go')], { text: lines('Prose', 20) }));
  const first = await call({ maxChars: 80 });
  const next = Number(first.payload.match(/Pass offset=(\d+)/)[1]);
  await call({ since: true });
  retained.current(session, target).startedAt -= 5_000;
  const paged = await call({ maxChars: 80, offset: next });
  assert.match(paged.head, /\nPaged: from the render the last since read made 5 s ago\n/);
});

test("a paging read whose scope, article, or hidden differs from the retained render's renders again rather than slicing that render", async (t) => {
  const { call, fake } = await setup(t, page([control('button', 'Go')], { text: lines('Prose', 20) }));
  for (const differing of [{ scope: 'all' }, { article: true }, { hidden: true }]) {
    const first = await call({ maxChars: 80 });
    const next = Number(first.payload.match(/Pass offset=(\d+)/)[1]);
    const renders = renderCalls(fake);
    await call({ maxChars: 80, offset: next, ...differing });
    assert.strictEqual(renderCalls(fake), renders + 1, JSON.stringify(differing));
  }
});

test("a navigation during the state read that follows the region fails a plain, a since, and a paging read, rather than heading one document's region with another's URL", async (t) => {
  const other = 'http://a.test/elsewhere';
  for (const [name, args] of [['plain', () => ({})], ['since', () => ({ since: true })], ['paging', (next) => ({ maxChars: 80, offset: next })]]) {
    const { call, fake, target } = await setup(t, page([control('button', 'Go')], { text: lines('Prose', 20) }));
    fake.site[other] = page([], { title: 'B', text: 'Another document.' });
    const first = await call({ maxChars: 80 });
    const next = Number(first.payload.match(/Pass offset=(\d+)/)[1]);
    const original = fake.handlers.get('Runtime.callFunctionOn');
    let armed = true;
    fake.handle('Runtime.callFunctionOn', (params, sid) => {
      // The URL and Title lines are read after every check of the region's own
      // documents has passed.
      if (armed && /function claudesurfScroll/.test(params.functionDeclaration)) {
        armed = false;
        fake.navigateTarget(fake.targets.get(target.targetId), other);
      }
      return original(params, sid);
    });
    const { ok, fail } = await outcome(call(args(next)));
    assert.ok(fail, `the ${name} read was delivered:\n${ok && ok.payload}`);
    assert.strictEqual(fail.outcome, 'error');
    assert.match(fail.message, /document changed while it was being read/);
    assert.ok(!armed, `the ${name} read read the state lines`);
  }
});

test('since without a retained render reads the whole page under its Since: line, and with one returns the diff as the region', async (t) => {
  const { call, fake, session, target } = await setup(t, page([control('button', 'Go')]));
  const unread = await call({ since: true });
  assert.strictEqual(unread.head, 'URL: http://a.test/\nTitle: A\nSince: no earlier read of this document; the whole page follows\nScope: body');
  assert.match(unread.body, /^First paragraph\./);
  assert.strictEqual(session.refsTarget, target.targetId);
  fake.site[URL].text = 'First paragraph.\n\nSecond paragraph, changed.';
  const since = await call({ since: true });
  assert.strictEqual(since.head, 'URL: http://a.test/\nTitle: A\nSince: 1 line added, 1 removed\nScope: body');
  assert.strictEqual(since.body, '@@\n  First paragraph.\n- Second paragraph.\n+ Second paragraph, changed.\n  [e10 button "Go"]');
  const none = await call({ since: true });
  assert.deepStrictEqual([none.head.split('\n')[2], none.body], ['Since: no change', '']);
});

test('since on a switched-to tab whose retained render is ref-scoped resolves that scope, and then the tab is the last one read', async (t) => {
  const tree = [bareNode(1, 'RootWebArea', 'A', { childIds: ['2', '3'] }), bareNode(2, 'navigation', 'Site', { childIds: ['4'] }), bareNode(3, 'main', ''), bareNode(4, 'link', 'Away', { properties: [{ name: 'url', value: { value: 'http://a.test/away' } }] })];
  const { call, fake, session, target } = await setup(t, page([control('link', 'Away', { backendNodeId: 4, href: 'http://a.test/away' })], { tree }));
  await call();
  await call({ scope: 'e2' });
  session.refsTarget = 'a tab the agent read since';
  fake.site[URL].tree[3].name = { value: 'Elsewhere' };
  const since = await call({ since: true });
  assert.match(since.head, /\nSince: 1 line added, 1 removed\nScope: e2/);
  assert.match(since.body, /\+ \[Elsewhere\]\(http:\/\/a\.test\/away\)\[e4\]/);
  assert.strictEqual(session.refsTarget, target.targetId);
});

test('a render over the size cap is not kept, and its marker answers the next summary and since read', async (t) => {
  const { call, context, session, target } = await setup(t, page([control('button', 'Go')], { text: 'x '.repeat(260_000) }));
  await call();
  assert.strictEqual(retained.current(session, target).tooLarge, true);
  // The button's marker is past the read's cut; the read recorded its ref all the same.
  const click = await input.click(context, session, { ref: 'e10' });
  assert.match(click.head, /\nChanged: not tracked \(the page is too large to keep\)$/);
  const since = await call({ since: true, maxChars: 100 });
  assert.match(since.head, /\nSince: the page is too large to keep; the whole page follows\n/);
});

test('since past the edit cap takes the render it diffed as its region, with one render and the source since, and its cut names the retained parameters', async (t) => {
  const tree = [bareNode(1, 'RootWebArea', 'A', { childIds: ['2'] }), bareNode(2, 'main', '', { childIds: ['3'] }), bareNode(3, 'button', 'Go')];
  const { call, fake, session, target } = await setup(t, page([control('button', 'Go', { backendNodeId: 3 })], { tree, text: lines('Before', 1200) }));
  await call();
  await call({ scope: 'e3' });
  fake.site[URL].text = lines('After', 1200);
  const renders = renderCalls(fake);
  const since = await call({ since: true, maxChars: 200 });
  assert.strictEqual(renderCalls(fake), renders + 1, 'one render in the call');
  assert.match(since.head, /\nSince: most of the page changed \(1200 lines differ\); the region follows\n/);
  assert.match(since.head, /^\[Showing characters 0–\d+ of \d+\. Pass scope=e3 offset=\d+ for the next part\.\]$/m);
  assert.match(since.body, /^After line 0\./);
  assert.strictEqual(retained.current(session, target).source, 'since');
});

test("since past the edit cap names article, links, and hidden in its cut's resume, and a paging read that passes them slices that render", async (t) => {
  const { call, fake } = await setup(t, page([control('button', 'Go'), control('button', 'Shade', { visible: false })], { text: lines('Before', 1200) }));
  const params = { article: true, links: 'index', hidden: true };
  await call(params);
  fake.site[URL].text = lines('After', 1200);
  const since = await call({ since: true, maxChars: 200 });
  const resume = since.head.match(/^\[Showing characters 0–\d+ of \d+\. Pass (.+) for the next part\.\]$/m);
  assert.ok(resume, since.head);
  assert.match(resume[1], /^article=true links=index hidden=true offset=\d+$/);
  const renders = renderCalls(fake);
  const paged = await call({ ...params, offset: Number(resume[1].match(/offset=(\d+)/)[1]) });
  assert.strictEqual(renderCalls(fake), renders, 'sliced, not rendered');
  assert.match(paged.head, /\nPaged: from the render the last since read made \d+ s ago\n/);
});

test('since past the size cap takes the render it made rather than rendering twice', async (t) => {
  const { call, fake } = await setup(t, page([control('button', 'Go')]));
  await call();
  fake.site[URL].text = 'y '.repeat(260_000);
  const renders = renderCalls(fake);
  const since = await call({ since: true, maxChars: 100 });
  assert.strictEqual(renderCalls(fake), renders + 1);
  assert.match(since.head, /\nSince: the page is too large to keep; the whole page follows\n/);
});

test('a since read whose render throws fails with error, its recourse a read without since and the exception in the journal alone', async (t) => {
  const { call, fake, log } = await setup(t, page([control('button', 'Go')]), { log: recordingLog() });
  await call();
  fake.site[URL].render = () => { throw new Error('Cannot read properties of null'); };
  const journaled = log.lines.info.length;
  const { fail } = await outcome(call({ since: true }));
  assert.strictEqual(fail.outcome, 'error');
  assert.strictEqual(fail.message, 'Rendering the page failed. Read without since, which takes scope=all or scope=<ref> for another subtree, or screenshot.');
  assert.ok(log.lines.info.slice(journaled).some((line) => line.includes('Cannot read properties of null')), 'the exception is in the journal');
});

test('a since read cuts its diff at max_chars, and its truncation line sends the agent to a read without since', async (t) => {
  const { call, fake } = await setup(t, page([control('button', 'Go')], { text: lines('Before', 40) }));
  await call();
  fake.site[URL].text = lines('After', 40);
  const since = await call({ since: true, maxChars: 300 });
  assert.match(since.head, /\nSince: 40 lines added, 40 removed\n/);
  assert.match(since.head, /^\[Showing characters 0–\d+ of \d+\. Read without since for the whole page\.\]$/m);
  const [, end, total] = since.head.match(/^\[Showing characters 0–(\d+) of (\d+)\./m).map(Number);
  assert.ok(end <= 300 && total > 1000 && since.body.length === end, `cut at max_chars (${end} of ${total})`);
  assert.ok(since.body.startsWith('@@\n- Before line 0.'), since.body);
});

// Builds a tree from a nested spec, [id, role, name, children, extra], each node with
// the DOM node of its id behind it.
function treeOf(spec) {
  const nodes = [];
  const visit = ([id, role, name, children = [], extra = {}]) => {
    nodes.push(bareNode(id, role, name, { ...extra, childIds: children.map((child) => String(child[0])) }));
    children.forEach(visit);
  };
  visit(spec);
  return nodes;
}

// Returns the walk elements behind the buttons of a spec, so a click on one resolves.
function buttonsOf(spec, extra = {}) {
  const found = [];
  const visit = ([id, role, name, children = []]) => {
    if (role === 'button') found.push(control('button', name, { backendNodeId: id, ...(extra[id] || {}) }));
    children.forEach(visit);
  };
  visit(spec);
  return found;
}

// Returns a page whose tree is `spec` and whose overlays render as `overlays` says, by
// ref.
function overlayPage(spec, overlays, extra = {}) {
  return page(buttonsOf(spec), { text: 'Main text.', tree: treeOf(spec), overlays, ...extra });
}

const MODAL = { properties: [{ name: 'modal', value: { value: true } }] };
const dialogPage = (extra) => overlayPage(['1', 'RootWebArea', 'A', [
  [2, 'main', '', [[3, 'button', 'Go']]],
  [10, 'dialog', 'Confirm', [[11, 'button', 'OK']]],
  [20, 'status', 'Saved'],
]], { e10: { text: 'Dialog text.' }, e20: { text: 'Saved text.' } }, extra);

test('the overlay blocks print ahead of the region under main and a ref scope, in slot order, and only the dialogs do under all and a body fall-through', async (t) => {
  const { call } = await setup(t, dialogPage());
  const main = await call();
  assert.strictEqual(main.head, 'URL: http://a.test/\nTitle: A\nScope: main\nOverlays: dialog "Confirm" [e10], status "Saved" [e20] (above the page)');
  assert.strictEqual(main.body, '[e10 dialog "Confirm"]\nDialog text.\n\n[e11 button "OK"]\n[/dialog]\n\n[e20 status "Saved"]\nSaved text.\n[/status]\n\nMain text.\n\n[e3 button "Go"]');
  const scoped = await call({ scope: 'e3' });
  assert.match(scoped.head, /\nOverlays: dialog "Confirm" \[e10\], status "Saved" \[e20\] \(above the page\)$/);
  assert.strictEqual(scoped.body, '[e10 dialog "Confirm"]\nDialog text.\n\n[e11 button "OK"]\n[/dialog]\n\n[e20 status "Saved"]\nSaved text.\n[/status]\n\nMain text.');
  const all = await call({ scope: 'all' });
  assert.match(all.head, /\nOverlays: dialog "Confirm" \[e10\] \(above the page\)$/);
  assert.ok(all.body.startsWith('[e10 dialog "Confirm"]') && !all.body.includes('[e20 status'), all.body);
  const { call: noMain } = await setup(t, overlayPage(['1', 'RootWebArea', 'A', [[10, 'dialog', 'Confirm', [[11, 'button', 'OK']]], [20, 'status', 'Saved']]], { e10: { text: 'Dialog text.' } }));
  const body = await noMain();
  assert.match(body.head, /\nScope: body\nOverlays: dialog "Confirm" \[e10\] \(above the page\)$/);
  assert.ok(body.body.startsWith('[e10 dialog "Confirm"]\nDialog text.\n\n[e11 button "OK"]\n[/dialog]\n\nMain text.'), body.body);
});

test('an overlay that contains a ref scope\'s root doesn\'t get a block, and scope= on an overlay or inside one reads it', async (t) => {
  const { call, fake } = await setup(t, dialogPage());
  await call();
  // The region's text names the root that it rendered at.
  const site = fake.site[URL];
  site.render = (options, descriptors) => {
    const root = descriptors.find((d) => d.kind === 'root');
    return fake.renderAnswer(site, options, descriptors, { text: root ? `Rendered at ${root.ref}.` : site.text });
  };
  const inside = await call({ scope: 'e11' });
  assert.match(inside.head, /\nScope: e11 .*\nOverlays: status "Saved" \[e20\] \(above the page\)$/);
  assert.ok(!inside.body.includes('[e10 dialog'), 'the dialog holding the scope renders no block');
  assert.ok(inside.body.endsWith('\n\nRendered at e11.'), `the region is the scope's own:\n${inside.body}`);
  const whole = await call({ scope: 'e10' });
  assert.match(whole.body, /\[e11 button "OK"\]/);
  assert.ok(!whole.body.includes('[e10 dialog'), 'scope=e10 reads the dialog as its region');
});

test('an overlay faded out, gone, or too small to see doesn\'t render a block and isn\'t named', async (t) => {
  for (const skip of [{ hidden: true }, { lost: true }, { tiny: true }]) {
    const { call } = await setup(t, dialogPage({ overlays: { e10: { text: 'Dialog text.' }, e20: skip } }));
    const { head, body } = await call();
    assert.match(head, /\nOverlays: dialog "Confirm" \[e10\] \(above the page\)$/, JSON.stringify(skip));
    assert.ok(!body.includes('[e20 status'));
  }
});

test('a dialog inside main is cut from the region and rendered as a block, while an alert inside main stays where it reads', async (t) => {
  const { call } = await setup(t, overlayPage(['1', 'RootWebArea', 'A', [
    [2, 'main', '', [[3, 'textbox', 'Email'], [30, 'alert', 'Invalid email', [[31, 'button', 'Fix']]], [10, 'dialog', 'Confirm', [[11, 'button', 'OK']]]]],
  ]], { e10: { text: 'Dialog text.' }, e30: { text: 'Invalid email.' } }));
  const { head, body } = await call();
  assert.match(head, /\nOverlays: dialog "Confirm" \[e10\] \(above the page\)$/, 'the alert inside the root is no block');
  assert.strictEqual(body.split('[e11 button "OK"]').length, 2, 'the dialog\'s button renders once, in its block');
  assert.ok(body.indexOf('[e11 button "OK"]') < body.indexOf('Main text.'));
  assert.ok(body.slice(body.indexOf('Main text.')).includes('[e31 button "Fix"]'), `the alert's button renders in the region:\n${body}`);
});

test('a dialog that a Readability article would keep is left out of the article and rendered once as a block', async (t) => {
  const { call } = await setup(t, overlayPage(['1', 'RootWebArea', 'A', [[10, 'dialog', 'Confirm', [[11, 'button', 'OK']]], [3, 'button', 'Go']]], { e10: { text: 'Dialog text.' } }, { article: { title: 'An article' } }));
  const { head, body } = await call();
  assert.match(head, /\nScope: readability\nOverlays: dialog "Confirm" \[e10\] \(above the page\)$/);
  assert.strictEqual(body.split('[e11 button "OK"]').length, 2);
});

test('under the auto chain only dialogs are picked, whether the render takes Readability or the body', async (t) => {
  const spec = ['1', 'RootWebArea', 'A', [[20, 'status', 'Saved'], [10, 'dialog', 'Confirm'], [3, 'button', 'Go']]];
  for (const extra of [{}, { article: { title: 'An article' } }]) {
    const { call } = await setup(t, overlayPage(spec, { e10: { text: 'Dialog text.' }, e20: { text: 'Saved.' } }, extra));
    const { head } = await call();
    assert.match(head, /\nOverlays: dialog "Confirm" \[e10\] \(above the page\)$/, JSON.stringify(extra));
  }
});

test('a dialog takes a block slot ahead of four earlier toasts outside the scope, and the toast past the four is named', async (t) => {
  const toasts = [20, 21, 22, 23].map((id) => [id, 'status', `Toast ${id}`]);
  const overlays = Object.fromEntries([20, 21, 22, 23].map((id) => [`e${id}`, { text: `Toast ${id} text.` }]));
  const { call } = await setup(t, overlayPage(['1', 'RootWebArea', 'A', [[2, 'main', '', [[3, 'button', 'Go']]], ...toasts, [10, 'dialog', 'Confirm']]], { ...overlays, e10: { text: 'Dialog text.' } }));
  const { head } = await call();
  assert.match(head, /\nOverlays: dialog "Confirm" \[e10\], status "Toast 20" \[e20\], status "Toast 21" \[e21\], status "Toast 22" \[e22\], … and 1 more: \[e23\] \(above the page\)$/);
});

test('the region says nothing is readable outside the overlays when the dialog is all there is, and that there is no readable text when every overlay was skipped', async (t) => {
  const spec = ['1', 'RootWebArea', 'A', [[2, 'main', ''], [10, 'dialog', 'Confirm']]];
  const { call } = await setup(t, overlayPage(spec, { e10: { text: 'Dialog text.' } }, { text: '' }));
  assert.strictEqual((await call()).body, '[e10 dialog "Confirm"]\nDialog text.\n[/dialog]\n\n(nothing readable outside the overlays above)');
  const { call: skipped } = await setup(t, overlayPage(spec, { e10: { hidden: true } }, { text: '' }));
  assert.strictEqual((await skipped()).body, '(no readable text; use screenshot)');
});

test("a block whose render throws prints as not readable, its text in the journal alone, and isn't a readable block beside an empty region", async (t) => {
  const spec = ['1', 'RootWebArea', 'A', [[2, 'main', ''], [10, 'dialog', 'Confirm', [[11, 'button', 'OK']]]]];
  const { call, log } = await setup(t, overlayPage(spec, { e10: { throws: 'the dialog script broke' } }, { text: '' }), { log: recordingLog() });
  const { head, body } = await call();
  assert.strictEqual(body, '[e10 dialog (not readable)]\n\n(no readable text; use screenshot)');
  assert.match(head, /\nOverlays: dialog "Confirm" \[e10\] \(above the page\)$/);
  assert.ok(log.lines.info.some((line) => line.includes('the dialog script broke')), 'the exception is in the journal');
});

test('find searches the blocks with the region, a block\'s offset resolves without find, and the links index takes a block\'s links', async (t) => {
  const spec = ['1', 'RootWebArea', 'A', [[2, 'main', '', [[3, 'button', 'Go']]], [10, 'dialog', 'Confirm', [[12, 'link', 'Help', [], { properties: [{ name: 'url', value: { value: 'http://a.test/help' } }] }]]]]];
  const fixture = overlayPage(spec, { e10: { text: 'Dialog text.' } });
  fixture.elements.push(control('link', 'Help', { backendNodeId: 12, href: 'http://a.test/help' }));
  const { call } = await setup(t, fixture);
  const found = await call({ find: 'Dialog text' });
  assert.match(found.head, /\nFind: "Dialog text" — 1 block$/);
  assert.match(found.body, /^\[offset 0\]\n\[e10 dialog "Confirm"\]\nDialog text\.$/);
  const { call: second } = await setup(t, dialogPage());
  const status = await second({ find: 'Saved text' });
  const offset = Number(status.body.match(/^\[offset (\d+)\]/)[1]);
  assert.ok(offset > 0);
  const resumed = await second({ offset });
  assert.ok(resumed.body.startsWith('[e20 status "Saved"]\nSaved text.'), `the second block's offset resolves:\n${resumed.body}`);
  const indexed = await call({ links: 'index' });
  assert.ok(indexed.body.endsWith('## Links\n[e12] http://a.test/help'), indexed.body);
});

test('a paging read can start inside the blocks, and one under links=index reassembles the index from the retained link lists', async (t) => {
  const spec = ['1', 'RootWebArea', 'A', [[2, 'main', '', [[3, 'button', 'Go']]], [10, 'dialog', 'Confirm', [[12, 'link', 'Help', [], { properties: [{ name: 'url', value: { value: 'http://a.test/help' } }] }]]]]];
  const fixture = overlayPage(spec, { e10: { text: lines('Dialog', 10) } });
  fixture.elements.push(control('link', 'Help', { backendNodeId: 12, href: 'http://a.test/help' }));
  const { call, fake } = await setup(t, fixture);
  const first = await call({ maxChars: 60, links: 'index' });
  const next = Number(first.payload.match(/Pass offset=(\d+)/)[1]);
  const renders = renderCalls(fake);
  const paged = await call({ maxChars: 40000, offset: next, links: 'index' });
  assert.strictEqual(renderCalls(fake), renders, 'sliced, not rendered');
  assert.match(paged.body, /^\nDialog line [1-3]\./, 'the slice starts inside the dialog\'s block');
  assert.ok(paged.body.endsWith('## Links\n[e12] http://a.test/help'), paged.body);
});

test("the controls of a rendered block drop out of the omission line, while those of an overlay past the four, one skipped, or one past a block's cut stay counted", async (t) => {
  const spec = ['1', 'RootWebArea', 'A', [
    [2, 'main', '', [[3, 'button', 'Go']]],
    [10, 'dialog', 'Confirm', [[11, 'button', 'OK']]],
    [20, 'status', 'One', [[21, 'button', 'Undo one']]],
    [22, 'status', 'Two'], [23, 'status', 'Three'],
    [24, 'status', 'Four', [[25, 'button', 'Undo four']]],
  ]];
  const overlays = { e10: { text: 'Dialog.' }, e20: { text: 'One.' }, e22: { text: 'Two.' }, e23: { text: 'Three.' }, e24: { text: 'Four.' } };
  const { call } = await setup(t, overlayPage(spec, overlays));
  assert.match((await call()).head, /\nScope: main \(omitted: 1 button elsewhere; scope=all shows everything\)\n/, 'the fifth overlay\'s button alone');
  const { call: tiny } = await setup(t, overlayPage(['1', 'RootWebArea', 'A', [[2, 'main', '', [[3, 'button', 'Go']]], [30, 'alert', 'Route', [[31, 'button', 'Skip']]]]], { e30: { tiny: true } }));
  assert.match((await tiny()).head, /\nScope: main \(omitted: 1 button elsewhere; scope=all shows everything\)$/, 'a 1×1 announcer\'s controls stay counted');
  const long = Array.from({ length: 120 }, (unused, i) => `Dialog line ${i} of a length that fills the block.`).join('\n');
  const { call: cut } = await setup(t, overlayPage(['1', 'RootWebArea', 'A', [[2, 'main', ''], [10, 'dialog', 'Long', [[11, 'button', 'Early'], [12, 'button', 'Late']]]]], {
    e10: () => ({ markdown: `[e11 button "Early"]\n${long}\n[e12 button "Late"]`, links: [], chain: 'ref', refs: ['e11', 'e12'], hiddenRefs: [], article: null }),
  }));
  const read = await cut();
  assert.match(read.body, /\n… cut; scope=e10 reads it whole\n\[\/dialog\]/);
  const kept = read.body.slice(read.body.indexOf('\n') + 1, read.body.indexOf('\n… cut;'));
  assert.ok(kept.length <= 4000 && kept.length > 4000 - 52, `the block's own text is cut within a line of 4,000 (${kept.length})`);
  assert.match(read.head, /\nScope: main \(omitted: 1 button elsewhere; scope=all shows everything\)\n/, 'the control past the cut stays counted');
});

test('an overlay that opens between a read and an action shows in the summary as added lines carrying its refs', async (t) => {
  const spec = ['1', 'RootWebArea', 'A', [[2, 'main', '', [[3, 'button', 'Go']]]]];
  const fixture = overlayPage(spec, { e10: { text: 'Dialog text.' } }, {
    elements: [control('button', 'Go', { backendNodeId: 3, onClick: (fake) => {
      fake.site[URL].tree[0].childIds.push('10');
      fake.site[URL].tree.push(bareNode(10, 'dialog', 'Confirm', { childIds: ['11'], ...MODAL }), bareNode(11, 'button', 'OK'));
    } })],
  });
  const { call, context, session } = await setup(t, fixture);
  await call();
  const click = await input.click(context, session, { ref: 'e3' });
  assert.match(click.head, /\nChanged: 4 lines added, 0 removed$/);
  assert.strictEqual(click.body, '@@\n+ [e10 dialog "Confirm" (modal)]\n+ Dialog text.\n+ [e11 button "OK"]\n+ [/dialog]', "the overlays are diffed apart, so the region lends no context");
});

test('a dialog that the tree marks modal says so in its marker and on the Overlays: line, and one over an aria-hidden app root reads under Scope: body', async (t) => {
  const { call } = await setup(t, overlayPage(['1', 'RootWebArea', 'A', [
    [5, 'generic', '', [[2, 'main', '', [[3, 'button', 'Go']], { ignored: true }]], { ignored: true }],
    [10, 'dialog', 'Delete this repository?', [[11, 'button', 'Cancel']], MODAL],
  ]], { e10: { text: 'This will permanently delete it.' } }, { text: '' }));
  const { head, body } = await call();
  assert.strictEqual(head, 'URL: http://a.test/\nTitle: A\nScope: body\nOverlays: dialog "Delete this repository?" [e10] (modal) (above the page)');
  assert.ok(body.startsWith('[e10 dialog "Delete this repository?" (modal)]\nThis will permanently delete it.'), body);
});

test('a main root lost before the render still renders the main pick\'s blocks ahead of the body region', async (t) => {
  const { call } = await setup(t, dialogPage({ lostRoot: true }));
  const { head, body } = await call();
  assert.match(head, /\nScope: body\nOverlays: dialog "Confirm" \[e10\], status "Saved" \[e20\] \(above the page\)$/);
  assert.ok(body.startsWith('[e10 dialog "Confirm"]'));
});

test('a page with ten hidden statuses makes eight overlay render calls without rendering a block', async (t) => {
  const statuses = Array.from({ length: 10 }, (unused, i) => [20 + i, 'status', `Status ${i}`]);
  const { call, fake } = await setup(t, overlayPage(['1', 'RootWebArea', 'A', [[2, 'main', '', [[3, 'button', 'Go']]], ...statuses]], Object.fromEntries(statuses.map(([id]) => [`e${id}`, { hidden: true }]))));
  const before = renderCalls(fake, { overlay: true });
  const { head } = await call();
  assert.strictEqual(renderCalls(fake, { overlay: true }) - before, 8);
  assert.match(head, /\nOverlays: not rendered: \[e28\], \[e29\]$/);
});

test('a nameless overlay opens its block with its role and ref alone', async (t) => {
  const { call } = await setup(t, overlayPage(['1', 'RootWebArea', 'A', [[2, 'main', '', [[3, 'button', 'Go']]], [10, 'dialog', '', [[11, 'button', 'OK']]]]], { e10: { text: 'Dialog text.' } }));
  const { head, body } = await call();
  assert.match(head, /\nOverlays: dialog \[e10\] \(above the page\)$/);
  assert.ok(body.startsWith('[e10 dialog]\nDialog text.\n\n[e11 button "OK"]\n[/dialog]\n\n'), body);
});

test('a hidden control inside a block counts as hidden, not as one the read left out', async (t) => {
  const fixture = overlayPage(['1', 'RootWebArea', 'A', [
    [2, 'main', '', [[3, 'button', 'Go']]],
    [10, 'dialog', 'Confirm', [[11, 'button', 'OK'], [12, 'button', 'Shade']]],
  ]], { e10: { text: 'Dialog text.' } });
  fixture.elements.find((el) => el.backendNodeId === 12).visible = false;
  const { call } = await setup(t, fixture);
  const { head, body } = await call();
  assert.strictEqual(head, [
    'URL: http://a.test/',
    'Title: A',
    'Scope: main',
    'Overlays: dialog "Confirm" [e10] (above the page)',
    'Hidden: 1 control on the page (hidden=true lists them)',
  ].join('\n'));
  assert.ok(!body.includes('e12'), body);
});

test("a since read's head carries the Settled:, Overlays:, and Hidden: lines that a read's would", async (t) => {
  const fixture = dialogPage();
  fixture.elements.push(control('button', 'Shade', { visible: false }));
  const { call, fake } = await setup(t, fixture);
  await call();
  fake.site[URL].text = 'Main text, changed.';
  fake.site[URL].busy = { throws: 'the observer broke' };
  const since = await call({ since: true });
  assert.strictEqual(since.head, [
    'URL: http://a.test/',
    'Title: A',
    'Settled: no — the page could not be checked',
    'Since: 1 line added, 1 removed',
    'Scope: main',
    'Overlays: dialog "Confirm" [e10], status "Saved" [e20] (above the page)',
    'Hidden: 1 control on the page (hidden=true lists them)',
  ].join('\n'));
  assert.strictEqual(since.outcome, 'unsettled');
});

test("a custom listbox's options and an ARIA combobox's print with their refs, a native select's without, and every option joins the ref set", async (t) => {
  const options = (base, names) => names.map((name, i) => [base + 1 + i, 'option', name]);
  const spec = ['1', 'RootWebArea', 'A', [[2, 'main', '', [
    [40, 'combobox', 'Sort', options(40, ['Newest', 'Oldest', 'Price'])],
    [50, 'listbox', 'Colour', options(50, ['Red', 'Green'])],
    [60, 'listbox', 'Toppings', options(60, ['Cheese', 'Olives'])],
  ]]]];
  const fixture = overlayPage(spec, {}, { elements: [control('listbox', 'Toppings', { backendNodeId: 60, select: true })] });
  const { call, session, target } = await setup(t, fixture);
  const { body } = await call();
  assert.match(body, /\[e40 combobox "Sort" \(options: Newest \[e41\], Oldest \[e42\], Price \[e43\]\)\]/);
  assert.match(body, /\[e50 listbox "Colour" \(options: Red \[e51\], Green \[e52\]\)\]/);
  assert.match(body, /\[e60 listbox "Toppings" \(options: Cheese, Olives\)\]/);
  const ids = session.refs.get(target.targetId).ids;
  for (const id of [41, 42, 43, 51, 52, 61, 62]) assert.ok(ids.has(id), `e${id} joined the ref set`);
});

test('scope= on a select of 40 options renders its marker as the region, with every option', async (t) => {
  const names = Array.from({ length: 40 }, (unused, i) => `Size ${i + 1}`);
  const spec = ['1', 'RootWebArea', 'A', [[2, 'main', '', [[70, 'combobox', 'Size', names.map((name, i) => [71 + i, 'option', name])]]]]];
  const { call } = await setup(t, overlayPage(spec, {}, { elements: [control('combobox', 'Size', { backendNodeId: 70, select: true })] }));
  const whole = await call();
  assert.match(whole.body, /\(options: Size 1, Size 2, .*Size 12, … and 28 more\)\]/, 'outside a scope it lists twelve');
  const { body } = await call({ scope: 'e70' });
  assert.strictEqual(body, `[e70 combobox "Size" (options: ${names.join(', ')})]`);
});

// Resolves with the setup of a page whose tree is `spec`, with each frame in `frames`
// ({ backendId, text }) attached as an out-of-process frame target whose page serves
// `text`; the result's `frames` maps each backendId to its fake target.
async function setupOverlayFrames(t, spec, overlays, frames) {
  const childFrames = frames.map(({ backendId }) => ({ backendId, url: `http://frame.test/${backendId}` }));
  const ctx = await setup(t, overlayPage(spec, overlays, { childFrames }));
  for (const { backendId, text, elements = [] } of frames) ctx.fake.site[`http://frame.test/${backendId}`] = page(elements, { title: `Frame ${backendId}`, text });
  const parent = ctx.fake.targets.get(ctx.session.workingTargetId);
  const attached = {};
  for (const { backendId } of frames) {
    const frame = await attachFrame(ctx, parent, backendId);
    attached[backendId] = frame;
  }
  return { ...ctx, frames: attached };
}

const iframe = (id) => [id, 'Iframe', ''];

test("a block's frames are read ahead of the page's and draw on the read's frame text first", async (t) => {
  const long = (n) => `${'Frame prose that fills the budget. '.repeat(Math.ceil(n / 35)).slice(0, n)}`;
  const spec = ['1', 'RootWebArea', 'A', [[2, 'main', '', [iframe(90)]], [10, 'dialog', 'Pay', [iframe(95), iframe(96)]]]];
  const { call } = await setupOverlayFrames(t, spec, { e10: { text: 'Dialog text.' } }, [
    { backendId: 90, text: long(1000) }, { backendId: 95, text: long(7900) }, { backendId: 96, text: long(7900) },
  ]);
  const { body } = await call();
  assert.match(body, /\[e95 frame http:\/\/frame\.test\/95 cross-site\]\n/);
  assert.match(body, /\[e96 frame http:\/\/frame\.test\/96 cross-site\]\n/);
  assert.match(body, /\(frame content cut: \d+ more characters; scope=e90 reads it whole\)/, "the page's frame got what the dialog's left of the 16,000");
  assert.ok(body.indexOf('[e95 frame') < body.indexOf('[e90 frame'), 'the dialog prints first');
});

test('a frame level reads each target\'s frame tree once, and doesn\'t read one for a parent without a frame', async (t) => {
  const spec = ['1', 'RootWebArea', 'A', [[2, 'main', '', [iframe(90)]], [10, 'dialog', 'Pay', [iframe(95)]], [20, 'dialog', 'Note']]];
  const { call, fake } = await setupOverlayFrames(t, spec, { e10: { text: 'Dialog text.' }, e20: { text: 'Note text.' } }, [
    { backendId: 90, text: 'Page frame text.' }, { backendId: 95, text: 'Dialog frame text.' },
  ]);
  const trees = () => fake.callsTo('Page.getFrameTree').length;
  const before = trees();
  const { body } = await call();
  assert.match(body, /\[e95 frame http:\/\/frame\.test\/95 cross-site\]\nDialog frame text\./);
  assert.match(body, /\[e90 frame http:\/\/frame\.test\/90 cross-site\]\nPage frame text\./);
  assert.strictEqual(trees() - before, 1, "the page's tree, once for the dialog with a frame and the region; the frameless dialog and the frames' own renders read none");
});

test("when the eight frame units run short the dialog's frames take them, and a placeholder past the block's cut spends none", async (t) => {
  const inDialog = [95, 96, 97, 98, 99, 101, 102, 103];
  const spec = ['1', 'RootWebArea', 'A', [[2, 'main', '', [iframe(90)]], [10, 'dialog', 'Many', inDialog.map(iframe)]]];
  const { call } = await setupOverlayFrames(t, spec, { e10: { text: 'Dialog text.' } }, [90, ...inDialog].map((backendId) => ({ backendId, text: `Frame ${backendId} text.` })));
  const { body } = await call();
  assert.match(body, /\[e90 frame http:\/\/frame\.test\/90 \(not read: frame limit\)\]/, "the page's frame is past the limit");
  for (const id of inDialog) assert.match(body, new RegExp(`\\[e${id} frame http://frame\\.test/${id} cross-site\\]\\nFrame ${id} text\\.`));

  const cutSpec = ['1', 'RootWebArea', 'A', [[2, 'main', '', [iframe(90)]], [10, 'dialog', 'Long', [iframe(95)]]]];
  const filler = Array.from({ length: 120 }, (unused, i) => `Dialog line ${i} that pushes the frame past the cut.`).join('\n');
  const cut = await setupOverlayFrames(t, cutSpec, {
    e10: () => ({ markdown: `${filler}\n\u0000frame:e95\u0000`, links: [], chain: 'ref', refs: ['e95'], hiddenRefs: [], article: null }),
  }, [{ backendId: 90, text: 'Page frame text.' }, { backendId: 95, text: 'Dialog frame text.' }]);
  const pulls = () => cut.fake.callsTo('Accessibility.getFullAXTree').filter((c) => c.sessionId === cut.frames[95].sessionId).length;
  const before = pulls();
  const read = await cut.call();
  assert.strictEqual(pulls(), before, 'the frame past the cut was never pulled');
  assert.ok(!read.body.includes('Dialog frame text.'));
  assert.match(read.body, /\[e90 frame http:\/\/frame\.test\/90 cross-site\]\nPage frame text\./);
});

test('a read scoped into a frame picks dialogs alone, leaves out a dialog holding the frame, and reads the frame once', async (t) => {
  const spec = ['1', 'RootWebArea', 'A', [
    [2, 'main', '', [[3, 'button', 'Go']]],
    [30, 'dialog', 'Holder', [iframe(90)]],
    [10, 'dialog', 'Confirm', [[11, 'button', 'OK']]],
    [12, 'dialog', 'Second'], [14, 'dialog', 'Third'], [16, 'dialog', 'Fourth'], [18, 'dialog', 'Fifth'],
    [20, 'status', 'Saved'],
  ]];
  const overlays = { e10: { text: 'Dialog text.' }, e12: { text: 'Two.' }, e14: { text: 'Three.' }, e16: { text: 'Four.' }, e18: { text: 'Five.' }, e30: { text: 'Holder.' } };
  const { call, context, session } = await setupOverlayFrames(t, spec, overlays, [{ backendId: 90, text: 'Frame text.', elements: [control('button', 'In frame')] }]);
  const first = await call();
  const inFrame = refsIn(first.payload)['In frame'];
  assert.match(inFrame, /^f1e\d+$/, first.payload);
  // The page's own ref set is deleted, so what resolves below is what the frame-scoped
  // read offered alone.
  session.refs.delete(session.workingTargetId);
  const scoped = await call({ scope: inFrame });
  assert.match(scoped.head, /\nOverlays: dialog "Confirm" \[e10\], dialog "Second" \[e12\], dialog "Third" \[e14\], dialog "Fourth" \[e16\], … and 1 more: \[e18\] \(above the page\)$/);
  assert.ok(!scoped.body.includes('Holder.') && !scoped.body.includes('[e20 status'), scoped.body);
  assert.strictEqual(scoped.body.split('Frame text.').length, 2, 'the scoped frame renders once, as the region, and in no block');
  // What the frame-scoped read offered resolves without a read of the page.
  const click = await input.click(context, session, { ref: 'e11' });
  assert.match(click.head, /\nNavigated: no\n/);
  assert.match((await call({ scope: 'e10' })).body, /\[e11 button "OK"\]/);
  assert.match((await call({ scope: 'e18' })).head, /\nScope: e18/, 'and so does the fifth dialog, past the four blocks');
});

test("a read scoped into a frame files a block's groups and listed options in the page's set, so a scope on the group resolves", async (t) => {
  const spec = ['1', 'RootWebArea', 'A', [
    [2, 'main', '', [iframe(90)]],
    [10, 'dialog', 'Confirm', [[13, 'group', 'Shipping', [[14, 'button', 'Fast']]], [15, 'listbox', 'Colour', [[16, 'option', 'Red'], [17, 'option', 'Green']]]]],
  ]];
  const { call, session } = await setupOverlayFrames(t, spec, { e10: { text: 'Dialog text.' } }, [{ backendId: 90, text: 'Frame text.', elements: [control('button', 'In frame')] }]);
  const first = await call();
  const inFrame = refsIn(first.payload)['In frame'];
  session.refs.delete(session.workingTargetId);
  await call({ scope: inFrame });
  const { ids } = session.refs.get(session.workingTargetId);
  for (const id of [16, 17]) assert.ok(ids.has(id), `e${id} joined the page's set`);
  assert.match((await call({ scope: 'e13' })).head, /\nScope: e13/);
});

test('a read whose scoped frame goes after the ref checks is a stale ref: a frame target and a same-process frame by the frame that the ref was read in, an <iframe> ref by the frame it names', async (t) => {
  const ctx = await setupFrames(t, 1);
  const first = await ctx.call();
  const inFrame = refsIn(first.payload)['Link 0'];
  const [frame] = ctx.sessions.frameTargets(ctx.session.workingTargetId);
  const pull = ctx.fake.handlers.get('Accessibility.getFullAXTree');
  ctx.fake.handle('Accessibility.getFullAXTree', (params, sid) => {
    if (sid !== frame.cdpSessionId) return pull(params, sid);
    ctx.fake.destroyTarget(frame.targetId);
    throw { code: -32000, message: 'Target closed' };
  });
  const gone = await outcome(ctx.call({ scope: inFrame }));
  assert.deepStrictEqual(gone.fail, { outcome: 'stale_ref', message: `${inFrame}: the frame it was read in is gone; read the page again` });

  const named = await setupFrames(t, 1);
  await named.call();
  const [namedFrame] = named.sessions.frameTargets(named.session.workingTargetId);
  const namedPull = named.fake.handlers.get('Accessibility.getFullAXTree');
  named.fake.handle('Accessibility.getFullAXTree', (params, sid) => {
    if (sid !== namedFrame.cdpSessionId) return namedPull(params, sid);
    named.fake.destroyTarget(namedFrame.targetId);
    throw { code: -32000, message: 'Target closed' };
  });
  const viaIframe = await outcome(named.call({ scope: 'e100' }));
  assert.deepStrictEqual(viaIframe.fail, { outcome: 'stale_ref', message: 'e100: the frame it names is gone; read the page again' });

  const same = await setupSameProcessFrame(t);
  const read = await same.call();
  const bare = refsIn(read.payload)['In frame'];
  assert.strictEqual(bare, 'e55');
  const samePull = same.fake.handlers.get('Accessibility.getFullAXTree');
  same.fake.handle('Accessibility.getFullAXTree', (params, sid) => {
    if (!params.frameId) return samePull(params, sid);
    same.fake.site[URL].childFrames = [];
    throw { code: -32000, message: 'Frame with the given id was not found.' };
  });
  const sameGone = await outcome(same.call({ scope: bare }));
  assert.deepStrictEqual(sameGone.fail, { outcome: 'stale_ref', message: 'e55: the frame it was read in is gone; read the page again' });
});

test("an <iframe> ref whose frame is still there stays not readable when its pull fails or times out", async (t) => {
  for (const fails of [() => { throw { code: -32000, message: 'No frame for given id found' }; }, () => new Promise(() => {})]) {
    const ctx = await setupFrames(t, 1);
    await ctx.call();
    const [frame] = ctx.sessions.frameTargets(ctx.session.workingTargetId);
    const pull = ctx.fake.handlers.get('Accessibility.getFullAXTree');
    ctx.fake.handle('Accessibility.getFullAXTree', (params, sid) => (sid === frame.cdpSessionId ? fails() : pull(params, sid)));
    const { fail } = await outcome(ctx.call({ scope: 'e100', deadline: Date.now() + 2_600 }));
    assert.deepStrictEqual(fail, { outcome: 'error', message: 'the frame at e100 is not readable; read the page around it instead' });
  }
});

test('a frame-scoped read whose frame goes between the tree pull and the render is a stale ref, and one whose frame stays keeps the render failure', async (t) => {
  const ctx = await setupFrames(t, 1);
  const first = await ctx.call();
  const inFrame = refsIn(first.payload)['Link 0'];
  const [frame] = ctx.sessions.frameTargets(ctx.session.workingTargetId);
  const render = ctx.fake.handlers.get('Runtime.callFunctionOn');
  ctx.fake.handle('Runtime.callFunctionOn', (params, sid) => {
    if (sid !== frame.cdpSessionId || !/claudesurfRender\(/.test(params.functionDeclaration)) return render(params, sid);
    ctx.fake.destroyTarget(frame.targetId);
    throw { code: -32000, message: 'Target closed' };
  });
  const gone = await outcome(ctx.call({ scope: inFrame }));
  assert.deepStrictEqual(gone.fail, { outcome: 'stale_ref', message: `${inFrame}: the frame it was read in is gone; read the page again` });

  const same = await setupSameProcessFrame(t);
  await same.call();
  const sameRender = same.fake.handlers.get('Runtime.callFunctionOn');
  let removed = false;
  same.fake.handle('Runtime.callFunctionOn', (params, sid) => {
    const tab = same.fake.bySession(sid);
    if (!/claudesurfRender\(/.test(params.functionDeclaration) || tab.contexts.get(params.executionContextId) !== 'FRAME-SAME') return sameRender(params, sid);
    if (removed) same.fake.site[URL].childFrames = [];
    throw { code: -32000, message: 'Frame with the given id was not found.' };
  });
  const stays = await outcome(same.call({ scope: 'e55' }));
  assert.match(stays.fail.message, /^Rendering the page failed\. /, 'a frame still in the frame tree keeps its own row');
  removed = true;
  const sameGone = await outcome(same.call({ scope: 'e55' }));
  assert.deepStrictEqual(sameGone.fail, { outcome: 'stale_ref', message: 'e55: the frame it was read in is gone; read the page again' });
});

test("a read scoped to an <iframe> whose frame's tree pull meets a closed pipe fails with the pipe's error rather than as not readable", async (t) => {
  const ctx = await setupFrames(t, 1);
  await ctx.call();
  const [frame] = ctx.sessions.frameTargets(ctx.session.workingTargetId);
  const pull = ctx.fake.handlers.get('Accessibility.getFullAXTree');
  ctx.fake.handle('Accessibility.getFullAXTree', (params, sid) => {
    if (sid !== frame.cdpSessionId) return pull(params, sid);
    ctx.fake.close();
    return new Promise(() => {});
  });
  await assert.rejects(ctx.call({ scope: 'e100' }), (e) => e instanceof ConnectionClosedError);
});

test("a frame-scoped read whose render fails, and whose check of the frame then fails or times out, keeps the render's failure", async (t) => {
  const checks = { fails: () => { throw { code: -32000, message: 'Target crashed' }; }, 'times out': () => new Promise(() => {}) };
  for (const [how, check] of Object.entries(checks)) {
    const same = await setupSameProcessFrame(t);
    await same.call();
    let failed = false;
    const render = same.fake.handlers.get('Runtime.callFunctionOn');
    same.fake.handle('Runtime.callFunctionOn', (params, sid) => {
      const tab = same.fake.bySession(sid);
      if (!/claudesurfRender\(/.test(params.functionDeclaration) || tab.contexts.get(params.executionContextId) !== 'FRAME-SAME') return render(params, sid);
      failed = true;
      throw { code: -32000, message: 'Frame with the given id was not found.' };
    });
    const trees = same.fake.handlers.get('Page.getFrameTree');
    same.fake.handle('Page.getFrameTree', (params, sid) => (failed ? check() : trees(params, sid)));
    const { fail } = await outcome(same.call({ scope: 'e55', deadline: Date.now() + 2_600 }));
    assert.ok(failed, how);
    assert.match(fail.message, /^Rendering the page failed\. /, `a check that ${how} decides nothing`);
  }
});

test("a read whose region render meets a closed pipe fails with the pipe's error rather than a render failure", async (t) => {
  const { call, fake } = await setup(t, page([control('button', 'Go')]));
  const render = fake.handlers.get('Runtime.callFunctionOn');
  fake.handle('Runtime.callFunctionOn', (params, sid) => {
    if (!/claudesurfRender\(/.test(params.functionDeclaration)) return render(params, sid);
    fake.close();
    return new Promise(() => {});
  });
  await assert.rejects(call(), (e) => e.name === 'ConnectionClosedError' || /browser connection closed|target .* is gone/.test(e.message));
});
