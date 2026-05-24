# Phase 2 LLD — Multi-profile routing

**HLD**: `hld-per-session-windows.md` Phase 2.

## Scope

The daemon currently treats the WebSocket as a singleton — last-connected extension wins, so only one Chrome profile is reachable at a time. Phase 2 lifts that:

- Daemon tracks every connected extension (one per profile).
- Each extension tracks "when did one of my windows last gain OS focus" via `chrome.windows.onFocusChanged` and a one-shot seed from `chrome.windows.getLastFocused()` on load.
- On the first request for a sessionId the daemon hasn't seen, it probes all connected extensions in parallel, picks the one with the highest `lastFocusedAt`, and binds the session to that socket for the daemon's lifetime (or until that socket disconnects).
- Subsequent requests for that sessionId route deterministically to the bound socket — sessions don't follow your focus after binding.

After this phase: opening a Claude session in your work profile spawns its dedicated window in work, even if you then alt-tab to personal; opening another session in personal spawns there.

## Resolutions to HLD open questions

1. **Probe parallelism**: parallel via `Promise.all`. Each probe is its own request/response over the existing `pendingRequests` plumbing.
2. **Probe timeout**: 500 ms. Slow/dead extensions get scored as `lastFocusedAt = 0` and lose ties.
3. **Disconnect handling**: option (a) — on socket close, remove from the connected set AND drop any `sessionBindings` entries pointing to it. Next request for those sessions re-picks. The dedicated window in the gone profile is orphaned; the new profile spawns a fresh one.
4. **Internal action name**: `__claudesurf_get_focus` (double-underscore prefix namespaces it away from any MCP tool action).
5. **Initial focus seed**: on extension load, call `chrome.windows.getLastFocused({ populate: false })`. If the returned window has `focused: true`, write `lastFocusedAt: Date.now()` to `chrome.storage.session`. Otherwise leave it absent.
6. **Concurrent un-bound sessions**: no special handling — parallel pickers all converge on the same focused profile, all bind there. Idempotent.

## Changes by file

### `server/daemon.js` (modified)

Replace `extensionSocket` (single) with `connectedExtensions: Set<WebSocket>`. Add `sessionBindings: Map<sessionId, WebSocket>`. Refactor `sendToExtension` into a high-level "send to the bound socket for this session" + a low-level "send to a specific socket" so the focus probe can reuse the wire protocol.

Sketch:

```js
const connectedExtensions = new Set();
const sessionBindings = new Map();

function sendToSocket(socket, action, params, sessionId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (socket.readyState !== 1) {
      reject(new Error('Extension socket not open'));
      return;
    }
    const id = ++requestId;
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pendingRequests.set(id, { resolve: (r) => { clearTimeout(timer); resolve(r); } });
    socket.send(JSON.stringify({ id, action, params, sessionId }));
  });
}

async function pickProfileForSession() {
  const sockets = [...connectedExtensions];
  if (sockets.length === 0) throw new Error('No extension connected');
  if (sockets.length === 1) return sockets[0];

  const results = await Promise.all(sockets.map((s) =>
    sendToSocket(s, '__claudesurf_get_focus', {}, null, 500)
      .then((r) => ({ socket: s, ts: (r && r.lastFocusedAt) || 0 }))
      .catch(() => ({ socket: s, ts: 0 }))
  ));
  // Highest timestamp wins; ties go to first-iterated (insertion order on Set).
  return results.reduce((best, r) => (r.ts > best.ts ? r : best)).socket;
}

async function getOrBindSessionSocket(sessionId) {
  const bound = sessionBindings.get(sessionId);
  if (bound && connectedExtensions.has(bound) && bound.readyState === 1) {
    return bound;
  }
  const picked = await pickProfileForSession();
  sessionBindings.set(sessionId, picked);
  return picked;
}

async function sendToExtension(action, params = {}, sessionId = null) {
  if (connectedExtensions.size === 0) {
    throw new Error('Chrome extension not connected. Make sure the ClaudeSurf extension is loaded and a page is open.');
  }
  const socket = await getOrBindSessionSocket(sessionId);
  return sendToSocket(socket, action, params, sessionId);
}
```

Connection / disconnection:

```js
wss.on('connection', (socket) => {
  log('Chrome extension connected');
  connectedExtensions.add(socket);
  socket.on('message', /* unchanged: route reply to pendingRequests */);
  socket.on('close', () => {
    log('Chrome extension disconnected');
    connectedExtensions.delete(socket);
    for (const [sid, s] of sessionBindings.entries()) {
      if (s === socket) sessionBindings.delete(sid);
    }
  });
});
```

`/health` updated to report `extensionsConnected: connectedExtensions.size` (renamed from `extensionConnected: boolean` for accuracy; minor breaking change for the health endpoint).

### `extension/background.js` (modified)

Add a focus-tracking initializer and a handler for `__claudesurf_get_focus`. Storage key: a bare `lastFocusedAt` (no per-session prefix — it's profile-wide).

```js
const LAST_FOCUSED_KEY = 'lastFocusedAt';

async function initFocusTracking() {
  try {
    const win = await chrome.windows.getLastFocused({ populate: false });
    if (win && win.focused) {
      await chrome.storage.session.set({ [LAST_FOCUSED_KEY]: Date.now() });
    }
  } catch {
    // No windows yet, or transient — onFocusChanged will catch the next event.
  }
}

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return; // focus left all of our windows
  await chrome.storage.session.set({ [LAST_FOCUSED_KEY]: Date.now() });
});

initFocusTracking();
```

Add to the `ws.onmessage` switch:

```js
case '__claudesurf_get_focus': {
  const stored = await chrome.storage.session.get(LAST_FOCUSED_KEY);
  result = { lastFocusedAt: stored[LAST_FOCUSED_KEY] || null };
  break;
}
```

This case must come *before* the `sessionId` validation gate inside the existing per-action handlers — `__claudesurf_get_focus` doesn't carry a sessionId. Since the existing switch handlers each call helpers that themselves enforce sessionId (via `getOrCreateSessionWindow`), no top-level sessionId validation needs adjustment.

### Tests

Manual (no test framework declared):

1. **Single profile (regression)**: with extension loaded in one profile only, all Phase 1 tests still pass. Daemon's `connectedExtensions.size === 1` short-circuits the probe.
2. **Two profiles, focused-profile wins binding**: load extension in profile A and profile B. Focus a window in A. Restart Claude Code (new sessionId). Run a tool → dedicated window appears in profile A.
3. **Sticky binding**: from test 2, alt-tab to profile B and run another tool from the *same* Claude session. Window stays in A.
4. **Second session takes the other profile**: focus profile B. Start a second Claude session. Run a tool → dedicated window appears in profile B. First session's window in A is untouched.
5. **Disconnect recovery**: unload extension in profile A (sessions bound there lose their socket). Run a tool from a session that was bound to A → daemon re-picks based on current focus; window spawns in the new profile.
6. **No focus ever**: start daemon with extensions already loaded but Chrome unfocused (alt-tab to terminal first). First session → daemon probe sees `lastFocusedAt = null` for all extensions → falls back to first-connected.
7. **Race-on-bind**: fire two tool calls back-to-back from two fresh sessions. Both `pickProfileForSession` runs probe in parallel; both bind to the same focused profile. Confirm via daemon log no errors.

### Documentation

`README.md` is the only declared doc (`docs.md`). Should add a brief note explaining multi-profile behavior in the troubleshooting section: "Load the extension in each Chrome profile you want claudesurf to be able to use; the daemon will route each Claude session to whichever profile had OS focus when the session first called a tool." Defer to wrap-up if scope-sensitive.

## Risks

- **Initial focus seed depends on `getLastFocused().focused === true`**, which reflects OS-level focus state at extension-load instant. On Linux/X11 with quirky window managers this might mis-report (return a window with `focused: true` even when another app is foreground). Acceptable — focus events will correct subsequent state.
- **`pendingRequests` cleanup on socket close**: a disconnect leaves any in-flight requests to that socket dangling. They'll time out after 30s and reject — annoying but not corrupting. A nicer cleanup (walk pendingRequests, reject those tagged to closed socket) is possible but adds bookkeeping; deferring.
- **`/health` shape change** (`extensionConnected: bool` → `extensionsConnected: number`) is a minor breaking change for anyone scripting against the daemon. No known consumers besides curl-debugging.
- **Tie-break on identical timestamps**: only matters if two profiles tied to the millisecond — extremely unlikely in real use. Falls back to Set insertion order (first-connected).

Ready for implementer?
