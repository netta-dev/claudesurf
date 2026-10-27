// The settle check. A page has settled once each of its counted requests
// (requests.js) has ended, its document is past `loading`, and its structure and text
// (page/settle.js's observer) have stayed unchanged for the quiet window. An input
// action into a child frame watches that frame's document too. The check re-runs
// every POLL_MS and on every counted request event until it holds or the budget runs
// out.

const { ConnectionClosedError } = require('./cdp');
const requests = require('./requests');
const { frameThere } = require('./frames');
const { SETTLE_SOURCE } = require('./action-support');

const QUIET_MS = 500;
const POLL_MS = 100;
// The least time that a probe gets to answer, so the one that the budget's last check sends
// doesn't time out before the renderer could answer it.
const PROBE_FLOOR_MS = 50;

// Resolves { settled: true }, or { settled: false, reason, after } once `budget` ms, cut
// to `deadline`, have run out, `reason` naming what was still busy and `after` the
// milliseconds spent; or { settled: false, stopped: true } as soon as `stop()` holds.
// `from` is the Date.now() time that the quiet window counts from at the earliest, the
// action's end. `own` is the requests.mark() that an acting call took before it acted: a
// request that started after it counts until it ends. `frame`, { target, frameId,
// label }, is a child frame that an input action touched: a frame target with `frameId`
// null, or a same-process frame of `target`; `label`, a string or a function that
// returns one when `reason` is read, names it in the reason, as in "the frame holding
// f1e42". A frame that disappears drops its signal. A closed pipe, the target's
// TargetGoneError, and a failure of the page's own probe reject.
async function settle(sessions, t, { from = 0, own = Infinity, budget, deadline, frame = null, stop = () => false }) {
  const started = Date.now();
  const end = deadline === undefined ? started + budget : Math.min(started + budget, deadline);
  const quiet = quietMs();
  // A probe ends with the budget, or PROBE_FLOOR_MS after it starts when that is later,
  // so one that the renderer never answers leaves the caller what remains of the deadline.
  const probeBy = () => {
    const floored = Math.max(end, Date.now() + PROBE_FLOOR_MS);
    return { deadline: deadline === undefined ? floored : Math.min(deadline, floored) };
  };
  let watched = frame;
  for (;;) {
    if (stop()) return { settled: false, stopped: true };
    const page = await sessions.callInWorld(t.targetId, SETTLE_SOURCE, [], probeBy());
    let framed = null;
    let silent = false;
    if (watched) {
      try {
        framed = await probeFrame(sessions, watched, probeBy());
      } catch (e) {
        if (e instanceof ConnectionClosedError) throw e;
        // A frame that can't be judged counts as there, so settling waits for it.
        if (await frameThere(sessions, watched.target, watched.frameId, probeBy()).catch(() => true)) silent = true;
        else watched = null;
      }
    }
    if (stop()) return { settled: false, stopped: true };
    const now = Date.now();
    const net = requests.busy(t, now, own);
    const documents = framed ? [page, framed] : [page];
    const mutated = Math.max(0, ...documents.map((d) => d.lastMutationAt || 0));
    const quietFrom = Math.max(from, net.lastEventAt, mutated, ...documents.map((d) => d.installedAt));
    const reasons = [];
    if (documents.some((d) => d.readyState === 'loading')) reasons.push('the page has not finished loading');
    if (net.count) reasons.push(`${net.count} ${net.count === 1 ? 'request' : 'requests'} in flight`);
    if (now - mutated < quiet) reasons.push('the document is still changing');
    if (silent) reasons.push(() => `${typeof frame.label === 'function' ? frame.label() : frame.label} did not answer`);
    const calm = !reasons.length && now - quietFrom >= quiet;
    if (calm) return { settled: true };
    if (now >= end) {
      // The quiet window alone can outlast a budget that the deadline cut short. A
      // mutation inside it is a reason already, so the line names a request that just
      // ended, or else the document.
      if (!reasons.length) reasons.push(now - net.lastEventAt < quiet ? 'a request just finished' : 'the document is still changing');
      return {
        settled: false,
        after: now - started,
        // A getter, so a frame's label function runs as the caller reads the reason
        // rather than as settling ends.
        get reason() { return reasons.map((r) => (typeof r === 'function' ? r() : r)).join(', '); },
      };
    }
    // When only the quiet window holds settling, the wait ends as the window does.
    const left = reasons.length ? POLL_MS : quietFrom + quiet - now;
    const seen = net.lastEventAt;
    await sessions.waitUntil(t.targetId, (target) => stop() || requests.busy(target).lastEventAt !== seen, {
      timeout: Math.max(1, Math.min(POLL_MS, left, end - now)),
    });
  }
}

// Returns the Settled: head line for an answer that didn't settle.
function settledLine({ reason, after }) {
  return `Settled: no — after ${(after / 1000).toFixed(1)} s, ${reason}`;
}

// The line for a settle step that failed outright.
const UNCHECKED = 'Settled: no — the page could not be checked';

function probeFrame(sessions, { target, frameId }, opts) {
  return sessions.withWorld(target.targetId, frameId, (executionContextId) => (
    sessions.callFunction(target.targetId, { executionContextId, functionDeclaration: SETTLE_SOURCE }, opts)
  ), opts);
}

// Returns the quiet window, read on each call so a test can shorten it.
function quietMs() {
  const raw = process.env.CLAUDESURF_SETTLE_QUIET_MS;
  const value = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : QUIET_MS;
}

module.exports = { settle, settledLine, UNCHECKED };
