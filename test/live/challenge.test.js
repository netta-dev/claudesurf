// These tests exercise challenge detection against headless Chrome, using 127.0.0.2
// for cross-site frames and test vendor rows for widgets; related fake-browser tests
// live in test/challenge.test.js, and download tests live in test/live/read.test.js.
// The optional headful case (CLAUDESURF_LIVE_HEADFUL=1) tests urgency marks against
// the window manager through xprop, with a recording notify-send to suppress notices.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const navigation = require('../../server/navigation');
const challenge = require('../../server/challenge');
const { respond } = require('../../server/respond');
const { Handoff } = require('../../server/handoff');
const { Notifier, toolEnv } = require('../../server/notify');
const { holdDisplay, liveBinary, liveBrowser, recordingLog, tmpDir, waitFor, FAKE_TOOLS } = require('../helpers');
const { serve } = require('../fixtures/serve');

const skip = liveBinary() ? false : 'no Chrome binary found';
const headful = !process.env.CLAUDESURF_LIVE_HEADFUL ? 'set CLAUDESURF_LIVE_HEADFUL=1 to run' : skip;
let live;
let site;
let session;

before(async () => {
  if (skip) return;
  site = await serve();
  live = await liveBrowser();
  session = await live.sessions.ensure('live-challenge');
});

after(async () => {
  if (skip) return;
  await live.close();
  site.close();
});

function working() {
  return live.sessions.target(session.workingTargetId);
}

function open(path, deadline = Date.now() + 30_000) {
  return navigation.navigate(live.context, session, { url: `${site.base}${path}`, name: 'challenge' }, deadline);
}

async function evaluate(expression) {
  const { result, exceptionDetails } = await live.sessions.send(session.workingTargetId, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (exceptionDetails) throw new Error(`${expression}: ${exceptionDetails.text}`);
  return result.value;
}

function vendors() {
  const host = new URL(site.crossBase).host;
  return [...challenge.VENDORS, { vendor: 'Test widget', frame: (url) => url.host === host, field: '[name="test-response"]' }];
}

// Resolves with the signal that detection finds once `script` has run on a blank page,
// or null. Detection runs once the page's earlier frames have detached and the
// `frames` widget frames that the script adds have committed, with the widget wait
// spent, so a test about one state doesn't wait out another.
async function signalAfter(script, { frames = 0 } = {}) {
  await evaluate("document.body.innerHTML = ''; true");
  await waitFor(() => live.sessions.frameTargets(session.workingTargetId).length === 0, 5_000);
  await evaluate(`(async () => { ${script} })()`);
  if (frames) await waitFor(() => live.sessions.frameTargets(session.workingTargetId).filter((f) => f.generation > 0).length === frames, 5_000);
  const t = working();
  t.widgetWaited = t.generation;
  const { challenge: found } = await challenge.detect(live.sessions, t, { deadline: Date.now() + 10_000, vendors: vendors() });
  return found ? found.signal : null;
}

function body(html) {
  return `document.body.innerHTML = ${JSON.stringify(html)};`;
}

test("a page answering with Cloudflare's challenge header returns needs_human once the self-clearing wait runs out", { skip, timeout: 60_000 }, async () => {
  const result = await open('/challenge', Date.now() + 7_000);
  assert.match(result.head, /^URL: http:\/\/127\.0\.0\.1:\d+\/challenge\nTitle: Just a moment\.\.\.\nChallenge: bot check — Cloudflare \(the page's cf-mitigated header\)\nNavigated: yes/);
  assert.strictEqual(respond(live.sessions, session, result).envelope.outcome, 'needs_human');
});

test('a challenge page that reloads itself to an ordinary page within the wait returns success on that page', { skip, timeout: 60_000 }, async () => {
  const result = await open('/clears');
  assert.match(result.head, /^URL: http:\/\/127\.0\.0\.1:\d+\/\nTitle: Home\nNavigated: yes/);
  assert.strictEqual(result.challenge, null);
  assert.strictEqual(respond(live.sessions, session, result).envelope.outcome, 'success');
});

test('a sign-in page and a code page return needs_human with their types', { skip }, async () => {
  const signIn = await open('/signin');
  assert.match(signIn.head, /^URL: [^\n]+\/signin\nTitle: Sign in\nChallenge: sign-in — a password field\nNavigated: yes/);
  const otp = await open('/otp');
  assert.match(otp.head, /\nChallenge: two-factor — a one-time-code field\n/);
  assert.strictEqual(respond(live.sessions, session, otp).envelope.outcome, 'needs_human');
});

test('a visible #px-captcha of 20 × 20 or more returns needs_human, and a smaller one reads as ordinary content', { skip }, async () => {
  const big = await open('/px?size=100');
  assert.match(big.head, /\nChallenge: bot check — HUMAN \(a press-and-hold element\)\n/);
  const least = await open('/px?size=20');
  assert.match(least.head, /\nChallenge: bot check — HUMAN \(a press-and-hold element\)\n/, '20 × 20');
  const small = await open('/px?size=19');
  assert.strictEqual(small.challenge, null, '19 × 19');
});

test("the scan's two-factor words name a sign-in code by prefix, word, and run, and leave out a prefix or a run inside a word, postal codes, cards, and vouchers", { skip, timeout: 60_000 }, async () => {
  await open('/');
  const code = 'a verification-code field';
  const cases = [
    ['<input name="app_otp">', code], ['<input id="mfaCode">', code], ['<input name="totpPin">', code], ['<input name="2fa">', code],
    ['<input placeholder="Enter your passcode">', code], ['<input aria-label="Two-factor code">', code],
    ['<label>One-time code <input name="x"></label>', code], ['<label for="v">Verification code</label><input id="v">', code],
    ['<label>Sign-in code <input name="y"></label>', code], ['<input aria-label="Two-step verification">', code],
    ['<input name="otpcode">', code], ['<input aria-label="Authentication code">', code],
    ['<input name="code">', null], ['<input name="otpCard">', null], ['<input name="zip_otp">', null],
    ['<input name="otp_postal">', null], ['<input name="otp_cvc">', null], ['<input name="otp_cvv">', null], ['<input name="otp_csc">', null],
    ['<input name="otp_coupon">', null], ['<input name="otp_gift">', null],
    ['<input name="otp" autocomplete="postal-code">', null], ['<input name="otp" autocomplete="cc-csc">', null],
    ['<input name="promo" placeholder="One-time code">', null], ['<input name="otp" autocomplete="one-time-code">', 'a one-time-code field'],
    ['<input name="shotput">', null], ['<input name="hotpot">', null], ['<input name="amfam">', null], ['<input aria-label="Someone time">', null],
  ];
  for (const [html, signal] of cases) assert.strictEqual(await signalAfter(body(html)), signal, html);
});

test("the scan's verification-code field takes a maxlength from 4 to 8, which a number input lacks, and a numeric type or inputmode", { skip, timeout: 60_000 }, async () => {
  await open('/');
  const code = 'a verification-code field';
  const cases = [
    ['<input name="otp" maxlength="6">', code], ['<input name="otp" maxlength="4">', code], ['<input name="otp" maxlength="8">', code],
    ['<input name="otp" maxlength="9">', null], ['<input name="otp" maxlength="10">', null], ['<input name="otp" maxlength="3">', null],
    ['<input type="number" name="otp" maxlength="20">', code], ['<input type="tel" name="otp">', code],
    ['<input type="email" name="otp">', null], ['<input type="email" inputmode="numeric" name="otp">', code],
  ];
  for (const [html, signal] of cases) assert.strictEqual(await signalAfter(body(html)), signal, html);
});

test("the scan's code boxes are a run of 4 to 8 visible single-character inputs with no other input between them, outside a card's fieldset, whose own legend names the row however deep the boxes sit", { skip, timeout: 60_000 }, async () => {
  await open('/');
  const boxes = (n) => '<input maxlength="1" style="width:30px">'.repeat(n);
  const row = 'a row of code boxes';
  const cases = [
    [`<div>${boxes(6)}</div>`, row], [`<div>${boxes(4)}</div>`, row], [`<div>${boxes(8)}</div>`, row], [`<div>${boxes(3)}</div>`, null], [`<div>${boxes(9)}</div>`, null],
    [`<div>${boxes(3)}<input name="other">${boxes(3)}</div>`, null],
    [`<fieldset><legend>Card number</legend>${boxes(6)}</fieldset>`, null],
    [`<div aria-label="Gift card PIN">${boxes(6)}</div>`, null],
    [`<div><input maxlength="1" autocomplete="cc-number" style="width:30px">${boxes(5)}</div>`, null],
    [`<div>${'<input maxlength="1" style="width:30px;display:none">'.repeat(4)}</div>`, null],
    [`<fieldset><legend>Card</legend>${'<span><input maxlength="1" style="width:30px"></span>'.repeat(6)}</fieldset>`, null],
    [`<fieldset>${boxes(6)}<fieldset><legend>Gift card</legend></fieldset></fieldset>`, row],
  ];
  for (const [html, signal] of cases) assert.strictEqual(await signalAfter(body(html)), signal, html);
});

test("the scan judges a row of code boxes within one document or shadow root, so boxes on both sides of a frame's or a shadow root's boundary don't form one", { skip, timeout: 60_000 }, async () => {
  await open('/');
  const boxes = (n) => '<input maxlength="1" style="width:30px">'.repeat(n);
  const row = 'a row of code boxes';
  const framed = (outside, inside) => `${body(boxes(outside))} const frame = document.createElement('iframe'); const loaded = new Promise((r) => { frame.onload = r; }); frame.srcdoc = ${JSON.stringify(boxes(inside))}; document.body.append(frame); await loaded;`;
  const shadowed = (outside, inside) => `${body(boxes(outside))} const host = document.createElement('div'); document.body.append(host); host.attachShadow({ mode: 'open' }).innerHTML = ${JSON.stringify(boxes(inside))};`;
  assert.strictEqual(await signalAfter(framed(2, 2)), null, 'two in the page and two in a same-origin frame');
  assert.strictEqual(await signalAfter(framed(0, 4)), row, 'four in a same-origin frame');
  assert.strictEqual(await signalAfter(shadowed(2, 2)), null, 'two in the page and two in an open shadow root');
  assert.strictEqual(await signalAfter(shadowed(0, 4)), row, 'four in an open shadow root');
});

function framedPassword(style = '', html = '<input type="password">') {
  return `const frame = document.createElement('iframe'); frame.setAttribute('style', ${JSON.stringify(style)}); const loaded = new Promise((r) => { frame.onload = r; }); frame.srcdoc = ${JSON.stringify(html)}; document.body.append(frame); await loaded;`;
}

test("the scan's password field counts when visible, at least 10 × 10, and not parked off the document's origin, in an open shadow root and a same-origin frame that counts the same way", { skip, timeout: 60_000 }, async () => {
  await open('/');
  const signIn = 'a password field';
  const sized = (side) => body(`<input type="password" style="width:${side}px;height:${side}px;padding:0;border:0;box-sizing:border-box">`);
  assert.strictEqual(await signalAfter(body('<input type="password">')), signIn);
  assert.strictEqual(await signalAfter(body('<input type="password" style="position:absolute;left:-2000px">')), null, 'left of the origin');
  assert.strictEqual(await signalAfter(body('<input type="password" style="position:absolute;top:-500px">')), null, 'above the origin');
  assert.strictEqual(await signalAfter(sized(10)), signIn, '10 × 10');
  assert.strictEqual(await signalAfter(sized(9)), null, '9 × 9');
  assert.strictEqual(await signalAfter(body('<input type="password" style="width:100px;height:5px;padding:0;border:0;box-sizing:border-box">')), null, '100 × 5');
  const placed = (box) => body(`<input type="password" style="position:absolute;padding:0;border:0;box-sizing:border-box;height:20px;${box}">`);
  assert.strictEqual(await signalAfter(placed('left:-50px;width:50px')), null, 'its right edge on the origin');
  assert.strictEqual(await signalAfter(placed('left:-5px;width:100px')), signIn, 'partly left of the origin');
  assert.strictEqual(await signalAfter(body('<input type="password" style="visibility:hidden">')), null, 'hidden');
  assert.strictEqual(await signalAfter("const host = document.createElement('div'); document.body.append(host); host.attachShadow({ mode: 'open' }).innerHTML = '<input type=\"password\">';"), signIn, 'an open shadow root');
  assert.strictEqual(await signalAfter(framedPassword()), signIn, 'a same-origin frame');
  assert.strictEqual(await signalAfter(framedPassword('visibility:hidden')), null, 'a hidden same-origin frame');
  assert.strictEqual(await signalAfter(framedPassword('position:absolute;left:-2000px')), null, 'a same-origin frame left of the origin');
});

test('an aria-hidden shadow host, or an aria-hidden ancestor of it, hides the password field in its shadow root, in the page and in a same-origin frame',{ skip, timeout: 60_000 }, async () => {
  await open('/');
  const signIn = 'a password field';
  const component = (html) => `<script>customElements.define('sign-in', class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<input type="password">'; } });</script>${html}`;
  const cases = [
    ['<sign-in></sign-in>', signIn, 'the host shown'],
    ['<sign-in aria-hidden="true"></sign-in>', null, 'the host aria-hidden'],
    ['<div aria-hidden="true"><sign-in></sign-in></div>', null, 'the app root aria-hidden'],
  ];
  for (const [html, signal, why] of cases) {
    assert.strictEqual(await signalAfter(framedPassword('', component(html))), signal, `${why}, in a same-origin frame`);
  }
  const paged = (html) => `const host = document.createElement('div'); host.innerHTML = ${JSON.stringify(html)}; document.body.append(host); host.querySelector('[data-host]').attachShadow({ mode: 'open' }).innerHTML = '<input type="password">';`;
  assert.strictEqual(await signalAfter(paged('<div data-host aria-hidden="true"></div>')), null, 'the host aria-hidden, in the page');
  assert.strictEqual(await signalAfter(paged('<div aria-hidden="true"><div data-host></div></div>')), null, 'the app root aria-hidden, in the page');
});

function widget(wrapper, style = 'width:304px;height:78px;border:0') {
  return `document.body.innerHTML = ${JSON.stringify(wrapper.replace('<widget>', `<iframe src="${site.crossBase}/other" style="${style}"></iframe>`))};`;
}

test("a widget counts while visible, at least 20 × 20, and unsolved by the response fields nearest it, which read as solved only when every one is filled", { skip, timeout: 90_000 }, async () => {
  await open('/');
  const visible = 'Test widget (a visible widget)';
  const field = (value) => `<input name="test-response" value="${value}">`;
  const cases = [
    [widget(`<div><widget>${field('')}</div>`), visible, 'an empty field'],
    [widget(`<div><widget>${field('token')}</div>`), null, 'a filled field'],
    [widget(`<div><widget>${field('  ')}</div>`), visible, 'a field of spaces alone'],
    [widget('<div><widget></div>'), visible, 'no field'],
    [widget(`<div><widget>${field('token')}${field('')}</div>`), visible, 'one of two fields filled'],
    [widget(`<div><widget>${field('token')}${field('token')}</div>`), null, 'both fields filled'],
    [widget(`<div><widget>${field('')}</div>${field('token')}`), visible, 'the near field empty, another filled elsewhere'],
    [widget(`<div><widget>${field('token')}</div>${field('')}`), null, 'the near field filled, another empty elsewhere'],
    [widget(`<div><widget>${field('')}</div>`, 'display:none'), null, 'display: none'],
    [widget(`<div><widget>${field('')}</div>`, 'width:304px;height:78px;visibility:hidden'), null, 'visibility: hidden'],
    [widget(`<div><widget>${field('')}</div>`, 'width:20px;height:20px;border:0'), visible, '20 × 20'],
    [widget(`<div><widget>${field('')}</div>`, 'width:19px;height:19px;border:0'), null, '19 × 19'],
  ];
  for (const [script, signal, why] of cases) assert.strictEqual(await signalAfter(script, { frames: 1 }), signal, why);
});

test("a widget inside a closed shadow root counts while visible and reads as solved once a response field in its host's light DOM fills", { skip, timeout: 60_000 }, async () => {
  await open('/');
  const closed = (style, value) => `
    const host = document.createElement('div');
    host.innerHTML = '<input name="test-response" value="${value}">';
    document.body.append(host);
    host.attachShadow({ mode: 'closed' }).innerHTML = '<iframe src="${site.crossBase}/other" style="${style}"></iframe>';`;
  const shown = 'width:304px;height:78px;border:0';
  assert.strictEqual(await signalAfter(closed(shown, ''), { frames: 1 }), 'Test widget (a visible widget)');
  assert.strictEqual(await signalAfter(closed(shown, 'token'), { frames: 1 }), null, 'the light-DOM field filled');
  assert.strictEqual(await signalAfter(closed('display:none', ''), { frames: 1 }), null, 'hidden');
  assert.strictEqual(await signalAfter(closed('width:304px;height:78px;visibility:hidden', ''), { frames: 1 }), null, 'visibility: hidden');
});

test("a widget inside a shadow root reads its response field beside the <iframe>'s parent in the same shadow tree, the shadow root and its host each counting as a level", { skip, timeout: 90_000 }, async () => {
  await open('/');
  // `depth` <div>s hold the <iframe> inside the shadow root; the field sits in the
  // shadow root beside them, or in the host's light DOM.
  const shadowed = (depth, value, { light = false } = {}) => {
    const field = `<input name="test-response" value="${value}">`;
    const frame = `${'<div>'.repeat(depth)}<iframe src="${site.crossBase}/other" style="width:304px;height:78px;border:0"></iframe>${'</div>'.repeat(depth)}`;
    return `
      const host = document.createElement('div');
      host.innerHTML = ${JSON.stringify(light ? field : '')};
      document.body.append(host);
      host.attachShadow({ mode: 'closed' }).innerHTML = ${JSON.stringify(light ? frame : frame + field)};`;
  };
  const visible = 'Test widget (a visible widget)';
  const cases = [
    [shadowed(1, 'token'), null, 'the field beside the parent filled'],
    [shadowed(1, ''), visible, 'the field beside the parent empty'],
    [shadowed(4, 'token'), null, 'the shadow root as the fifth level'],
    [shadowed(5, 'token'), visible, 'the shadow root past the fifth level'],
    [shadowed(3, 'token', { light: true }), null, 'the host as the fifth level'],
    [shadowed(4, 'token', { light: true }), visible, 'the host past the fifth level, since the shadow root counted as one'],
  ];
  for (const [script, signal, why] of cases) assert.strictEqual(await signalAfter(script, { frames: 1 }), signal, why);
});

function committedFrames() {
  return live.sessions.frameTargets(session.workingTargetId).filter((f) => f.generation > 0);
}

async function crossSiteFrame(style, inner) {
  await evaluate("document.body.innerHTML = ''; true");
  await waitFor(() => live.sessions.frameTargets(session.workingTargetId).length === 0, 5_000);
  await evaluate(widget('<div><widget></div>', `width:400px;height:200px;border:0;${style}`));
  await waitFor(() => committedFrames().length === 1, 5_000);
  await live.sessions.send(committedFrames()[0].targetId, 'Runtime.evaluate', { expression: `document.body.innerHTML = ${JSON.stringify(inner)}; true` });
}

async function detected(vendors) {
  const t = working();
  t.widgetWaited = t.generation;
  return (await challenge.detect(live.sessions, t, { deadline: Date.now() + 10_000, vendors })).challenge;
}

// Resolves with the signal that detection finds for a widget nested one frame down: the
// second site's /other in an <iframe> with `style`, holding the first site's /other,
// which the test's row names, so the outer frame isn't a widget of its own.
async function nestedSignal(style) {
  await crossSiteFrame(style, `<iframe src="${site.base}/other" style="width:304px;height:78px;border:0"></iframe>`);
  await waitFor(() => committedFrames().length === 2, 5_000);
  const row = { vendor: 'Nested widget', frame: (url) => url.origin === site.base && url.pathname === '/other', field: '[name="test-response"]' };
  const found = await detected([row]);
  return found ? found.signal : null;
}

test("a widget nested in a frame of another site counts only while that frame's <iframe> counts too", { skip, timeout: 60_000 }, async () => {
  await open('/');
  assert.strictEqual(await nestedSignal(''), 'Nested widget (a visible widget)', 'the outer frame shown');
  assert.strictEqual(await nestedSignal('width:20px;height:20px'), 'Nested widget (a visible widget)', 'the outer frame at 20 × 20');
  assert.strictEqual(await nestedSignal('width:300px;height:10px'), null, 'the outer frame at 300 × 10');
  assert.strictEqual(await nestedSignal('visibility:hidden'), null, 'the outer frame under visibility: hidden');
  assert.strictEqual(await nestedSignal('opacity:0'), null, 'the outer frame under opacity: 0');
});

async function sameOriginSignal(html) {
  await evaluate(`(async () => { ${body(html)} await Promise.all([...document.querySelectorAll('iframe[srcdoc]')].map((f) => new Promise((resolve) => { f.onload = resolve; }))); return true; })()`);
  const row = { vendor: 'Own widget', frame: (url) => url.origin === site.base && url.searchParams.has('widget'), field: '[name="test-response"]' };
  const found = await detected([row]);
  return found ? found.signal : null;
}

test("a widget frame of the page's own origin, which has no frame target, counts by the page scan's rule: visible, unsolved by the fields nearest it, and in a frame that counts", { skip, timeout: 60_000 }, async () => {
  await open('/');
  const frame = (style = 'width:304px;height:78px;border:0') => `<iframe src="${site.base}/other?widget=1" style="${style}"></iframe>`;
  const field = (value) => `<input name="test-response" value="${value}">`;
  const inner = (html, style = 'width:400px;height:200px;border:0') => `<iframe srcdoc="${html.replaceAll('"', '&quot;')}" style="${style}"></iframe>`;
  const visible = 'Own widget (a visible widget)';
  assert.strictEqual(await sameOriginSignal(`<div>${frame()}${field('')}</div>`), visible, 'an empty field');
  assert.strictEqual(live.sessions.frameTargets(session.workingTargetId).length, 0, 'Chrome gives the frame no target of its own');
  const cases = [
    [`<div>${frame()}${field('token')}</div>`, null, 'a filled field'],
    [`<div>${frame()}</div>`, visible, 'no field'],
    [`<div>${frame()}</div>${field('token')}`.replace('<div>', '<div><div><div><div><div>').replace('</div>', '</div></div></div></div></div>'), visible, 'a filled field past the fifth level'],
    [`<div>${frame('width:304px;height:78px;visibility:hidden')}${field('')}</div>`, null, 'visibility: hidden'],
    [`<div>${frame('width:19px;height:19px;border:0')}${field('')}</div>`, null, '19 × 19'],
    [inner(`<div>${frame()}${field('')}</div>`), visible, 'inside a same-origin frame'],
    [inner(`<div>${frame()}${field('token')}</div>`), null, 'inside a same-origin frame, its field filled'],
    [inner(`<div>${frame()}${field('')}</div>`, 'width:400px;height:200px;border:0;visibility:hidden'), null, 'inside a hidden same-origin frame'],
  ];
  for (const [html, signal, why] of cases) assert.strictEqual(await sameOriginSignal(html), signal, why);
});

test('a sign-in or a code prompt inside a frame of another site, which no vendor row names, reads as ordinary content', { skip, timeout: 60_000 }, async () => {
  await open('/');
  await crossSiteFrame('', '<input type="password"><input name="otp" autocomplete="one-time-code">');
  const { result } = await live.sessions.send(committedFrames()[0].targetId, 'Runtime.evaluate', { expression: "document.querySelectorAll('input').length", returnByValue: true });
  assert.strictEqual(result.value, 2, 'the frame holds both fields');
  assert.strictEqual(await detected(challenge.VENDORS), null);
});

function marks(id) {
  const out = execFileSync('xprop', ['-id', id, 'WM_HINTS', '_NET_WM_STATE'], { encoding: 'utf8' });
  return { urgency: /urgency hint bit is set/i.test(out), attention: /_NET_WM_STATE_DEMANDS_ATTENTION/.test(out) };
}

function minimized(id) {
  return /_NET_WM_STATE_HIDDEN/.test(execFileSync('xprop', ['-id', id, '_NET_WM_STATE'], { encoding: 'utf8' }));
}

// Mutter and Muffin reject demands-attention for visible windows.
// The test minimizes the session window before checking that state.
test('headful: the handoff sets the urgency bit on the session window and the next call clears it, and a minimized window takes both marks', { skip: headful, timeout: 90_000 }, async (t) => {
  const release = await holdDisplay();
  const window = await liveBrowser({ headless: false });
  t.after(() => window.close());
  t.after(release);
  const own = await window.sessions.ensure('live-headful');
  const result = await navigation.navigate(window.context, own, { url: `${site.base}/signin`, name: 'headful handoff' }, Date.now() + 30_000);
  assert.ok(result.challenge, result.head);
  // The test puts a recording notify-send first on PATH to suppress desktop notices.
  const dir = tmpDir('claudesurf-headful');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.symlinkSync(path.join(FAKE_TOOLS, 'notify-send'), path.join(dir, 'notify-send'));
  const env = () => ({ ...toolEnv(process.env, {}), PATH: `${dir}${path.delimiter}${process.env.PATH}` });
  const notifier = new Notifier({ log: recordingLog(), env });
  const handoff = new Handoff({ notifier, browserPid: () => window.child.pid, log: recordingLog() });
  const id = await notifier.findWindow({ pid: window.child.pid, title: result.challenge.title });
  assert.ok(id, 'the session window carries the page title');
  handoff.opened(own, result.challenge, `${site.base}/signin`);
  await waitFor(() => marks(id).urgency, 5_000);
  handoff.closed(own.id);
  await waitFor(() => !marks(id).urgency && !marks(id).attention, 5_000);
  execFileSync('xdotool', ['windowminimize', id]);
  await waitFor(() => minimized(id), 5_000);
  handoff.opened(own, result.challenge, `${site.base}/signin`);
  await waitFor(() => marks(id).urgency && marks(id).attention, 5_000);
  handoff.closed(own.id);
  await waitFor(() => !marks(id).urgency && !marks(id).attention, 5_000);
});
