// The result step that every acting call ends with. Before the call acts, `beforeAction`
// records the counters that its result is measured against and sets the call's marks
// on the session. While the marks are set, a full refusal list drops first the entries
// that the call can't claim (refusals.js), and dropping the window's state keeps the list
// (sessions.js). `finishAction` then waits for a navigation that the action started,
// settles, takes the refusals that the call led to, and builds the head: the state lines,
// what navigated and opened, whether the page settled, and the change summary when the
// call stayed on its document.
//
// Once the action has acted, a failure of these steps prints in the head rather than
// failing the call, since the page has already changed; a closed pipe still fails it,
// and a working tab that disappeared during the call leaves only the Tab: line and what
// the call opened.

const envelope = require('./envelope');
const { ConnectionClosedError, TimeoutError } = require('./cdp');
const refusals = require('./refusals');
const requests = require('./requests');
const tabRecords = require('./tab-records');
const { settle, settledLine, UNCHECKED } = require('./settle');
const { renderChanges } = require('./changes');
const { waitForDocument, navigatedVerdict, NAVIGATION_MS } = require('./navigation-wait');
const { fail, currentStateLines, loadBudget } = require('./action-support');

// The cap on settling, cut so the summary keeps its reserve of the request deadline,
// and the floor under it, enough for one probe.
const SETTLE_MS = 5_000;
const SUMMARY_RESERVE_MS = 3_000;
const SETTLE_FLOOR_MS = 100;
const TAB_GONE = 'Tab: the working tab closed during the call; the next call returns to a working tab';
const MAY_HAVE_RUN = 'the action may have run, but its command timed out; read the page before repeating it';

// Returns the counters of the working tab `t` that the call's result is measured
// against, with the mark past which a request is the call's own. Sets the call's marks ({ seq,
// nextTab, workingTargetId, newTab }) on the session; daemon.js clears them when the
// handler ends.
function beforeAction(sessions, session, t) {
  const marks = { seq: session.refusalCount, nextTab: session.nextTab, workingTargetId: t.targetId, newTab: null };
  session.marks = marks;
  return {
    marks, targetId: t.targetId, navigations: t.navigations, downloads: t.downloads,
    generation: t.generation, sameDocument: t.sameDocument, requests: requests.mark(),
  };
}

// Runs the command after which an action counts as having acted, and resolves with its
// answer. A timeout doesn't cancel the command in the browser, so the call can't say
// whether the page changed, and answers with an error that says so.
async function acting(command) {
  try {
    return await command();
  } catch (e) {
    if (e instanceof TimeoutError) fail(envelope.error(MAY_HAVE_RUN));
    throw e;
  }
}

// Resolves { head, body, outcome, blocked } for the action that `before` measured on the
// working tab `t`. Options:
//   - `deadline`, the request's;
//   - `frame`, { target, frameId, label }, a child frame that the action touched, which
//     settling watches too (settle.js);
//   - `lines`, head lines printed after the state lines: strings, or functions called
//     for their line as the head is built, for a line that depends on the document that
//     the call ended on;
//   - `focusNow`, an async function called once the summary has refreshed the ref set,
//     on a call that stayed on its document; the line it returns, if any, prints after
//     `lines`;
//   - `navigation`, the answer of a waitForDocument that the handler already ran on the
//     navigation that the action started;
//   - `navigationError`, a line printed after Navigated:.
// `outcome` is 'unsettled' when settling ran out or failed, and undefined for success;
// `blocked` holds the refusals that the call led to, which make it needs_confirmation.
async function finishAction(sessions, session, t, before, opts = {}) {
  const { deadline, frame = null, lines = [], focusNow = null, navigation = null, navigationError = null } = opts;
  const actedAt = Date.now();
  const ctx = { sessions, t };
  let settled = null;
  let gone = false;
  try {
    // The first wait counts from before the action because its navigation may have
    // committed before this step began. Each later wait counts from where the previous
    // wait ended, so the same stop doesn't end both waits. A navigation counts as seen
    // once a wait has covered it. A navigation that started among the events that ended
    // a wait, including the handler's own wait, gets a wait of its own.
    let start = navigation ? navigation.ended : before;
    for (;;) {
      if (t.navigations > start.navigations) {
        ({ ended: start } = await waitForDocument(sessions, t, start, { timeout: loadBudget(NAVIGATION_MS, deadline), deadline }));
      }
      const seen = start.navigations;
      const result = await settle(sessions, t, { from: actedAt, own: before.requests, budget: settleBudget(deadline), deadline, frame, stop: () => t.navigations > seen });
      if (result.stopped) continue;
      settled = result;
      break;
    }
  } catch (e) {
    gone = failedStep(ctx, e, 'settling');
    if (!gone) settled = { failed: true };
  }
  const blocked = refusals.takeOwn(session, before.marks);
  const opened = await openedLines(sessions, session, before.marks, { deadline });

  let state = null;
  if (!gone) {
    try {
      state = await currentStateLines(sessions, t, { deadline });
    } catch (e) {
      gone = failedStep(ctx, e, 'reading the page state');
      state = 'State: not read';
    }
  }
  let changed = null;
  let body = '';
  let focused = null;
  const stayed = t.generation === before.generation && session.workingTargetId === before.targetId;
  const navigated = navigatedVerdict(t, before);
  if (!gone && stayed) {
    try {
      const answer = await renderChanges(sessions, session, t, { source: 'summary', deadline });
      if (answer.untracked) changed = `Changed: not tracked (${answer.untracked})`;
      else if (answer.notMeasured) changed = `Changed: not measured (${answer.notMeasured})`;
      else ({ line: changed, body } = answer);
    } catch (e) {
      gone = failedStep(ctx, e, 'the change summary');
      changed = 'Changed: not measured (the renderer failed)';
    }
    if (!gone && focusNow) {
      try {
        focused = await focusNow();
      } catch (e) {
        gone = failedStep(ctx, e, 'reading the focus');
      }
    }
  }
  if (gone) return { head: [TAB_GONE, ...opened].join('\n'), body: '', outcome: undefined, blocked };

  const head = [state, ...lines.map((line) => (typeof line === 'function' ? line() : line))];
  if (focused) head.push(focused);
  head.push(`Navigated: ${navigated}`);
  if (navigationError) head.push(navigationError);
  head.push(...opened);
  const unsettled = settled.failed || !settled.settled;
  if (settled.failed) head.push(UNCHECKED);
  else if (!settled.settled) head.push(settledLine(settled));
  if (changed) head.push(changed);
  return { head: head.join('\n'), body, outcome: unsettled ? 'unsettled' : undefined, blocked };
}

// Resolves with the Opened: lines of the tabs attributed during the call, numbered
// from the marks' next tab: each tab still open, the session's, and neither the
// working tab, the identity tab, nor one that the daemon is closing.
async function openedLines(sessions, session, marks, opts) {
  const numbered = [...session.tabIds].filter(([, n]) => n >= marks.nextTab).sort((a, b) => a[1] - b[1]);
  const lines = [];
  for (const [targetId] of numbered) {
    const tab = sessions.target(targetId);
    if (!tab || tab.closing || tab.sessionId !== session.id || targetId === session.workingTargetId || tab.role === 'identity') continue;
    const inside = await tabRecords.inSessionWindow(sessions, session, targetId, opts);
    lines.push(`Opened: ${tabRecords.tabId(session, targetId)}, ${inside ? 'a new tab' : 'a popup window'} (not the working tab)`);
  }
  return lines;
}

function settleBudget(deadline) {
  if (deadline === undefined) return SETTLE_MS;
  return Math.max(Math.min(SETTLE_FLOOR_MS, deadline - Date.now()), Math.min(SETTLE_MS, deadline - SUMMARY_RESERVE_MS - Date.now()));
}

// Returns whether a step's failure means the working tab is gone; a command in flight as
// the tab closes fails with a protocol error or a timeout as often as with a
// TargetGoneError. A closed pipe fails the call; any other failure is logged.
function failedStep({ sessions, t }, e, step) {
  if (e instanceof ConnectionClosedError || (sessions.conn && sessions.conn.closed)) throw e;
  if (sessions.target(t.targetId) !== t) return true;
  sessions.log.info(`${step} failed after the action: ${e.message}`);
  return false;
}

module.exports = { beforeAction, finishAction, acting };
