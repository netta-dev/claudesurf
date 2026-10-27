// The in-flight requests of each target with Network enabled, the network half of
// settling. Arming enables Network on the session's tabs, with or without a domain
// gate, since Network only listens. A same-process frame's requests arrive on its
// page's session and count with the page's; an out-of-process frame's don't, since
// Network is off on frame targets. The document request of a frame that goes out of
// process is the exception: it starts on the page's session, and its end is reported
// to the frame's own target, so it ends here when that target attaches.
//
// Entries live as long as their target's record: sessions.js drops them with the
// target and on the pipe's closing, and arming.js when it disarms the tab. A new
// document's commit ends the requests of the one before it, whose ends Chrome doesn't
// report.

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

// Records the Network events of every target that the registry knows, by the protocol
// session that they arrive on, and wakes the target's waiters on each counted one.
function attachRequests(conn, sessions) {
  const on = (event, fn) => conn.on(event, (params, cdpSessionId) => {
    const t = sessions.byCdpSession(cdpSessionId);
    if (t && fn(storeOf(t), params)) sessions.notify(t);
  });
  on('Network.requestWillBeSent', (store, { requestId, type, frameId, loaderId }) => {
    // A redirect hop arrives under the request's own id, which stays in flight and
    // keeps its number.
    const counted = COUNTED.has(type);
    const hop = store.inFlight.get(requestId);
    store.inFlight.delete(requestId);
    store.inFlight.set(requestId, { counted, startedAt: Date.now(), number: hop ? hop.number : ++started, frameId, loaderId });
    if (store.inFlight.size > MAX_ENTRIES) store.inFlight.delete(store.inFlight.keys().next().value);
    if (counted) store.lastEventAt = Date.now();
    return counted;
  });
  const finished = (store, { requestId }) => {
    const entry = store.inFlight.get(requestId);
    if (!entry) return false;
    store.inFlight.delete(requestId);
    if (entry.counted) store.lastEventAt = Date.now();
    return entry.counted;
  };
  on('Network.loadingFinished', finished);
  on('Network.loadingFailed', finished);
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
    if (entry.loaderId !== loaderId) store.inFlight.delete(requestId);
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
  }
  if (counted) store.lastEventAt = Date.now();
  return counted;
}

function storeOf(t) {
  let store = stores.get(t);
  if (!store) {
    store = { inFlight: new Map(), lastEventAt: 0 };
    stores.set(t, store);
  }
  return store;
}

module.exports = { attachRequests, mark, busy, drop, commit, endFrame, STALE_MS };
