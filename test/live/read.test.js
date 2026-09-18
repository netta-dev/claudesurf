// The read and click paths against real Chrome (headless) over the fixture pages.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const read = require('../../server/read');
const input = require('../../server/input');
const { liveBinary, liveBrowser, sleep } = require('../helpers');
const { serve } = require('../fixtures/serve');

const skip = liveBinary() ? false : 'no Chrome binary found';

let live, site, sessions, session;
before(async () => {
  if (skip) return;
  live = await liveBrowser();
  site = await serve();
  sessions = live.sessions;
  session = await sessions.ensure('live-read');
});
after(async () => {
  if (skip) return;
  site.close();
  await live.close();
});

async function open(page) {
  await input.navigate(sessions, session, { url: `${site.base}/${page}`, name: 'live read' });
}

// Reads the page and returns the payload plus a label → ref map.
async function readAll({ hidden = true, maxChars = 40000 } = {}) {
  const { payload } = await read.readPage(sessions, session, { maxChars, offset: 0, hidden });
  const refs = {};
  for (const m of payload.matchAll(/\[(e\d+)\] [\w-]+ "([^"]*)"/g)) refs[m[2]] = m[1];
  return { payload, refs };
}

async function outcome(promise) {
  try { return { ok: await promise }; } catch (e) {
    if (e instanceof read.OutcomeError) return { fail: e.envelope };
    throw e;
  }
}

const logText = () => sessions.callInWorld(session.workingTargetId, 'function () { return document.getElementById("log").textContent; }');

test('labels come from each source; hidden elements are counted, excluded, then included', { skip }, async () => {
  await open('labels.html');
  const visible = await readAll({ hidden: false });
  for (const label of ['From aria-label', 'From aria-labelledby', 'From label element', 'From innerText', 'From img alt', 'From title', 'From placeholder', 'From value', 'Role button', 'Shadow button', 'Offscreen link']) {
    assert.ok(visible.refs[label], `${label} listed: ${visible.payload}`);
  }
  assert.match(visible.payload, /\[e\d+\] checkbox "Checked box" \(checked\)/);
  assert.match(visible.payload, /\[e\d+\] button "Disabled control" \(disabled\)/);
  assert.match(visible.payload, /\[e\d+\] link "From innerText" → http:\/\/127\.0\.0\.1:\d+\/other/);
  assert.match(visible.payload, /## Interactive elements \(\d+ visible, 3 hidden\)/);
  for (const label of ['Display none', 'Aria hidden', 'Transparent']) assert.ok(!visible.refs[label], `${label} excluded`);
  assert.ok(!/\[e\d+\] [\w-]+ "not interactive"/.test(visible.payload), 'role=presentation is not an element');
  assert.match(visible.payload, /\nBody text of the labels fixture\.\n/);
  const all = await readAll({ hidden: true });
  for (const label of ['Display none', 'Aria hidden', 'Transparent']) assert.match(all.payload, new RegExp(`\\[e\\d+\\] \\w+ "${label}" \\(hidden\\)`));
});

test('a scripted click delivers to a handler as a scripted event; trusted delivers a trusted one', { skip }, async () => {
  await open('actions.html');
  const { refs } = await readAll();
  const scripted = await input.click(sessions, session, refs['Handler button'], {});
  assert.match(scripted.payload, /Navigated: no$/);
  assert.strictEqual(await logText(), 'handled scripted');
  await input.click(sessions, session, refs['Trusted only'], {});
  assert.strictEqual(await logText(), 'handled scripted', 'a scripted click does not satisfy an isTrusted check');
  await input.click(sessions, session, refs['Trusted only'], { trusted: true });
  assert.strictEqual(await logText(), 'trusted only fired');
});

test('a trusted click is refused when covered; a scripted one reaches through; a disabled ref is refused', { skip }, async () => {
  await open('actions.html');
  const { refs } = await readAll();
  const covered = await outcome(input.click(sessions, session, refs['Covered button'], { trusted: true }));
  assert.match(covered.fail.message, /covered by another element/);
  await input.click(sessions, session, refs['Covered button'], {});
  assert.strictEqual(await logText(), 'covered clicked');
  const disabled = await outcome(input.click(sessions, session, refs['Disabled button'], {}));
  assert.match(disabled.fail.message, /is disabled/);
});

test('a link click reports Navigated: yes with the new URL, and the old refs go stale', { skip }, async () => {
  await open('actions.html');
  const { refs } = await readAll();
  const r = await input.click(sessions, session, refs['Same tab link'], {});
  assert.strictEqual(r.payload, `URL: ${site.base}/other\nTitle: Other\nNavigated: yes`);
  const stale = await outcome(input.click(sessions, session, refs['Handler button'], {}));
  assert.strictEqual(stale.fail.outcome, 'stale_ref');
});

test('a target=_blank click reports Opened: a new tab, attributed to the session', { skip }, async () => {
  await open('actions.html');
  const { refs } = await readAll();
  const before = session.opened.size;
  const r = await input.click(sessions, session, refs['New tab link'], {});
  assert.strictEqual(r.payload, `URL: ${site.base}/actions.html\nTitle: Actions fixture\nNavigated: no\nOpened: a new tab (not the working tab)`);
  assert.strictEqual(session.opened.size, before + 1);
  for (const id of session.opened) await live.conn.send('Target.closeTarget', { targetId: id });
});

test('a download link is denied and reads as an unchanged click', { skip }, async () => {
  await open('actions.html');
  const { refs } = await readAll();
  const r = await input.click(sessions, session, refs['Download link'], {});
  assert.strictEqual(r.payload, `URL: ${site.base}/actions.html\nTitle: Actions fixture\nNavigated: no`);
});

test('pushState keeps refs valid; a ref from an earlier read of the same document still clicks', { skip }, async () => {
  await open('actions.html');
  const first = await readAll();
  await input.click(sessions, session, first.refs['Push state'], {});
  assert.strictEqual(await logText(), 'pushed');
  await read.readPage(sessions, session, { maxChars: 40000, offset: 0, hidden: false });
  const r = await input.click(sessions, session, first.refs['Handler button'], {});
  assert.match(r.payload, /^URL: .*\/actions\.html\?pushed=1\n/);
  assert.strictEqual(await logText(), 'handled scripted');
});

test('a ref cut by max_chars still clicks', { skip }, async () => {
  await open('actions.html');
  const cut = await read.readPage(sessions, session, { maxChars: 30, offset: 0, hidden: false });
  assert.ok(!cut.payload.includes('## Interactive'), 'elements were cut');
  assert.match(cut.payload, /they start at offset \d+/);
  // The cut read merged every id it found, so the first element (the handler button,
  // in document order) is clickable without paging to it.
  const set = session.refs.get(session.workingTargetId);
  assert.ok(set.ids.size >= 10, 'ids of the cut elements were recorded');
  const r = await input.click(sessions, session, `e${[...set.ids][0]}`, {});
  assert.match(r.payload, /Navigated: no$/);
  assert.strictEqual(await logText(), 'handled scripted');
});

test('dialog text lands in the payload via takeDialogs; beforeunload is accepted on navigate', { skip }, async () => {
  await open('actions.html');
  const { refs } = await readAll();
  await input.click(sessions, session, refs['Alert button'], {});
  assert.deepStrictEqual(sessions.takeDialogs(session.workingTargetId), [{ type: 'alert', message: 'Alert text from the page' }]);
  await input.click(sessions, session, refs['Arm beforeunload'], {});
  assert.strictEqual(await logText(), 'armed');
  // A beforeunload prompt only fires after a user gesture; the trusted click above counts.
  await input.click(sessions, session, refs['Arm beforeunload'], { trusted: true });
  const r = await input.navigate(sessions, session, { url: `${site.base}/other`, name: 'live read' });
  assert.strictEqual(r.payload, `URL: ${site.base}/other\nTitle: Other`);
  const dialogs = sessions.takeDialogs(session.workingTargetId);
  assert.ok(dialogs.every((d) => d.type === 'beforeunload'), JSON.stringify(dialogs));
});

test('a slow form post starts within the wait and reports Navigated: yes once loaded', { skip }, async () => {
  await open('actions.html');
  const { refs } = await readAll();
  const r = await input.click(sessions, session, refs['Slow submit'], {});
  assert.strictEqual(r.payload, `URL: ${site.base}/slow\nTitle: Slow\nNavigated: yes`);
});

test('scroll moves a scrollable container on a fixture whose window does not scroll', { skip }, async () => {
  await open('container.html');
  const r = await input.scroll(sessions, session, 'down', 700, {});
  assert.match(r.payload, /\nScroll: 700 of \d+ \(viewport \d+\)$/);
  const info = await read.pageInfo(sessions, session, {});
  assert.match(info.payload, /\nScroll: 700 of /);
  await sleep(10);
});
