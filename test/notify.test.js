// These tests exercise notify.js through the recording tools in test/fakes/bin.
// The temporary PATH contains node and the selected fakes; window-manager integration
// tests live in test/live/challenge.test.js.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Notifier, toolEnv } = require('../server/notify');
const { recordingLog, tmpDir, fakeTools } = require('./helpers');

function setup(t, { tools, answer, env = {} } = {}) {
  const fakes = fakeTools(t, { tools, answer });
  const log = recordingLog();
  const toolsEnv = { ...fakes.env, DISPLAY: ':5', ...env };
  const notifier = new Notifier({ log, env: () => toolsEnv });
  return { notifier, runs: fakes.runs, log };
}

test('notify runs notify-send with the app name, the urgency, and -- before the summary, and escapes the body\'s markup', async (t) => {
  const { notifier, runs } = setup(t);
  assert.strictEqual(await notifier.notify({ summary: '--help "x"', body: 'A sign-in on a&b.example <i>now</i>', urgency: 'critical' }), true);
  assert.deepStrictEqual(runs().map((r) => [r.tool, r.args]), [
    ['notify-send', ['--app-name=ClaudeSurf', '--urgency=critical', '--', '--help "x"', 'A sign-in on a&amp;b.example &lt;i&gt;now&lt;/i&gt;']],
  ]);
});

test("an argument that execFile refuses, such as a summary with a NUL, resolves false with a warning instead of rejecting", async (t) => {
  const { notifier, runs, log } = setup(t);
  assert.strictEqual(await notifier.notify({ summary: 'ClaudeSurf: "a\u0000b" needs you', body: 'b', urgency: 'critical' }), false);
  assert.deepStrictEqual(runs(), [], 'nothing ran');
  assert.match(log.lines.warn.join('\n'), /^running notify-send: .*null bytes/m);
});

test('findWindow searches the pid\'s windows, unmapped ones included, and picks the one whose name starts with the title and " - "', async (t) => {
  const answer = {
    xdotool: [
      { args: ['search'], stdout: '11\n22\n33\n' },
      { args: ['getwindowname', '11'], stdout: 'Other - Google Chrome\n' },
      { args: ['getwindowname', '22'], stdout: 'Sign in · App - Google Chrome\n' },
      { args: ['getwindowname', '33'], stdout: 'Sign in · App\n' },
    ],
  };
  const { notifier, runs } = setup(t, { answer });
  assert.strictEqual(await notifier.findWindow({ pid: 4242, title: 'Sign in · App' }), '22');
  assert.deepStrictEqual(runs().map((r) => r.args), [
    ['search', '--pid', '4242'], ['getwindowname', '11'], ['getwindowname', '22'], ['getwindowname', '33'],
  ]);
});

test('findWindow skips the hint, with an info line, for two matches, none, an empty title, and a session without DISPLAY', async (t) => {
  const named = (name) => ({ xdotool: [{ args: ['search'], stdout: '11\n22\n' }, { args: ['getwindowname'], stdout: `${name} - Google Chrome\n` }] });
  const two = setup(t, { answer: named('Sign in') });
  assert.strictEqual(await two.notifier.findWindow({ pid: 1, title: 'Sign in' }), null);
  assert.match(two.log.lines.info.join('\n'), /urgency hint skipped: 2 browser windows carry the page's title/);
  const none = setup(t, { answer: named('Other') });
  assert.strictEqual(await none.notifier.findWindow({ pid: 1, title: 'Sign in' }), null);
  assert.match(none.log.lines.info.join('\n'), /urgency hint skipped: no browser window carries the page's title/);
  const unmatched = setup(t, { answer: { xdotool: [{ args: ['search'], code: 1 }] } });
  assert.strictEqual(await unmatched.notifier.findWindow({ pid: 1, title: 'Sign in' }), null);
  assert.deepStrictEqual(unmatched.log.lines.info, ["urgency hint skipped: no browser window carries the page's title"], 'xdotool search exits 1 when no window matches');
  const failed = setup(t, { answer: { xdotool: [{ args: ['search'], code: 2, stderr: 'XGetWindowProperty failed\n' }] } });
  assert.strictEqual(await failed.notifier.findWindow({ pid: 1, title: 'Sign in' }), null);
  assert.deepStrictEqual(failed.log.lines.info, ['xdotool search: XGetWindowProperty failed', 'urgency hint skipped: xdotool could not search the windows']);
  const noDisplay = setup(t, { answer: { xdotool: [{ args: ['search'], code: 1, stderr: "Error: Can't open display: (null)\nFailed creating new xdo instance\n" }] } });
  assert.strictEqual(await noDisplay.notifier.findWindow({ pid: 1, title: 'Sign in' }), null);
  assert.deepStrictEqual(noDisplay.log.lines.info, ["xdotool search: Error: Can't open display: (null)", 'urgency hint skipped: xdotool could not search the windows'], 'an exit of 1 with stderr is a failure');
  const untitled = setup(t);
  assert.strictEqual(await untitled.notifier.findWindow({ pid: 1, title: '' }), null);
  assert.deepStrictEqual(untitled.runs(), [], 'nothing runs for an untitled page');
  assert.match(untitled.log.lines.info.join('\n'), /urgency hint skipped: the page has no title/);
  const wayland = setup(t, { env: { DISPLAY: '', WAYLAND_DISPLAY: 'wayland-0' } });
  assert.strictEqual(await wayland.notifier.findWindow({ pid: 1, title: 'Sign in' }), null);
  assert.deepStrictEqual(wayland.runs(), [], 'nothing runs under Wayland');
  assert.match(wayland.log.lines.info.join('\n'), /urgency hint skipped: the session lacks DISPLAY/);
});

test('mark sets and clears both marks: the urgency bit through xdotool and demands-attention through wmctrl', async (t) => {
  const { notifier, runs } = setup(t);
  assert.strictEqual(await notifier.mark('22', true), true);
  assert.strictEqual(await notifier.mark('22', false), true);
  assert.deepStrictEqual(runs().map((r) => [r.tool, r.args]), [
    ['xdotool', ['set_window', '--urgency', '1', '22']],
    ['wmctrl', ['-i', '-r', '22', '-b', 'add,demands_attention']],
    ['xdotool', ['set_window', '--urgency', '0', '22']],
    ['wmctrl', ['-i', '-r', '22', '-b', 'remove,demands_attention']],
  ]);
});

test('a missing wmctrl leaves the urgency bit, and a missing binary is logged once at info', async (t) => {
  const { notifier, runs, log } = setup(t, { tools: ['xdotool'] });
  assert.strictEqual(await notifier.mark('22', true), false);
  assert.strictEqual(await notifier.mark('22', false), false);
  assert.deepStrictEqual(runs().map((r) => r.args), [['set_window', '--urgency', '1', '22'], ['set_window', '--urgency', '0', '22']], 'xdotool still ran');
  assert.deepStrictEqual(log.lines.info.filter((l) => /wmctrl is not installed/.test(l)).length, 1);
  assert.strictEqual(await notifier.notify({ summary: 's', body: 'b', urgency: 'normal' }), false, 'notify-send is missing too');
  assert.deepStrictEqual(log.lines.info.filter((l) => /notify-send is not installed/.test(l)).length, 1);
});

test("a failed run logs its first stderr line at info the first time it appears and at debug after", async (t) => {
  const answer = { 'notify-send': [{ args: [], code: 1, stderr: 'GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown: no server\nsecond line\n' }] };
  const { notifier, log } = setup(t, { answer });
  assert.strictEqual(await notifier.notify({ summary: 's', body: 'b', urgency: 'normal' }), false);
  assert.strictEqual(await notifier.notify({ summary: 's', body: 'b', urgency: 'normal' }), false);
  const line = 'notify-send: GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown: no server';
  assert.deepStrictEqual(log.lines.info, [line]);
  assert.deepStrictEqual(log.lines.debug, [line]);
});

test('a tool that hangs is killed after 5 s, and the run resolves false', async (t) => {
  const answer = { 'notify-send': [{ args: [], sleepMs: 30_000 }] };
  const { notifier, log, runs } = setup(t, { answer });
  const started = Date.now();
  assert.strictEqual(await notifier.notify({ summary: 's', body: 'b', urgency: 'normal' }), false);
  const took = Date.now() - started;
  assert.ok(took >= 4_900 && took < 7_000, `killed at 5 s (${took} ms)`);
  assert.deepStrictEqual(log.lines.info, ['notify-send: killed after 5000 ms']);
  assert.deepStrictEqual(runs(), [], 'the run was killed before it answered');
});

test("the tools' environment is the daemon's, plus each graphical variable the daemon lacks from the request, without an XAUTHORITY it can't read", (t) => {
  const dir = tmpDir('claudesurf-xauth');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const readable = path.join(dir, 'auth');
  fs.writeFileSync(readable, '');
  const daemon = { PATH: '/bin', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/daemon-bus', HOME: '/home/z' };
  const request = { DISPLAY: ':1', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/bridge-bus', XAUTHORITY: readable, PATH: '/evil' };
  assert.deepStrictEqual(toolEnv(daemon, request), {
    PATH: '/bin', HOME: '/home/z', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/daemon-bus', DISPLAY: ':1', XAUTHORITY: readable,
  }, "notify-send keeps the daemon's bus while xdotool takes the bridge's DISPLAY");
  assert.deepStrictEqual(toolEnv(daemon, { DISPLAY: ':1', XAUTHORITY: path.join(dir, 'missing') }), { ...daemon, DISPLAY: ':1' });
  assert.deepStrictEqual(toolEnv({ ...daemon, DISPLAY: ':0' }, { DISPLAY: ':1' }).DISPLAY, ':0', "the daemon's own value wins");
  assert.deepStrictEqual(toolEnv({ PATH: '/bin' }, { DISPLAY: '', DBUS_SESSION_BUS_ADDRESS: '' }), { PATH: '/bin' }, "a request's empty value adds nothing, so a tool falls back as it does without one");
});

test('each tool runs under the environment that env() returns at that run, and the window search reads DISPLAY there too', async (t) => {
  const fakes = fakeTools(t, { answer: { xdotool: [{ args: ['search'], stdout: '' }] } });
  let current = { DISPLAY: ':5', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/first' };
  const log = recordingLog();
  const notifier = new Notifier({ log, env: () => ({ ...fakes.env, ...current }) });
  await notifier.notify({ summary: 's', body: 'b', urgency: 'low' });
  current = { DISPLAY: ':6', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/second' };
  await notifier.mark('9', true);
  current = { DISPLAY: '' };
  assert.strictEqual(await notifier.findWindow({ pid: 1, title: 'Sign in' }), null);
  current = { DISPLAY: ':7' };
  await notifier.findWindow({ pid: 1, title: 'Sign in' });
  assert.deepStrictEqual(fakes.runs().map((r) => [r.tool, r.env.DISPLAY, r.env.DBUS_SESSION_BUS_ADDRESS]), [
    ['notify-send', ':5', 'unix:path=/first'],
    ['xdotool', ':6', 'unix:path=/second'],
    ['wmctrl', ':6', 'unix:path=/second'],
    ['xdotool', ':7', undefined],
  ]);
  assert.match(log.lines.info[0], /urgency hint skipped: the session lacks DISPLAY/);
});
