// These tests exercise challenge.js against the in-process fake browser.
// The page scripts are tested against Chrome in test/live/challenge.test.js.

const { test } = require('node:test');
const assert = require('node:assert');
const challenge = require('../server/challenge');
const { ConnectionClosedError, TimeoutError } = require('../server/cdp');
const { navigatedSession, frameAt, recordingLog, waitFor } = require('./helpers');

const URL = 'http://a.test/';

function page(extra = {}) {
  return { title: 'Sign in · App', text: 'Page text.', elements: [], scrollY: 0, pageHeight: 1200, viewportHeight: 600, ...extra };
}

async function setup(t, site = {}, options = {}) {
  const ctx = await navigatedSession({ t, url: URL, site: { [URL]: page(), ...site }, ...options });
  return { ...ctx, tab: ctx.fake.targets.get(ctx.target.targetId) };
}

function detect(ctx, opts = {}) {
  return challenge.detect(ctx.sessions, ctx.target, { deadline: Date.now() + 10_000, ...opts });
}

function waited(ctx) {
  ctx.target.widgetWaited = ctx.target.generation;
}

function mockPolls(t, ctx) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const polls = [];
  t.mock.method(ctx.sessions, 'waitUntil', (targetId, predicate, { timeout }) => {
    polls.push(timeout);
    t.mock.timers.tick(timeout);
    return Promise.resolve(false);
  });
  return polls;
}

function scans(ctx) {
  return ctx.fake.callsTo('Runtime.callFunctionOn').filter((c) => /function claudesurfDetect/.test(c.params.functionDeclaration)).length;
}

function onTitleRead(ctx, answer) {
  const original = ctx.fake.handlers.get('Runtime.callFunctionOn');
  ctx.fake.handle('Runtime.callFunctionOn', (params, sid, f) => (
    /function claudesurfScroll/.test(params.functionDeclaration) ? answer(f, f.bySession(sid)) : original(params, sid, f)
  ));
}

function thrown(message) {
  return { exceptionDetails: { text: 'Uncaught', exception: { description: `Error: ${message}` } } };
}

test('a quiet page has no challenge, and a password field reads as a sign-in, with the title for the urgency hint', async (t) => {
  const quiet = await setup(t);
  assert.deepStrictEqual(await detect(quiet), { challenge: null, generation: quiet.target.generation, once: false });
  const [scan] = quiet.fake.callsTo('Runtime.callFunctionOn').filter((c) => /function claudesurfDetect/.test(c.params.functionDeclaration));
  assert.deepStrictEqual(scan.params.arguments, [{ value: { fieldMin: 10, widgetMin: 20, selectors: ['[name="cf-turnstile-response"]', '[name="g-recaptcha-response"]', '[name="h-captcha-response"]'] } }],
    "the scan takes the 10 px field and 20 px widget minimums and the vendors' response-field selectors");
  const signIn = await setup(t, { [URL]: page({ detect: { password: true } }) });
  assert.deepStrictEqual(await detect(signIn), {
    challenge: { type: 'sign-in', signal: 'a password field', clears: false, title: 'Sign in · App' }, generation: signIn.target.generation, once: false,
  });
  assert.strictEqual(challenge.challengeLine((await detect(signIn)).challenge), 'Challenge: sign-in — a password field');
});

test("a challenge header on the document's own response, in any case, reads as a bot check, and only AWS's captcha won't clear itself", async (t) => {
  const cases = [
    [{ 'cf-mitigated': 'challenge' }, "Cloudflare (the page's cf-mitigated header)", true],
    [{ 'CF-Mitigated': ' Challenge ' }, "Cloudflare (the page's cf-mitigated header)", true],
    [{ 'X-Amzn-Waf-Action': 'challenge' }, "AWS WAF (the page's x-amzn-waf-action header)", true],
    [{ 'x-amzn-waf-action': 'captcha' }, "AWS WAF (the page's x-amzn-waf-action header)", false],
    [{ 'cf-mitigated': 'other', 'x-amzn-waf-action': 'block' }, null, null],
  ];
  for (const [headers, signal, clears] of cases) {
    const ctx = await setup(t, { [URL]: page({ status: 403, headers }) });
    const { challenge: found } = await detect(ctx);
    assert.deepStrictEqual(found && { signal: found.signal, clears: found.clears, type: found.type }, signal && { signal, clears, type: 'bot check' }, JSON.stringify(headers));
  }
});

test('the signals are judged in order: a header, then a widget, then press-and-hold, then a two-factor field, then a password field', async (t) => {
  const everything = { password: true, twoFactor: 'one-time-code', px: true };
  const header = await setup(t, { [URL]: page({ status: 403, headers: { 'cf-mitigated': 'challenge' }, detect: everything }) });
  await frameAt(header, header.tab, 'https://challenges.cloudflare.com/turnstile/if/abc/');
  assert.match((await detect(header)).challenge.signal, /^Cloudflare \(the page's cf-mitigated header\)$/);
  const widget = await setup(t, { [URL]: page({ detect: everything }) });
  waited(widget);
  await frameAt(widget, widget.tab, 'https://challenges.cloudflare.com/turnstile/if/abc/');
  assert.strictEqual((await detect(widget)).challenge.signal, 'Cloudflare Turnstile (a visible widget)');
  const px = await setup(t, { [URL]: page({ detect: everything }) });
  const pressed = await detect(px);
  assert.deepStrictEqual(pressed.challenge, { type: 'bot check', signal: 'HUMAN (a press-and-hold element)', clears: false, title: 'Sign in · App' });
  challenge.keep(px.target, pressed);
  assert.deepStrictEqual((await detect(px)).challenge, pressed.challenge, 'press-and-hold counts on every detection of its document, a kept one included');
  for (const [form, signal] of [['one-time-code', 'a one-time-code field'], ['verification-code', 'a verification-code field'], ['code-boxes', 'a row of code boxes']]) {
    const code = await setup(t, { [URL]: page({ detect: { password: true, twoFactor: form } }) });
    assert.deepStrictEqual((await detect(code)).challenge, { type: 'two-factor', signal, clears: false, title: 'Sign in · App' }, form);
  }
});

test("each vendor row names its widget frames, whose <iframe> the visibility script judges under the row's response field and the 20 px minimum, and a frame that its row marks as never shown is not a widget", async (t) => {
  const turnstile = '[name="cf-turnstile-response"]';
  const recaptcha = '[name="g-recaptcha-response"]';
  const hcaptcha = '[name="h-captcha-response"]';
  const rows = [
    ['https://challenges.cloudflare.com/cdn-cgi/challenge-platform/turnstile/if/ov2/', 'Cloudflare Turnstile (a visible widget)', turnstile],
    ['https://www.google.com/recaptcha/api2/anchor?k=x&size=normal', 'reCAPTCHA (a visible widget)', recaptcha],
    ['https://www.recaptcha.net/recaptcha/api2/anchor?k=x', 'reCAPTCHA (a visible widget)', recaptcha],
    ['https://www.google.com/recaptcha/api2/anchor?k=x&size=invisible', null],
    ['https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=checkbox&id=1', 'hCaptcha (a visible widget)', hcaptcha],
    ['https://hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=checkbox-invisible&id=1', null],
    ['https://geo.captcha-delivery.com/captcha/?initialCid=x', 'DataDome (a visible widget)', null],
    ['https://client-api.arkoselabs.com/fc/gc/?token=x', 'Arkose (a visible widget)', null],
    ['https://x.funcaptcha.com/fc/gc/', 'Arkose (a visible widget)', null],
    ['https://notcaptcha-delivery.com/captcha/', null],
    ['https://www.google.com/maps/embed', null],
  ];
  for (const [url, signal, field] of rows) {
    const ctx = await setup(t);
    waited(ctx);
    await frameAt(ctx, ctx.tab, url, { field: 'absent' });
    const { challenge: found } = await detect(ctx);
    assert.strictEqual(found ? found.signal : null, signal, url);
    const judged = ctx.fake.callsTo('Runtime.callFunctionOn').filter((c) => /claudesurfVisible/.test(c.params.functionDeclaration)).map((c) => c.params.arguments);
    assert.deepStrictEqual(judged, signal ? [[{ value: field }, { value: 20 }]] : [], url);
  }
});

test("an <iframe> that the page scan finds, which has no frame target, counts as a widget when a vendor row names its src, by the row's response field nearest it", async (t) => {
  const recaptcha = '[name="g-recaptcha-response"]';
  const fields = (state) => ({ '[name="cf-turnstile-response"]': 'absent', [recaptcha]: 'absent', '[name="h-captcha-response"]': 'absent', ...state });
  const anchor = 'https://www.google.com/recaptcha/api2/anchor?k=x&size=normal';
  const rows = [
    [[{ src: anchor, fields: fields({ [recaptcha]: 'empty' }) }], 'reCAPTCHA (a visible widget)', 'an empty field'],
    [[{ src: anchor, fields: fields() }], 'reCAPTCHA (a visible widget)', 'no field'],
    [[{ src: anchor, fields: fields({ [recaptcha]: 'filled' }) }], null, 'a filled field'],
    [[{ src: 'https://www.google.com/recaptcha/api2/anchor?k=x&size=invisible', fields: fields({ [recaptcha]: 'empty' }) }], null, 'a frame that its row marks as never shown'],
    [[{ src: 'https://www.google.com/maps/embed', fields: fields() }, { src: 'https://geo.captcha-delivery.com/interstitial/?initialCid=x', fields: fields() }], 'DataDome (a device check)', 'a row without a field, after a frame that no row names'],
  ];
  // The test adds widget frames after setup so setup's detection doesn't mark them
  // as reported.
  for (const [frames, signal, why] of rows) {
    const ctx = await setup(t);
    ctx.fake.site[URL].detect = { frames };
    waited(ctx);
    const { challenge: found } = await detect(ctx);
    assert.strictEqual(found ? found.signal : null, signal, why);
    assert.strictEqual(ctx.fake.callsTo('Runtime.callFunctionOn').filter((c) => /claudesurfVisible/.test(c.params.functionDeclaration)).length, 0, `${why}: judged by the scan alone`);
  }
  const arkose = await setup(t);
  arkose.fake.site[URL].detect = { frames: [{ src: 'https://client-api.arkoselabs.com/fc/gc/?token=x', fields: fields() }] };
  const first = await detect(arkose);
  assert.strictEqual(first.once, true, 'a row without a field counts once per document');
  challenge.keep(arkose.target, first);
  assert.strictEqual((await detect(arkose)).challenge, null);
});

test("the widget wait checks the page scan's widgets again, so the response field of one that fills within it reads as solved", async (t) => {
  let filledAt = Infinity;
  const turnstile = '[name="cf-turnstile-response"]';
  const scanned = () => ({ frames: [{ src: 'https://challenges.cloudflare.com/turnstile/if/abc/', fields: { [turnstile]: Date.now() >= filledAt ? 'filled' : 'empty' } }] });
  const ctx = await setup(t);
  ctx.fake.site[URL].detect = scanned;
  filledAt = Date.now() + 700;
  const started = Date.now();
  assert.strictEqual((await detect(ctx)).challenge, null, 'Turnstile solved itself within the wait');
  const took = Date.now() - started;
  assert.ok(took >= 600 && took < 2_000, `the wait ended as the field filled (${took} ms)`);
  assert.strictEqual(ctx.target.widgetWaited, ctx.target.generation);
});

test('a widget without a response field skips the widget wait, which stays unspent', async (t) => {
  const ctx = await setup(t);
  await frameAt(ctx, ctx.tab, 'https://client-api.arkoselabs.com/fc/gc/?token=x', { field: 'absent' });
  const polls = [];
  const waitUntil = ctx.sessions.waitUntil.bind(ctx.sessions);
  t.mock.method(ctx.sessions, 'waitUntil', (...args) => {
    polls.push(args[2].timeout);
    return waitUntil(...args);
  });
  assert.strictEqual((await detect(ctx)).challenge.signal, 'Arkose (a visible widget)');
  assert.deepStrictEqual(polls, []);
  assert.strictEqual(ctx.target.widgetWaited, null);
});

test("a widget counts only while visible and unsolved, and an <iframe> its parent's world can't resolve doesn't count, with a debug line", async (t) => {
  const turnstile = 'https://challenges.cloudflare.com/turnstile/if/abc/';
  for (const [owner, counts] of [[{ visible: false }, false], [{ field: 'filled' }, false], [{ field: 'empty' }, true], [{ field: 'absent' }, true]]) {
    const ctx = await setup(t);
    waited(ctx);
    await frameAt(ctx, ctx.tab, turnstile, owner);
    assert.strictEqual(Boolean((await detect(ctx)).challenge), counts, JSON.stringify(owner));
  }
  const log = recordingLog();
  const lost = await setup(t, {}, { log });
  waited(lost);
  await frameAt(lost, lost.tab, turnstile, { unresolvable: true });
  assert.strictEqual((await detect(lost)).challenge, null);
  assert.match(log.lines.debug.join('\n'), /detection: the <iframe> of frame T\d+ did not resolve/);
  const groups = lost.fake.callsTo('DOM.resolveNode').filter((c) => c.params.objectGroup === 'claudesurf-detect');
  assert.strictEqual(groups.length, 1, 'resolved under the detection group');
  assert.ok(lost.fake.callsTo('Runtime.releaseObjectGroup').some((c) => c.params.objectGroup === 'claudesurf-detect'), 'and the group is released');
});

test("a widget inside a frame whose own <iframe> doesn't resolve doesn't count, with a debug line naming that frame, and a resolvable one is judged without a selector", async (t) => {
  const turnstile = 'https://challenges.cloudflare.com/turnstile/if/abc/';
  // Resolves with a context whose tab holds a frame of another site, its <iframe>
  // `outerOwner`, which holds a Turnstile frame.
  async function nested(outerOwner, log) {
    const ctx = await setup(t, {}, { log });
    waited(ctx);
    const outer = await frameAt(ctx, ctx.tab, 'https://embed.example/', outerOwner);
    const widget = ctx.fake.createTarget({ type: 'iframe', parent: outer, url: turnstile });
    widget.owner = { backendNodeId: 900 + ctx.fake.nextTarget, visible: true, field: 'empty' };
    await waitFor(() => ctx.sessions.frameTargets(ctx.tab.targetId).some((f) => f.url === turnstile));
    return { ctx, outer };
  }
  const log = recordingLog();
  const lost = await nested({ unresolvable: true }, log);
  assert.strictEqual((await detect(lost.ctx)).challenge, null);
  assert.match(log.lines.debug.join('\n'), new RegExp(`detection: the <iframe> of frame ${lost.outer.targetId} did not resolve`));
  const shown = await nested({}, recordingLog());
  assert.strictEqual((await detect(shown.ctx)).challenge.signal, 'Cloudflare Turnstile (a visible widget)');
  const judged = shown.ctx.fake.callsTo('Runtime.callFunctionOn').filter((c) => /claudesurfVisible/.test(c.params.functionDeclaration));
  assert.deepStrictEqual(judged.map((c) => [c.sessionId, c.params.arguments]), [
    [shown.outer.sessionId, [{ value: '[name="cf-turnstile-response"]' }, { value: 20 }]],
    [shown.ctx.tab.sessionId, [{ value: null }, { value: 20 }]],
  ], "the widget's <iframe> under its field in the outer frame, then the outer frame's <iframe> in the page");
});

test('a widget without a response field counts once per document, spent by the keep of a result, and DataDome\'s device check may clear itself', async (t) => {
  const ctx = await setup(t, { 'http://a.test/next': page() });
  await frameAt(ctx, ctx.tab, 'https://client-api.arkoselabs.com/fc/gc/?token=x');
  const first = await detect(ctx);
  assert.deepStrictEqual(first, { challenge: { type: 'bot check', signal: 'Arkose (a visible widget)', clears: false, title: 'Sign in · App' }, generation: ctx.target.generation, once: true });
  assert.deepStrictEqual(await detect(ctx), first, 'a detection whose result nobody kept leaves it unspent');
  assert.deepStrictEqual(challenge.keep(ctx.target, first), first.challenge);
  assert.strictEqual(ctx.target.widgetReported, ctx.target.generation);
  assert.strictEqual((await detect(ctx)).challenge, null, 'the daemon cannot tell when the human solved it');
  ctx.fake.navigateTarget(ctx.tab, 'http://a.test/next');
  await waitFor(() => ctx.target.url === 'http://a.test/next');
  await frameAt(ctx, ctx.tab, 'https://client-api.arkoselabs.com/fc/gc/?token=y');
  assert.strictEqual((await detect(ctx)).challenge.signal, 'Arkose (a visible widget)', 'a new document reports it again');

  const device = await setup(t);
  await frameAt(device, device.tab, 'https://geo.captcha-delivery.com/interstitial/?initialCid=x');
  assert.deepStrictEqual((await detect(device)).challenge, { type: 'bot check', signal: 'DataDome (a device check)', clears: true, title: 'Sign in · App' });

  const password = await setup(t, { [URL]: page({ detect: { password: true } }) });
  const signIn = await detect(password);
  challenge.keep(password.target, signIn);
  assert.strictEqual(password.target.widgetReported, null, 'a challenge of another kind spends nothing');
  assert.strictEqual(challenge.keep(password.target, null), null, 'a failed detection keeps nothing');
});

test('the widget wait gives an empty response field up to 3 s to fill, once per document', async (t) => {
  let filledAt = Infinity;
  const ctx = await setup(t);
  await frameAt(ctx, ctx.tab, 'https://challenges.cloudflare.com/turnstile/if/abc/', { field: () => (Date.now() >= filledAt ? 'filled' : 'empty') });
  filledAt = Date.now() + 700;
  const started = Date.now();
  assert.strictEqual((await detect(ctx)).challenge, null, 'Turnstile solved itself within the wait');
  const took = Date.now() - started;
  assert.ok(took >= 600 && took < 2_000, `the wait ended as the field filled (${took} ms)`);
  filledAt = Infinity;
  const again = Date.now();
  assert.strictEqual((await detect(ctx)).challenge.signal, 'Cloudflare Turnstile (a visible widget)');
  assert.ok(Date.now() - again < 400, 'the wait is spent on this document');
});

test('the widget wait ends 500 ms before the deadline, so its last check, whose scan reads the title, still has time to answer', async (t) => {
  const stuck = await setup(t);
  await frameAt(stuck, stuck.tab, 'https://challenges.cloudflare.com/turnstile/if/abc/');
  const original = stuck.fake.handlers.get('DOM.getFrameOwner');
  stuck.fake.handle('DOM.getFrameOwner', (params, sid, f) => new Promise((resolve, reject) => {
    setTimeout(() => { try { resolve(original(params, sid, f)); } catch (e) { reject(e); } }, 20);
  }));
  const from = Date.now();
  const found = await detect(stuck, { deadline: Date.now() + 1_500 });
  assert.deepStrictEqual(found.challenge, { type: 'bot check', signal: 'Cloudflare Turnstile (a visible widget)', clears: false, title: 'Sign in · App' }, 'a field that never fills counts');
  const spent = Date.now() - from;
  assert.ok(spent >= 900 && spent < 1_400, `the wait ended 500 ms before the deadline (${spent} ms)`);
});

test('a widget wait with no room before the deadline stays unspent, so a later call on the document waits', async (t) => {
  let filledAt = Infinity;
  const ctx = await setup(t);
  await frameAt(ctx, ctx.tab, 'https://challenges.cloudflare.com/turnstile/if/abc/', { field: () => (Date.now() >= filledAt ? 'filled' : 'empty') });
  assert.ok((await detect(ctx, { deadline: Date.now() + 300 })).challenge, 'the empty field counts');
  assert.strictEqual(ctx.target.widgetWaited, null);
  filledAt = Date.now() + 300;
  assert.strictEqual((await detect(ctx)).challenge, null, 'the later call waited for the field to fill');
  assert.strictEqual(ctx.target.widgetWaited, ctx.target.generation);
});

test('the widget wait checks again every 500 ms for at most 3 s, however far off the deadline is', async (t) => {
  const ctx = await setup(t);
  await frameAt(ctx, ctx.tab, 'https://challenges.cloudflare.com/turnstile/if/abc/');
  const polls = mockPolls(t, ctx);
  assert.ok((await detect(ctx, { deadline: Date.now() + 60_000 })).challenge, 'a field that never fills counts');
  assert.deepStrictEqual(polls, [500, 500, 500, 500, 500, 500]);
});

test("the widget wait's last check waits only for what is left before the wait ends, 500 ms before the deadline", async (t) => {
  const ctx = await setup(t);
  await frameAt(ctx, ctx.tab, 'https://challenges.cloudflare.com/turnstile/if/abc/');
  const polls = mockPolls(t, ctx);
  assert.ok((await detect(ctx, { deadline: Date.now() + 2_250 })).challenge, 'a field that never fills counts');
  assert.deepStrictEqual(polls, [500, 500, 500, 250]);
});

test("a visible widget whose response field reads absent gets the widget wait, as an empty one does, since its field isn't filled", async (t) => {
  const ctx = await setup(t);
  await frameAt(ctx, ctx.tab, 'https://challenges.cloudflare.com/turnstile/if/abc/', { field: 'absent' });
  const polls = mockPolls(t, ctx);
  assert.strictEqual((await detect(ctx)).challenge.signal, 'Cloudflare Turnstile (a visible widget)');
  assert.deepStrictEqual(polls, [500, 500, 500, 500, 500, 500]);
  assert.strictEqual(ctx.target.widgetWaited, ctx.target.generation);
});

test("a hidden widget leaves the widget wait unspent, though its response field is empty", async (t) => {
  const ctx = await setup(t);
  await frameAt(ctx, ctx.tab, 'https://challenges.cloudflare.com/turnstile/if/abc/', { visible: false, field: 'empty' });
  const polls = mockPolls(t, ctx);
  assert.strictEqual((await detect(ctx)).challenge, null);
  assert.deepStrictEqual(polls, []);
  assert.strictEqual(ctx.target.widgetWaited, null);
});

test('the widget wait is spent only with room for one 500 ms check before it ends', async (t) => {
  const ctx = await setup(t);
  await frameAt(ctx, ctx.tab, 'https://challenges.cloudflare.com/turnstile/if/abc/');
  const polls = mockPolls(t, ctx);
  assert.ok((await detect(ctx, { deadline: Date.now() + 900 })).challenge, 'the empty field counts');
  assert.deepStrictEqual(polls, [], '400 ms of room is less than one check');
  assert.strictEqual(ctx.target.widgetWaited, null);
  assert.ok((await detect(ctx, { deadline: Date.now() + 1_000 })).challenge);
  assert.deepStrictEqual(polls, [500], '500 ms of room is one check');
  assert.strictEqual(ctx.target.widgetWaited, ctx.target.generation);
});

test("a navigation that starts during the widget wait ends it, and a commit before detection ends makes the challenge null", async (t) => {
  const ctx = await setup(t, { 'http://a.test/next': page() });
  await frameAt(ctx, ctx.tab, 'https://challenges.cloudflare.com/turnstile/if/abc/');
  setTimeout(() => ctx.fake.announce(ctx.tab, 'http://a.test/next'), 300);
  const started = Date.now();
  await detect(ctx);
  assert.ok(Date.now() - started < 1_500, `the wait ended as the navigation started (${Date.now() - started} ms)`);

  // The wait checks the widgets once more as it ends on a navigation, so a field that
  // filled before the navigation started reads as solved.
  const judged = async (fills) => {
    const at = await setup(t, { 'http://a.test/next': page() });
    let filledAt = Infinity;
    await frameAt(at, at.tab, 'https://challenges.cloudflare.com/turnstile/if/abc/', { field: () => (Date.now() >= filledAt ? 'filled' : 'empty') });
    if (fills) setTimeout(() => { filledAt = Date.now(); }, 150);
    setTimeout(() => at.fake.announce(at.tab, 'http://a.test/next'), 300);
    return (await detect(at)).challenge;
  };
  assert.strictEqual(await judged(true), null, 'filled before the navigation started');
  assert.strictEqual((await judged(false)).signal, 'Cloudflare Turnstile (a visible widget)', 'still empty as the navigation started');

  const moving = await setup(t, { 'http://a.test/next': page() });
  moving.fake.site[URL].detect = (target) => {
    moving.fake.navigateTarget(target, 'http://a.test/next');
    return { password: true };
  };
  const before = moving.target.generation;
  assert.deepStrictEqual(await detect(moving), { challenge: null, generation: before, once: false });
});

test("a back-forward cache restore commits under its document's old loader id, so its response's header still counts", async (t) => {
  const ctx = await setup(t, {
    [URL]: page({ status: 403, headers: { 'cf-mitigated': 'challenge' }, restored: true }),
    'http://a.test/next': page({ title: 'Next' }),
  });
  assert.ok((await detect(ctx)).challenge);
  ctx.fake.navigateTarget(ctx.tab, 'http://a.test/next');
  await waitFor(() => ctx.target.url === 'http://a.test/next');
  assert.strictEqual((await detect(ctx)).challenge, null);
  ctx.fake.historyStep(ctx.tab, ctx.tab.history.findIndex((entry) => entry.url === URL));
  await waitFor(() => ctx.target.url === URL);
  assert.strictEqual((await detect(ctx)).challenge.signal, "Cloudflare (the page's cf-mitigated header)");
});

test('a page scan that throws rejects detect, and detectOrLog logs it at info and answers null', async (t) => {
  const log = recordingLog();
  const ctx = await setup(t, { [URL]: page({ detect: { throws: 'the page did not answer' } }) }, { log });
  await assert.rejects(detect(ctx), /the page did not answer/);
  assert.strictEqual(await challenge.detectOrLog(ctx.sessions, ctx.target, {}), null);
  assert.match(log.lines.info.join('\n'), /detecting a challenge on T\d+ failed: page script failed: Error: the page did not answer/);
});

test("a widget whose visibility read fails as the protocol's, as when a commit lands after its <iframe> resolved, is dropped at debug", async (t) => {
  const log = recordingLog();
  const ctx = await setup(t, {}, { log });
  waited(ctx);
  await frameAt(ctx, ctx.tab, 'https://challenges.cloudflare.com/turnstile/if/abc/', { field: () => { throw new Error('Cannot find context with specified id'); } });
  assert.strictEqual(await challenge.detectOrLog(ctx.sessions, ctx.target, { deadline: Date.now() + 10_000 }).then((d) => d && d.challenge), null);
  assert.deepStrictEqual(log.lines.info.filter((l) => /detecting a challenge/.test(l)), []);
  assert.match(log.lines.debug.join('\n'), /detection: the <iframe> of frame T\d+ did not answer: .*Cannot find context/);
});

test("a widget check that fails other than as the protocol's, by a frame owner that doesn't answer in time or a visibility script that throws, rejects detect, and detectOrLog logs it at info and answers null", async (t) => {
  const cases = [
    ['an owner that never answers', (ctx) => ctx.fake.handle('DOM.getFrameOwner', () => new Promise(() => {})), (e) => e instanceof TimeoutError && e.method === 'DOM.getFrameOwner', /failed: DOM\.getFrameOwner timed out/],
    ['a visibility script that throws', (ctx) => {
      const original = ctx.fake.handlers.get('Runtime.callFunctionOn');
      ctx.fake.handle('Runtime.callFunctionOn', (params, sid, f) => (
        /function claudesurfVisible/.test(params.functionDeclaration) ? thrown('the widget script broke') : original(params, sid, f)
      ));
    }, /page script failed: Error: the widget script broke/, /failed: page script failed: Error: the widget script broke/],
  ];
  for (const [why, breaks, error, logged] of cases) {
    const log = recordingLog();
    const ctx = await setup(t, {}, { log });
    waited(ctx);
    await frameAt(ctx, ctx.tab, 'https://challenges.cloudflare.com/turnstile/if/abc/');
    breaks(ctx);
    await assert.rejects(detect(ctx, { deadline: Date.now() + 300 }), error, why);
    assert.strictEqual(await challenge.detectOrLog(ctx.sessions, ctx.target, { deadline: Date.now() + 300 }), null, why);
    assert.match(log.lines.info.join('\n'), new RegExp(`detecting a challenge on T\\d+ ${logged.source}`), why);
  }
});

test("a widget frame whose parent frame goes during detection doesn't count, and the page's own signals still do", async (t) => {
  const ctx = await setup(t, { [URL]: page({ detect: { password: true } }) });
  waited(ctx);
  const first = await frameAt(ctx, ctx.tab, 'https://challenges.cloudflare.com/turnstile/if/first/', { field: 'filled' });
  const outer = await frameAt(ctx, ctx.tab, 'https://embed.example/');
  const widget = ctx.fake.createTarget({ type: 'iframe', parent: outer, url: 'https://challenges.cloudflare.com/turnstile/if/abc/' });
  widget.owner = { backendNodeId: 900 + ctx.fake.nextTarget, visible: true, field: 'empty' };
  await waitFor(() => ctx.sessions.frameTargets(ctx.tab.targetId).some((f) => f.targetId === widget.targetId));
  const original = ctx.fake.handlers.get('DOM.getFrameOwner');
  ctx.fake.handle('DOM.getFrameOwner', (params, sid, f) => {
    if (params.frameId === first.targetId) f.destroyTarget(outer.targetId);
    return original(params, sid, f);
  });
  assert.deepStrictEqual((await detect(ctx)).challenge, { type: 'sign-in', signal: 'a password field', clears: false, title: 'Sign in · App' });
  assert.strictEqual(ctx.sessions.target(outer.targetId), null, 'the outer frame left the registry during detection');
});

test('after a header match, the title comes from the page-state read without the page scan, and after a widget match from the scan that ran with the widget check', async (t) => {
  const header = await setup(t, { [URL]: page({ status: 405, headers: { 'x-amzn-waf-action': 'captcha' }, title: 'Verify' }) });
  const before = scans(header);
  assert.strictEqual((await detect(header)).challenge.title, 'Verify');
  assert.strictEqual(scans(header), before, 'after a header match');
  const widget = await setup(t, { [URL]: page({ title: 'Verify' }) });
  waited(widget);
  await frameAt(widget, widget.tab, 'https://challenges.cloudflare.com/turnstile/if/abc/');
  const earlier = scans(widget);
  onTitleRead(widget, () => thrown('the page state was read'));
  assert.strictEqual((await detect(widget)).challenge.title, 'Verify');
  assert.strictEqual(scans(widget), earlier + 1, 'after a widget match');
});

test("a header match stands when the title read throws: the title is empty, which skips the urgency hint", async (t) => {
  const log = recordingLog();
  const header = await setup(t, { [URL]: page({ status: 405, headers: { 'x-amzn-waf-action': 'captcha' } }) }, { log });
  onTitleRead(header, () => thrown('the deadline passed'));
  assert.deepStrictEqual(await detect(header), {
    challenge: { type: 'bot check', signal: "AWS WAF (the page's x-amzn-waf-action header)", clears: false, title: '' }, generation: header.target.generation, once: false,
  });
  assert.match(log.lines.info.join('\n'), /reading the title of T\d+ for the urgency hint failed: page script failed: Error: the deadline passed/);
});

test('a pipe that closes or a tab that goes during the title read after a header match rejects detect and detectOrLog, with nothing logged', async (t) => {
  const cases = [
    ['a closed pipe', (f) => { f.close(); return {}; }, (e) => e instanceof ConnectionClosedError],
    ['a gone tab', (f, tab) => {
      f.destroyTarget(tab.targetId);
      throw { code: -32001, message: 'Session with given id not found.' };
    }, /Session with given id not found/],
  ];
  const calls = [['detect', detect], ['detectOrLog', (ctx) => challenge.detectOrLog(ctx.sessions, ctx.target, { deadline: Date.now() + 10_000 })]];
  for (const [what, answer, error] of cases) {
    for (const [name, call] of calls) {
      const log = recordingLog();
      const ctx = await setup(t, { [URL]: page({ status: 403, headers: { 'cf-mitigated': 'challenge' } }) }, { log });
      const logged = log.lines.info.length;
      onTitleRead(ctx, answer);
      await assert.rejects(call(ctx), error, `${name}, ${what}`);
      assert.deepStrictEqual(log.lines.info.slice(logged), [], `${name}, ${what}`);
    }
  }
});

test('the vendor rows can be extended, as the live test extends them for its second site', async (t) => {
  const ctx = await setup(t);
  waited(ctx);
  await frameAt(ctx, ctx.tab, 'http://127.0.0.2:9/widget', { field: 'empty' });
  assert.strictEqual((await detect(ctx)).challenge, null, 'not a vendor of VENDORS');
  const vendors = [...challenge.VENDORS, { vendor: 'Test widget', frame: (url) => url.hostname === '127.0.0.2', field: '[name="test-response"]' }];
  assert.strictEqual((await detect(ctx, { vendors })).challenge.signal, 'Test widget (a visible widget)');
  const visible = ctx.fake.callsTo('Runtime.callFunctionOn').filter((c) => /claudesurfVisible/.test(c.params.functionDeclaration)).at(-1);
  assert.deepStrictEqual(visible.params.arguments, [{ value: '[name="test-response"]' }, { value: 20 }], 'the row\'s selector and the 20 px minimum');
});
