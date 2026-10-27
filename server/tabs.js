// The tabs action over a session's tabs: its working tab, its identity tab, and the
// tabs that its pages opened, each named t<n> by tab-records.js.
//   - list prints one line per tab, the working tab first;
//   - new opens a tab from a session tab in the session's window, navigates it through
//     the domain gate, and makes it the working tab;
//   - switch makes another tab the working tab without activating it, which would
//     raise the window, so input reaches it through focus emulation;
//   - close closes a tab other than the identity tab.
// A switch leaves every ref stale until a read of the new working tab (refs.js).

const crypto = require('crypto');
const envelope = require('./envelope');
const arming = require('./arming');
const tabRecords = require('./tab-records');
const { ConnectionClosedError } = require('./cdp');
const { TargetGoneError } = require('./sessions');
const { beforeAction, finishAction } = require('./act-result');
const { waitForDocument, refusedOwn, NAVIGATION_MS } = require('./navigation-wait');
const { fail, workingTarget, currentStateLines, loadBudget, within, TIMED_OUT, cappedText, cappedUrl } = require('./action-support');
const { precheck, NAVIGATE_LOAD_MS } = require('./navigation');

const NO_TAB = 'no tab opened; call navigate to open the page in the working tab instead';
const NO_OPENER = "no session tab is in the session's window to open from; close the popup or call navigate";
const UNGATED_TAB = 'the new tab could not be put under the domain gate; call again';
const CLOSED_EARLY = 'Tab: the new tab closed before its page loaded; tabs list shows the open tabs';

async function tabs(ctx, session, { op, target }, deadline) {
  if (op === 'list') return list(ctx.sessions, session, deadline);
  if (op === 'new') return open(ctx, session, target, deadline);
  if (op === 'switch') return switchTo(ctx.sessions, session, target, deadline);
  return close(ctx.sessions, session, target, deadline);
}

// Resolves with the session's tab list. Titles and URLs are the pages' to set, so each
// is made safe and capped; a tab that the daemon is closing, or one that the browser no
// longer describes, prints as closing.
async function list(sessions, session, deadline) {
  const listed = await tabRecords.tabs(sessions, session, { deadline });
  const lines = [`Tabs: ${listed.length}`];
  for (const { id, targetId, kind } of listed) {
    if (kind === 'identity') {
      lines.push(`[${id}] identity (the session's label; not a page to work in)`);
      continue;
    }
    const t = sessions.target(targetId);
    const info = t && !t.closing ? await targetInfo(sessions, targetId, { deadline }) : null;
    lines.push(info ? `[${id}] ${kind} "${cappedText(info.title)}" ${cappedUrl(info.url)}` : `[${id}] ${kind} (closing)`);
  }
  return { head: lines.join('\n') };
}

// Opens `url` in a new tab, in this order: the marks, so the tab's number and any
// refusal come after them; the gate's pre-check; window.open from a session tab under
// a user gesture, with a nonce on its about:blank that tells the call's tab from a
// popup that the page opens meanwhile; the tab's arming; its navigation; and the switch.
// The gate closes the new tab when it refuses a redirect hop, and the call then reports
// on the tab that it began on, as it does when the tab closes before its page loaded or the
// daemon is closing it.
async function open({ sessions, gate }, session, url, deadline) {
  const working = workingTarget(sessions, session);
  const opts = { deadline };
  const before = beforeAction(sessions, session, working);
  const refused = await precheck(gate, sessions, session, working, url, 'new tab', opts);
  if (refused) return refused;
  const opener = await openerOf(sessions, session, working, opts);
  if (!opener) fail(envelope.error(NO_OPENER));
  const started = Date.now();
  const found = await opened(sessions, session, opener, before.marks.nextTab, sessions.windowBudget(deadline));
  const { tab, outcomes } = found;
  session.marks.newTab = tab.targetId;
  const failed = outcomes && arming.failure(outcomes);
  if (!outcomes || failed) {
    sessions.log.warn(`tabs new: ${tabRecords.tabId(session, tab.targetId)} could not be put under the domain gate${failed ? `: ${failed.error.message}` : ''}`);
    fail(envelope.error(UNGATED_TAB));
  }

  const from = { generation: tab.generation, navigations: tab.navigations, sameDocument: tab.sameDocument };
  let answer = null;
  try {
    answer = await sessions.send(tab.targetId, 'Page.navigate', { url }, opts);
  } catch (e) {
    if (e instanceof ConnectionClosedError) throw e;
    sessions.log.info(`tabs new: navigating the new tab: ${e.message}`);
  }
  if (refusedOwn(session, tab, before.marks)) return finishAction(sessions, session, working, before, { deadline });
  if (closedEarly(sessions, tab)) return finishAction(sessions, session, working, before, { deadline, lines: [CLOSED_EARLY] });
  tabRecords.switchWorking(sessions, session, tab.targetId);

  // Chrome commits its error page after a network error, and the wait covers it, with an
  // acting call's budget. Chrome doesn't commit after net::ERR_ABORTED, as for a 204, a
  // download, or a URL handed to another application, and its drop of the navigation
  // ends the wait.
  const navigationError = answer && answer.errorText ? `Navigation error: ${cappedText(answer.errorText)}` : null;
  const budget = navigationError ? NAVIGATION_MS : NAVIGATE_LOAD_MS - (Date.now() - started);
  const navigation = await waitForDocument(sessions, tab, from, { timeout: loadBudget(budget, deadline), deadline })
    .catch((e) => { if (e instanceof TargetGoneError) return null; throw e; });
  // A new tab that closes after the switch, before its page loaded, hands the working
  // role back to the tab that the call began on when that tab is still open, and the call
  // reports on that tab, as it does for an earlier close.
  if (!(navigation && navigation.loaded) && closedEarly(sessions, tab) && tabRecords.isLive(sessions, session, working.targetId)) {
    tabRecords.switchWorking(sessions, session, working.targetId);
    return finishAction(sessions, session, working, before, { deadline, lines: [CLOSED_EARLY] });
  }
  const measured = { ...before, ...from, targetId: tab.targetId };
  return finishAction(sessions, session, tab, measured, { deadline, navigation, navigationError });
}

// Returns the session tab to open from: the working tab when it is in the session's
// window, else the most recent earlier working tab there, else the identity tab; a
// popup lacks a tab strip, so a window.open from one would land in whichever window
// was last active.
async function openerOf(sessions, session, working, opts) {
  if (await tabRecords.inSessionWindow(sessions, session, working.targetId, opts)) return working;
  const earlier = await tabRecords.latestIn(sessions, session, opts);
  if (earlier) return sessions.target(earlier);
  return (session.identityTargetId && sessions.target(session.identityTargetId)) || null;
}

// Evaluates the window.open and resolves with { tab, outcomes } for the tab whose URL
// carries the nonce, once it has attached and its arming has settled; the evaluation
// and the wait share `budget`. The waiter is registered first, since the tab can
// attach before the evaluation answers.
async function opened(sessions, session, opener, nextTab, budget) {
  const nonce = crypto.randomBytes(8).toString('hex');
  const identified = identify(sessions, session, opener, `about:blank#${nonce}`, nextTab, budget);
  // The trailing null makes the answer null whatever window.open returns: a window
  // can't be returned by value, so an open that returned one would read as a failure.
  const expression = `window.open(${JSON.stringify(`about:blank#${nonce}`)}, '_blank', 'noopener'), null`;
  // A hung opener doesn't answer, and the tab that it may still open later stays behind.
  try {
    await sessions.withWorld(opener.targetId, null, async (contextId) => {
      const { exceptionDetails } = await sessions.send(opener.targetId, 'Runtime.evaluate', { expression, contextId, userGesture: true, returnByValue: true }, budget);
      if (exceptionDetails) throw new Error(`window.open threw: ${exceptionDetails.text}`);
    }, budget);
  } catch (e) {
    if (e instanceof ConnectionClosedError) throw e;
    sessions.log.info(`tabs new: opening from ${opener.targetId}: ${e.message}`);
    fail(envelope.error(NO_TAB));
  }
  const found = await identified;
  if (!found) fail(envelope.error(NO_TAB));
  return found;
}

// Resolves with { tab, outcomes } for the first tab, of those attributed to `opener`
// and numbered from `nextTab`, whose URL is `url` once its `ready` has resolved; or
// with null when none is within the budget. The attributed tabs are checked
// concurrently, so a page popup held on a slow first request doesn't hold up the
// call's tab. Never rejects.
async function identify(sessions, session, opener, url, nextTab, budget) {
  const checked = new Set();
  let found = null;
  const check = async (tab) => {
    const outcomes = await tab.ready;
    const info = await targetInfo(sessions, tab.targetId, budget);
    if (!found && info && info.url === url) found = { tab, outcomes };
    // The wait below runs on the opener's waiters, so a notify there runs scan again,
    // which ends the wait once a check has found the tab.
    const page = sessions.target(opener.targetId);
    if (page) sessions.notify(page);
  };
  const scan = () => {
    for (const [targetId, n] of session.tabIds) {
      const tab = sessions.target(targetId);
      if (n < nextTab || checked.has(targetId) || !tab || tab.openerPage !== opener.targetId) continue;
      checked.add(targetId);
      // Nothing awaits a check, and its steps handle their own failures. If a change to
      // check brings in a throw, the catch keeps it from ending the daemon as an
      // unhandled rejection, and the tab stays unidentified.
      check(tab).catch((e) => sessions.log.warn(`tabs new: checking ${targetId}: ${e.message}`));
    }
    return found !== null;
  };
  await sessions.waitUntil(opener.targetId, scan, budget).catch(() => false);
  return found;
}

// Switches the working tab to `id`. A switch to the working tab answers its state
// lines and leaves the session's records as they are.
async function switchTo(sessions, session, id, deadline) {
  const t = sessionTab(sessions, session, id);
  if (t.role === 'identity') fail(envelope.error(`${id} is the identity tab, which shows the session's label; switch to another tab`));
  const moved = t.targetId !== session.workingTargetId;
  if (moved) {
    await gateReady(sessions, session, t, id, deadline);
    tabRecords.switchWorking(sessions, session, t.targetId);
  }
  const state = await currentStateLines(sessions, t, { deadline });
  return { head: moved ? `${state}\nWorking tab: ${id}` : state };
}

// Waits, under the window budget, for the arming that a tab's attach queued, and
// refuses the tab when that arming failed and arming.js's rule is closing it. A tab
// armed by repair, or one whose only failure was a timeout of Network.enable or the
// bypass, switches at once; repair arms the last kind again.
async function gateReady(sessions, session, t, id, deadline) {
  if (!t.armed && t.openerPage) {
    const outcomes = await within(t.ready, sessions.windowBudget(deadline).deadline);
    if (outcomes === TIMED_OUT) fail(envelope.error(`${id} is still loading its first page; call again`));
    if (arming.closesTab(outcomes)) fail(envelope.error(`${id} could not be put under the domain gate and is closing`));
  }
  if (sessions.target(t.targetId) !== t || t.sessionId !== session.id) fail(envelope.error(notOpen(id)));
  if (t.closing) fail(envelope.error(`${id} is closing; tabs list shows the open tabs`));
}

// Closes a tab with Target.closeTarget, which skips its page's beforeunload handlers,
// and waits for its destruction, both within the window budget. Chrome answers success
// before the tab is gone, a second close of a tab already closing included, so the wait
// runs while the tab is registered, whatever the command answered. A closed working tab
// is replaced by the next call's repair, so a repair that fails can't fail this call.
async function close(sessions, session, id, deadline) {
  const t = sessionTab(sessions, session, id);
  if (t.role === 'identity') fail(envelope.error(`${id} is the identity tab, which the session keeps; close another tab`));
  const wasWorking = t.targetId === session.workingTargetId;
  const { deadline: by } = sessions.windowBudget(deadline);
  await sessions.closeTab(t, { deadline: by });
  let gone = sessions.target(t.targetId) !== t;
  if (!gone) {
    gone = await sessions.waitUntil(t.targetId, () => false, { deadline: by })
      .then(() => false, (e) => { if (e instanceof TargetGoneError) return true; throw e; });
  }
  if (!gone) fail(envelope.error(`${id} did not close within 5 s; tabs list shows whether it is still open`));
  if (wasWorking) return { head: `Closed: ${id}; the next call returns to a working tab` };
  const working = workingTarget(sessions, session);
  return { head: `Closed: ${id}\n${await currentStateLines(sessions, working, { deadline })}` };
}

// Returns the registered target of the session's tab `id`, t<n>.
function sessionTab(sessions, session, id) {
  const n = Number(/^t(\d+)$/.exec(id)[1]);
  const entry = [...session.tabIds].find(([, number]) => number === n);
  const t = entry && sessions.target(entry[0]);
  if (!t || t.sessionId !== session.id) fail(envelope.error(notOpen(id)));
  return t;
}

// Resolves with the browser's description of the target, or null when the command
// fails or `opts.deadline` passes first.
function targetInfo(sessions, targetId, opts) {
  return sessions.conn.send('Target.getTargetInfo', { targetId }, opts).then((r) => r.targetInfo, () => null);
}

// Returns whether the tab has closed, or the daemon is closing it.
function closedEarly(sessions, tab) {
  return sessions.target(tab.targetId) !== tab || tab.closing;
}

function notOpen(id) {
  return `${id} is not an open tab of this session; tabs list shows them`;
}

module.exports = { tabs };
