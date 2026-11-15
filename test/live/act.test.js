// The acting calls against Chrome, with both fixture sites allowed: type, press, and
// select over form.html, its cross-site frame included; clicks that open menus and
// dialogs over menu.html, read back through the change summary and a default read;
// history; and tabs, popup.html's self-closing popup included. Each test works in a
// session of its own, so refs, history, and tabs don't leak between them.
//
// The headful suite, gated by CLAUDESURF_LIVE_HEADFUL=1, drives a tab that isn't its
// window's active tab, and a tabs new from a session whose window wasn't
// activated last by Chrome. It reads the active X window and its title with xdotool; without
// xdotool it skips those checks, and the tabs new case, which has only those, reports
// itself skipped.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const input = require('../../server/input');
const navigation = require('../../server/navigation');
const read = require('../../server/read');
const { tabs } = require('../../server/tabs');
const { holdDisplay, liveBinary, liveBrowser, readPayload, refsIn, sleep } = require('../helpers');
const { serve } = require('../fixtures/serve');

const skip = liveBinary() ? false : 'no Chrome binary found';
const headful = !process.env.CLAUDESURF_LIVE_HEADFUL ? 'set CLAUDESURF_LIVE_HEADFUL=1 to run'
  : skip || (!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY) ? 'no display' : false);
const ALLOW = ['127.0.0.1', '127.0.0.2'];

let site;
let headless;
// The calls over the headless browser, which every test outside the headful suite
// shares.
let h;
before(async () => {
  if (skip) return;
  site = await serve();
  headless = await liveBrowser({ allow: ALLOW });
  h = over(headless);
});
after(async () => {
  if (skip) return;
  await headless.close();
  site.close();
});

// Returns the calls over one launched browser, each under a fresh 30 s deadline.
function over({ conn, sessions, context }) {
  const deadline = () => Date.now() + 30_000;
  const d = {
    conn,
    sessions,
    open: (session, page) => navigation.navigate(context, session, { url: `${site.base}/${page}`, name: 'act' }, deadline()),
    readAll: async (session) => (await readPayload(sessions, session, { maxChars: 40000, offset: 0 })).payload,
    type: (session, ref, text) => input.type(context, session, { ref, text }, deadline()),
    press: (session, keys) => input.press(context, session, { keys }, deadline()),
    select: (session, ref, option) => input.select(context, session, { ref, option }, deadline()),
    click: (session, ref, trusted = false) => input.click(context, session, { ref, trusted }, deadline()),
    history: (session, op) => navigation.history(context, session, { op }, deadline()),
    tabs: (session, op, target) => tabs(context, session, { op, target }, deadline()),
    screenshot: (session) => read.screenshot(sessions, session, { fullPage: false, deadline: deadline() }),
    async evaluate(targetId, expression) {
      const { result, exceptionDetails } = await sessions.send(targetId, 'Runtime.evaluate', { expression, returnByValue: true });
      if (exceptionDetails) throw new Error(`${expression}: ${exceptionDetails.text}`);
      return result.value;
    },
    // Resolves with a new session on `page`, with the payload and the refs of a default
    // read of it.
    async sessionOn(id, page) {
      const session = await sessions.ensure(id);
      await d.open(session, page);
      const payload = await d.readAll(session);
      return { session, payload, refs: refsIn(payload) };
    },
  };
  return d;
}

function tabName(session, targetId) {
  return `t${session.tabIds.get(targetId)}`;
}

// Resolves with the envelope of the OutcomeError that `call` rejected with.
async function refusal(call) {
  const e = await call.then(() => null, (error) => error);
  assert.ok(e && e.envelope, `the call failed with an outcome: ${e ? e.stack : 'it succeeded'}`);
  return e.envelope;
}

// Returns a regex source that matches `text` as it is.
const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('tabs new from a web page to a page that answers after 1.5 s waits for it, and reports it loaded with its title', { skip, timeout: 30_000 }, async () => {
  const session = await h.sessions.ensure('act-tabs-slow');
  await h.open(session, 'form.html');
  const opener = session.workingTargetId;
  const result = await h.tabs(session, 'new', `${site.base}/slow`);
  assert.notStrictEqual(session.workingTargetId, opener, 'the new tab is the working tab');
  assert.match(result.head, /^URL: http:\/\/127\.0\.0\.1:\d+\/slow\nTitle: Slow\nNavigated: yes$/, result.head);
  assert.strictEqual(result.outcome, undefined);
});

test('type replaces the content of each kind of text field, empty text clears one, and a readonly field is refused', { skip, timeout: 60_000 }, async () => {
  const { session, refs } = await h.sessionOn('act-type', 'form.html');
  const page = session.workingTargetId;
  const fields = [
    ['Text field', "document.getElementById('text').value", 'new text'],
    ['Email field', "document.getElementById('email').value", 'new@example.com'],
    ['Number field', "document.getElementById('number').value", '42'],
    ['Notes field', "document.getElementById('notes').value", 'new notes'],
    ['Editable region', "document.getElementById('editable').textContent", 'new editable'],
    ['Shadow field', "document.getElementById('host').shadowRoot.getElementById('inner').value", 'new shadow'],
  ];
  for (const [name, value, text] of fields) {
    const result = await h.type(session, refs[name], text);
    assert.strictEqual(await h.evaluate(page, value), text, `${name}: replaced`);
    assert.ok(!/^Input:/m.test(result.head), `${name}: the input completed:\n${result.head}`);
    assert.match(result.body, new RegExp(`^\\+ .*\\[${refs[name]} \\w+ "${name}" = "${literal(text)}"\\]`, 'm'), `${name}: the summary shows the new value:\n${result.body}`);
  }

  const cleared = await h.type(session, refs['Text field'], '');
  assert.strictEqual(await h.evaluate(page, "document.getElementById('text').value"), '', 'empty text clears the field');
  assert.match(cleared.body, new RegExp(`^\\+ \\[${refs['Text field']} textbox "Text field"\\] `, 'm'), `a cleared field prints without a value:\n${cleared.body}`);

  const readonly = await refusal(h.type(session, refs['Readonly field'], 'changed'));
  assert.deepStrictEqual(readonly, { outcome: 'error', message: `${refs['Readonly field']} is read-only; typing into it would change nothing` });
  assert.strictEqual(await h.evaluate(page, "document.getElementById('readonly').value"), 'fixed');
});

test("a password field's new value prints masked in the change summary", { skip, timeout: 30_000 }, async () => {
  const { session, refs } = await h.sessionOn('act-password', 'form.html');
  const result = await h.type(session, refs['Password field'], 'hunter2');
  assert.strictEqual(await h.evaluate(session.workingTargetId, "document.getElementById('password').value"), 'hunter2');
  assert.match(result.body, new RegExp(`^\\+ \\[${refs['Password field']} textbox "Password field" = "•••"\\] Strength: 7 characters$`, 'm'), result.body);
  assert.ok(!`${result.head}\n${result.body}`.includes('hunter2'), 'and the text typed into it prints nowhere');
});

test('press sends Enter to the focused field, which submits its form, and names where the keys went in each form', { skip, timeout: 60_000 }, async () => {
  const { session, refs } = await h.sessionOn('act-press', 'form.html');
  const page = session.workingTargetId;
  await h.type(session, refs.Search, 'lighthouses');
  const enter = await h.press(session, 'Enter');
  assert.match(enter.head, new RegExp(`^Keys to: \\[${refs.Search}\\] input "Search"\nNavigated: no$`, 'm'), `the field the last read returned, by its ref; focus stayed:\n${enter.head}`);
  assert.match(enter.body, /^\+ Submitted: lighthouses$/m, enter.body);

  await h.type(session, refs['Shadow field'], 'inner');
  const inner = await h.press(session, 'End');
  assert.match(inner.head, new RegExp(`^Keys to: \\[${refs['Shadow field']}\\] input "Shadow field"$`, 'm'), `a web component's inner field, by its ref:\n${inner.head}`);

  await h.evaluate(page, '(() => { let el = document.activeElement; while (el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement; el.blur(); })()');
  const unfocused = await h.press(session, 'Escape');
  assert.match(unfocused.head, /^Keys to: the page \(nothing focused\)$/m, unfocused.head);
  assert.match(await h.evaluate(page, "document.getElementById('key-log').textContent"), / Escape$/, 'the keys reached the page');

  await h.open(session, 'form.html');
  await h.evaluate(session.workingTargetId, "document.getElementById('search').focus()");
  const unread = await h.press(session, 'x');
  assert.match(unread.head, /^Keys to: input "Search"$/m, `a field of a document no read covered, without a ref:\n${unread.head}`);
  assert.strictEqual(await h.evaluate(session.workingTargetId, "document.getElementById('search').value"), 'x');
});

test('select chooses a native option by label and by value, and refuses a custom control, a disabled select, a disabled option, and an option that is not there', { skip, timeout: 60_000 }, async () => {
  const { session, refs } = await h.sessionOn('act-select', 'form.html');
  const size = refs.Size;
  const value = () => h.evaluate(session.workingTargetId, "document.getElementById('size').value");

  const byLabel = await h.select(session, size, 'Medium');
  assert.strictEqual(await value(), 'm');
  assert.match(byLabel.body, new RegExp(`^\\+ \\[${size} combobox "Size" = "Medium"`, 'm'), byLabel.body);
  assert.match(byLabel.body, /^\+ Size changes: m$/m, 'the page saw the change event');
  const byValue = await h.select(session, size, 's');
  assert.strictEqual(await value(), 's');
  assert.match(byValue.body, /^\+ Size changes: s$/m, byValue.body);

  const refused = [
    [refs.Fruit, 'Banana', `${refs.Fruit} is not a native select; click the control to open it, then click the option's ref`],
    [refs.Locked, 'Only', `${refs.Locked} is disabled; choosing an option would change nothing`],
    [size, 'Large', `the option of ${size} with that label or value is disabled`],
    [size, 'Huge', `no option of ${size} has that label or value; read the page with scope=${size} for every option`],
  ];
  for (const [ref, option, message] of refused) {
    assert.deepStrictEqual(await refusal(h.select(session, ref, option)), { outcome: 'error', message });
  }
  assert.strictEqual(await value(), 's', 'and none of the refusals changed the select');
});

test("a custom listbox opens on a click, and an option is chosen by the ref that the click's summary printed", { skip, timeout: 30_000 }, async () => {
  const { session, refs } = await h.sessionOn('act-listbox', 'form.html');
  const opened = await h.click(session, refs.Fruit);
  const listed = opened.body.split('\n').find((line) => line.startsWith(`+ [${refs.Fruit} combobox "Fruit"`));
  assert.match(listed || '', /\(expanded\) \(options: Apple \[e\d+\], Banana \[e\d+\], Cherry \[e\d+\]\)\]$/, opened.body);
  const [, banana] = /Banana \[(e\d+)\]/.exec(listed);
  const chosen = await h.click(session, banana);
  assert.strictEqual(await h.evaluate(session.workingTargetId, "document.getElementById('fruit').textContent"), 'Banana');
  assert.match(chosen.body, new RegExp(`^\\+ \\[${refs.Fruit} combobox "Fruit" = "Banana" \\(collapsed\\)\\]$`, 'm'), chosen.body);
});

test("type and press reach the cross-site frame's input, and press names the frame as where the keys went", { skip, timeout: 30_000 }, async () => {
  const { session, payload, refs } = await h.sessionOn('act-frame', 'form.html');
  const [, iframe] = /\[(e\d+) frame http:\/\/127\.0\.0\.2:\d+\/frame-form\.html cross-site\]/.exec(payload);
  const field = refs['Frame field'];
  assert.match(field, /^f\d+e\d+$/);
  const [frame] = h.sessions.frameTargets(session.workingTargetId);
  const inFrame = (expression) => h.evaluate(frame.targetId, expression);

  const typed = await h.type(session, field, 'frame new');
  assert.strictEqual(await inFrame("document.getElementById('field').value"), 'frame new');
  assert.match(typed.body, new RegExp(`^\\+ \\[${field} textbox "Frame field" = "frame new"\\]$`, 'm'), typed.body);

  const pressed = await h.press(session, 'x');
  assert.match(pressed.head, new RegExp(`^Keys to: \\[${iframe}\\] frame$`, 'm'), pressed.head);
  assert.strictEqual(await inFrame("document.getElementById('field').value"), 'frame newx');
  assert.strictEqual(await inFrame("document.getElementById('frame-log').textContent"), 'Frame keys: Control a x', "the frame's own listener saw the keys");
  assert.strictEqual(await h.evaluate(session.workingTargetId, "document.getElementById('key-log').textContent"), 'Keys:', "and the page's didn't");
});

test('press Tab reports where focus moved, and Shift+Tab moves it back', { skip, timeout: 30_000 }, async () => {
  const { session, refs } = await h.sessionOn('act-tab', 'form.html');
  const [first, last, next] = [refs['First name'], refs['Last name'], refs.Next];
  await h.type(session, first, 'Ada');
  const forward = await h.press(session, 'Tab');
  assert.match(forward.head, new RegExp(`^Keys to: \\[${first}\\] input "First name"\nFocus now: \\[${last}\\] input "Last name"\nNavigated: no$`, 'm'), forward.head);
  const again = await h.press(session, 'Tab');
  assert.match(again.head, new RegExp(`^Keys to: \\[${last}\\] input "Last name"\nFocus now: \\[${next}\\] button "Next"$`, 'm'), again.head);
  const back = await h.press(session, 'Shift+Tab');
  assert.match(back.head, new RegExp(`^Keys to: \\[${next}\\] button "Next"\nFocus now: \\[${last}\\] input "Last name"$`, 'm'), back.head);
});

test('history goes back, forward, and reloads, and back from the first web page is an error', { skip, timeout: 60_000 }, async () => {
  const session = await h.sessions.ensure('act-history');
  const form = `${site.base}/form.html`;
  const other = `${site.base}/other`;
  await h.open(session, 'form.html');
  await h.open(session, 'other');

  const back = await h.history(session, 'back');
  assert.match(back.head, new RegExp(`^URL: ${literal(form)}\nTitle: Form fixture\nChallenge: sign-in — a password field\nNavigated: yes$`), back.head);
  assert.deepStrictEqual(await refusal(h.history(session, 'back')), { outcome: 'error', message: 'The working tab has no earlier web page to go back to; navigate instead' });
  const forward = await h.history(session, 'forward');
  assert.match(forward.head, new RegExp(`^URL: ${literal(other)}\nTitle: Other\nNavigated: yes$`), forward.head);

  const t = h.sessions.target(session.workingTargetId);
  const { generation } = t;
  const reload = await h.history(session, 'reload');
  assert.match(reload.head, new RegExp(`^URL: ${literal(other)}\nTitle: Other\nNavigated: yes$`), reload.head);
  assert.ok(t.generation > generation, 'the reload loaded a new document');
});

test('a click whose navigation Chrome drops without a commit reads Navigated: no without waiting out the navigation budget: a link and a form answered 204, and a window.stop()', { skip, timeout: 30_000 }, async () => {
  const { session, refs } = await h.sessionOn('act-no-content', 'no-content.html');
  const page = `${site.base}/no-content.html`;
  for (const name of ['Nothing here', 'Send nothing', 'Start and stop']) {
    const started = Date.now();
    const result = await h.click(session, refs[name]);
    const spent = Date.now() - started;
    assert.match(result.head, new RegExp(`^URL: ${literal(page)}\nTitle: No content\nNavigated: no\n`), `${name}:\n${result.head}`);
    assert.ok(spent < 5_000, `${name}: the call spent ${spent} ms against the wait's 10 s`);
  }
});

test('tabs new, list, switch, and close; a ref read in another tab is stale; and a popup that closes itself returns the agent to the earlier tab', { skip, timeout: 60_000 }, async () => {
  const { session, refs } = await h.sessionOn('act-tabs', 'form.html');
  const first = session.workingTargetId;
  const form = `${site.base}/form.html`;

  const opened = await h.tabs(session, 'new', `${site.base}/other`);
  const second = session.workingTargetId;
  assert.notStrictEqual(second, first);
  assert.match(opened.head, /\nTitle: Other\nNavigated: yes$/, opened.head);
  const listed = await h.tabs(session, 'list');
  const others = [
    [first, `[${tabName(session, first)}] tab "Form fixture" ${form}`],
    [session.identityTargetId, `[${tabName(session, session.identityTargetId)}] identity (the session's label; not a page to work in)`],
  ].sort(([a], [b]) => session.tabIds.get(a) - session.tabIds.get(b)).map(([, line]) => line);
  assert.strictEqual(listed.head, ['Tabs: 3', `[${tabName(session, second)}] working "Other" ${site.base}/other`, ...others].join('\n'));

  assert.deepStrictEqual(await refusal(h.click(session, refs.Next)), { outcome: 'stale_ref', message: `${refs.Next}: the working tab changed since the ref was read; read the page again` });
  const switched = await h.tabs(session, 'switch', tabName(session, first));
  assert.strictEqual(switched.head, `URL: ${form}\nTitle: Form fixture\nWorking tab: ${tabName(session, first)}`);
  assert.strictEqual(session.workingTargetId, first);
  const clicked = await h.click(session, refs.Next);
  assert.match(clicked.head, /^Navigated: no$/m, 'the tab the agent last read takes its refs back');
  const closedName = tabName(session, second);
  const closed = await h.tabs(session, 'close', closedName);
  assert.strictEqual(closed.head, `Closed: ${closedName}\nURL: ${form}\nTitle: Form fixture`);
  assert.strictEqual(h.sessions.target(second), null);

  await h.open(session, 'popup.html');
  const opener = refsIn(await h.readAll(session));
  const popped = await h.click(session, opener['Open the popup']);
  const [, popup] = /^Opened: (t\d+), a popup window \(not the working tab\)$/m.exec(popped.head) || [];
  assert.ok(popup, popped.head);
  await h.tabs(session, 'switch', popup);
  const inPopup = refsIn(await h.readAll(session));
  const closing = await h.click(session, inPopup['Close this popup']);
  assert.strictEqual(closing.head, 'Tab: the working tab closed during the call; the next call returns to a working tab');
  const { notes } = await h.sessions.ensureWithNotes('act-tabs');
  assert.deepStrictEqual(notes, [`the working tab closed; ${tabName(session, first)} is the working tab again`]);
  assert.strictEqual(session.workingTargetId, first);
});

test('tabs close of a tab that the daemon is already closing keeps it closing until it is gone, so it does not read as an open tab', { skip, timeout: 30_000 }, async () => {
  const { session } = await h.sessionOn('act-close-twice', 'form.html');
  await h.tabs(session, 'new', `${site.base}/other`);
  const tab = h.sessions.target(session.workingTargetId);
  const id = tabName(session, tab.targetId);
  // The daemon's own close, as the gate's or the arming rule's, is in flight as the
  // agent's close of the same tab goes out.
  h.sessions.closeTab(tab);
  const closing = h.tabs(session, 'close', id);
  let reopened = false;
  while (h.sessions.target(tab.targetId) === tab) {
    if (!tab.closing) reopened = true;
    await sleep(1);
  }
  assert.strictEqual((await closing).head, `Closed: ${id}; the next call returns to a working tab`);
  assert.strictEqual(reopened, false, 'the tab was closing for as long as it was registered');
});

test("a click that opens a menu lists its buttons as a block's added lines, and a second click resolves one by that ref", { skip, timeout: 30_000 }, async () => {
  const { session, refs } = await h.sessionOn('act-menu', 'menu.html');
  const clicked = await h.click(session, refs['Open menu']);
  assert.match(clicked.head, /^Changed: 3 lines added, 0 removed$/m, clicked.head);
  assert.match(clicked.body, /^@@\n\+ \[e\d+ menu "Page menu"\]\n\+ \[e\d+ menuitem "Rename"\] \[e\d+ menuitem "Duplicate"\] \[e\d+ menuitem "Delete"\]\n\+ \[\/menu\]$/, clicked.body);
  const second = await h.click(session, refsIn(clicked.body).Rename);
  assert.match(second.head, /^Navigated: no$/m, second.head);
});

// The three dialogs of menu.html: the button that opens each, its name, its controls,
// the scope that a default read falls to once it is open, whether it takes the page's
// controls out of the tree, and the text that a read prints after its block.
const DIALOGS = [
  { button: 'Open hidden-root dialog', label: 'Hidden root dialog', modal: '', controls: ['Cancel', 'Confirm'], scope: 'body', hidesPage: true, follows: '(nothing readable outside the overlays above)' },
  { button: 'Open modal dialog', label: 'Native modal dialog', modal: ' (modal)', controls: ['Cancel', 'Delete'], scope: 'body', hidesPage: true, follows: '# Menu fixture' },
  { button: 'Open aria-modal dialog', label: 'Aria modal dialog', modal: ' (modal)', controls: ['Archive', 'Restore', 'Close'], scope: 'main', hidesPage: false, follows: '# Menu fixture' },
];

test("a click that opens a dialog prints the dialog's hunk first and whole, ahead of what it did to the page, and a default read puts the dialog ahead of the page", { skip, timeout: 60_000 }, async () => {
  for (const [i, { button, label, modal, controls, scope, hidesPage, follows }] of DIALOGS.entries()) {
    const { session, refs } = await h.sessionOn(`act-dialog-${i}`, 'menu.html');
    const clicked = await h.click(session, refs[button]);
    const [dialogHunk, ...pageHunks] = clicked.body.split(/^@@\n/m).filter(Boolean);
    const lines = dialogHunk.trimEnd().split('\n');
    assert.match(lines[0], new RegExp(`^\\+ \\[e\\d+ dialog "${label}"${literal(modal)}\\]$`), `${label}: its marker opens the summary:\n${clicked.body}`);
    assert.strictEqual(lines.at(-1), '+ [/dialog]', `${label}: the whole dialog is in its hunk`);
    assert.ok(lines.every((line) => line.startsWith('+ ')), `${label}: every line of it added`);
    for (const control of controls) assert.match(dialogHunk, new RegExp(`\\[e\\d+ (button|menuitem) "${control}"\\]`), `${label}: with its ${control} control`);
    const removedControls = pageHunks.join('').match(/^- .*\[e\d+ button "Open menu"\]/m);
    if (hidesPage) {
      assert.ok(removedControls, `${label}: the page's controls left the tree after the dialog's hunk:\n${clicked.body}`);
    } else {
      assert.deepStrictEqual(pageHunks, [], `${label}: the page stayed in the tree:\n${clicked.body}`);
    }

    const payload = await h.readAll(session);
    const ref = /\[(e\d+) dialog/.exec(lines[0])[1];
    assert.match(payload, new RegExp(`^Scope: ${scope}\\b`, 'm'), `${label}:\n${payload}`);
    assert.match(payload, new RegExp(`^Overlays: dialog "${label}" \\[${ref}\\]${literal(modal)} \\(above the page\\)$`, 'm'), `${label}:\n${payload}`);
    const block = payload.indexOf(`[${ref} dialog "${label}"`);
    assert.ok(block > 0 && block < payload.indexOf(follows), `${label}: the dialog's block comes ahead of the page:\n${payload}`);
  }
});

function xdotool(...args) {
  try { return execFileSync('xdotool', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}
const activeWindow = () => xdotool('getactivewindow');
const windowName = (id) => xdotool('getwindowname', id);
const activate = (id) => { xdotool('windowactivate', '--sync', id); };

describe('headful', { skip: headful }, () => {
  let hf;
  let headed;
  let parked;
  let release;
  before(async () => {
    release = await holdDisplay();
    parked = activeWindow();
    headed = await liveBrowser({ headless: false, allow: ALLOW });
    hf = over(headed);
  });
  after(async () => {
    if (headed) await headed.close();
    if (parked !== null) activate(parked);
    if (release) release();
  });

  // Resolves with a new session on `page` in a tab that isn't its window's active one:
  // a tabs new opens a tab in front of it and raises the window, and the switch back
  // leaves that tab in front. Under focus emulation a tab behind another tells its page
  // that it is visible and focused, so the window's title, which names the active tab,
  // is the one check of it.
  async function inBackground(id, page) {
    const session = await hf.sessions.ensure(id);
    await hf.open(session, page);
    const tab = session.workingTargetId;
    await hf.tabs(session, 'new', `${site.base}/other`);
    const raised = activeWindow();
    await hf.tabs(session, 'switch', tabName(session, tab));
    if (raised !== null) assert.match(windowName(raised), /^Other\b/, "the working tab is not its window's active tab");
    return session;
  }

  test("type reaches the cross-site frame's input in a tab that isn't its window's active tab, without the stall of an unfocused page", { timeout: 60_000 }, async (t) => {
    const session = await inBackground('act-headful-frame', 'form.html');
    const refs = refsIn(await hf.readAll(session));
    const started = Date.now();
    const result = await hf.type(session, refs['Frame field'], 'from the background');
    const spent = Date.now() - started;
    t.diagnostic(`type into the frame of a background tab took ${spent} ms`);
    const [frame] = hf.sessions.frameTargets(session.workingTargetId);
    assert.strictEqual(await hf.evaluate(frame.targetId, "document.getElementById('field').value"), 'from the background');
    assert.ok(!/^Input:/m.test(result.head), result.head);
    assert.ok(spent < 4_000, `the input didn't stall (${spent} ms)`);
  });

  test("a screenshot of a tab that isn't its window's active tab answers, and the time it takes is reported", { timeout: 60_000 }, async (t) => {
    const session = await inBackground('act-headful-screenshot', 'form.html');
    const started = Date.now();
    const shot = await hf.screenshot(session);
    t.diagnostic(`a screenshot of a background tab took ${Date.now() - started} ms`);
    assert.strictEqual(shot.images.length, 1);
    assert.ok(shot.images[0].data.length > 0);
  });

  test("tabs new from the session page of a session whose window Chrome didn't activate last opens in that session's window and raises it", { timeout: 60_000 }, async (t) => {
    if (activeWindow() === null) {
      t.skip('every check here reads the active window with xdotool, which is absent');
      return;
    }
    const first = await hf.sessions.ensure('act-headful-first');
    await sleep(500);
    const firstWindow = activeWindow();
    const second = await hf.sessions.ensure('act-headful-second');
    await sleep(500);
    const secondWindow = activeWindow();
    assert.notStrictEqual(secondWindow, firstWindow, "the second session's window was raised over the first's");
    activate(secondWindow);
    await sleep(300);
    const { targetId: probe } = await hf.conn.send('Target.createTarget', { url: 'about:blank' });
    const { windowId: probed } = await hf.conn.send('Browser.getWindowForTarget', { targetId: probe });
    await hf.conn.send('Target.closeTarget', { targetId: probe });
    assert.strictEqual(probed, second.windowId, "precondition: Chrome puts a tab with no window named into the second session's window");

    const result = await hf.tabs(first, 'new', `${site.base}/other`);
    assert.match(result.head, /\nTitle: Other\nNavigated: yes$/, result.head);
    const { windowId: landed } = await hf.conn.send('Browser.getWindowForTarget', { targetId: first.workingTargetId });
    assert.strictEqual(landed, first.windowId, "the new tab opened in the first session's window");
    await sleep(500);
    assert.strictEqual(activeWindow(), firstWindow, 'and raised it');
  });

  test("a trusted click reaches its element in a tab that isn't its window's active tab, without the stall of an unfocused page", { timeout: 60_000 }, async (t) => {
    const session = await inBackground('act-headful-trusted', 'labels.html');
    const refs = refsIn(await hf.readAll(session));
    const started = Date.now();
    await hf.click(session, refs['From aria-label'], true);
    const spent = Date.now() - started;
    t.diagnostic(`a trusted click in a background tab took ${spent} ms`);
    assert.strictEqual(await hf.evaluate(session.workingTargetId, "document.getElementById('log').textContent"), 'trusted click');
    assert.ok(spent < 4_000, `the click didn't stall (${spent} ms)`);
  });
});
