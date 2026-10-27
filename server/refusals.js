// A session's list of domain-gate refusals not yet reported. The gate records each one
// as it happens, outside any queue; the call that led to a refusal takes it as its own
// when it settles, and the next response built inside a handler's queue slot takes the
// rest. Each refusal reaches one response, as a line of its own or as part of the
// "… and N more" count when it falls past the printed lines or a full list dropped it,
// unless the window's state is dropped first.
//
// An entry is { kind, how, url, host, targetId, tab, opener, count, seq }: `seq` is the
// session's refusal counter when the entry was last recorded, and `opener` the page
// target that opened its tab. A call's marks ({ seq, nextTab, workingTargetId,
// newTab }) say which entries the running call led to: of kind navigation or new tab,
// recorded after the call began, and on the tab that the call acted in or on a tab that
// this tab opened during the call.

// The most entries the list holds; past it, the oldest entry that the running call
// can't claim goes first.
const MAX_REFUSALS = 20;

// Records a refusal on the session and returns its entry. A repeat of one still on the
// list, by tab, kind, how, and URL, raises that entry's count and updates its seq.
function record(session, entry) {
  session.refusalCount += 1;
  const seq = session.refusalCount;
  const repeat = session.refusals.find((e) => e.tab === entry.tab && e.kind === entry.kind && e.how === entry.how && e.url === entry.url);
  if (repeat) {
    repeat.count += entry.count || 1;
    repeat.seq = seq;
    return repeat;
  }
  const recorded = { ...entry, count: entry.count || 1, seq };
  session.refusals.push(recorded);
  if (session.refusals.length > MAX_REFUSALS) drop(session);
  return recorded;
}

// Removes and returns, in list order, the entries that the call described by `marks`
// led to.
function takeOwn(session, marks) {
  const own = [];
  const rest = [];
  for (const entry of session.refusals) (isOwn(entry, marks) ? own : rest).push(entry);
  session.refusals = rest;
  return own;
}

// Removes and returns every entry left, with the count of entries dropped from a full
// list since the last take, which it resets.
function takeRest(session) {
  const taken = { entries: session.refusals, dropped: session.droppedRefusals };
  session.refusals = [];
  session.droppedRefusals = 0;
  return taken;
}

// Drops the entry with the lowest seq among those that the running call can't claim,
// or the lowest overall when it could claim them all or the session lacks marks.
function drop(session) {
  const { marks } = session;
  const others = marks ? session.refusals.filter((e) => !isOwn(e, marks)) : session.refusals;
  const pool = others.length ? others : session.refusals;
  const oldest = pool.reduce((low, e) => (e.seq < low.seq ? e : low));
  session.refusals = session.refusals.filter((e) => e !== oldest);
  session.droppedRefusals += 1;
}

// Returns whether the call that `marks` describes led to the entry. `tabs new` sets
// `marks.newTab` once it has identified its tab, which then takes the place of the
// tab that was working when the call began.
function isOwn(entry, marks) {
  if (entry.kind !== 'navigation' && entry.kind !== 'new tab') return false;
  if (!(entry.seq > marks.seq)) return false;
  const anchor = marks.newTab || marks.workingTargetId;
  return entry.targetId === anchor || (entry.tab >= marks.nextTab && entry.opener === anchor);
}

module.exports = { record, takeOwn, takeRest };
