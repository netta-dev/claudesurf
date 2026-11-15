// This module tracks requests in flight for settling and forwards their stages to
// network capture. Arming enables Network on session tabs with or without a domain
// gate because collecting events doesn't require interception.
// Same-process frame requests count with the page's requests. Out-of-process frame
// requests are excluded because Network is disabled on frame targets.
// A frame's document request can start on the page's protocol session and end on
// the frame's own target. This module ends that request when the frame target
// attaches.
//
// sessions.js drops entries with their target and when the pipe closes;
// arming.js drops them on disarm. A new document's commit ends requests from the
// previous document because Chrome doesn't report their ends.
//
// Entries retain the sink's capture records without inspecting them.
// The sink receives stages while a tab's arming commands have been sent and the tab
// hasn't been disarmed. Sink failures are logged without interrupting settling
// counts or waiter notifications. Entries evicted past MAX_ENTRIES or dropped with
// their tab are removed without notifying the sink.

// The resource types that hold settling; images, media, fonts, and pings don't.
const COUNTED = new Set(['Document', 'Script', 'Stylesheet', 'XHR', 'Fetch']);
// The age past which a counted request in flight stops counting, so a long poll holds
// settling for at most this long; one that an acting call started counts until it ends.
const STALE_MS = 5_000;
// The entries kept per target, oldest out, so a page that leaks requests can't grow
// the store without bound.
const MAX_ENTRIES = 1_000;

const stores = new WeakMap();
// The number of requests started so far, across every target: each entry keeps its own,
// so an acting call tells the requests that it started from those in flight before it.
let started = 0;
// The sink and logger supplied by the most recently attached registry.
// The registry calls commit and endFrame directly, outside attachRequests.
let attached = null;

function attachRequests(conn, sessions, sink) {
  attached = { sink, log: sessions.log };
  const on = (event, fn) => conn.on(event, (params, cdpSessionId) => {
    const t = sessions.byCdpSession(cdpSessionId);
    if (t && fn(storeOf(t), params, t)) sessions.notify(t);
  });
  on('Network.requestWillBeSent', (store, params, t) => {
    const { requestId, type, frameId, loaderId } = params;
    // A redirect hop arrives under the request's own id, which stays in flight and
    // keeps its number.
    const counted = COUNTED.has(type);
    const hop = store.inFlight.get(requestId);
    store.inFlight.delete(requestId);
    const entry = { counted, startedAt: Date.now(), number: hop ? hop.number : ++started, frameId, loaderId, record: null };
    store.inFlight.set(requestId, entry);
    if (store.inFlight.size > MAX_ENTRIES) store.inFlight.delete(store.inFlight.keys().next().value);
    if (counted) store.lastEventAt = Date.now();
    if (hop) pass(t, 'ended', hop.record, 'redirect', params);
    entry.record = start(t, params);
    return counted;
  });
  on('Network.responseReceived', (store, params, t) => {
    const entry = store.inFlight.get(params.requestId);
    if (entry) pass(t, 'response', entry.record, params);
    return false;
  });
  const ends = (how) => (store, params, t) => {
    const entry = store.inFlight.get(params.requestId);
    if (!entry) return false;
    store.inFlight.delete(params.requestId);
    if (entry.counted) store.lastEventAt = Date.now();
    pass(t, 'ended', entry.record, how, params);
    return entry.counted;
  };
  on('Network.loadingFinished', ends('finished'));
  on('Network.loadingFailed', ends('failed'));
}

// Returns the mark that an acting call takes before it acts: every request that starts
// after it is the call's own.
function mark() {
  return started;
}

// Returns { count, lastEventAt } for the target at `now`: the counted requests in
// flight for under STALE_MS, together with those that started after the mark `own`
// whatever their age, and the Date.now() time of its last counted request event, 0
// when there was none.
function busy(t, now = Date.now(), own = Infinity) {
  const store = stores.get(t);
  if (!store) return { count: 0, lastEventAt: 0 };
  let count = 0;
  for (const entry of store.inFlight.values()) {
    if (entry.counted && (entry.number > own || now - entry.startedAt < STALE_MS)) count += 1;
  }
  return { count, lastEventAt: store.lastEventAt };
}

function inFlight(t) {
  const store = stores.get(t);
  if (!store) return [];
  return [...store.inFlight.values()].map((entry) => entry.record).filter(Boolean);
}

function drop(t) {
  stores.delete(t);
}

// Ends the requests of every document of the target but the one that its main frame
// just committed, which `loaderId` names: that document's own request is the one still
// loading, and its subresources start after the commit.
function commit(t, loaderId) {
  const store = stores.get(t);
  if (!store) return;
  for (const [requestId, entry] of store.inFlight) {
    if (entry.loaderId === loaderId) continue;
    store.inFlight.delete(requestId);
    pass(t, 'ended', entry.record, 'ended by a navigation', {});
  }
}

// Ends the requests that the target made for the frame `frameId`, which has attached as a
// frame target of its own, as an out-of-process frame's id is its target's. Returns
// whether one of them counted.
function endFrame(t, frameId) {
  const store = stores.get(t);
  if (!store) return false;
  let counted = false;
  for (const [requestId, entry] of store.inFlight) {
    if (entry.frameId !== frameId) continue;
    store.inFlight.delete(requestId);
    counted = counted || entry.counted;
    pass(t, 'ended', entry.record, 'continued in a cross-site frame', {});
  }
  if (counted) store.lastEventAt = Date.now();
  return counted;
}

function start(t, params) {
  return deliver(t, 'started', (sink) => sink.started(t, params));
}

function pass(t, stage, record, ...rest) {
  if (record) deliver(t, stage, (sink) => sink[stage](t, record, ...rest));
}

function deliver(t, stage, call) {
  if (!t.armingSent) return null;
  try {
    return call(attached.sink);
  } catch (e) {
    attached.log.warn(`network capture of ${t.targetId} at ${stage}: ${e.stack || e.message}`);
    return null;
  }
}

function storeOf(t) {
  let store = stores.get(t);
  if (!store) {
    store = { inFlight: new Map(), lastEventAt: 0 };
    stores.set(t, store);
  }
  return store;
}

module.exports = { attachRequests, mark, busy, inFlight, drop, commit, endFrame, STALE_MS };
