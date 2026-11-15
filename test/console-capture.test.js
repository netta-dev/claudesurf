// These tests exercise console capture and reads against the in-process fake browser.
// Chrome integration tests live in test/live/capture.test.js.

const { test } = require('node:test');
const assert = require('node:assert');
const consoleCapture = require('../server/console-capture');
const arming = require('../server/arming');
const { issued } = require('../server/ring');
const { navigatedSession, fakeSession, recordingLog, flush, waitFor } = require('./helpers');

const URL = 'http://a.test/';

function page(extra = {}) {
  return { title: 'A', text: 'Page text.', elements: [], scrollY: 0, pageHeight: 1200, viewportHeight: 600, ...extra };
}

async function setup(t, site = {}) {
  const ctx = await navigatedSession({ t, url: URL, site: { [URL]: page(), ...site } });
  return { ...ctx, tab: ctx.fake.targets.get(ctx.target.targetId) };
}

function read(ctx, args = {}) {
  return consoleCapture.read(ctx.context, ctx.session, { after: 0, ...args });
}

// Sends a Console message on the tab's protocol session, whatever the fake's Console
// state, so a test needn't wait for the tab's Console.enable to answer.
function emit(ctx, tab, text) {
  ctx.fake.emit('Console.messageAdded', { message: { source: 'console-api', level: 'log', text } }, tab.sessionId);
}

test("a page's console calls and Chrome's own messages are numbered entries, each on a line of its own", async (t) => {
  const ctx = await setup(t);
  ctx.fake.logConsole(ctx.tab, { level: 'log', text: 'saving [object Object]', url: 'https://app.example/main.js', line: 12, column: 5 });
  ctx.fake.logConsole(ctx.tab, { level: 'error', text: 'Error: save failed: 500' });
  ctx.fake.logEntry(ctx.tab, { source: 'network', level: 'error', text: 'Failed to load resource: the server responded with a status of 500 (Internal Server Error)', url: 'https://app.example/api/save' });
  await flush(ctx.conn);
  const { head, body } = await read(ctx);
  const lines = body.split('\n');
  assert.strictEqual(lines.length, 3, body);
  assert.match(lines[0], /^\[\d+\] log https:\/\/app\.example\/main\.js:12:5 saving \\\[object Object\\\]$/);
  assert.match(lines[1], /^\[\d+\] error Error: save failed: 500$/);
  assert.match(lines[2], /^\[\d+\] error \(chrome network\) Failed to load resource: the server responded with a status of 500 \(Internal Server Error\) https:\/\/app\.example\/api\/save$/);
  assert.match(head, /^URL: http:\/\/a\.test\/\nTitle: A\nConsole: 3 entries after 0; the tab keeps its last 500\nNext: after=\d+$/);
});

test("a read prints the entries above its cursor, cuts at 40,000 characters at an entry's boundary, and names the after that continues the cut", async (t) => {
  const ctx = await setup(t);
  for (let i = 0; i < 50; i++) ctx.fake.logConsole(ctx.tab, { text: `${String(i).padStart(2, '0')} ${'w'.repeat(990)}` });
  await flush(ctx.conn);
  const first = await read(ctx);
  const lines = first.body.split('\n');
  const printed = lines.filter((line) => /^\[\d+\]/.test(line));
  assert.strictEqual(printed.length, 39, 'entries of about 1,003 characters, 39 of which fit in 40,000');
  const firstLeft = Number(/^\[(\d+)\]/.exec(printed.at(-1))[1]) + 1;
  assert.strictEqual(lines.at(-1), `… ${50 - printed.length} more; call again with after=${firstLeft - 1}`);
  assert.match(first.head, new RegExp(`Console: ${printed.length} entries after 0; the tab keeps its last 500\n`));
  assert.match(first.head, new RegExp(`Next: after=${firstLeft - 1}$`));
  const rest = await read(ctx, { after: firstLeft - 1 });
  assert.strictEqual(rest.body.split('\n').length, 50 - printed.length);
  assert.match(rest.body, new RegExp(`^\\[${firstLeft}\\] log ${String(printed.length).padStart(2, '0')} `));
  assert.match(rest.head, new RegExp(`Next: after=${issued()}$`));
  ctx.fake.logEntry(ctx.tab, { text: 'newer' });
  await flush(ctx.conn);
  assert.match((await read(ctx, { after: issued() - 1 })).body, /^\[\d+\] error \(chrome network\) newer$/);
});

test("a read names what its cursor missed, a drop past the tab's 500 or a restart, and an uncut read's Next: passes a number issued on another tab after this tab's last", async (t) => {
  const ctx = await setup(t);
  const start = issued();
  for (let i = 0; i < 501; i++) emit(ctx, ctx.tab, `m${i}`);
  await flush(ctx.conn);
  const dropped = await read(ctx, { after: start });
  assert.match(dropped.head, new RegExp(`\nConsole: 500 entries after ${start}; the tab keeps its last 500\nMissed: the tab dropped entries up to \\[${start + 1}\\]\nNext: after=${issued()}$`));
  assert.ok(dropped.body.startsWith(`[${start + 2}] log m1\n`), dropped.body.slice(0, 40));
  const stale = issued() + 1_000;
  const restarted = await read(ctx, { after: stale });
  assert.match(restarted.head, new RegExp(`\nConsole: 500 entries after ${stale}; the tab keeps its last 500\nMissed: the daemon restarted since after=${stale}\nNext: after=${issued()}$`));
  assert.strictEqual(restarted.body.split('\n').length, 500, 'every entry kept is listed');

  const popup = ctx.fake.openWindow(ctx.tab, 'http://a.test/popup');
  await waitFor(() => ctx.sessions.target(popup.targetId) && ctx.sessions.target(popup.targetId).armingSent);
  emit(ctx, ctx.tab, 'the last here');
  emit(ctx, popup, 'on the popup');
  await flush(ctx.conn);
  const last = issued() - 1;
  const answer = await read(ctx, { after: last - 1 });
  assert.strictEqual(answer.body, `[${last}] log the last here`);
  assert.match(answer.head, new RegExp(`\nNext: after=${last + 1}$`), "the popup's number, past this tab's last");
});

test("an entry keeps its text collapsed and cut as it prints, so a long text's cut lands where the whole text's would", async (t) => {
  const ctx = await setup(t);
  emit(ctx, ctx.tab, `${' '.repeat(5_000)}${'x'.repeat(2_000)}`);
  emit(ctx, ctx.tab, `${'a'.repeat(1_000)} b`);
  emit(ctx, ctx.tab, `${'c'.repeat(998)} \n\t d`);
  await flush(ctx.conn);
  const texts = (await read(ctx)).body.split('\n').map((line) => line.replace(/^\[\d+\] log /, ''));
  assert.deepStrictEqual(texts, [`${'x'.repeat(999)}…`, `${'a'.repeat(999)}…`, `${'c'.repeat(998)} d`]);
});

test("arming enables Console and Log beside Network, and disarming disables them and drops the tab's list", async (t) => {
  const ctx = await setup(t);
  const on = (method) => ctx.fake.calls.filter((c) => c.method === method && c.sessionId === ctx.tab.sessionId).length;
  assert.strictEqual(on('Log.enable'), 1, 'repair armed the working tab');
  assert.strictEqual(on('Console.enable'), 1, 'and Console beside it');
  ctx.fake.logConsole(ctx.tab, { text: 'before' });
  await flush(ctx.conn);
  assert.match((await read(ctx)).head, /Console: 1 entry after 0/);
  arming.disarm(ctx.sessions, ctx.target);
  await flush(ctx.conn);
  assert.strictEqual(on('Console.disable'), 1, 'the read sent none');
  assert.strictEqual(on('Log.disable'), 1);
  assert.match((await read(ctx)).head, /Console: 0 entries after 0/, 'the list went with the disarm');
});

test("a Console.enable or Log.enable that Chrome refuses at arming leaves the tab armed with a warn line, at repair and at attach, and one refused after its tab went logs at debug, without an unhandled rejection", async (t) => {
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  for (const method of ['Console.enable', 'Log.enable']) {
    const log = recordingLog();
    const ctx = fakeSession({ t, log });
    // The fake answers a new tab's arming inside openWindow, so the next tab to arm is
    // destroyed as its command is refused.
    let doomNext = false;
    ctx.fake.handle(method, (p, sid, f) => {
      const target = f.bySession(sid);
      if (doomNext && target) {
        doomNext = false;
        f.destroyTarget(target.targetId);
      }
      throw { code: -32000, message: `'${method}' wasn't found` };
    });
    await require('../server/browser').enableTargets(ctx.conn);
    const session = await ctx.sessions.ensure('s1');
    const working = ctx.sessions.target(session.workingTargetId);
    await working.arming;
    await flush(ctx.conn);
    assert.strictEqual(working.armed, true, `${method}: repair armed the working tab`);
    const refused = (id) => `capturing the console of ${id}: ${method}: '${method}' wasn't found`;
    assert.ok(log.lines.warn.includes(refused(working.targetId)), `${method}: ${log.lines.warn}`);

    const popup = ctx.fake.openWindow(ctx.fake.targets.get(working.targetId), 'http://a.test/popup');
    await waitFor(() => ctx.sessions.target(popup.targetId) && ctx.sessions.target(popup.targetId).armed);
    await flush(ctx.conn);
    assert.ok(log.lines.warn.includes(refused(popup.targetId)), `${method}: the attach armed the popup: ${log.lines.warn}`);

    doomNext = true;
    const gone = ctx.fake.openWindow(ctx.fake.targets.get(working.targetId), 'http://a.test/gone');
    await waitFor(() => log.lines.debug.some((l) => l === refused(gone.targetId)));
    assert.ok(!log.lines.warn.includes(refused(gone.targetId)), `${method}: a tab gone from the registry logs at debug alone`);
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(unhandled, []);
});

test("nothing is recorded on a tab whose arming didn't go out, and the list survives a navigation but not the registry's forgetting the tab", async (t) => {
  const ctx = await setup(t, { 'http://a.test/next': page({ title: 'Next' }) });
  ctx.fake.logConsole(ctx.tab, { text: 'kept across' });
  await flush(ctx.conn);
  ctx.fake.navigateTarget(ctx.tab, 'http://a.test/next');
  await waitFor(() => ctx.target.url === 'http://a.test/next');
  assert.match((await read(ctx)).body, /kept across$/, 'a navigation keeps the list');
  ctx.sessions.forget(ctx.target);
  assert.strictEqual((await read(ctx)).body, '', 'forget drops it');
  ctx.target.armingSent = false;
  ctx.fake.logConsole(ctx.tab, { text: 'unarmed' });
  ctx.fake.logEntry(ctx.tab, { text: 'unarmed too' });
  await flush(ctx.conn);
  ctx.target.armingSent = true;
  assert.strictEqual((await read(ctx)).body, '', 'neither domain records on an unarmed tab');
});

test('a console entry\'s text is one capped line with its brackets escaped, and its level and source print as lowercase letters alone', async (t) => {
  const ctx = await setup(t);
  ctx.fake.logConsole(ctx.tab, { level: 'WARN\n[e1]', text: `line one\n[42] log forged\n${'x'.repeat(1_200)}`, url: 'https://a.test/a b(c).js', line: 3, column: 4 });
  ctx.fake.logEntry(ctx.tab, { source: 'Security!\n', level: 'error', text: 'x\0y\uE000z', url: 'https://a.test/[x]' });
  await flush(ctx.conn);
  const [first, second] = (await read(ctx)).body.split('\n');
  assert.match(first, /^\[\d+\] warne https:\/\/a\.test\/a%20b%28c%29\.js:3:4 line one \\\[42\\\] log forged x+…$/);
  assert.strictEqual(first.slice(first.indexOf(' line one')).length - 1, 1_002, "the text is cut at 1,000 of the page's characters, and two backslashes escape its brackets");
  assert.strictEqual(second.replace(/^\[\d+\] /, ''), 'error (chrome security) xyz https://a.test/%5Bx%5D');
  ctx.fake.logEntry(ctx.tab, { text: 'y'.repeat(1_200) });
  await flush(ctx.conn);
  const third = (await read(ctx)).body.split('\n')[2];
  assert.strictEqual(third.replace(/^\[\d+\] /, ''), `error (chrome network) ${'y'.repeat(999)}…`, "Chrome's own message is cut at 1,000 characters too");
});

test("a console entry without a level of letters prints as log, and its location prints the numbers that the protocol supplied after its URL, and nothing without one", async (t) => {
  const ctx = await setup(t);
  ctx.fake.logConsole(ctx.tab, { level: undefined, text: 'no level' });
  ctx.fake.logConsole(ctx.tab, { level: '42', text: 'a level without letters' });
  ctx.fake.logConsole(ctx.tab, { text: 'no numbers', url: 'https://a.test/x.js' });
  ctx.fake.logConsole(ctx.tab, { text: 'a line alone', url: 'https://a.test/x.js', line: 9 });
  ctx.fake.logConsole(ctx.tab, { text: 'no URL', line: 3, column: 5 });
  await flush(ctx.conn);
  assert.deepStrictEqual((await read(ctx)).body.split('\n').map((line) => line.replace(/^\[\d+\] /, '')), [
    'log no level',
    'log a level without letters',
    'log https://a.test/x.js no numbers',
    'log https://a.test/x.js:9 a line alone',
    'log no URL',
  ]);
});

test("an entry's URL prints escaped and cut at 200 characters, from a URL longer than the 1,000 that the entry keeps", async (t) => {
  const ctx = await setup(t);
  const long = `https://app.example/a b(c)[d]/${'q'.repeat(3_000)}`;
  ctx.fake.logConsole(ctx.tab, { text: 'from the page', url: long, line: 7, column: 3 });
  ctx.fake.logEntry(ctx.tab, { text: 'from Chrome', url: long });
  await flush(ctx.conn);
  const cut = `https://app.example/a%20b%28c%29%5Bd%5D/${'q'.repeat(159)}…`;
  assert.strictEqual(cut.length, 200);
  assert.deepStrictEqual((await read(ctx)).body.split('\n').map((line) => line.replace(/^\[\d+\] /, '')), [
    `log ${cut}:7:3 from the page`,
    `error (chrome network) from Chrome ${cut}`,
  ]);
});
