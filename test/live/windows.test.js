// Headful window behaviour, gated by CLAUDESURF_LIVE_HEADFUL=1: which tab is active,
// tab grouping, and which operations raise the session window (creation, a click that
// opens a tab, a trusted click). The active X window and its title are read with
// xdotool; the focus assertions skip without it. The window title names the active
// tab, which tells the working tab from the identity tab.

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const read = require('../../server/read');
const input = require('../../server/input');
const { liveBinary, liveBrowser, refsIn, sleep } = require('../helpers');
const { serve } = require('../fixtures/serve');

const skip = !process.env.CLAUDESURF_LIVE_HEADFUL ? 'set CLAUDESURF_LIVE_HEADFUL=1 to run'
  : !liveBinary() ? 'no Chrome binary found'
    : !(process.env.DISPLAY || process.env.WAYLAND_DISPLAY) ? 'no display' : false;

function xdotool(...args) {
  try { return execFileSync('xdotool', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}
const activeWindow = () => xdotool('getactivewindow');
const windowName = (id) => xdotool('getwindowname', id);
const activate = (id) => { xdotool('windowactivate', '--sync', id); };

test('the working tab is the active tab, the identity tab joins its window, and only creation, tab-opening clicks, and trusted clicks raise', { skip }, async () => {
  const live = await liveBrowser({ headless: false });
  const site = await serve();
  const before = activeWindow();
  try {
    const sessions = live.sessions;
    const session = await sessions.ensure('live-window');
    await sleep(500);
    const working = sessions.target(session.workingTargetId);
    const identity = sessions.target(session.identityTargetId);
    assert.strictEqual(identity.windowId, working.windowId, 'identity tab joined the working tab\'s window');
    const chromeWindow = activeWindow();
    if (before === null) return; // xdotool absent: the grouping assertion above is all we can check
    assert.notStrictEqual(chromeWindow, before, 'window creation raised the session window');

    await input.navigate(sessions, session, { url: `${site.base}/actions.html`, name: 'window test' });
    await sleep(300);
    assert.match(windowName(chromeWindow), /^Actions fixture/, 'the working tab is the window\'s active tab');

    activate(before);
    await sleep(300);
    assert.strictEqual(activeWindow(), before, 'parked the desktop focus on the previous window');
    const { payload } = await read.readPage(sessions, session, { maxChars: 40000, offset: 0, hidden: false });
    const refs = refsIn(payload);
    const started = Date.now();
    await input.click(sessions, session, refs['Handler button'], {});
    assert.ok(Date.now() - started < 3000, 'a scripted click into a background window does not stall');
    await input.scroll(sessions, session, 'down', 100, {});
    await read.screenshot(sessions, session, { fullPage: false });
    await input.navigate(sessions, session, { url: `${site.base}/actions.html`, name: 'window test' });
    await sleep(300);
    assert.strictEqual(activeWindow(), before, 'navigate, scripted click, scroll, and screenshot left the active window alone');
    assert.match(windowName(chromeWindow), /^Actions fixture/, 'the working tab stayed active');

    const again = refsIn((await read.readPage(sessions, session, { maxChars: 40000, offset: 0, hidden: false })).payload);
    const r = await input.click(sessions, session, again['New tab link'], {});
    assert.match(r.payload, /Opened: a new tab/);
    await sleep(500);
    assert.strictEqual(activeWindow(), chromeWindow, 'a click that opens a tab raises the session window');
    for (const id of session.opened) await live.conn.send('Target.closeTarget', { targetId: id });

    activate(before);
    await sleep(300);
    assert.strictEqual(activeWindow(), before, 'parked the desktop focus again');
    await input.click(sessions, session, again['Handler button'], { trusted: true });
    await sleep(500);
    assert.strictEqual(activeWindow(), chromeWindow, 'a trusted click brings the session window to the front');
  } finally {
    site.close();
    await live.close();
    if (before !== null) activate(before);
  }
});
