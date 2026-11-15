// The read and click paths against real Chrome (headless) over the fixture pages: the
// page rendered through the whole pipeline, the header lines each parameter adds, and
// the clicks the refs of that render resolve to.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const read = require('../../server/read');
const input = require('../../server/input');
const navigation = require('../../server/navigation');
const { OutcomeError, WALK_SOURCE, LABEL_MAX } = require('../../server/action-support');
const { liveBinary, liveBrowser, markedRefs, readPayload, refsIn, waitFor } = require('../helpers');
const { serve } = require('../fixtures/serve');

const skip = liveBinary() ? false : 'no Chrome binary found';

let live, site, sessions, context, session;
before(async () => {
  if (skip) return;
  live = await liveBrowser();
  site = await serve();
  ({ sessions, context } = live);
  session = await sessions.ensure('live-read');
});
after(async () => {
  if (skip) return;
  site.close();
  await live.close();
});

async function open(page) {
  await navigation.navigate(context, session, { url: `${site.base}/${page}`, name: 'live read' });
}

// Reads the page and returns the payload plus a name → ref map.
async function readAll({ hidden = true, maxChars = 40000, ...rest } = {}) {
  const { payload } = await readPayload(sessions, session, { maxChars, offset: 0, hidden, ...rest });
  return { payload, refs: refsIn(payload) };
}

function refIds() {
  const set = session.refs.get(session.workingTargetId);
  return set ? [...set.ids.keys()] : [];
}

async function outcome(promise) {
  try { return { ok: await promise }; } catch (e) {
    if (e instanceof OutcomeError) return { fail: e.envelope };
    throw e;
  }
}

const logText = () => sessions.callInWorld(session.workingTargetId, 'function () { return document.getElementById("log").textContent; }');

test('the default read renders the main content as markdown with every control inline', { skip }, async () => {
  await open('render.html');
  const { payload } = await readAll({ hidden: false });
  const expected = [
    [/^# Render fixture$/m, 'the heading'],
    [/Prose with \*\*bold\*\*, _italic_, and `inline code`\./, 'emphasis and code spans'],
    [/```\nconst x = 1;\nconst y = 2;\n```/, 'a fenced code block'],
    [/\| Key \| Value \|\n\| --- \| --- \|\n\| alpha \| 1 \|/, 'a table with a heading row as GFM'],
    [/\nleft cell right cell\nsecond row \[Row link\]\(\/row\)\[e\d+\]\n/, 'a layout table one line per row'],
    [/\[Dup link\]\(\/dup\)\[e\d+\] and again \[Dup link\]\(…\)\[e\d+\]/, 'a repeated link without its URL'],
    [/\[e\d+ textbox "Email" = "foo@x"\]/, "a control's role, name, and value"],
    [/\[e\d+ radio "Fast" \(checked\)\]/, 'its state'],
    [/\[e\d+ slider "Volume" = "50" \(0–100\)\]/, 'a range'],
    [/\[e\d+ combobox "Chooser" = "one" \(collapsed\) \(options: one, two, three\)\]/, "a select's options as its value list"],
    [/\[e\d+ DisclosureTriangle "Details summary" \(collapsed\)\]/, 'a summary'],
    [/\[e\d+ Date "When"\]/, "a date input, whose own spinbuttons fold into it"],
    [/\[e\d+ textbox "Password" = "•••"\]/, 'a password masked'],
    [/\[e\d+ textbox "One-time code" = "•••"\]/, 'a one-time code masked'],
    [/\[image "An image with alt"\]/, 'an image with alt'],
    [/\[image "Linked image"\]\(\/linked-image\)\[e\d+\]/, 'a linked image'],
    [/Shadow paragraph/, "an open shadow root's own content"],
    [/Slotted light text/, 'and the light nodes it slots'],
    [/A literal frame:e99 in the prose\./, 'page text holding the frame placeholder, as text'],
  ];
  for (const [pattern, what] of expected) assert.match(payload, pattern, `${what}:\n${payload}`);
  assert.ok(!payload.includes('[e99 frame'), 'and nothing the page built out of it — text, a name, a value, an alt — opens a frame block');
  assert.ok(!payload.includes('[image ""]'), 'an unnamed image is dropped');
  assert.ok(!payload.includes('Aside one'), 'the sidebar is outside the main content');
  assert.strictEqual(payload.match(/Wrapped label/g).length, 1, "a label whose text is its control's name renders once, in the marker");
  const notes = payload.match(/\[e\d+ textbox "Notes" = "([^"]*)"\]/);
  assert.strictEqual(notes[1].length, LABEL_MAX, 'a value is cut at the cap');
});

test('hidden content is skipped and counted; hidden=true lists it, masking a secret', { skip }, async () => {
  await open('labels.html');
  const visible = await readAll({ hidden: false });
  assert.match(visible.payload, /\nHidden: 4 controls on the page \(hidden=true lists them\)\n/);
  for (const name of ['Display none', 'Aria hidden', 'Transparent', 'Zero height']) {
    assert.ok(!visible.refs[name], `${name} has no marker`);
  }
  const fromDefault = refIds();
  const all = await readAll({ hidden: true });
  assert.match(all.payload, /\nHidden: 4 controls on the page \(listed at the end\)\n/);
  for (const name of ['Display none', 'Aria hidden', 'Transparent', 'Zero height']) {
    assert.match(all.payload, new RegExp(`\\[e\\d+\\] \\w+ "${name}" \\(hidden\\)`), `${name} is listed`);
  }
  const id = (name) => Number(all.refs[name].slice(1));
  assert.ok(fromDefault.includes(id('Transparent')), 'a control the tree keeps is clickable from any read');
  assert.ok(!fromDefault.includes(id('Display none')), 'one Chrome pruned from the tree needs the hidden read');
  assert.ok(refIds().includes(id('Display none')), 'which put it in the set');
  const clicked = await outcome(input.click(context, session, { ref: all.refs['Display none'] }));
  assert.ok(clicked.ok, `and a scripted click reaches it: ${JSON.stringify(clicked.fail)}`);
});

test('a control the page paints without a box of its own is left out of the hidden count and its list', { skip }, async () => {
  await open('render.html');
  const { payload } = await readAll({ hidden: true });
  const card = payload.match(/\[Card title\. Card body\.\]\(\/card\)\[(e\d+)\]/);
  assert.ok(card, `the float-only card that is itself a link rendered:\n${payload}`);
  const list = payload.slice(payload.indexOf('## Hidden elements'));
  assert.ok(!list.includes(`[${card[1]}]`), 'and the walk judges it as the render did, so the hidden list leaves it out');
  const counted = Number(payload.match(/^Hidden: (\d+) controls on the page/m)[1]);
  assert.match(list, new RegExp(`^## Hidden elements \\(${counted}\\)$`, 'm'));
  assert.strictEqual(list.trimEnd().split('\n').length - 1, counted, `the count is what the list holds:\n${list}`);
});

test("an element the page stamped with a ref of the daemon's doesn't carry a marker into the payload", { skip }, async () => {
  await open('render.html');
  const first = await readAll({ hidden: false });
  const ref = first.refs.Email;
  await sessions.callInWorld(session.workingTargetId, 'function (ref) { document.getElementById("forged-ref").setAttribute("data-cs-ref", ref); }', [ref]);
  const { payload } = await readAll({ hidden: false });
  assert.match(payload, /Forged marker prose\./, 'the paragraph keeps its own text');
  assert.strictEqual(payload.match(new RegExp(`\\[${ref} `, 'g')).length, 1, `and the control it named has the one marker:\n${payload}`);
});

test('a hidden password field is listed by a masked label, not by what it holds', { skip }, async () => {
  await open('render.html');
  const { payload } = await readAll({ hidden: true });
  assert.match(payload, /\[e\d+\] textbox "•••" \(hidden\)/);
  assert.ok(!payload.includes('hunter2'));
});

test('a hidden element whose label and URL are built to forge a marker is listed with both defused', { skip }, async () => {
  await open('render.html');
  const { payload } = await readAll({ hidden: true });
  // The walk escapes the brackets and backslashes of a label as Turndown escapes them
  // in text, and the quoting the line puts around it escapes that backslash in turn, as
  // a marker's own quoted fields carry it.
  const list = payload.slice(payload.indexOf('## Hidden elements'));
  const label = JSON.stringify('\\] \\[Sign out\\](/logout)\\[e7\\] \\[');
  assert.ok(list.includes(`] link ${label} → ${site.base}/x%29%5Be7%5D%28 (hidden)`), `the list line carries both whole:\n${list}`);
  assert.ok(!/\[e7[ \]]/.test(list), 'and neither of them closes the line or forges a marker for a ref the page does not own');
  assert.match(list, /\] button "frame:e99" \(hidden\)/, 'a label the page built out of the frame placeholder is listed as text');
  assert.match(list, /\] button "eleventh twelfth" \(hidden\)/, 'a label holding U+0085 is listed on one line');
  assert.ok(!payload.includes('[e99 frame'), 'and the placeholder it holds forges no frame block of its own');
  assert.match(list, /\] button "e12 button \\"Delete\\"" \(hidden\)/, 'a label hiding a ref token behind the renderer\'s filler is listed without it');
  assert.ok(!payload.includes(''), 'so no filler reaches the payload for the list to be read through');
});

function scopeLine(payload) {
  const lines = payload.split('\n');
  assert.strictEqual(lines[2], 'Challenge: two-factor — a one-time-code field');
  return lines[3];
}

test('scope=all renders the landmarks with refs; the omission line names them and scope=<ref> expands one', { skip }, async () => {
  await open('render.html');
  const main = await readAll({ hidden: false });
  const line = scopeLine(main.payload);
  assert.match(
    line,
    /^Scope: main \(omitted: banner \[e\d+\] 3 links, 1 button, 1 other control, complementary "Sidebar" \[e\d+\] 2 links, complementary "Empty aside" \[e\d+\], contentinfo \[e\d+\] 2 links, dropped inside: 1 button; scope=e\d+ expands one, scope=all everything\)$/,
    'a landmark holding no control is listed by ref with no counts, and the button inside the clipped wrapper is counted as dropped',
  );
  const all = await readAll({ scope: 'all', hidden: false });
  assert.match(
    scopeLine(all.payload),
    /^Scope: all \(dropped: main \[e\d+\] 1 button\)$/,
    'a whole-body read leaves out only what the page does not paint — the button inside the clipped wrapper — '
    + 'and the landmark it names rendered, so there is no narrower read to propose',
  );
  assert.match(all.payload, /\[e\d+ banner\][\s\S]*\[\/banner\]/);
  assert.match(all.payload, /\[e\d+ navigation "Site"\][\s\S]*\[\/navigation\]/);
  assert.match(all.payload, /\[Home\]\(\/other\)\[e\d+\]/, 'an icon-only link takes its accessible name as its text');
  assert.ok(all.payload.includes('Aside one'), 'and the sidebar is in');
  const sidebar = line.match(/complementary "Sidebar" \[(e\d+)\]/)[1];
  const scoped = await readAll({ scope: sidebar, hidden: false });
  assert.match(
    scopeLine(scoped.payload),
    new RegExp(`^Scope: ${sidebar} \\(omitted: banner \\[e\\d+\\] 3 links, 1 button, 1 other control, main \\[e\\d+\\] `
      + '\\d+ links, \\d+ buttons, \\d+ other controls, complementary "Empty aside" \\[e\\d+\\], contentinfo \\[e\\d+\\] 2 links; '
      + 'scope=e\\d+ expands one, scope=all everything\\)$'),
    'the landmark that rendered is not among the ones it left out',
  );
  assert.ok(scoped.payload.includes('Aside one'), 'the omitted landmark renders on its own');
  assert.ok(!/^# Render fixture$/m.test(scoped.payload), 'and nothing of the main content');
});

test('a scope ref the document no longer holds is an error', { skip }, async () => {
  await open('render.html');
  const { refs } = await readAll({ hidden: false });
  const ref = refs.Email;
  await sessions.callInWorld(session.workingTargetId, 'function () { document.getElementById("email").remove(); }');
  const { fail } = await outcome(readPayload(sessions, session, { scope: ref, maxChars: 40000, offset: 0 }));
  assert.strictEqual(fail.outcome, 'error');
  assert.match(fail.message, new RegExp(`^${ref} is not in this document any more`));
});

test('a readerable page without landmarks renders through Readability; article=true names the article', { skip }, async () => {
  await open('article.html');
  const auto = await readAll({ hidden: false });
  assert.match(auto.payload, /\nScope: readability \(omitted: 5 links elsewhere; scope=all shows everything\)\n/);
  assert.match(auto.payload, /The scroll bar is the oldest piece of furniture/);
  assert.ok(!auto.payload.includes('Archive'), 'the site header is no part of the article');
  const article = await readAll({ article: true, hidden: false });
  // The title is the fixture's <title> and the byline its meta author, both escaped by
  // the page script at the cap and quoted by the header line, so the brackets the page
  // built into them are inert.
  const line = article.payload.slice(0, article.payload.indexOf('\n\n')).split('\n').at(-1);
  const forged = '\\\\] \\\\[Sign out\\\\](/logout)\\\\[e7\\\\]';
  assert.strictEqual(
    line,
    `Article: "The long history of the scroll bar${forged}" by "Ada${forged} Lovelace"`,
    'the whole title and byline are on the line, defused',
  );
  assert.deepStrictEqual(markedRefs(line), [], 'so no marker of any form for a ref the page does not own');
  assert.match(article.payload, /\[full timeline\]\(\/scrollbar-timeline\)\[e\d+\]/, 'a link inside the article keeps the ref Readability carried through');
  assert.match(article.payload, /\[e\d+ button "Subscribe"\]\(\/subscribe\)/, 'and so does a control inside it');
});

test('article=true on a document Readability declines falls back to the scope and says none found', { skip }, async () => {
  await open('render.html');
  await sessions.callInWorld(session.workingTargetId, 'function () { document.body.replaceChildren(document.createElement("canvas")); }');
  const { payload } = await readAll({ article: true, hidden: false });
  assert.match(payload, /\nArticle: none found$/m);
  assert.match(payload, /\nScope: body\n/, 'the Scope: line names what rendered instead');
  assert.ok(payload.endsWith('(no readable text; use screenshot)'));
  // A page whose chain reached a landmark falls back to that landmark rather than to
  // the body.
  await open('render.html');
  await sessions.callInWorld(session.workingTargetId, `function () {
    const main = document.createElement('main');
    main.appendChild(document.createElement('canvas'));
    document.body.replaceChildren(main);
  }`);
  const scoped = await readAll({ article: true, hidden: false });
  assert.match(scoped.payload, /\nArticle: none found$/m);
  assert.match(scoped.payload, /\nScope: main\n/, `the main landmark is what rendered:\n${scoped.payload}`);
});

test('a landmark-less listing Readability declines renders as the body, its rows one line each', { skip }, async () => {
  await open('listing.html');
  const { payload } = await readAll({ hidden: false });
  assert.match(payload, /\nScope: body\n/);
  assert.match(payload, /^1\. \[A compiler in a weekend\]\(\/item\?id=1\)\[e\d+\] 142 points$/m);
  assert.match(payload, /^5\. \[A short history of the modem\]\(\/item\?id=5\)\[e\d+\] 34 points$/m);
});

test('find returns the blocks matching it within the scope, and scope=all widens the search', { skip }, async () => {
  await open('render.html');
  const scoped = await readAll({ find: 'cell', hidden: false });
  assert.match(scoped.payload, /\nFind: "cell" — 1 block\n/);
  assert.match(scoped.payload, /\n\[offset \d+\]\nleft cell right cell\n/);
  const missing = await readAll({ find: 'Aside one', hidden: false });
  assert.match(missing.payload, /\nFind: "Aside one" — 0 blocks$/);
  const widened = await readAll({ find: 'Aside one', scope: 'all', hidden: false });
  assert.match(widened.payload, /\nFind: "Aside one" — 1 block\n/);
  assert.match(widened.payload, /\[Aside one\]\(\/aside-one\)\[e\d+\]/);
});

test('links=index leaves the ref in the prose and lists each URL once, with every ref pointing at it', { skip }, async () => {
  await open('render.html');
  const { payload } = await readAll({ links: 'index', hidden: false });
  assert.match(payload, /Repeated: \[Dup link\]\[e\d+\] and again \[Dup link\]\[e\d+\]/);
  assert.ok(!payload.includes('](/dup)'), 'no URL is left in the prose');
  const index = payload.slice(payload.indexOf('## Links'));
  assert.match(index, new RegExp(`\\[e\\d+, e\\d+\\] ${site.base}/dup`), 'both refs on the one line, the URL absolute');
  assert.match(index, /\[e\d+\] https:\/\/example\.test\/elsewhere/);
  assert.match(index, new RegExp(`\\[e\\d+\\] ${site.base}/act%29%5Be7%5D%28`), "an anchor the tree gives another role joins the index like a link's");
  assert.match(index, /\[e\d+\] \(url omitted: \d+ chars\)/, 'a data URL is no more navigable here than inline');
  const offset = Number(payload.match(/^Links: (?:\d+) \(index at offset (\d+)\)$/m)[1]);
  const region = payload.slice(payload.indexOf('\n\n') + 2);
  assert.ok(region.slice(offset).startsWith('## Links'), 'and the header says where to page to');
});

test('a JSON response fences as one block, and a PDF says there is nothing to read', { skip }, async () => {
  await navigation.navigate(context, session, { url: `${site.base}/data.json`, name: 'live read' });
  const json = await readAll({ hidden: false });
  assert.match(json.payload, /\n```\n\{\n {2}"items": \[\n/, 'the JSON arrives unescaped, in a fence');
  assert.match(json.payload, /"name": "beta"/);
  await navigation.navigate(context, session, { url: `${site.base}/page.pdf`, name: 'live read' });
  const pdf = await readAll({ hidden: false });
  assert.ok(pdf.payload.endsWith('(no readable text; use screenshot)'), pdf.payload);
});

test('frames render inline under their own refs, nested ones inside their parent', { skip }, async () => {
  await open('frames.html');
  const { payload } = await readAll({ hidden: false });
  assert.match(payload, /The page's own prose, before the frames\./);
  const cross = payload.match(new RegExp(`\\[(e\\d+) frame ${site.crossBase}/nested\\.html cross-site\\]`));
  assert.ok(cross, `the cross-site child is a frame block of its own:\n${payload}`);
  const button = payload.match(/\[(f\d+)e\d+ button "Child button"\]/);
  assert.ok(button, `its refs carry its frame's number:\n${payload}`);
  assert.match(payload, new RegExp(`\\[${button[1]}e\\d+ frame ${site.crossBase}/deep\\.html\\]`), 'a frame inside it renders inside its block, sharing its renderer and its prefix');
  assert.match(payload, /Three levels down from the page\./);
  assert.match(payload, new RegExp(`\\[e\\d+ frame ${site.base}/labels\\.html\\]`), 'the same-site child is no target of its own');
  assert.match(payload, /\[e\d+ button "From aria-label"\]/, 'so its refs are bare');
  assert.ok(payload.lastIndexOf('[/frame]') < payload.indexOf("The page's own prose, after the frames."), 'every frame block closes above the prose that follows the <iframe>s');
  assert.ok(!payload.includes('The long history of the scroll bar'), 'the frame the page hides is not read');
  assert.ok(!payload.split('\n')[2].includes('frames not read'), 'nor listed as one the read did not enter, as a hidden control is left out of the line too');
});

test('a scripted click on an f-ref lands in the frame, and a trusted one is refused', { skip }, async () => {
  await open('frames.html');
  const { refs } = await readAll({ hidden: false });
  const [frame] = sessions.frameTargets(session.workingTargetId);
  assert.ok(frame, 'the cross-site child attached as a target of its own');
  const inFrame = (expression) => sessions.callInWorld(frame.targetId, `function () { return ${expression}; }`);
  assert.strictEqual(await inFrame('document.getElementById("log").textContent'), 'nothing yet');
  await input.click(context, session, { ref: refs['Child button'] });
  assert.strictEqual(await inFrame('document.getElementById("log").textContent'), 'child clicked');
  const refused = await outcome(input.click(context, session, { ref: refs['Child button'], trusted: true }));
  assert.strictEqual(refused.fail.outcome, 'error');
  assert.match(refused.fail.message, /inside a cross-site frame, where trusted clicks are not supported yet/);
});

test('a bare ref in a same-process frame takes a scripted click and a trusted one', { skip }, async () => {
  await open('frames.html');
  const { refs } = await readAll({ hidden: false });
  // The child is same-site, so the page's own world reaches its document.
  const childLog = () => sessions.callInWorld(session.workingTargetId, `function () {
    return document.querySelector('iframe[title="Same-site child"]').contentDocument.getElementById('log').textContent;
  }`);
  assert.strictEqual(await childLog(), 'nothing yet');
  const scripted = await outcome(input.click(context, session, { ref: refs['From aria-label'] }));
  assert.ok(scripted.ok, `a same-process frame is clicked by a bare ref: ${JSON.stringify(scripted.fail)}`);
  assert.strictEqual(await childLog(), 'scripted click');
  const trusted = await outcome(input.click(context, session, { ref: refs['From aria-label'], trusted: true }));
  assert.ok(trusted.ok, `and the trusted path reaches it: ${JSON.stringify(trusted.fail)}`);
  assert.strictEqual(await childLog(), 'trusted click', 'the real mouse events landed on the button inside the frame');
});

test('a dialog raised inside a frame is dismissed and queued for the next payload', { skip }, async () => {
  await open('frames.html');
  const { refs } = await readAll({ hidden: false });
  await input.click(context, session, { ref: refs['Child alert'] });
  // Chrome delivers javascriptDialogOpening on the page target's session whichever
  // frame raised it, so the working tab's queue is where it lands and the frames'
  // stay empty; the daemon drains both, so either routing works.
  const frames = sessions.frameTargets(session.workingTargetId);
  assert.ok(frames.length > 0, 'the cross-site child is a target of its own');
  assert.deepStrictEqual(frames.flatMap((f) => sessions.takeDialogs(f.targetId)), [], 'no frame target carried it');
  assert.deepStrictEqual(sessions.takeDialogs(session.workingTargetId), [{ type: 'alert', message: 'Alert from the nested frame' }]);
});

test('navigating the parent makes an f-ref stale, and scope on a frame ref reads that frame alone', { skip }, async () => {
  await open('frames.html');
  const first = await readAll({ hidden: false });
  const frameRef = first.payload.match(new RegExp(`\\[(e\\d+) frame ${site.crossBase}/nested\\.html cross-site\\]`))[1];
  const scoped = await readPayload(sessions, session, { scope: frameRef, maxChars: 40000, offset: 0 });
  assert.match(scoped.payload, /^URL: http:\/\/127\.0\.0\.1:\d+\/frames\.html/, 'the state lines stay the tab\'s');
  assert.match(scoped.payload, /\n# Nested child\n/);
  assert.match(
    scoped.payload,
    /\[f\d+e\d+ navigation "Child nav"\][\s\S]*\[\/navigation\]/,
    "the frame's own landmarks carry boundaries, since its whole document is what rendered",
  );
  assert.ok(!scoped.payload.includes("The page's own prose"), 'and nothing of the page around it');
  assert.match(scoped.payload.split('\n')[2], new RegExp(`^Scope: ${frameRef} \\(omitted: `), 'with the page counted as omitted');
  const sameSite = first.payload.match(new RegExp(`\\[(e\\d+) frame ${site.base}/labels\\.html\\]`))[1];
  const same = await readPayload(sessions, session, { scope: sameSite, maxChars: 40000, offset: 0 });
  assert.match(same.payload, /\[e\d+ button "From aria-label"\]/, 'a same-process frame reads by its ref too, with bare refs');
  assert.ok(!same.payload.includes("The page's own prose"), 'and nothing of the page around it');
  await open('frames.html');
  const stale = await outcome(input.click(context, session, { ref: first.refs['Child button'] }));
  assert.strictEqual(stale.fail.outcome, 'stale_ref');
  // The parent's navigation destroyed the frame target, and its number is never
  // reassigned, so the ref names a frame that is gone rather than one that moved on.
  assert.match(stale.fail.message, /the frame it was read in is gone; read the page again/);
});

test('a bare ref of a same-process frame that navigated on its own is an error, not a click in the new document', { skip }, async () => {
  await open('frames.html');
  const { refs } = await readAll({ hidden: false });
  // Empty while the child is between documents, which says nothing either way.
  const childTitle = () => sessions.callInWorld(session.workingTargetId, `function () {
    const frame = document.querySelector('iframe[title="Same-site child"]');
    return frame.contentDocument ? frame.contentDocument.title : '';
  }`);
  await sessions.callInWorld(session.workingTargetId, `function () {
    document.querySelector('iframe[title="Same-site child"]').contentWindow.location.href = '/other';
  }`);
  await waitFor(async () => await childTitle() === 'Other');
  // The page's own generation never moved, so the set still answers for it; the node
  // the ref names belongs to a document the renderer has discarded.
  const { fail } = await outcome(input.click(context, session, { ref: refs['From aria-label'] }));
  assert.strictEqual(fail.outcome, 'error');
  assert.match(fail.message, /no longer resolves to an element \(it was removed from the page\)/);
});

test('a frame that holds its renderer past the unit budget is not readable, and the page still arrives', { skip }, async () => {
  await open('frames.html');
  await sessions.callInWorld(session.workingTargetId, `function () {
    const frame = document.createElement('iframe');
    frame.src = '${site.crossBase}/stall.html';
    frame.title = 'Stalling child';
    document.body.appendChild(frame);
  }`);
  // The frame's document commits, then its own process spins past the read's budget
  // for it; the page's own content is delivered regardless.
  const started = Date.now();
  const { payload } = await readAll({ hidden: false });
  const spent = Date.now() - started;
  assert.ok(spent < 6000, `the read stopped waiting for it (${spent} ms)`);
  assert.ok(spent > 4000, `after its own budget (${spent} ms)`);
  assert.match(payload, new RegExp(`\\[e\\d+ frame ${site.crossBase}/stall\\.html \\(not readable\\)\\]`), payload);
  assert.match(payload, /The page's own prose, after the frames\./);
});

test('a read renders eight frames at most, each cut at 8,000 characters and all of them at 16,000', { skip }, async () => {
  await open('many-frames.html');
  const { payload } = await readAll({ hidden: false });
  const region = payload.slice(payload.indexOf('\n\n') + 2);
  assert.strictEqual((region.match(/\[\/frame\]/g) || []).length, 8, `eight frame units rendered:\n${region.slice(0, 600)}`);
  assert.strictEqual((region.match(/\(not read: frame limit\)/g) || []).length, 1, 'and the ninth says why it is not there');
  const cuts = [...region.matchAll(/\(frame content cut: (\d+) more characters; scope=(e\d+) reads it whole\)/g)];
  assert.strictEqual(cuts.length, 8, 'each rendered frame carries more than a read inlines');
  assert.ok(region.includes('Frame 1 paragraph 0'), 'the first frame kept the top of its content');
  assert.ok(!region.includes('Frame 8 paragraph 0'), 'by the eighth the read-wide budget is spent');
  assert.ok(region.length > 16_000 && region.length < 20_000, `the frames cost the read 16,000 characters at most (${region.length})`);
  assert.ok(region.includes("The page's own prose, below the frames."), 'and the page around them is delivered whole');
});

test('a click judges hidden and disabled the way the read did, element for element', { skip }, async () => {
  await open('labels.html');
  const { refs } = await readAll({ hidden: true });
  for (const label of ['Display none', 'Aria hidden', 'Transparent', 'Zero height']) {
    const trusted = await outcome(input.click(context, session, { ref: refs[label], trusted: true }));
    assert.match(trusted.fail.message, /is hidden; a trusted click/, label);
    const scripted = await outcome(input.click(context, session, { ref: refs[label] }));
    assert.ok(scripted.ok, `${label}: a scripted click is attempted`);
  }
  const disabled = await outcome(input.click(context, session, { ref: refs['Disabled control'] }));
  assert.match(disabled.fail.message, /is disabled/);
});

test('the walk restricted to hidden elements returns those alone, no page text, and a mask for a secret value', { skip }, async () => {
  await open('render.html');
  const targetId = session.workingTargetId;
  const hidden = await sessions.callInWorld(targetId, WALK_SOURCE, [true, LABEL_MAX]);
  assert.strictEqual(hidden.text, '', 'the hidden walk reports no page text');
  assert.ok(hidden.elements.length > 0);
  assert.ok(hidden.elements.every((el) => !el.visible), JSON.stringify(hidden.elements));
  assert.ok(hidden.elements.some((el) => el.label === 'Display none'));
  const long = hidden.elements.find((el) => el.label.startsWith('A hidden button whose label'));
  assert.strictEqual(long.label.length, LABEL_MAX, 'a label past the cap is cut to it');
  assert.ok(long.label.endsWith('…'), `and ends in an ellipsis: ${long.label}`);
  assert.ok(hidden.elements.some((el) => el.label === '•••'), 'an unlabelled password field falls back to a mask, not its value');
  assert.ok(!hidden.elements.some((el) => el.label === 'hunter2'));
  const editable = hidden.elements.find((el) => el.label === 'Editable prose the page hides.');
  assert.strictEqual(editable.kind, 'textbox', 'an editable region the page hides is editable to Chrome all the same');
  const svg = hidden.elements.find((el) => el.kind === 'element');
  assert.ok(svg, `the SVG element carrying the same attribute has no isContentEditable, so the kind chain runs off its end:\n${JSON.stringify(hidden.elements)}`);
  assert.strictEqual(svg.label, '', 'and nothing of the page is printed as its kind');
  const all = await sessions.callInWorld(targetId, WALK_SOURCE, [false, LABEL_MAX]);
  assert.ok(all.text.includes('Render fixture'), 'the whole walk still reports the page text');
  assert.ok(all.elements.length > hidden.elements.length);
});

test('a scripted click delivers to a handler as a scripted event; trusted delivers a trusted one', { skip }, async () => {
  await open('actions.html');
  const { refs } = await readAll();
  const scripted = await input.click(context, session, { ref: refs['Handler button'] });
  assert.match(scripted.head, /\nNavigated: no\nChanged: 1 line added, 1 removed$/);
  assert.match(scripted.body, /^@@\n/, 'the hunks are the body');
  assert.strictEqual(await logText(), 'handled scripted');
  await input.click(context, session, { ref: refs['Trusted only'] });
  assert.strictEqual(await logText(), 'handled scripted', 'a scripted click does not satisfy an isTrusted check');
  await input.click(context, session, { ref: refs['Trusted only'], trusted: true });
  assert.strictEqual(await logText(), 'trusted only fired');
});

test('a trusted click reaches an element below the fold: the page scrolls and the hit test lands', { skip }, async () => {
  await open('labels.html');
  const { refs } = await readAll();
  const r = await input.click(context, session, { ref: refs['Offscreen link'], trusted: true });
  assert.match(r.head, /^URL: http:\/\/127\.0\.0\.1:\d+\/other\n/);
  assert.match(r.head, /Navigated: yes/);
});

test('a trusted click is refused when covered; a scripted one reaches through; a disabled ref is refused', { skip }, async () => {
  await open('actions.html');
  const { refs } = await readAll();
  const covered = await outcome(input.click(context, session, { ref: refs['Covered button'], trusted: true }));
  assert.match(covered.fail.message, /covered by another element/);
  await input.click(context, session, { ref: refs['Covered button'] });
  assert.strictEqual(await logText(), 'covered clicked');
  const disabled = await outcome(input.click(context, session, { ref: refs['Disabled button'] }));
  assert.match(disabled.fail.message, /is disabled/);
});

test('a link click reports Navigated: yes with the new URL, and the old refs go stale', { skip }, async () => {
  await open('actions.html');
  const { refs } = await readAll();
  const r = await input.click(context, session, { ref: refs['Same tab link'] });
  assert.strictEqual(r.head, `URL: ${site.base}/other\nTitle: Other\nNavigated: yes`);
  const stale = await outcome(input.click(context, session, { ref: refs['Handler button'] }));
  assert.strictEqual(stale.fail.outcome, 'stale_ref');
});

test('a target=_blank click reports Opened: a new tab, attributed to the session', { skip }, async () => {
  await open('actions.html');
  const { refs } = await readAll();
  const before = session.opened.size;
  const r = await input.click(context, session, { ref: refs['New tab link'] });
  assert.match(r.head, new RegExp(`^URL: ${site.base}/actions\\.html\nTitle: Actions fixture\nNavigated: no\nOpened: t\\d+, a new tab \\(not the working tab\\)\nChanged: nothing$`));
  assert.strictEqual(session.opened.size, before + 1);
  for (const id of session.opened) await live.conn.send('Target.closeTarget', { targetId: id });
});

test('a trusted click reaches a shadow host whose painted content is in its shadow tree', { skip }, async () => {
  await open('actions.html');
  const { refs } = await readAll();
  await input.click(context, session, { ref: refs['Shadow host button'], trusted: true });
  assert.strictEqual(await logText(), 'shadow host trusted');
});

test('navigate to a denied download is an error that leaves the page; a fragment navigate returns promptly with the new URL', { skip }, async () => {
  await open('actions.html');
  let started = Date.now();
  const download = await outcome(navigation.navigate(context, session, { url: `${site.base}/download`, name: 'live read' }));
  assert.match(download.fail.message, /was a download, which is denied; the page is unchanged/);
  assert.ok(Date.now() - started < 2000, `the download event ended the wait (${Date.now() - started} ms)`);
  started = Date.now();
  const fragment = await navigation.navigate(context, session, { url: `${site.base}/actions.html#part`, name: 'live read' });
  assert.strictEqual(fragment.head, `URL: ${site.base}/actions.html#part\nTitle: Actions fixture\nNavigated: no\nChanged: not tracked (read the page first)`);
  assert.ok(Date.now() - started < 2000, `the same-document event ended the wait (${Date.now() - started} ms)`);
});

test('a download link is denied and reads as an unchanged click, without waiting for a load', { skip }, async () => {
  await open('actions.html');
  const { refs } = await readAll();
  const started = Date.now();
  const r = await input.click(context, session, { ref: refs['Download link'] });
  // Under deny, Chrome fails the link's document request with net::ERR_ABORTED, which
  // ends the wait, and fires Page.downloadWillBegin a few ms later; the quiet window
  // and the change summary still follow.
  assert.ok(Date.now() - started < 2000, `the failed document request ended the wait (${Date.now() - started} ms)`);
  assert.strictEqual(r.head, `URL: ${site.base}/actions.html\nTitle: Actions fixture\nNavigated: no\nDownload: denied — fixture.bin from ${site.base}/download\nChanged: nothing`);
});

test('pushState keeps refs valid; a ref from an earlier read of the same document still clicks', { skip }, async () => {
  await open('actions.html');
  const first = await readAll();
  await input.click(context, session, { ref: first.refs['Push state'] });
  assert.strictEqual(await logText(), 'pushed');
  await readAll();
  const r = await input.click(context, session, { ref: first.refs['Handler button'] });
  assert.match(r.head, /^URL: .*\/actions\.html\?pushed=1\n/);
  assert.strictEqual(await logText(), 'handled scripted');
});

test('a ref cut by max_chars still clicks', { skip }, async () => {
  await open('actions.html');
  const cut = await readPayload(sessions, session, { maxChars: 30, offset: 0, hidden: false });
  assert.ok(!cut.payload.includes('Handler button'), 'the markers were cut');
  assert.match(cut.payload, /Pass offset=\d+ for the next part/);
  // The cut read merged every id its tree found, so a control it never delivered is
  // clickable without paging to it.
  const whole = await readAll({ hidden: false });
  const r = await input.click(context, session, { ref: whole.refs['Handler button'] });
  assert.match(r.head, /\nNavigated: no\nChanged: /);
  assert.strictEqual(await logText(), 'handled scripted');
});

test('dialog text lands in the payload via takeDialogs; beforeunload is accepted on navigate', { skip }, async () => {
  await open('actions.html');
  const { refs } = await readAll();
  await input.click(context, session, { ref: refs['Alert button'] });
  assert.deepStrictEqual(sessions.takeDialogs(session.workingTargetId), [{ type: 'alert', message: 'Alert text from the page' }]);
  await input.click(context, session, { ref: refs['Arm beforeunload'] });
  assert.strictEqual(await logText(), 'armed');
  // A beforeunload prompt fires only after a user gesture, which this trusted click supplies.
  await input.click(context, session, { ref: refs['Arm beforeunload'], trusted: true });
  const r = await navigation.navigate(context, session, { url: `${site.base}/other`, name: 'live read' });
  assert.strictEqual(r.head, `URL: ${site.base}/other\nTitle: Other\nNavigated: yes`);
  const dialogs = sessions.takeDialogs(session.workingTargetId);
  assert.ok(dialogs.every((d) => d.type === 'beforeunload'), JSON.stringify(dialogs));
});

test('a slow form post starts within the wait and reports Navigated: yes once loaded', { skip }, async () => {
  await open('actions.html');
  const { refs } = await readAll();
  const r = await input.click(context, session, { ref: refs['Slow submit'] });
  assert.strictEqual(r.head, `URL: ${site.base}/slow\nTitle: Slow\nNavigated: yes`);
});

test('scroll moves a scrollable container on a fixture whose window does not scroll', { skip }, async () => {
  await open('container.html');
  const r = await input.scroll(context, session, { direction: 'down', amount: 700 });
  assert.match(r.head, /\nScroll: 700 of \d+ \(viewport \d+\)\nNavigated: no\nChanged: not tracked \(read the page first\)$/);
  const info = await read.pageInfo(sessions, session, {});
  assert.match(info.head, /\nScroll: 700 of /);
});

test('a dedicated worker runs in a session tab and in a cross-site frame, though the attach pauses each new target', { skip }, async () => {
  await open('dedicated-worker.html');
  const shows = async (text) => (await readAll({ scope: 'all' })).payload.includes(text);
  await waitFor(async () => (await shows('Own worker: answered')) && (await shows('Frame worker: answered')), 5000);
});
