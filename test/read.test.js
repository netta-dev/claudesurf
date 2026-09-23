// The read pipeline against the in-process fake: the header lines each parameter adds,
// the hidden list, the ref set the units fill, and the object groups a read releases.

const { test, mock } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { enableTargets } = require('../server/browser');
const input = require('../server/input');
const read = require('../server/read');
const { OutcomeError } = require('../server/action-support');
const { fakeSession, recordingLog, refsIn, waitFor } = require('./helpers');

const URL = 'http://a.test/';

// A page the fake serves: `elements` is what the walk finds and, through the tree the
// fake derives from them, what a read finds too.
function page(elements, extra = {}) {
  return { title: 'A', text: 'First paragraph.\n\nSecond paragraph.', elements, scrollY: 0, pageHeight: 1200, viewportHeight: 600, ...extra };
}

function control(kind, label, extra = {}) {
  return { kind, label, disabled: false, checked: false, visible: true, ...extra };
}

async function setup(fixture, options = {}) {
  const ctx = fakeSession(options);
  await enableTargets(ctx.conn);
  ctx.fake.site[URL] = fixture;
  const session = await ctx.sessions.ensure('s1');
  await input.navigate(ctx.sessions, session, { url: URL, name: 'n' });
  const call = (args = {}) => read.readPage(ctx.sessions, session, { maxChars: 40000, offset: 0, ...args });
  return { ...ctx, session, call, target: ctx.sessions.target(session.workingTargetId) };
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
async function setupFrames(count, content, options = {}) {
  const fixture = framedPage(count, content);
  const ctx = await setup(fixture.page, options);
  Object.assign(ctx.fake.site, fixture.site);
  const parent = ctx.fake.targets.get(ctx.session.workingTargetId);
  for (let i = 0; i < count; i++) {
    const frame = ctx.fake.attachFrame(parent, 100 + i);
    await waitFor(() => ctx.sessions.target(frame.targetId) && ctx.sessions.target(frame.targetId).generation > 0);
  }
  return ctx;
}

// A page holding one same-process child frame: a frame of the page's own renderer,
// which the frame tree names and the target registry never sees. `frameId` null leaves
// that frame with no id, so describeNode answers without one, as it does for an
// <iframe> holding no document at all.
async function setupSameProcessFrame({ frameId = 'FRAME-SAME' } = {}, options = {}) {
  const tree = [
    { nodeId: 'n0', role: { value: 'RootWebArea' }, name: { value: 'A' }, childIds: ['n1'] },
    { nodeId: 'n1', role: { value: 'Iframe' }, name: { value: '' }, backendDOMNodeId: 100 },
  ];
  const child = 'http://a.test/child';
  const entry = { backendId: 100, url: child };
  if (frameId) entry.id = frameId;
  const ctx = await setup(page([], { tree, text: 'The page around the frame.', childFrames: [entry] }), options);
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
async function setupNested(depth, options = {}) {
  const fixture = nestedPage(depth);
  const ctx = await setup(fixture.page, options);
  Object.assign(ctx.fake.site, fixture.site);
  let parent = ctx.fake.targets.get(ctx.session.workingTargetId);
  for (let level = 0; level < depth; level++) {
    const frame = ctx.fake.attachFrame(parent, 200 + level);
    await waitFor(() => ctx.sessions.target(frame.targetId) && ctx.sessions.target(frame.targetId).generation > 0);
    parent = frame;
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
  const { call } = await setup(page([control('button', 'Go')]));
  await assert.rejects(call(), (e) => {
    // daemon.js renders this one as setup_error; anything else would be `error`.
    assert.strictEqual(e.name, 'SetupError');
    assert.match(e.message, /turndown-plugin-gfm/);
    assert.match(e.message, /npm --prefix server ci --ignore-scripts/);
    return true;
  });
});

test('the header is the state lines and the scope, then a blank line, then the render', async () => {
  const { call } = await setup(page([control('button', 'Go')]));
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

test('a page with a main landmark renders it and reports what it left out, by ref and by count', async () => {
  const tree = [
    { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'A' }, childIds: ['2', '4'] },
    { nodeId: '2', role: { value: 'navigation' }, name: { value: 'Site' }, backendDOMNodeId: 20, childIds: ['3'] },
    { nodeId: '3', role: { value: 'link' }, name: { value: 'Away' }, backendDOMNodeId: 21, properties: [{ name: 'url', value: { value: 'http://a.test/away' } }] },
    { nodeId: '4', role: { value: 'main' }, name: { value: '' }, backendDOMNodeId: 40, childIds: ['5'] },
    { nodeId: '5', role: { value: 'button' }, name: { value: 'Go' }, backendDOMNodeId: 41 },
  ];
  const { call, session, target } = await setup(page([control('button', 'Go', { backendNodeId: 41 })], { tree }));
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

test('a tree node with no DOM node behind it is neither described, recorded, nor named by the omission line', async () => {
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
  const { call, fake, session, target } = await setup(page([control('button', 'Go', { backendNodeId: 41 })], { tree }));
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

test('a read the document outlived leaves the ref set at the generation it was read', async () => {
  const { call, fake, session, sessions, target } = await setup(page([control('button', 'Go')]));
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
  assert.notStrictEqual(set.generation, target.generation, 'the set the last good read left claims nothing about the new document');
  const clicked = await outcome(input.click(sessions, session, ref, {}));
  assert.strictEqual(clicked.fail.outcome, 'stale_ref', 'and a ref from before it is stale');
});

test('a scope ref no read returned, and one the tree has since lost, are both errors', async () => {
  const fixture = page([control('button', 'Go', { backendNodeId: 7 })]);
  const { call, fake } = await setup(fixture);
  const unread = await outcome(call({ scope: 'e999' }));
  assert.strictEqual(unread.fail.outcome, 'error');
  assert.match(unread.fail.message, /^e999 was not returned by a read of this document/);
  await call();
  fake.site[URL].tree = fixture.tree.filter((node) => node.backendDOMNodeId !== 7);
  const gone = await outcome(call({ scope: 'e7' }));
  assert.strictEqual(gone.fail.outcome, 'error');
  assert.match(gone.fail.message, /^e7 is not in this document any more/);
});

test('hidden controls are always counted, and the ones Chrome pruned from the tree arrive with hidden=true', async () => {
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
  const { call, session, target } = await setup(page(elements, { tree }));
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

test('the hidden ids of a read a navigation overtook carry the generation they were read at', async () => {
  const other = 'http://a.test/elsewhere';
  const { call, fake, session, sessions, target } = await setup(page([
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
  const clicked = await outcome(input.click(sessions, session, shade, {}));
  assert.strictEqual(clicked.fail.outcome, 'stale_ref', 'so a hidden ref of that read is stale rather than a click into the new document');
});

test("the walk's elements go with the document, so a read that lost them says so rather than describing another document's nodes", async () => {
  const other = 'http://a.test/elsewhere';
  // The third control is one Chrome prunes from the tree, so the hidden list is the
  // only thing that would put its id in the set.
  const tree = [
    { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'A' }, childIds: ['2', '3'] },
    { nodeId: '2', role: { value: 'button' }, name: { value: 'Go' }, backendDOMNodeId: 1 },
    { nodeId: '3', role: { value: 'button' }, name: { value: 'Shade' }, backendDOMNodeId: 2 },
  ];
  const { call, fake, session, target } = await setup(page([
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

test('the hidden section is part of the region, so max_chars cuts it and an offset reaches it', async () => {
  const { call } = await setup(page([control('button', 'Go'), control('button', 'Shade', { visible: false })]));
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

test('links=index moves the URLs to a trailing list and the header says where it starts', async () => {
  const elements = [control('link', 'Home', { href: 'http://a.test/home' }), control('link', 'Same', { href: 'http://a.test/home' })];
  const { call } = await setup(page(elements));
  const { payload } = await call({ links: 'index' });
  const offset = Number(payload.match(/^Links: 1 \(index at offset (\d+)\)$/m)[1]);
  const region = payload.slice(payload.indexOf('\n\n') + 2);
  assert.strictEqual(region.slice(offset), '## Links\n[e10, e11] http://a.test/home');
  assert.ok(!payload.includes('](http://a.test/home)'), 'no URL is left in the prose');
});

test('find returns the matching blocks with their offsets, and pages by block', async () => {
  const { call } = await setup(page([control('button', 'Go')]));
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

test('a find read resumes at a block it delivered, not at an [offset N] line the page wrote', async () => {
  // A fenced block is the one place page text reaches the payload unescaped, so a line
  // the page wrote in the daemon's own mark form arrives whole; here it is a block of
  // its own, delivered before the cut, with the third block's mark past it.
  const text = 'Findable first.\n\n```\n[offset 999]\nFindable fence\n```\n\nFindable second.';
  const { call } = await setup(page([], { text }));
  const whole = await call({ find: 'Findable' });
  const region = whole.payload.slice(whole.payload.indexOf('\n\n') + 2);
  const cut = await call({ find: 'Findable', maxChars: region.lastIndexOf('[offset ') - 1 });
  assert.ok(cut.payload.includes('[offset 999]'), `the page's own line is in the region:\n${cut.payload}`);
  assert.match(cut.payload, /Narrow find, or read without it from offset 17\.\]/, 'and the resume offset is the mark the daemon wrote');
  const rest = await call({ offset: 17 });
  assert.ok(rest.payload.includes('Findable fence'), 'which is where the block the cut stopped at begins');
});

test('find narrows the links index to the blocks it delivered, drops the hidden section, and searches neither', async () => {
  const elements = [
    control('link', 'Inside a.test', { href: 'http://a.test/in' }),
    control('button', 'Shade', { visible: false }),
  ];
  const { call } = await setup(page(elements, { text: 'Findable paragraph.' }));
  // The needle is in the index line as well as in the prose block that carries the ref.
  const { payload } = await call({ find: 'a.test', links: 'index', hidden: true });
  assert.match(payload, /\nFind: "a.test" — 1 block\n/, 'the index is appended after find has run, so it is no block of the page');
  assert.match(payload, /\nLinks: 1\n/, 'with no offset, which a find read cannot pass');
  assert.match(payload, /\nHidden: 1 control on the page \(not listed under find\)\n/, 'the count still prints');
  assert.ok(!payload.includes('## Hidden elements'), 'the list is no block of the page either');
  assert.ok(payload.endsWith('[offset 21]\n[Inside a.test][e10]\n\n## Links\n[e10] http://a.test/in'), payload);
  assert.ok(!payload.includes('Findable paragraph.'), 'only the matching block is in the region');
});

test('find does not take an escaped bracket in page text for a marker when it narrows the links index', async () => {
  const elements = [control('link', 'Real', { href: 'http://a.test/real' })];
  // Turndown escapes a page's own brackets, so `\[e10 button "x"\]` in the prose is text, not a marker.
  const { call } = await setup(page(elements, { text: 'Mentions \\[e10 button "x"\\] in prose.' }));
  const { payload } = await call({ find: 'Mentions', links: 'index' });
  assert.match(payload, /\nFind: "Mentions" — 1 block\n/);
  assert.ok(!payload.includes('http://a.test/real'), `the escaped mention brings no URL into the index: ${payload}`);
});

test('article=true reports the extraction, and a page without one falls back to the scope', async () => {
  const found = await setup(page([], { article: { title: 'The scroll bar', byline: 'By Ada' } }));
  const hit = await found.call({ article: true });
  assert.match(hit.payload, /\nScope: readability\nArticle: "The scroll bar" by "Ada"$/m);
  const none = await setup(page([]));
  const miss = await none.call({ article: true });
  assert.match(miss.payload, /\nScope: body\nArticle: none found\n/);
});

test('article=true falls back to the chain step the scope reached rather than to the body', async () => {
  const tree = [
    { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'A' }, childIds: ['2'] },
    { nodeId: '2', role: { value: 'main' }, name: { value: '' }, backendDOMNodeId: 40, childIds: ['3'] },
    { nodeId: '3', role: { value: 'button' }, name: { value: 'Go' }, backendDOMNodeId: 41 },
  ];
  const { call } = await setup(page([control('button', 'Go', { backendNodeId: 41 })], { tree }));
  const { payload } = await call({ article: true });
  assert.match(payload, /\nScope: main\nArticle: none found\n/, `the main landmark is what rendered:\n${payload}`);
});

test('article=true resolves the whole page, so a control outside the scope that Readability keeps renders', async () => {
  const tree = [
    { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'A' }, childIds: ['2', '4'] },
    { nodeId: '2', role: { value: 'navigation' }, name: { value: 'Site' }, backendDOMNodeId: 20, childIds: ['3'] },
    { nodeId: '3', role: { value: 'link' }, name: { value: 'Away' }, backendDOMNodeId: 21, properties: [{ name: 'url', value: { value: 'http://a.test/away' } }] },
    { nodeId: '4', role: { value: 'main' }, name: { value: '' }, backendDOMNodeId: 40, childIds: ['5'] },
    { nodeId: '5', role: { value: 'button' }, name: { value: 'Go' }, backendDOMNodeId: 41 },
  ];
  const elements = [control('button', 'Go', { backendNodeId: 41 }), control('link', 'Away', { backendNodeId: 21, href: 'http://a.test/away' })];
  const { call } = await setup(page(elements, { tree, article: { title: 'The scroll bar', byline: 'By Ada' } }));
  const { payload } = await call({ article: true });
  assert.ok(payload.includes('[Away](http://a.test/away)[e21]'), `the link outside main is resolved and marked:\n${payload}`);
  assert.strictEqual(payload.split('\n')[2], 'Scope: readability', 'and nothing is reported omitted');
});

test('a renderer exception fails the read with the exception text and the recourses', async () => {
  const { call, fake } = await setup(page([control('button', 'Go')]));
  fake.site[URL].render = () => { throw new Error('Cannot read properties of null'); };
  const { fail } = await outcome(call({ article: true }));
  assert.strictEqual(fail.outcome, 'error');
  assert.match(fail.message, /^Rendering the page failed: .*Cannot read properties of null/);
  assert.match(fail.message, /Try scope=all or scope=<ref> for another subtree, article=false, or screenshot\.$/);
});

test('a read releases the object group of every unit it resolved nodes in', async () => {
  const { call, fake } = await setup(page([control('button', 'Go'), control('button', 'Shade', { visible: false })]));
  await call({ hidden: true });
  const groups = fake.callsTo('Runtime.releaseObjectGroup').map((c) => c.params.objectGroup);
  assert.deepStrictEqual(groups, ['claudesurf-read-0', 'claudesurf-read-hidden']);
  const resolved = fake.callsTo('DOM.resolveNode').map((c) => c.params.objectGroup);
  assert.ok(resolved.length > 0 && resolved.every((g) => g === 'claudesurf-read-0'));
});

test('a release the browser refuses is logged and never reaches the caller', async () => {
  const { call, fake, log } = await setup(page([control('button', 'Go')]), { log: recordingLog() });
  fake.handle('Runtime.releaseObjectGroup', () => { throw { code: -32000, message: 'Cannot find context with specified id' }; });
  const { payload } = await call();
  assert.ok(payload.endsWith('[e10 button "Go"]'), `the read delivered what it rendered:\n${payload}`);
  assert.deepStrictEqual(log.lines.debug.filter((line) => line.startsWith('releasing ')), [
    'releasing claudesurf-read-0: Runtime.releaseObjectGroup: Cannot find context with specified id',
  ], 'a caller on its way out learns of it from the log alone');
});

test('the hidden list releases its element handles even when the read has spent its deadline', async () => {
  const { call, fake } = await setup(page([control('button', 'Go'), control('button', 'Shade', { visible: false })]));
  // The release answers late, so a read that abandoned it at its own spent deadline
  // would finish before the browser had let the nodes go.
  const order = [];
  fake.handle('Runtime.releaseObjectGroup', ({ objectGroup }) => new Promise((resolve) => setTimeout(() => {
    order.push(objectGroup);
    resolve({});
  }, 100)));
  // The walk's handles are taken and then the read runs out of time reading them.
  fake.handle('DOM.describeNode', () => new Promise(() => {}));
  await assert.rejects(call({ hidden: true, deadline: Date.now() + 600 }), /DOM.describeNode timed out/);
  order.push('read returned');
  assert.deepStrictEqual(order, ['claudesurf-read-0', 'claudesurf-read-hidden', 'read returned']);
});

test('the renderer source is evaluated once per world and the second read reuses it', async () => {
  const { call, fake, target } = await setup(page([control('button', 'Go')]));
  await call();
  await call();
  const injections = fake.callsTo('Runtime.evaluate').filter((c) => /claudesurfRender/.test(c.params.expression));
  assert.strictEqual(injections.length, 1, 'the 140 KB of libraries goes in once per document');
  fake.navigateTarget(fake.targets.get(target.targetId), URL);
  await call();
  assert.strictEqual(fake.callsTo('Runtime.evaluate').filter((c) => /claudesurfRender/.test(c.params.expression)).length, 2, 'a new document gets its own');
});

test('a library that throws as it is evaluated fails the read, and the next read evaluates it again', async () => {
  const { call, fake } = await setup(page([control('button', 'Go')]));
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
  assert.match(fail.message, /the renderer's libraries did not evaluate.*TurndownService is not a constructor/);
  throwing = false;
  const { payload } = await call();
  assert.ok(payload.endsWith('[e10 button "Go"]'), `the world was left uninjected, so the next read evaluates them again:\n${payload}`);
  assert.strictEqual(fake.callsTo('Runtime.evaluate').filter((c) => /claudesurfRender/.test(c.params.expression)).length, 2);
});

test('a document that renders nothing reads as no text rather than as an empty payload', async () => {
  const { call } = await setup(page([], { text: '' }));
  const { payload } = await call();
  assert.ok(payload.endsWith('\n\n(no readable text; use screenshot)'));
});

test('a frame renders inline under its own ref prefix, and its links join the index', async () => {
  const { call, session, sessions } = await setupFrames(2);
  const { payload } = await call({ links: 'index' });
  assert.match(payload, /\[e100 frame http:\/\/frame\.test\/0 cross-site\]\nFrame 0 text\.\n\n\[Link 0\]\[f1e\d+\]\n\[\/frame\]/);
  assert.match(payload, /\[e101 frame http:\/\/frame\.test\/1 cross-site\]/);
  assert.match(payload, /## Links\n\[f1e\d+\] http:\/\/frame\.test\/0\/away\n\[f2e\d+\] http:\/\/frame\.test\/1\/away$/);
  const [first] = sessions.frameTargets(session.workingTargetId);
  assert.deepStrictEqual([...session.refs.get(first.targetId).ids.values()], [null], "a frame's refs live in its own target's set");
});

test('past the eight-frame limit a frame says so instead of rendering', async () => {
  const { call, log } = await setupFrames(9, undefined, { log: recordingLog() });
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

test('a frame whose unit fails renders as not readable, and the page is delivered anyway', async () => {
  const { call, fake, log } = await setupFrames(2, undefined, { log: recordingLog() });
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

test('an iframe outside the scope is listed by ref as a frame the read did not enter', async () => {
  const fixture = framedPage(1);
  fixture.page.tree[0].childIds.unshift('m');
  fixture.page.tree.push({ nodeId: 'm', role: { value: 'main' }, name: { value: '' }, backendDOMNodeId: 50, childIds: [] });
  const ctx = await setup(fixture.page);
  Object.assign(ctx.fake.site, fixture.site);
  const parent = ctx.fake.targets.get(ctx.session.workingTargetId);
  const frame = ctx.fake.attachFrame(parent, 100);
  await waitFor(() => ctx.sessions.target(frame.targetId) && ctx.sessions.target(frame.targetId).generation > 0);
  const { payload } = await ctx.call();
  assert.strictEqual(payload.split('\n')[2], 'Scope: main (omitted: frames not read: [e100]; scope=all shows everything)');
  assert.ok(!payload.includes('Frame 0 text.'), 'a frame outside the scope is not pulled');
  const all = await ctx.call({ scope: 'all' });
  assert.ok(all.payload.includes('Frame 0 text.'));
});

test('scope on an iframe ref reads that frame alone', async () => {
  const { call } = await setupFrames(1);
  await call();
  const { payload } = await call({ scope: 'e100' });
  assert.ok(payload.includes('Frame 0 text.'));
  assert.ok(!payload.includes('[e100 frame'), 'the frame is the whole region, not a block inside the page');
  assert.match(payload.split('\n')[2], /^Scope: e100$/);
});

test('scope on a same-process frame ref reads that frame, whose refs stay the page target\'s', async () => {
  const { call, session, target } = await setupSameProcessFrame();
  const whole = await call();
  assert.match(whole.payload, /\[e100 frame http:\/\/a\.test\/child\]\nSame-process frame text\./, 'no site of its own, so no cross-site tag');
  const { payload } = await call({ scope: 'e100' });
  assert.strictEqual(payload.split('\n')[2], 'Scope: e100');
  assert.ok(payload.includes('Same-process frame text.'), `the frame is the whole region:\n${payload}`);
  assert.ok(payload.includes('[e55 button "In frame"]'), 'with bare refs, since it shares the page\'s renderer');
  assert.ok(!payload.includes('The page around the frame.'), 'and nothing of the page around it');
  assert.strictEqual(session.refs.get(target.targetId).ids.get(55), 'FRAME-SAME', "its ids are in the page's set, against the frame they were read in");
});

test('a same-process frame that navigates under its own render renders as not readable, and the page is delivered anyway', async () => {
  const { call, fake, log } = await setupSameProcessFrame({}, { log: recordingLog() });
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

test('scope on an <iframe> ref with no document behind it is an error naming the recourse', async () => {
  const { call } = await setupSameProcessFrame({ frameId: null });
  const whole = await call();
  assert.match(whole.payload, /\[e100 frame \(not readable\)\]/, 'the default read says so where the frame would be');
  const { fail } = await outcome(call({ scope: 'e100' }));
  assert.strictEqual(fail.outcome, 'error');
  assert.strictEqual(fail.message, 'the frame at e100 is not readable; read the page around it instead');
});

test("a scope on a frame the page's own session cannot read is an error naming the recourse", async () => {
  const { call, fake, log } = await setupSameProcessFrame({}, { log: recordingLog() });
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

test('a frame-scoped read records the refs its omission line offers, so a scope on one of them resolves', async () => {
  const ctx = await setupFrames(1);
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

test('a frame the page hides is neither rendered nor named as one the read did not enter', async () => {
  const ctx = await setupFrames(1);
  ctx.fake.site[URL].childFrames[0].hidden = true;
  const { payload } = await ctx.call({ scope: 'all' });
  assert.ok(!payload.includes('[e100 frame'), `no block and no line for it:\n${payload}`);
  assert.ok(!payload.includes('Frame 0 text.'));
  assert.strictEqual(payload.split('\n')[2], 'Scope: all', 'a hidden frame is left out of the omission line, as a hidden control is');
});

test('a frame whose placeholder the prose around it swallowed is left unread and named by ref', async () => {
  const ctx = await setupFrames(1);
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

test('a forged placeholder in the page\'s own prose does not inline or count a hidden frame', async () => {
  const ctx = await setupFrames(1);
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

test("a frame past the cut its parent's own inlining takes is left unread", async () => {
  const ctx = await setupNested(2);
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

test('frames nest three levels deep, and one a level further says it is past the limit', async () => {
  const { call, log } = await setupNested(4, { log: recordingLog() });
  const { payload } = await call();
  assert.match(payload, /\[e200 frame http:\/\/frame\.test\/level1 cross-site\]/);
  for (const level of [1, 2, 3]) assert.ok(payload.includes(`Level ${level} text.`), `level ${level} rendered:\n${payload}`);
  assert.match(payload, /\[f3e203 frame http:\/\/frame\.test\/level4 \(not read: frame limit\)\]/);
  assert.ok(!payload.includes('Level 4 text.'), 'the fourth level is named, not read');
  assert.deepStrictEqual(frameLines(log), ['frame f3e203 (http://frame.test/level4) is past the 3-level limit of this read']);
});

test("a frame whose frame tree never answers costs a frame's budget, not the whole request's", async () => {
  const { call, fake } = await setupNested(2);
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

test("a scope on a frame whose page never answers for its frames costs a frame's budget too", async () => {
  const { call, fake } = await setupFrames(1);
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

test('a frame unit that runs out of time still releases the objects it resolved', async () => {
  const { call, fake, log } = await setupFrames(1, undefined, { log: recordingLog() });
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

test('a frame-scoped read whose <iframe> the page tree no longer shows counts the whole page as outside it', async () => {
  const tree = [
    { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'A' }, childIds: ['2', '3', '5'] },
    { nodeId: '2', role: { value: 'navigation' }, name: { value: 'Site' }, backendDOMNodeId: 20 },
    { nodeId: '3', role: { value: 'main' }, name: { value: '' }, backendDOMNodeId: 40, childIds: ['4'] },
    { nodeId: '4', role: { value: 'button' }, name: { value: 'Go' }, backendDOMNodeId: 41 },
    { nodeId: '5', role: { value: 'Iframe' }, name: { value: '' }, backendDOMNodeId: 100 },
  ];
  const ctx = await setup(page([control('button', 'Go', { backendNodeId: 41 })], { tree, childFrames: [{ backendId: 100, url: 'http://frame.test/0' }] }));
  ctx.fake.site['http://frame.test/0'] = page([control('button', 'In frame')], { title: 'Frame', text: 'Frame text.' });
  const frame = ctx.fake.attachFrame(ctx.fake.targets.get(ctx.session.workingTargetId), 100);
  await waitFor(() => ctx.sessions.target(frame.targetId) && ctx.sessions.target(frame.targetId).generation > 0);
  const first = await ctx.call({ scope: 'all' });
  const ref = refsIn(first.payload)['In frame'];
  // The page rewrites itself around the frame, so the <iframe> its tree held is gone.
  ctx.fake.site[URL].tree = tree.filter((node) => node.backendDOMNodeId !== 100);
  const { payload } = await ctx.call({ scope: ref });
  assert.ok(payload.includes('Frame text.'), 'the frame is still what rendered');
  assert.strictEqual(payload.split('\n')[2], `Scope: ${ref} (omitted: navigation "Site" [e20], main [e40] 1 button; scope=e40 expands one, scope=all everything)`);
});

test('a read logs each unit at debug, and a renderer exception at info', async () => {
  const { call, fake, log } = await setupFrames(1, undefined, { log: recordingLog() });
  await call();
  const debug = log.lines.debug.join('\n');
  assert.match(debug, /^page: \d+ tree nodes in \d+ ms$/m);
  assert.match(debug, /^page: \d+ nodes resolved in \d+ ms, rendered in \d+ ms$/m);
  assert.match(debug, /^frame e100: \d+ tree nodes in \d+ ms$/m);
  assert.match(debug, /^frame e100: \d+ nodes resolved in \d+ ms, rendered in \d+ ms$/m);
  fake.site[URL].render = () => { throw new Error('the renderer fell over'); };
  await outcome(call());
  assert.ok(log.lines.info.some((line) => /the renderer fell over/.test(line)), 'the exception is in the log as well as the payload');
});

test('a frame-scoped read stamps the frame\'s ref set with the frame\'s own generation, so a click on what it returned resolves', async () => {
  const { call, sessions, session } = await setupFrames(1);
  await call();
  const { payload } = await call({ scope: 'e100' });
  const ref = refsIn(payload)['Link 0'];
  assert.match(ref, /^f1e\d+$/);
  const clicked = await outcome(input.click(sessions, session, ref, {}));
  assert.ok(clicked.ok, `a ref of the frame-scoped read is clickable: ${JSON.stringify(clicked.fail)}`);
});

test('a frame-scoped read whose frame navigates mid-read is an error, and leaves the set the read before it left', async () => {
  const { call, fake, sessions, session } = await setupFrames(1);
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

test('a frame-scoped read whose frame navigates after its refs were recorded is an error, not a payload of the old document', async () => {
  const { call, fake, sessions, session } = await setupFrames(1);
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

test('a frame-scoped read whose page navigates during the hidden walk is an error, not a payload of two documents', async () => {
  const { call, fake, target } = await setupFrames(1);
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

test('a frame whose own document changes during its render is not readable, and the page is delivered', async () => {
  const { call, fake, sessions, session } = await setupFrames(2);
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
