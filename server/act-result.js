// This module builds results for actions that may already have changed the page.
// refusals.js drops unrelated entries first when its list is full, and sessions.js
// retains the list during window-state loss while the call's marks are set.
//
// The daemon reports failures during result collection in the head because the
// action may have changed the page. A closed pipe fails the call.
// The result for a working tab that disappeared contains the Tab: line and the
// Opened: lines for tabs opened during the call.

const envelope = require('./envelope');
const { TimeoutError } = require('./cdp');
const refusals = require('./refusals');
const requests = require('./requests');
const tabRecords = require('./tab-records');
const { settle, settledLine, UNCHECKED } = require('./settle');
const { renderChanges } = require('./changes');
const { detectOrLog, keep, challengeLine } = require('./challenge');
const { waitForDocument, navigatedVerdict, NAVIGATION_MS } = require('./navigation-wait');
const { fail, currentStateLines, loadBudget, pipeClosed, cappedText, cappedUrl } = require('./action-support');

// The daemon reduces the settling budget to reserve time for the summary, with a
// floor that allows a probe near the deadline. Detection and the wait for a challenge
// to clear use the same reserve.
const SETTLE_MS = 5_000;
const SUMMARY_RESERVE_MS = 3_000;
const SETTLE_FLOOR_MS = 100;
const CLEAR_WAIT_MS = 10_000;
// The minimum time that a call must have left, excluding the summary's reserve, to
// wait for a challenge to clear itself. A call with less leaves that document's wait
// to a later call.
const CLEAR_WAIT_MIN_MS = 500;
const DOWNLOAD_LINES = 3;
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

// Resolves { head, body, outcome, blocked, challenge } for the action that `before`
// measured on the working tab `t`. Options:
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
// `blocked` holds the refusals that the call led to, which make it needs_confirmation;
// `challenge` is detection's match on the document that the state lines describe, or
// null.
async function finishAction(sessions, session, t, before, opts = {}) {
  const { deadline, frame = null, lines = [], focusNow = null, navigation = null, navigationError = null } = opts;
  const actedAt = Date.now();
  const ctx = { sessions, t };
  const reserved = deadline === undefined ? undefined : deadline - SUMMARY_RESERVE_MS;
  let settled = null;
  let detected = null;
  let gone = false;
  try {
    // The first wait counts from before the action because its navigation may have
    // committed before this step began. Each later wait counts from where the previous
    // wait ended, so the same stop doesn't end both waits. A navigation counts as seen
    // once a wait has covered it. A navigation that started among the events that ended
    // a wait, including the handler's own wait, gets a wait of its own, and so does one
    // that started during detection or the wait for a challenge to clear itself.
    let start = navigation ? navigation.ended : before;
    for (;;) {
      if (t.navigations > start.navigations) {
        ({ ended: start } = await waitForDocument(sessions, t, start, { timeout: loadBudget(NAVIGATION_MS, deadline), deadline }));
      }
      const seen = start.navigations;
      const started = () => t.navigations > seen;
      const result = await settle(sessions, t, { from: actedAt, own: before.requests, budget: settleBudget(deadline), deadline, frame, stop: started });
      if (result.stopped) continue;
      settled = result;
      detected = await detectOrLog(sessions, t, { deadline: reserved });
      if (started()) continue;
      if (clearWaitDue(t, detected, reserved)) {
        t.clearWaited = detected.generation;
        await sessions.waitUntil(t.targetId, started, { timeout: CLEAR_WAIT_MS, deadline: reserved });
        if (started()) continue;
      }
      break;
    }
  } catch (e) {
    gone = failedStep(ctx, e, 'settling');
    if (!gone) settled = { failed: true };
  }
  const blocked = refusals.takeOwn(session, before.marks);
  const opened = await openedLines(sessions, session, before.marks, { deadline });

  let state = null;
  let challenge = null;
  if (!gone) {
    try {
      state = await currentStateLines(sessions, t, { deadline });
      // respond.js returns needs_confirmation for refusals attributed to this call.
      // The daemon doesn't open a handoff for that outcome, so the challenge remains
      // available for a later call.
      if (detected && detected.generation === t.generation) challenge = blocked.length ? detected.challenge : keep(t, detected);
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
  if (gone) return { head: [TAB_GONE, ...opened].join('\n'), body: '', outcome: undefined, blocked, challenge: null };

  const head = [state];
  if (challenge) head.push(challengeLine(challenge));
  head.push(...lines.map((line) => (typeof line === 'function' ? line() : line)));
  if (focused) head.push(focused);
  head.push(`Navigated: ${navigated}`);
  if (navigationError) head.push(navigationError);
  head.push(...opened, ...downloadLines(t, before));
  const unsettled = settled.failed || !settled.settled;
  if (settled.failed) head.push(UNCHECKED);
  else if (!settled.settled) head.push(settledLine(settled));
  if (changed) head.push(changed);
  return { head: head.join('\n'), body, outcome: unsettled ? 'unsettled' : undefined, blocked, challenge };
}

function downloadLines(t, before) {
  const total = t.downloads - before.downloads;
  if (total <= 0) return [];
  const shown = t.downloadLog.filter((d) => d.n > before.downloads).slice(0, DOWNLOAD_LINES);
  const lines = shown.map((d) => `Download: denied — ${cappedText(d.file) || 'a file'} from ${cappedUrl(d.url)}`);
  if (total > shown.length) lines.push(`… and ${total - shown.length} more`);
  return lines;
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

// Returns whether `detected`, detectOrLog's answer, holds a challenge that may clear
// itself on a document where the wait for it to clear is unspent, with at least
// CLEAR_WAIT_MIN_MS left before `reserved` (ms epoch).
function clearWaitDue(t, detected, reserved) {
  if (!detected || !detected.challenge || !detected.challenge.clears || t.clearWaited === detected.generation) return false;
  return reserved === undefined || reserved - Date.now() >= CLEAR_WAIT_MIN_MS;
}

function settleBudget(deadline) {
  if (deadline === undefined) return SETTLE_MS;
  return Math.max(Math.min(SETTLE_FLOOR_MS, deadline - Date.now()), Math.min(SETTLE_MS, deadline - SUMMARY_RESERVE_MS - Date.now()));
}

// Returns whether a step's failure means the working tab is gone; a command in flight as
// the tab closes fails with a protocol error or a timeout as often as with a
// TargetGoneError. A closed pipe fails the call; any other failure is logged.
function failedStep({ sessions, t }, e, step) {
  if (pipeClosed(sessions, e)) throw e;
  if (sessions.target(t.targetId) !== t) return true;
  sessions.log.info(`${step} failed after the action: ${e.message}`);
  return false;
}

module.exports = { beforeAction, finishAction, acting };
