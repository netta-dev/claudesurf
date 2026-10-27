// navigation.js against the in-process fake: navigate's payloads, its gate pre-check, a
// redirect hop that the gate refused, and its wait running out; history's steps, its ends,
// its pre-check, and a back-forward cache restore.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { enableTargets } = require('../server/browser');
const navigation = require('../server/navigation');
const { respond } = require('../server/respond');
const { OutcomeError } = require('../server/action-support');
const { NAVIGATION_MS } = require('../server/navigation-wait');
const { fakeSession, markedRefs, waitFor } = require('./helpers');

async function setup(t, pages = {}, { allow } = {}) {
  const ctx = fakeSession({ t, allow });
  await enableTargets(ctx.conn);
  Object.assign(ctx.fake.site, pages);
  const session = await ctx.sessions.ensure('s1');
  return { ...ctx, session, working: () => ctx.sessions.target(session.workingTargetId) };
}

function page(title, extra = {}) {
  return { title, text: 'text', elements: [], scrollY: 0, pageHeight: 1200, viewportHeight: 600, ...extra };
}

async function outcome(promise) {
  try { return { ok: await promise }; } catch (e) {
    if (e instanceof OutcomeError) return { fail: e.envelope };
    throw e;
  }
}

function go(ctx, url) {
  return navigation.navigate(ctx.context, ctx.session, { url, name: 'n' });
}

test('history on a fresh working tab\'s session page answers error saying to navigate first', async (t) => {
  const ctx = await setup(t);
  for (const op of ['reload', 'back', 'forward']) {
    const { fail } = await outcome(navigation.history(ctx.context, ctx.session, { op }));
    assert.strictEqual(fail.outcome, 'error', op);
    assert.match(fail.message, /navigate first/);
  }
  assert.strictEqual(ctx.fake.callsTo('Page.getNavigationHistory').length, 0, 'nothing was asked of the tab');
});

test('navigate labels the session, loads, and returns the page state', async (t) => {
  const ctx = await setup(t, { 'http://a.test/': page('A'), 'http://b.test/': page('B') });
  const { fake, context, session } = ctx;
  await go(ctx, 'http://a.test/');
  const { head } = await navigation.navigate(context, session, { url: 'http://b.test/', name: 'renamed', description: 'd' });
  assert.strictEqual(head, 'URL: http://b.test/\nTitle: B\nNavigated: yes');
  assert.deepStrictEqual(session.label, { name: 'renamed', description: 'd' });
  assert.deepStrictEqual(fake.targets.get(session.identityTargetId).label, { name: 'renamed', description: 'd' });
  fake.site['http://c.test/'] = { errorText: 'net::ERR_NAME_NOT_RESOLVED' };
  const { fail } = await outcome(navigation.navigate(context, session, { url: 'http://c.test/', name: 'renamed' }));
  assert.strictEqual(fail.outcome, 'error');
  assert.match(fail.message, /ERR_NAME_NOT_RESOLVED/);
});

test('navigate to a denied download is an error that the download event answers before its 300 ms wait for it runs out, and leaves the page; a fragment navigate returns the new URL promptly', async (t) => {
  const ctx = await setup(t, { 'http://a.test/': page('A'), 'http://a.test/file.bin': { download: true } }, { allow: ['a.test'] });
  await go(ctx, 'http://a.test/');
  const continued = ctx.fake.callsTo('Fetch.continueRequest').length;
  let started = Date.now();
  const download = await outcome(go(ctx, 'http://a.test/file.bin'));
  const took = Date.now() - started;
  assert.deepStrictEqual({ outcome: download.fail.outcome, message: download.fail.message }, {
    outcome: 'error', message: 'Navigation to http://a.test/file.bin was a download, which is denied; the page is unchanged',
  });
  assert.ok(took < 250, `the download event ended the wait for it (${took} ms)`);
  assert.strictEqual(ctx.fake.callsTo('Fetch.continueRequest').length, continued + 1, 'its request passed the gate');
  assert.strictEqual(ctx.working().url, 'http://a.test/');
  started = Date.now();
  const fragment = await go(ctx, 'http://a.test/#part');
  assert.strictEqual(fragment.head, 'URL: http://a.test/#part\nTitle: A\nNavigated: no\nChanged: not tracked (read the page first)', 'a fragment stays on its document, so it gets a summary');
  assert.ok(Date.now() - started < 1000, 'the same-document event ended the wait');
});

test('navigate to a page that answers 204, which Chrome drops without a commit or a download, is an error naming net::ERR_ABORTED and leaves the page', async (t) => {
  const ctx = await setup(t, { 'http://a.test/': page('A'), 'http://a.test/no-content': { noContent: true } }, { allow: ['a.test'] });
  await go(ctx, 'http://a.test/');
  const { fail } = await outcome(go(ctx, 'http://a.test/no-content'));
  assert.deepStrictEqual({ outcome: fail.outcome, message: fail.message }, { outcome: 'error', message: 'Navigation to http://a.test/no-content failed: net::ERR_ABORTED' });
  assert.strictEqual(ctx.working().url, 'http://a.test/');
});

test('a navigate the gate refuses returns the before-acting needs_confirmation with the working tab\'s state lines, without a Page.navigate', async (t) => {
  const ctx = await setup(t, { 'http://a.test/': page('A') }, { allow: ['a.test'] });
  await go(ctx, 'http://a.test/');
  const navigates = ctx.fake.callsTo('Page.navigate').length;
  const result = await go(ctx, 'http://evil.test/collect?d=1');
  assert.strictEqual(ctx.fake.callsTo('Page.navigate').length, navigates, 'nothing was sent');
  assert.strictEqual(result.head, 'URL: http://a.test/\nTitle: A');
  assert.deepStrictEqual(result.blocked.map(({ kind, how, host, tab }) => ({ kind, how, host, tab })), [{ kind: 'navigation', how: 'not started', host: 'evil.test', tab: 1 }]);
  assert.deepStrictEqual(ctx.session.refusals, [], 'a pre-check records nothing on the session');
  const { envelope } = respond(ctx.sessions, ctx.session, result);
  assert.strictEqual(envelope.outcome, 'needs_confirmation');
  assert.match(envelope.message, /^The navigation was not started: its host needs the human's approval\./);
  assert.ok(!envelope.message.includes('evil'), 'the host stays out of the message');
  assert.strictEqual(envelope.payload, 'URL: http://a.test/\nTitle: A\nBlocked: [t1] evil.test — navigation to http://evil.test/collect?d=1 (not started)');
});

test('a redirect hop that the gate refused returns the after-acting needs_confirmation, not the download error', async (t) => {
  const ctx = await setup(t, { 'http://a.test/': page('A'), 'http://a.test/go': { redirect: 'http://evil.test/landing' } }, { allow: ['a.test'] });
  await go(ctx, 'http://a.test/');
  const started = Date.now();
  const result = await go(ctx, 'http://a.test/go');
  assert.ok(Date.now() - started < 2000, 'the refusal ended the wait');
  assert.strictEqual(result.head, 'URL: http://a.test/\nTitle: A\nNavigated: no\nChanged: not tracked (read the page first)');
  assert.deepStrictEqual(result.blocked.map(({ kind, how, url }) => ({ kind, how, url })), [{ kind: 'navigation', how: 'stopped', url: 'http://evil.test/landing' }]);
  const { envelope } = respond(ctx.sessions, ctx.session, result);
  assert.strictEqual(envelope.outcome, 'needs_confirmation');
  assert.match(envelope.message, /^The action ran, and a navigation it led to was stopped at the domain gate\./);
  assert.match(envelope.payload, /\nBlocked: \[t1\] evil\.test — navigation to http:\/\/evil\.test\/landing$/);
});

test('a navigate whose document sends the tab to a refused host before its DOMContentLoaded reads Navigated: yes once that document has loaded', async (t) => {
  const short = 'http://a.test/short';
  let loaded = false;
  const ctx = await setup(t, { 'http://a.test/': page('A'), [short]: page('Short', { busy: () => ({ readyState: loaded ? 'interactive' : 'loading' }) }) }, { allow: ['a.test'] });
  const { fake } = ctx;
  await go(ctx, 'http://a.test/');
  const original = fake.handlers.get('Page.navigate');
  // The shortener's page commits, its head script sends the tab to a host that the
  // gate refuses, which ends navigate's own wait, and the page's DOMContentLoaded fires
  // only after the refusal.
  fake.handle('Page.navigate', (params, sid) => {
    if (params.url !== short) return original(params, sid);
    const target = fake.bySession(sid);
    setImmediate(() => {
      fake.announce(target, short);
      target.url = short;
      fake.emit('Page.frameNavigated', { frame: { id: target.targetId, url: short }, type: 'Navigation' }, sid);
      fake.navigateByPage(target, 'http://evil.test/');
      setTimeout(() => {
        loaded = true;
        fake.emit('Page.domContentEventFired', { timestamp: 1 }, sid);
      }, 150);
    });
    return { frameId: target.targetId, loaderId: 'L2' };
  });
  const result = await go(ctx, short);
  assert.strictEqual(result.head, `URL: ${short}\nTitle: Short\nNavigated: yes`);
  assert.deepStrictEqual(result.blocked.map(({ kind, how, url }) => `${kind} ${how} ${url}`), ['navigation stopped http://evil.test/']);
});

test('a navigate whose wait runs out is unsettled once the document committed, and an error when nothing did', async (t) => {
  const ctx = await setup(t, { 'http://a.test/': page('A'), 'http://a.test/slow': page('Slow', { busy: { readyState: 'loading' } }) });
  const { fake } = ctx;
  await go(ctx, 'http://a.test/');
  const original = fake.handlers.get('Page.navigate');
  // The document commits, and its DOMContentLoaded never fires.
  fake.handle('Page.navigate', ({ url }, sid) => {
    const target = fake.bySession(sid);
    setImmediate(() => {
      fake.announce(target, url);
      target.url = url;
      fake.emit('Page.frameNavigated', { frame: { id: target.targetId, url }, type: 'Navigation' }, sid);
    });
    return { frameId: target.targetId, loaderId: 'L2' };
  });
  const committed = await navigation.navigate(ctx.context, ctx.session, { url: 'http://a.test/slow', name: 'n' }, Date.now() + 3_200);
  assert.strictEqual(committed.outcome, 'unsettled');
  assert.match(committed.head, /^URL: http:\/\/a\.test\/slow\nTitle: Slow\nNavigated: started \(the new page has not finished loading\)\nSettled: no — after \d\.\d s, the page has not finished loading$/);

  fake.handle('Page.navigate', ({ url }, sid) => {
    const target = fake.bySession(sid);
    setImmediate(() => fake.announce(target, url));
    return { frameId: target.targetId, loaderId: 'L3' };
  });
  const nothing = await outcome(navigation.navigate(ctx.context, ctx.session, { url: 'http://a.test/never', name: 'n' }, Date.now() + 3_200));
  assert.strictEqual(nothing.fail.outcome, 'error');
  assert.match(nothing.fail.message, /^Navigation to http:\/\/a\.test\/never started but the page did not finish loading within \d\.\d s$/);
  fake.handle('Page.navigate', original);
});

test("a navigate whose own wait runs out on a document that hasn't fired DOMContentLoaded doesn't wait for it again, so the call keeps to its 25 s", async (t) => {
  const slow = 'http://a.test/slow';
  const ctx = await setup(t, { 'http://a.test/': page('A'), [slow]: page('Slow', { busy: { readyState: 'loading' } }) });
  const { fake } = ctx;
  await go(ctx, 'http://a.test/');
  const original = fake.handlers.get('Page.navigate');
  let late = null;
  fake.handle('Page.navigate', ({ url }, sid) => {
    const target = fake.bySession(sid);
    setImmediate(() => {
      fake.announce(target, url);
      fake.commitDocument(target, url, { loaded: false });
    });
    late = setTimeout(() => fake.emit('Page.domContentEventFired', { timestamp: 1 }, sid), navigation.NAVIGATE_LOAD_MS + 1_000);
    return { frameId: target.targetId, loaderId: 'L2' };
  });
  // The deadline leaves the call's own wait its full 25 s, and a wait after it about
  // 1.5 s, which would see the document's DOMContentLoaded.
  const result = await navigation.navigate(ctx.context, ctx.session, { url: slow, name: 'n' }, Date.now() + navigation.NAVIGATE_LOAD_MS + 3_500);
  clearTimeout(late);
  fake.handle('Page.navigate', original);
  assert.match(result.head, /^URL: http:\/\/a\.test\/slow\nTitle: Slow\nNavigated: started \(the new page has not finished loading\)\n/, 'the call ended before the document fired DOMContentLoaded');
});

test("a fragment navigate during which the page starts a cross-document navigation waits for that navigation's document", async (t) => {
  const ctx = await setup(t, { 'http://a.test/': page('A'), 'http://a.test/next': page('Next') });
  const { fake } = ctx;
  await go(ctx, 'http://a.test/');
  const original = fake.handlers.get('Page.navigate');
  fake.handle('Page.navigate', (params, sid) => {
    const target = fake.bySession(sid);
    // The fragment lands, and the page's hashchange handler sends the tab on, both
    // before the call goes on from the navigate's answer.
    target.url = params.url;
    fake.emit('Page.navigatedWithinDocument', { frameId: target.targetId, url: params.url }, sid);
    fake.announce(target, 'http://a.test/next');
    setTimeout(() => fake.commitDocument(target, 'http://a.test/next'), 200);
    return { frameId: target.targetId, loaderId: 'L2' };
  });
  const result = await go(ctx, 'http://a.test/#part');
  fake.handle('Page.navigate', original);
  assert.strictEqual(result.head, 'URL: http://a.test/next\nTitle: Next\nNavigated: yes');
});

test("a navigate from a page whose DOMContentLoaded fires during the request waits for the next document's own", async (t) => {
  const ctx = await setup(t, { 'http://a.test/': page('A'), 'http://a.test/slow': page('Slow', { busy: { readyState: 'loading' } }), 'http://a.test/next': page('Next', { busy: { readyState: 'loading' } }) });
  const { fake } = ctx;
  await go(ctx, 'http://a.test/');
  const original = fake.handlers.get('Page.navigate');
  // Neither document fires DOMContentLoaded of its own accord; the slow page's fires
  // after the next navigation has started, before that document commits.
  fake.handle('Page.navigate', ({ url }, sid) => {
    const target = fake.bySession(sid);
    setImmediate(() => {
      fake.announce(target, url);
      if (url === 'http://a.test/next') fake.emit('Page.domContentEventFired', { timestamp: 1 }, sid);
      setTimeout(() => fake.commitDocument(target, url, { loaded: false }), 50);
    });
    return { frameId: target.targetId, loaderId: 'L2' };
  });
  await navigation.navigate(ctx.context, ctx.session, { url: 'http://a.test/slow', name: 'n' }, Date.now() + 3_200);
  const started = Date.now();
  const next = await navigation.navigate(ctx.context, ctx.session, { url: 'http://a.test/next', name: 'n' }, Date.now() + 3_200);
  assert.match(next.head, /^URL: http:\/\/a\.test\/next\nTitle: Next\nNavigated: started \(the new page has not finished loading\)\nSettled: no/);
  assert.ok(Date.now() - started > 1_000, `the commit alone did not end the wait (${Date.now() - started} ms)`);
  fake.handle('Page.navigate', original);
});

test('a navigate whose page moves on after its DOMContentLoaded waits for the next document as well', async (t) => {
  const ctx = await setup(t, { 'http://a.test/': page('A'), 'http://a.test/hop': page('Hop'), 'http://a.test/final': page('Final') }, { allow: ['a.test'] });
  const { fake } = ctx;
  await go(ctx, 'http://a.test/');
  // The hop's page moves on at once, and the next document's request answers late,
  // well past the quiet window.
  let late = false;
  const commit = fake.commitDocument.bind(fake);
  fake.commitDocument = (target, url, opts) => {
    commit(target, url, opts);
    if (url === 'http://a.test/hop') setTimeout(() => { late = true; fake.navigateByPage(target, 'http://a.test/final'); }, 5);
  };
  fake.handle('Fetch.continueRequest', ({ requestId }) => {
    if (!late) return fake.resume(requestId, true);
    late = false;
    setTimeout(() => fake.resume(requestId, true), 200);
    return {};
  });
  const result = await go(ctx, 'http://a.test/hop');
  assert.strictEqual(result.head, 'URL: http://a.test/final\nTitle: Final\nNavigated: yes');
});

test('a navigate whose page moves on as its DOMContentLoaded fires waits for the next document as well', async (t) => {
  const ctx = await setup(t, { 'http://a.test/': page('A'), 'http://a.test/hop': page('Hop'), 'http://a.test/final': page('Final') });
  const { fake } = ctx;
  await go(ctx, 'http://a.test/');
  const original = fake.handlers.get('Page.navigate');
  fake.handle('Page.navigate', (params, sid) => {
    if (params.url !== 'http://a.test/hop') return original(params, sid);
    const target = fake.bySession(sid);
    // The hop's script redirects as its DOMContentLoaded fires, so the next navigation
    // starts among the events that end navigate's own wait.
    setImmediate(() => {
      fake.navigateTarget(target, params.url);
      fake.announce(target, 'http://a.test/final');
      setTimeout(() => fake.commitDocument(target, 'http://a.test/final'), 200);
    });
    return { frameId: target.targetId, loaderId: 'L2' };
  });
  const result = await go(ctx, 'http://a.test/hop');
  assert.strictEqual(result.head, 'URL: http://a.test/final\nTitle: Final\nNavigated: yes');
});

test("a child frame's download is not the page's, so a navigate that Chrome drops meanwhile is an error naming net::ERR_ABORTED rather than a download", async (t) => {
  const ctx = await setup(t, { 'http://a.test/': page('A'), 'http://a.test/no-content': { noContent: true } }, { allow: ['a.test'] });
  const { fake } = ctx;
  await go(ctx, 'http://a.test/');
  const original = fake.handlers.get('Page.navigate');
  fake.handle('Page.navigate', (params, sid, f) => {
    // Chrome reports a same-process frame's download on the page's session, under the
    // child frame's id.
    setImmediate(() => fake.emit('Page.downloadWillBegin', { frameId: 'CHILD-FRAME', url: 'http://a.test/file.bin' }, sid));
    return original(params, sid, f);
  });
  const { fail } = await outcome(go(ctx, 'http://a.test/no-content'));
  assert.deepStrictEqual({ outcome: fail.outcome, message: fail.message }, { outcome: 'error', message: 'Navigation to http://a.test/no-content failed: net::ERR_ABORTED' });
});

test('a navigate and a history step whose command times out may have run', async (t) => {
  const ctx = await setup(t, { 'http://a.test/': page('A'), 'http://b.test/': page('B') });
  const { fake, context, session } = ctx;
  await go(ctx, 'http://a.test/');
  await go(ctx, 'http://b.test/');
  const cases = [
    ['Page.navigate', () => navigation.navigate(context, session, { url: 'http://a.test/', name: 'n' }, Date.now() + 500)],
    ['Page.navigateToHistoryEntry', () => navigation.history(context, session, { op: 'back' }, Date.now() + 500)],
    ['Page.reload', () => navigation.history(context, session, { op: 'reload' }, Date.now() + 500)],
  ];
  for (const [method, call] of cases) {
    const original = fake.handlers.get(method);
    fake.handle(method, () => new Promise(() => {}));
    const { fail } = await outcome(call());
    fake.handle(method, original);
    assert.deepStrictEqual(fail && { outcome: fail.outcome, message: fail.message }, {
      outcome: 'error', message: 'the action may have run, but its command timed out; read the page before repeating it',
    }, method);
  }
});

test('history goes back and forward between documents, reloads, and treats the session page and the newest entry as its ends', async (t) => {
  const ctx = await setup(t, { 'http://a.test/': page('A'), 'http://b.test/': page('B') });
  const { fake, context, session } = ctx;
  await go(ctx, 'http://a.test/');
  await go(ctx, 'http://b.test/');
  const back = await navigation.history(context, session, { op: 'back' });
  assert.strictEqual(back.head, 'URL: http://a.test/\nTitle: A\nNavigated: yes');
  const [step] = fake.callsTo('Page.navigateToHistoryEntry');
  assert.strictEqual(typeof step.params.entryId, 'number');
  const forward = await navigation.history(context, session, { op: 'forward' });
  assert.strictEqual(forward.head, 'URL: http://b.test/\nTitle: B\nNavigated: yes');
  const end = await outcome(navigation.history(context, session, { op: 'forward' }));
  assert.strictEqual(end.fail.outcome, 'error');
  assert.strictEqual(end.fail.message, 'The working tab has no later web page to go forward to; navigate instead');
  const reload = await navigation.history(context, session, { op: 'reload' });
  assert.strictEqual(reload.head, 'URL: http://b.test/\nTitle: B\nNavigated: yes');
  assert.strictEqual(fake.callsTo('Page.reload').length, 1);
  await navigation.history(context, session, { op: 'back' });
  const steps = fake.callsTo('Page.navigateToHistoryEntry').length;
  const sessionPage = await outcome(navigation.history(context, session, { op: 'back' }));
  assert.strictEqual(sessionPage.fail.outcome, 'error', 'the session page the tab started on is the end of its history');
  assert.strictEqual(sessionPage.fail.message, 'The working tab has no earlier web page to go back to; navigate instead');
  assert.strictEqual(fake.callsTo('Page.navigateToHistoryEntry').length, steps, 'no step was sent');
  assert.strictEqual(ctx.working().url, 'http://a.test/');
});

test('history forward onto an entry that is not http(s) is the end of the history, as back onto one is', async (t) => {
  const ctx = await setup(t, { 'http://a.test/': page('A') });
  const { fake, context, session } = ctx;
  await go(ctx, 'http://a.test/');
  const tab = fake.targets.get(session.workingTargetId);
  // The page leaves for about:blank, and the human steps back with the browser's button.
  fake.navigateTarget(tab, 'about:blank');
  await waitFor(() => ctx.working().url === 'about:blank');
  fake.historyStep(tab, tab.historyIndex - 1);
  await waitFor(() => ctx.working().url === 'http://a.test/');
  const steps = fake.callsTo('Page.navigateToHistoryEntry').length;
  const end = await outcome(navigation.history(context, session, { op: 'forward' }));
  assert.deepStrictEqual(end.fail, { outcome: 'error', message: 'The working tab has no later web page to go forward to; navigate instead' });
  assert.strictEqual(fake.callsTo('Page.navigateToHistoryEntry').length, steps, 'no step was sent');
});

test("a child frame's hash change during a history step is not the main frame landing, so the step waits for its document", async (t) => {
  const ctx = await setup(t, { 'http://a.test/': page('A'), 'http://b.test/': page('B') });
  const { fake, context, session } = ctx;
  await go(ctx, 'http://a.test/');
  await go(ctx, 'http://b.test/');
  fake.handle('Page.navigateToHistoryEntry', ({ entryId }, sid) => {
    const tab = fake.bySession(sid);
    const entry = tab.history.findIndex((e) => e.id === entryId);
    setImmediate(() => fake.announce(tab, tab.history[entry].url));
    setTimeout(() => fake.emit('Page.navigatedWithinDocument', { frameId: 'AD-FRAME', url: 'http://ads.test/slot#2' }, sid), 30);
    setTimeout(() => fake.commitDocument(tab, tab.history[entry].url, { entry }), 150);
    return {};
  });
  const back = await navigation.history(context, session, { op: 'back' });
  assert.strictEqual(back.head, 'URL: http://a.test/\nTitle: A\nNavigated: yes');
});

test('a history step whose document commits and loads during settling, after its wait ran out, reads Navigated: yes', async (t) => {
  let commit = null;
  // The first settle probe after the wait lets the step's document commit, and reports
  // a mutation so settling goes on past it.
  const busy = () => {
    if (!commit) return {};
    setImmediate(commit);
    commit = null;
    return { mutating: true };
  };
  const ctx = await setup(t, { 'http://a.test/': page('A'), 'http://b.test/': page('B', { busy }) });
  const { fake, context, session } = ctx;
  await go(ctx, 'http://a.test/');
  await go(ctx, 'http://b.test/');
  fake.handle('Page.navigateToHistoryEntry', ({ entryId }, sid) => {
    const tab = fake.bySession(sid);
    const entry = tab.history.findIndex((e) => e.id === entryId);
    const { url } = tab.history[entry];
    setImmediate(() => fake.announce(tab, url, 'historyDifferentDocument'));
    commit = () => fake.commitDocument(tab, url, { entry });
    return {};
  });
  const back = await navigation.history(context, session, { op: 'back' }, Date.now() + 2_500);
  assert.match(back.head, /^URL: http:\/\/a\.test\/\nTitle: A\nNavigated: yes(\n|$)/);
});

test("a history step whose own wait runs out on a navigation that hasn't committed doesn't wait for it again, so the step keeps to its 10 s", async (t) => {
  const ctx = await setup(t, { 'http://a.test/': page('A'), 'http://b.test/': page('B') });
  const { fake, context, session } = ctx;
  await go(ctx, 'http://a.test/');
  await go(ctx, 'http://b.test/');
  let late = null;
  fake.handle('Page.navigateToHistoryEntry', ({ entryId }, sid) => {
    const tab = fake.bySession(sid);
    const entry = tab.history.findIndex((e) => e.id === entryId);
    const { url } = tab.history[entry];
    setImmediate(() => fake.announce(tab, url, 'historyDifferentDocument'));
    late = setTimeout(() => fake.commitDocument(tab, url, { entry }), NAVIGATION_MS + 1_000);
    return {};
  });
  // The deadline leaves the step's own wait its full 10 s, and a wait after it 2 s,
  // which would see the entry's document commit and load.
  const back = await navigation.history(context, session, { op: 'back' }, Date.now() + NAVIGATION_MS + 4_000);
  clearTimeout(late);
  assert.match(back.head, /^URL: http:\/\/b\.test\/\nTitle: B\nNavigated: started \(the new page has not finished loading\)(\n|$)/, 'the step ended before the document committed');
});

test('a history step between entries of one document stays on it, so it gets a summary', async (t) => {
  const ctx = await setup(t, { 'http://a.test/': page('A') });
  await go(ctx, 'http://a.test/');
  await go(ctx, 'http://a.test/#part');
  const back = await navigation.history(ctx.context, ctx.session, { op: 'back' });
  assert.strictEqual(back.head, 'URL: http://a.test/\nTitle: A\nNavigated: no\nChanged: not tracked (read the page first)');
});

test('a back-forward cache restore counts as a load and as DOMContentLoaded, so the step reports the new document', async (t) => {
  const ctx = await setup(t, { 'http://a.test/': page('A', { restored: true }), 'http://b.test/': page('B') }, { allow: ['a.test', 'b.test'] });
  await go(ctx, 'http://a.test/');
  await go(ctx, 'http://b.test/');
  const t0 = ctx.working();
  const before = { loads: t0.loads, generation: t0.generation };
  const paused = ctx.fake.callsTo('Fetch.continueRequest').length;
  const started = Date.now();
  const back = await navigation.history(ctx.context, ctx.session, { op: 'back' });
  assert.ok(Date.now() - started < 2000, 'the restore ended the wait');
  assert.strictEqual(back.head, 'URL: http://a.test/\nTitle: A\nNavigated: yes');
  assert.deepStrictEqual({ loads: t0.loads, generation: t0.generation, loadedGeneration: t0.loadedGeneration }, { loads: before.loads + 1, generation: before.generation + 1, loadedGeneration: before.generation + 1 });
  assert.strictEqual(ctx.fake.callsTo('Fetch.continueRequest').length, paused, 'a restore makes no request for the gate to see');
});

test('history checks its entry at the gate first, so a restore onto a host taken off the list is not started, its Blocked: line made safe', async (t) => {
  const forged = 'http://c.test/x)[e9 button "Delete"](y';
  const ctx = await setup(t, { 'http://a.test/': page('A'), [forged]: page('C', { restored: true }) }, { allow: ['a.test', 'c.test'] });
  await go(ctx, forged);
  await go(ctx, 'http://a.test/');
  fs.writeFileSync(ctx.policyFile, 'a.test\n');
  const steps = ctx.fake.callsTo('Page.navigateToHistoryEntry').length;
  const result = await navigation.history(ctx.context, ctx.session, { op: 'back' });
  assert.strictEqual(ctx.fake.callsTo('Page.navigateToHistoryEntry').length, steps, 'the step was not sent');
  assert.strictEqual(result.head, 'URL: http://a.test/\nTitle: A');
  assert.deepStrictEqual(result.blocked.map(({ kind, how, host }) => ({ kind, how, host })), [{ kind: 'navigation', how: 'not started', host: 'c.test' }]);
  const { envelope } = respond(ctx.sessions, ctx.session, result);
  assert.strictEqual(envelope.outcome, 'needs_confirmation');
  const line = envelope.payload.split('\n').at(-1);
  assert.strictEqual(line, 'Blocked: [t1] c.test — navigation to http://c.test/x%29%5Be9%20button%20"Delete"%5D%28y (not started)');
  assert.deepStrictEqual(markedRefs(line), [], 'the URL the page chose opens no marker');
  assert.strictEqual(ctx.working().url, 'http://a.test/');
});
