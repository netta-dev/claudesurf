# Phase 1 LLD — Per-session dedicated windows (single profile)

**HLD**: `hld-per-session-windows.md` Phase 1.

## Scope

Each Claude Code session gets its own dedicated Chrome window inside a single Chrome profile. Session ID is generated in `server.js`, flows through the daemon to the extension, which creates/reuses a window per session in `chrome.storage.session`. All tab ops target that window's active tab, never `currentWindow`. Daemon connection model is unchanged (last-wins single extension); multi-profile is Phase 2.

## Resolutions to HLD open questions

1. **`session.html` identity**: URL hash params — `session.html#sessionId=<uuid>&startedAt=<ISO8601>`.
2. **Manual claim affordance**: skipped (Future improvements).
3. **Window-create failure error**: `"Failed to open dedicated ClaudeSurf window for session <shortId>: <underlying>"`.
4. **`focused: false` reliability on Linux/X11**: defer empirical check to implementation; accept any focus-steal as v1 limitation.
5. **Concurrent first-use race**: in-memory `creatingWindow: Map<sessionId, Promise<windowId>>` in `background.js` to dedupe parallel creates for the same session.
6. **`read_page` on `chrome-extension://` page**: detect URL prefix in `executeInActiveTab`, short-circuit with `"Session window just opened — navigate to a URL first."` instead of attempting content-script injection. `screenshot` and `get_page_info` work without injection so still function.
7. **Session ID format**: full UUID v4 internally; `session.html` and any user-facing display use the first 8 chars.

## Changes by file

### `server/server.js` (modified)

- Top of file: `const SESSION_ID = require('crypto').randomUUID();`
- `sendToDaemon(action, params)`: change body shape from `{ action, params }` to `{ sessionId: SESSION_ID, action, params }`. Single-line change.

### `server/daemon.js` (modified)

- HTTP `/api` handler: parse `sessionId` from body alongside `action`/`params`; pass to `sendToExtension`.
- `sendToExtension(action, params, sessionId)`: include `sessionId` in the WebSocket message envelope: `{ id, action, params, sessionId }`.
- No other structural change. Single `extensionSocket` semantics preserved.

### `extension/background.js` (modified)

Structural change: every action handler routes through a `windowId` derived from `sessionId`. Replace the existing `getActiveTabId()` (which uses `currentWindow`) with helpers that take `sessionId` and operate against the session's window.

New helpers:

```js
// Map<sessionId, Promise<windowId>> — dedupe concurrent creates for the same session
const creatingWindow = new Map();

async function getOrCreateSessionWindow(sessionId) {
  if (!sessionId) throw new Error('Missing sessionId on request');

  // Coalesce in-flight creates for the same session
  if (creatingWindow.has(sessionId)) return creatingWindow.get(sessionId);

  const stored = await chrome.storage.session.get(sessionId);
  const existingId = stored[sessionId];
  if (existingId) {
    try {
      await chrome.windows.get(existingId);
      return existingId;
    } catch {
      // window was closed; fall through to create
      await chrome.storage.session.remove(sessionId);
    }
  }

  const shortId = sessionId.slice(0, 8);
  const startedAt = new Date().toISOString();
  const url = chrome.runtime.getURL(
    `session.html#sessionId=${encodeURIComponent(sessionId)}&startedAt=${encodeURIComponent(startedAt)}`
  );

  const createPromise = chrome.windows
    .create({ url, focused: false })
    .then(async (win) => {
      await chrome.storage.session.set({ [sessionId]: win.id });
      return win.id;
    })
    .catch((e) => {
      throw new Error(
        `Failed to open dedicated ClaudeSurf window for session ${shortId}: ${e.message}`
      );
    })
    .finally(() => creatingWindow.delete(sessionId));

  creatingWindow.set(sessionId, createPromise);
  return createPromise;
}

async function getActiveTabInSessionWindow(sessionId) {
  const windowId = await getOrCreateSessionWindow(sessionId);
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (!tab) throw new Error('No active tab in dedicated window');
  return { tabId: tab.id, url: tab.url, windowId };
}
```

Replace `getActiveTabId()`, `executeInActiveTab(message)`, `navigateActiveTab(url)`, and `captureScreenshot()` with `sessionId`-taking variants:

- `executeInActiveTab(sessionId, message)`:
  - `const { tabId, url } = await getActiveTabInSessionWindow(sessionId);`
  - If `url.startsWith(chrome.runtime.getURL(''))` (i.e., still on `session.html` or any extension page): return `{ success: false, error: 'Session window just opened — navigate to a URL first.' }` *for actions that need DOM access* (`getPageContent`, `clickBySelector`, `clickByText`, `scroll`). For `getPageInfo`, we can still return URL + title via `chrome.tabs.get(tabId)` without injection — handle that case inline.
  - Otherwise, `ensureContentScript(tabId)` and `chrome.tabs.sendMessage(tabId, message)` as today.
- `navigateActiveTab(sessionId, url)`: `const { tabId } = await getActiveTabInSessionWindow(sessionId); chrome.tabs.update(tabId, { url }); …` (rest unchanged).
- `captureScreenshot(sessionId)`: `const { windowId } = await getActiveTabInSessionWindow(sessionId); const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' }); …`.

`ws.onmessage` switch: extract `sessionId` from `msg` at the top, pass to each handler:

```js
const { id, action, params, sessionId } = msg;
…
case 'read_page':
  result = await executeInActiveTab(sessionId, { action: 'getPageContent' });
  break;
case 'get_page_info':
  // Special-case to bypass content script when on extension page
  result = await getPageInfo(sessionId);
  break;
…
case 'screenshot':
  result = await captureScreenshot(sessionId);
  break;
```

New `getPageInfo(sessionId)`:
- Fetch `{ tabId, url }`. If `url` is an extension page, return `{ success: true, url, title: 'ClaudeSurf session', scroll: { x: 0, y: 0 } }`.
- Otherwise inject and delegate as today.

`ensureContentScript`, `connect`, `scheduleReconnect`, the keepalive alarm, and `onStartup`/`onInstalled` handlers are unchanged.

### `extension/session.html` (new)

Minimal page. Reads `sessionId` and `startedAt` from `window.location.hash`, renders short ID and start time as the visible body plus document title.

```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>ClaudeSurf session</title>
  <style>
    body { font-family: system-ui, sans-serif; padding: 2rem; color: #333; }
    h1 { margin: 0 0 .5rem; font-size: 1.5rem; }
    .id { font-family: ui-monospace, monospace; background: #f4f4f4; padding: .15rem .4rem; border-radius: 3px; }
    .hint { color: #666; margin-top: 1.5rem; font-size: .9rem; }
  </style>
</head>
<body>
  <h1>ClaudeSurf session <span class="id" id="shortId">…</span></h1>
  <div>Started <span id="startedAt">…</span></div>
  <div class="hint">This window is dedicated to one Claude Code session. Tool calls from that session will appear here.</div>
  <script>
    const params = new URLSearchParams(location.hash.slice(1));
    const sessionId = params.get('sessionId') || '';
    const startedAt = params.get('startedAt') || '';
    const shortId = sessionId.slice(0, 8);
    document.getElementById('shortId').textContent = shortId || '?';
    document.getElementById('startedAt').textContent = startedAt || '?';
    document.title = `ClaudeSurf ${shortId}`;
  </script>
</body>
</html>
```

### `extension/manifest.json` (no change)

- `windows` is part of the `tabs` permission — already present.
- `chrome-extension://<id>/session.html` loaded into our own window doesn't need `web_accessible_resources` (that's only for embedding in foreign contexts).
- Confirmed during implementation; revert if testing reveals otherwise.

## Data flow

```
server.js
  SESSION_ID = uuid() at module load
  ↓ HTTP POST /api { sessionId, action, params }
daemon.js
  ↓ WS send { id, action, params, sessionId }
background.js
  ws.onmessage: extract sessionId
    getOrCreateSessionWindow(sessionId)
      → chrome.storage.session.get(sessionId)
      → if missing/dead: chrome.windows.create({ url: session.html#..., focused:false })
      → store in chrome.storage.session
    chrome.tabs.query({ active: true, windowId })
    → ensureContentScript / sendMessage / captureVisibleTab / update
  ws.send { id, result }
daemon.js → HTTP response → server.js → MCP stdout → Claude
```

## Tests

No declared test framework (`capabilities.md`). Manual verification plan:

1. **Single session**: restart daemon, reload extension. Start one Claude session, run `read_page`. Verify new Chrome window opens with `session.html`, daemon stderr shows the extension connected, no focus stolen from current foreground app.
2. **Reuse**: in same session, run `navigate https://example.com`, then `read_page`. Should reuse the same window, page text returned.
3. **Concurrent sessions**: start a second Claude session, run `navigate https://anothersite`. Second dedicated window appears; first window unaffected.
4. **Window closed mid-session**: close the dedicated window via the X button. Next `read_page` from that session creates a fresh window with the same session's short ID.
5. **Focus isolation**: focus another Chrome window in the same profile, run `read_page`. Result targets the dedicated window, not the focused one.
6. **`read_page` on fresh `session.html`**: immediately after window creation, run `read_page`. Returns the friendly "navigate first" message rather than a content-script error.
7. **Concurrent first-use race**: fire two MCP calls back-to-back from the same brand-new session. Exactly one window is created.

## Mid-phase extension: pinned marker tab + dedicated working tab + session naming

After initial implementation + manual testing, learned that:
- Chrome extension API has no way to set/read a window's name (`crbug.com/1190160`, still open). Window title is derived from active tab title.
- When Claude navigates the dedicated window's tab away from `session.html`, the window title changes too — defeating visual identification of which window is which session.
- A plain UUID short ID is fine for debugging but not actionable for the human ("which window is which task?"). A human-readable name per session is a real upgrade.

Resolution (folded into Phase 1, approved by user):

- **Dedicated window opens with TWO tabs.** Pinned `session.html` (marker, leftmost) + `about:blank` working tab (active).
- **All ops target the active non-pinned tab.** If active is pinned (user clicked session.html), fall back to the most-recently-accessed non-pinned tab. If no non-pinned tabs exist (user closed all), create a fresh `about:blank` one.
- **Landing-page short-circuit expanded** to cover `about:blank`, `chrome://*`, `chrome-extension://*`, `chrome-untrusted://*`, `devtools://*`, `view-source:*`, `file://*` — all are content-script-incapable and would otherwise trip cryptic injection errors.
- **Title-prefix via content script** (B3) skipped — too invasive for the marker benefit; the pinned tab is enough.
- **Session naming via the `navigate` tool.** `navigate` now requires `name` (string) and optionally `description`. Same name on repeat = no-op. Omitted description preserves the previous value; empty string clears it. The name + description are stored in `chrome.storage.session` keyed by `sessionName:<sessionId>`; `session.html`/`session.js` listen via `chrome.storage.onChanged` and re-render live. A standalone `set_session_name` tool was prototyped and dropped — navigate is the natural moment to label a session (it's when work begins), and a separate tool was redundant.

Updated files vs. original LLD:
- `extension/background.js`: window-create flow pins session.html + opens about:blank tab; `getActiveTabInSessionWindow` filters by `pinned`; `isSessionLandingPage` expanded; `navigate` action handler invokes internal `setSessionName` if `name` param is present; stale-window race wrapped in try/catch with single-retry recovery.
- `extension/session.html`, `extension/session.js`: render session name + description from `chrome.storage.session`, subscribe to changes.
- `server/server.js`: `navigate` tool schema gains `name` (required) and `description` (optional).

## Risks

- **Service worker death during `chrome.windows.create()`** — the create call is async; if the worker dies mid-flight, `chrome.storage.session` is fine, but the in-memory `creatingWindow` map is lost. The new worker will see no entry, retry create, and orphan a window. Bounded by how often the worker dies during the few-hundred-ms create window — rare with active use. Accept.
- **`focused: false` honored by Chrome on Linux/X11** — TBD. If broken, accept v1 limitation; note in README troubleshooting.
- **Existing single-extension assumption** — daemon still expects one extension. If the user has two profiles with the extension loaded, only one will be addressable (the last-connected), and sessions will all spawn windows there. Documented in HLD Phase 2.

Ready for implementer?
