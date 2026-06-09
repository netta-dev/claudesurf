# Architecture

## Three layers

- **`server/server.js`** — one process per Claude Code session, MCP stdio bridge. Tags every HTTP request to the daemon with a `SESSION_ID` that's stable for the Claude Code session (from `CLAUDE_CODE_SESSION_ID`), so a respawned MCP process reuses the same window.
- **`server/daemon.js`** — one persistent process, owns all WebSocket connections to Chrome extension instances (one per Chrome profile). Routes each `sessionId` to a chosen extension and remembers the binding.
- **`extension/`** — manifest v3 Chrome extension, one loaded per Chrome profile. Receives `sessionId` on every action; maintains a `sessionId → windowId` map in `chrome.storage.session`; targets ops at the active non-pinned tab inside that session's dedicated window.

## Per-session windows

Each `sessionId` gets its own Chrome window. First action from a sessionId creates a window:

- Tab 1: `chrome-extension://…/session.html` — **pinned** as the window's persistent visual identity. Shows the session name + start time. Reads + re-renders live via `chrome.storage.onChanged`.
- Tab 2: `about:blank` — the **working tab** Claude navigates and operates on.

All tab ops (`read_page`, `click`, `scroll`, `navigate`, `screenshot`, `get_page_info`) target the **active non-pinned tab**. If the user clicks the pinned session tab, ops fall back to the most-recently-accessed non-pinned tab. If all non-pinned tabs are closed, a fresh `about:blank` is created on demand.

## Multi-profile routing

The daemon tracks all connected extensions in `connectedExtensions: Set<WebSocket>` and binds each session to one via `sessionBindings: Map<sessionId, WebSocket>`. On the first request for a new sessionId, it probes all connected extensions in parallel with the reserved internal action `__claudesurf_get_focus` (500 ms timeout) and binds to the profile whose `lastFocusedAt` is highest. After binding, the session sticks to that profile even if the user alt-tabs.

Each extension tracks profile focus via `chrome.windows.onFocusChanged` (writes to `chrome.storage.session` key `lastFocusedAt`, debounced to 1 s) and a one-shot `getLastFocused` seed at extension load.

On socket disconnect, sessions bound to that socket are dropped — the next request re-picks based on current focus.

## Reserved action namespace

Action names starting with `__claudesurf_` are daemon-initiated internal RPC and rejected at the `/api` boundary, so MCP clients can't address them. Currently only `__claudesurf_get_focus` exists.

## Storage

`chrome.storage.session` — in-memory only, survives MV3 service worker restarts within a Chrome run, cleared on extension reload and Chrome restart. Keys:

- `session:<sessionId>` → `windowId` (per-session)
- `sessionName:<sessionId>` → `{ name, description }` (per-session)
- `lastFocusedAt` → millisecond timestamp (per-profile, not per-session)

No `chrome.storage.local`. No persistence across browser restarts by design — `chrome.storage.session` is cleared on restart, so windows aren't reattached even though the `SESSION_ID` is now stable.

## Non-obvious gotchas

- **`session.html` inline scripts are blocked by MV3 CSP.** All page logic must live in `extension/session.js` and be referenced via `<script src>`.
- **`chrome.windows.create({ focused: false })` is not honored on Linux/X11** — the dedicated window pops to foreground on creation. Subsequent ops (navigate, scroll, etc.) don't steal focus.
- **`chrome.tabs.captureVisibleTab(windowId)` captures whichever tab is active in that window.** If the user is viewing the pinned session tab, screenshot captures that, not the working tab.
- **`isSessionLandingPage(url)` short-circuits ops on any content-script-incapable URL** (`about:blank`, `chrome://*`, `chrome-extension://*`, `chrome-untrusted://*`, `devtools://*`, `view-source:*`, `file://*`) with a friendly "navigate first" message.
