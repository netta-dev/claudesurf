// These tests exercise handoff.js through a fake Notifier and through Notifier with
// recording desktop tools, without Chrome; Chrome integration tests live in
// test/live/challenge.test.js, and daemon integration tests live in test/daemon.test.js.

const { test } = require('node:test');
const assert = require('node:assert');
const { Handoff } = require('../server/handoff');
const { Notifier } = require('../server/notify');
const { recordingLog, fakeTools, waitFor, sleep } = require('./helpers');

const SIGN_IN = { type: 'sign-in', signal: 'a password field', title: 'Sign in · App', clears: false };

function fakeNotifier({ window = '77', search = null, marking = null } = {}) {
  const calls = [];
  return {
    calls,
    notified: () => calls.filter(([kind]) => kind === 'notify').map(([, n]) => n),
    marks: () => calls.filter(([kind]) => kind === 'mark').map(([, id, on]) => [id, on]),
    notify: async (n) => { calls.push(['notify', n]); return true; },
    findWindow: (q) => { calls.push(['find', q]); return search ? search(q) : Promise.resolve(window); },
    mark: (id, on) => { calls.push(['mark', id, on]); return marking ? marking(id, on) : Promise.resolve(true); },
  };
}

function session(id = 's1', name = 'reviewing PR #42') {
  return { id, name };
}

function handoffOver(notifier, { pid = 4242 } = {}) {
  return new Handoff({ notifier, browserPid: () => pid, log: recordingLog() });
}

test('opened notifies once per session, type, and URL origin and path in 10 minutes, whatever the query, and again after', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const notifier = fakeNotifier();
  const handoff = handoffOver(notifier);
  const s1 = session();
  handoff.opened(s1, SIGN_IN, 'https://app.example/login?state=1');
  handoff.closed(s1.id);
  handoff.opened(s1, SIGN_IN, 'https://app.example/login?state=2&nonce=x#y');
  assert.strictEqual(notifier.notified().length, 1, 'a retry that varies its query is the same URL');
  handoff.opened(s1, { ...SIGN_IN, type: 'two-factor' }, 'https://app.example/login');
  handoff.opened(s1, SIGN_IN, 'https://app.example/other');
  handoff.opened(session('s2'), SIGN_IN, 'https://app.example/login');
  assert.strictEqual(notifier.notified().length, 4, 'another type, path, or session notifies');
  t.mock.timers.tick(10 * 60_000 - 1);
  handoff.opened(s1, SIGN_IN, 'https://app.example/login');
  assert.strictEqual(notifier.notified().length, 4);
  t.mock.timers.tick(1);
  handoff.opened(s1, SIGN_IN, 'https://app.example/login');
  assert.strictEqual(notifier.notified().length, 5, 'again once 10 minutes have passed');
});

test("the texts name the session's label, quoted and cut, or an unnamed session, and the host alone, never the page's title", () => {
  const notifier = fakeNotifier();
  const handoff = handoffOver(notifier);
  handoff.opened(session('s1', 'reviewing\nPR   #42'), SIGN_IN, 'https://App.Example/login?next=%2F');
  handoff.opened(session('s2', null), { ...SIGN_IN, type: 'bot check' }, 'https://cf.example/');
  handoff.opened(session('s3', 'x'.repeat(70)), { ...SIGN_IN, type: 'two-factor' }, `https://${'h'.repeat(90)}.example/`);
  assert.deepStrictEqual(notifier.notified(), [
    { summary: 'ClaudeSurf: "reviewing PR #42" needs you', body: "A sign-in on app.example is waiting in that session's window.", urgency: 'critical' },
    { summary: 'ClaudeSurf: an unnamed session needs you', body: "A bot check on cf.example is waiting in that session's window.", urgency: 'critical' },
    { summary: `ClaudeSurf: "${'x'.repeat(59)}…" needs you`, body: `A two-factor code on ${'h'.repeat(79)}… is waiting in that session's window.`, urgency: 'critical' },
  ]);
  for (const { summary, body } of notifier.notified()) assert.ok(!summary.includes('Sign in · App') && !body.includes('Sign in · App'));
  handoff.opened(session('s4', `${'x'.repeat(58)}😀${'y'.repeat(10)}`), SIGN_IN, 'https://app.example/');
  assert.strictEqual(notifier.notified().at(-1).summary, `ClaudeSurf: "${'x'.repeat(58)}…" needs you`, 'a cut steps back past a surrogate pair rather than split it');
  handoff.opened(session('s5', 'a\u0000b\u001b[31mc\u007f d\u0085e\u202ef\u2066g'), SIGN_IN, 'https://app.example/');
  assert.strictEqual(notifier.notified().at(-1).summary, 'ClaudeSurf: "a b [31mc d e f g" needs you', 'C0 and C1 controls and bidi overrides collapse like whitespace');
  handoff.opened(session('s6', 'pair \u{1F469}\u200D\u{1F4BB}'), SIGN_IN, 'https://app.example/');
  assert.strictEqual(notifier.notified().at(-1).summary, 'ClaudeSurf: "pair \u{1F469}\u200D\u{1F4BB}" needs you', 'a zero-width joiner stays');
  handoff.refused(session('s1', 'reviewing PR #42'), { host: 'idp.example' });
  assert.deepStrictEqual(notifier.notified().at(-1), {
    summary: 'ClaudeSurf stopped idp.example',
    body: 'In "reviewing PR #42". Sign in from a tab you open yourself (Ctrl+T), which shares the cookies, or ask Claude to allow idp.example.',
    urgency: 'normal',
  });
});

test('a refusal notifies while the handoff is open, once per host and three times at most per session in 10 minutes across handoffs, and not after it closes', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const notifier = fakeNotifier();
  const handoff = handoffOver(notifier);
  const s1 = session();
  handoff.refused(s1, { host: 'a.example' });
  assert.strictEqual(notifier.notified().length, 0, 'no handoff, no notice');
  handoff.opened(s1, SIGN_IN, 'https://app.example/login');
  const notices = () => notifier.notified().filter((n) => n.summary.startsWith('ClaudeSurf stopped')).map((n) => n.summary.slice('ClaudeSurf stopped '.length));
  handoff.refused(s1, { host: 'a.example' });
  handoff.refused(s1, { host: 'a.example' });
  handoff.refused(s1, { host: 'b.example' });
  assert.deepStrictEqual(notices(), ['a.example', 'b.example'], 'once per host');
  handoff.closed(s1.id);
  handoff.refused(s1, { host: 'c.example' });
  assert.deepStrictEqual(notices(), ['a.example', 'b.example'], 'not after the handoff closed');
  handoff.opened(s1, SIGN_IN, 'https://app.example/login');
  handoff.refused(s1, { host: 'a.example' });
  handoff.refused(s1, { host: 'c.example' });
  handoff.refused(s1, { host: 'd.example' });
  assert.deepStrictEqual(notices(), ['a.example', 'b.example', 'c.example'], 'three at most per session across handoffs');
  handoff.opened(session('s2'), SIGN_IN, 'https://app.example/login');
  handoff.refused(session('s2'), { host: 'a.example' });
  assert.deepStrictEqual(notices().at(-1), 'a.example', "another session's limit is its own");
  t.mock.timers.tick(10 * 60_000);
  handoff.refused(s1, { host: 'd.example' });
  assert.deepStrictEqual(notices().at(-1), 'd.example', 'the limit lasts 10 minutes');
});

// Only the handoff's maps can show a leak, so this test reads them.
test("a session's refusal notices and its closed handoff leave no entry behind once 10 minutes have passed", (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const handoff = handoffOver(fakeNotifier());
  const s1 = session();
  handoff.opened(s1, SIGN_IN, 'https://app.example/login');
  handoff.refused(s1, { host: 'a.example' });
  handoff.closed(s1.id);
  assert.deepStrictEqual([handoff.open.has(s1.id), handoff.notices.has(s1.id)], [false, true], 'the notice counts toward later handoffs');
  t.mock.timers.tick(10 * 60_000);
  handoff.opened(session('s2'), SIGN_IN, 'https://app.example/login');
  assert.strictEqual(handoff.notices.has(s1.id), false, 'pruned as another session opens a handoff');
  handoff.refused(session('s2'), { host: 'b.example' });
  t.mock.timers.tick(10 * 60_000);
  handoff.refused(session('s2'), { host: 'c.example' });
  assert.deepStrictEqual(handoff.notices.get('s2').map((n) => n.host), ['c.example'], 'and as a refusal prunes it');
});

test('the mark is set on the window that findWindow finds for the browser and the page title, and cleared when the handoff closes', async () => {
  const notifier = fakeNotifier({ window: '77' });
  const handoff = handoffOver(notifier, { pid: 4242 });
  handoff.opened(session(), SIGN_IN, 'https://app.example/login');
  await waitFor(() => notifier.marks().length === 1);
  assert.deepStrictEqual(notifier.calls.find(([kind]) => kind === 'find')[1], { pid: 4242, title: 'Sign in · App' });
  handoff.closed('s1');
  await waitFor(() => notifier.marks().length === 2);
  assert.deepStrictEqual(notifier.marks(), [['77', true], ['77', false]]);
  handoff.closed('s1');
  await sleep(20);
  assert.strictEqual(notifier.marks().length, 2, 'a second close has nothing to clear');
});

test('a search that finds no window leaves the handoff without a mark to set or clear', async () => {
  const notifier = fakeNotifier({ window: null });
  const handoff = handoffOver(notifier);
  handoff.opened(session(), SIGN_IN, 'https://app.example/login');
  await waitFor(() => notifier.calls.some(([kind]) => kind === 'find'));
  await sleep(20);
  handoff.closed('s1');
  await sleep(20);
  assert.deepStrictEqual(notifier.marks(), []);
});

test('a close during the window search leaves the window unmarked, and a clear waits for a set that began before it', async () => {
  let found;
  const searching = fakeNotifier({ search: () => new Promise((resolve) => { found = resolve; }) });
  const handoff = handoffOver(searching);
  handoff.opened(session(), SIGN_IN, 'https://app.example/login');
  await waitFor(() => found);
  handoff.closed('s1');
  found('77');
  await sleep(20);
  assert.deepStrictEqual(searching.marks(), [], 'the handoff closed before the search resolved');

  let release;
  const slow = fakeNotifier({ marking: (id, on) => (on ? new Promise((resolve) => { release = resolve; }) : Promise.resolve(true)) });
  const queued = handoffOver(slow);
  queued.opened(session(), SIGN_IN, 'https://app.example/login');
  await waitFor(() => release);
  queued.closed('s1');
  await sleep(20);
  assert.deepStrictEqual(slow.marks(), [['77', true]], 'the clear waits for the set');
  release(true);
  await waitFor(() => slow.marks().length === 2);
  assert.deepStrictEqual(slow.marks(), [['77', true], ['77', false]]);
});

test("a mark command waits for the window's last one, which a command that ended before it doesn't stand in for", async () => {
  const pending = [];
  const notifier = fakeNotifier({ marking: () => new Promise((resolve) => { pending.push(resolve); }) });
  const handoff = handoffOver(notifier);
  handoff.opened(session(), SIGN_IN, 'https://app.example/login');
  await waitFor(() => pending.length === 1);
  handoff.closed('s1');
  pending[0](true);
  await waitFor(() => pending.length === 2);
  // The set has ended, and the clear queued behind it still runs.
  handoff.opened(session(), SIGN_IN, 'https://app.example/login');
  await sleep(20);
  assert.deepStrictEqual(notifier.marks(), [['77', true], ['77', false]], 'the second set waits for the clear');
  pending[1](true);
  await waitFor(() => notifier.marks().length === 3);
  assert.deepStrictEqual(notifier.marks(), [['77', true], ['77', false], ['77', true]]);
});

test('closing and opening again turns the mark off and on with each call, and without a browser the hint is skipped', async () => {
  const notifier = fakeNotifier();
  const handoff = handoffOver(notifier);
  handoff.opened(session(), SIGN_IN, 'https://app.example/login');
  await waitFor(() => notifier.marks().length === 1);
  handoff.closed('s1');
  handoff.opened(session(), SIGN_IN, 'https://app.example/login');
  await waitFor(() => notifier.marks().length === 3);
  assert.deepStrictEqual(notifier.marks(), [['77', true], ['77', false], ['77', true]]);
  const idle = fakeNotifier();
  const log = recordingLog();
  new Handoff({ notifier: idle, browserPid: () => null, log }).opened(session(), SIGN_IN, 'https://app.example/login');
  await sleep(20);
  assert.deepStrictEqual(idle.calls.filter(([kind]) => kind !== 'notify'), []);
  assert.match(log.lines.info.join('\n'), /urgency hint skipped: the browser is not running/);
});

test('through the real Notifier, the mark is set on the one matching window, and skipped for two matches, none, an empty title, and Wayland', async (t) => {
  const windows = (names) => ({
    xdotool: [{ args: ['search'], stdout: `${names.map((n, i) => 10 + i).join('\n')}\n` }, ...names.map((name, i) => ({ args: ['getwindowname', String(10 + i)], stdout: `${name}\n` }))],
  });
  const run = async (answer, done, { title = SIGN_IN.title, display = ':0' } = {}) => {
    const fakes = fakeTools(t, { answer });
    const log = recordingLog();
    const notifier = new Notifier({ log, env: () => ({ ...fakes.env, DISPLAY: display }) });
    handoffOver(notifier).opened(session(), { ...SIGN_IN, title }, 'https://app.example/login');
    await waitFor(() => done(log, fakes.runs()));
    return fakes.runs().filter((r) => r.tool !== 'notify-send' && r.args[0] !== 'search' && r.args[0] !== 'getwindowname').map((r) => [r.tool, ...r.args]);
  };
  const skipped = (why) => (log) => log.lines.info.includes(`urgency hint skipped: ${why}`);
  assert.deepStrictEqual(await run(windows(['Other - Google Chrome', 'Sign in · App - Google Chrome']), (log, runs) => runs.some((r) => r.tool === 'wmctrl')), [
    ['xdotool', 'set_window', '--urgency', '1', '11'], ['wmctrl', '-i', '-r', '11', '-b', 'add,demands_attention'],
  ], 'one match is marked with both marks');
  assert.deepStrictEqual(await run(windows(['Sign in · App - Google Chrome', 'Sign in · App - Google Chrome']), skipped("2 browser windows carry the page's title")), [], 'two matches');
  assert.deepStrictEqual(await run(windows(['Other - Google Chrome']), skipped("no browser window carries the page's title")), [], 'none');
  assert.deepStrictEqual(await run(windows(['Sign in · App - Google Chrome']), skipped('the page has no title'), { title: '' }), [], 'an untitled page');
  assert.deepStrictEqual(await run(windows(['Sign in · App - Google Chrome']), skipped('the session lacks DISPLAY'), { display: '' }), [], 'Wayland, without DISPLAY');
});
