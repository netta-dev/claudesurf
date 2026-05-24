# Per-session windows

**Last reviewed**: 2026-05-19
**Status**: Project complete

## Overview

Today the Chrome extension targets `chrome.tabs.query({ active: true, currentWindow: true })`, so claudesurf operations follow whichever Chrome window has OS focus at the moment of the call. As soon as the user clicks into another browser window, that window becomes claudesurf's target — making it impossible to browse normally while Claude is working.

This project gives each Claude Code session a dedicated Chrome window. A session ID generated in `server.js` flows through the daemon to the extension, which maintains a per-session window mapping and creates a fresh window on first use (or after the window has been closed). All tab operations target the session's window via explicit `windowId`, never `currentWindow`. Multiple concurrent Claude sessions get fully isolated windows.

Multi-profile support layers on top: the daemon tracks every connected extension (one per profile) and binds each new session to whichever profile was most recently OS-focused, so opening a Claude session in your work profile spawns its window in the work profile.

## Key decisions

- **Session ID generated in `server.js` at startup (UUID).** Stable for the life of one MCP process; dies with the Claude session. No persistence needed.
- **Session→window mapping stored in `chrome.storage.session`, not `local`.**
  - MV3 service workers die on idle, taking module-level `Map`s with them; `chrome.storage.session` survives worker restarts but clears on Chrome restart, which exactly matches the lifetime we want. No prune logic, no disk writes.
- **Daemon binds sessions to profiles via most-recently-focused at first-use.**
  - Mirrors today's "follow my focus" intuition but lifts it from per-call to per-session-once. Once bound, the session sticks with that profile so the user can wander freely. Fallback if no profile has ever reported focus: first-connected extension.
- **No env var / no popup UI.** Earlier draft considered an explicit `CLAUDESURF_PROFILE` override and an extension options page for naming profiles. Dropped — focus-based routing covers the multi-account case without any user setup.
- **Closed dedicated windows auto-recreate; closed sessions leave windows open.** Window is a render target, not a session anchor. Closing it mid-session is a no-op until the next tool call, which spins up a replacement. Closing a Claude session leaves the window for the user to clean up (its tabs may hold work the user wants).
- **Initial tab of a new dedicated window is an extension-hosted page** showing the short session ID and start time, so two+ dedicated windows are visually distinguishable in the taskbar/title bar.
- **Window created with `focused: false`** so spawning doesn't steal focus from whatever the user was doing.

## Requirements

1. Each MCP server generates a session ID at startup and tags every request with it.
2. Daemon forwards session ID to the chosen extension.
3. Daemon supports multiple concurrent extension connections (not last-wins).
4. Daemon binds a new session to the extension whose profile was most recently OS-focused.
5. Extension maintains `sessionId → windowId` in `chrome.storage.session`.
6. On each action: create a new dedicated window if none mapped or the mapped one no longer exists; otherwise reuse.
7. All tab operations target the active tab inside the session's window (`{ active: true, windowId }`); `currentWindow` is no longer used.
8. Ending a Claude session leaves its window open; closing the window is fine — next call auto-recreates.
9. New dedicated windows open with `focused: false` and load an extension-hosted intro page showing the short session ID + start time.
10. No persistence across Chrome restarts.
11. The dedicated window contains a pinned `session.html` marker tab + a separate working tab (`about:blank` initially) so the window identity survives navigation. All ops target the active non-pinned tab (with most-recently-accessed-non-pinned fallback if the user clicks the pinned tab).
12. The `navigate` tool requires a session `name` (and accepts optional `description`); the pinned tab renders these live via `chrome.storage.onChanged`. Same value = no-op. Omitted description preserves the previous value.

## Phases

### Phase 1 — Per-session dedicated windows (single profile) (40%) · 7ec34ee

Ships the core feature inside a single Chrome profile: session IDs flow end-to-end, the extension creates one dedicated window per session and routes all tab ops there. Daemon connection model stays last-wins (single extension assumption) — multi-profile is Phase 2. After this phase the user can no longer steal claudesurf's target by clicking into another window in the same profile, and concurrent Claude sessions are isolated.

**Key decisions:**
- **Session ID = UUID generated once in `server.js`** module top-level. Passed as a top-level field on the JSON body to `/api` (e.g., `{ sessionId, action, params }`).
- **Daemon passes `sessionId` through unchanged** to the extension in the WebSocket message envelope.
- **Window create uses an `chrome-extension://…/session.html` URL** loaded from the extension package (new file).
- **`get_page_info` and friends keep their existing semantics** — they just operate on the session's window's active tab instead of the OS-focused window's active tab.

**Key files:**
- `server/server.js` (modified — generate UUID, include in `sendToDaemon` body)
- `server/daemon.js` (modified — accept `sessionId` from HTTP, forward in WS message envelope)
- `extension/background.js` (modified — read `sessionId` from message, manage `chrome.storage.session` map, create/reuse window, retarget all `chrome.tabs.query` calls to use explicit `windowId`)
- `extension/session.html` (new — minimal intro page; receives session ID + start time via URL params or `chrome.storage.session`)
- `extension/manifest.json` (modified if needed — verify `windows` permission isn't required separately from `tabs`; add `web_accessible_resources` for `session.html` if needed)

All Phase 1 open questions resolved in the LLD. See `lld-1-per-session-dedicated-windows-single-profile.md`.

---

### Phase 2 — Multi-profile routing (20%) · 544a198

Layers multi-profile support on top of Phase 1. Daemon stops treating extensions as singletons; each profile's extension is tracked separately and the daemon picks one per session based on which profile had OS focus most recently. After this phase, opening a Claude session while working in your "personal" profile spawns its dedicated window there, and a different session opened while in "work" spawns there instead — fully isolated multi-account browsing.

**Key decisions:**
- **Focus tracking lives in each extension.** Extension subscribes to `chrome.windows.onFocusChanged` and stores the latest "this profile gained focus" timestamp in `chrome.storage.session` (so it survives worker death).
- **Daemon picks the profile at first-use, not per-call.** When a request arrives with a `sessionId` it hasn't seen, daemon probes all connected extensions for their `lastFocusedAt` and binds. Subsequent requests for that session route deterministically to the bound socket.
- **No identity / naming.** Daemon never needs to know "this is the work profile" — it just routes by socket. Email or profile name is not exposed.
- **Fallback when nothing has been focused yet** (cold Chrome start, no focus events fired): pick the first-connected extension. Logged to daemon stderr for debugging.

**Key files:**
- `server/daemon.js` (modified — `extensionSocket` becomes a `Set` of all connected sockets; new `sessionBindings: Map<sessionId, socket>`; new RPC to query extensions for focus timestamp; route logic in `sendToExtension`)
- `extension/background.js` (modified — register `chrome.windows.onFocusChanged` handler, store timestamp in `chrome.storage.session`, respond to a new daemon-initiated `__getFocusTimestamp` message)

All Phase 2 open questions resolved in the LLD. See `lld-2-multi-profile-routing.md`.

---

## Effort breakdown

| Bucket | Est % | Norm Est % | Actual % | Drift | Chars | Files | +/- | Est. time |
|---|---|---|---|---|---|---|---|---|
| brainstorm | 15 | 15.0 | 66.3 | +51.3 | 5533 | — | — | 1h 32m |
| hld | 5 | 5.0 | 3.1 | -1.9 | 255 | 1 | +110/-0 | 6m |
| phase 1: Per-session dedicated windows | 40 | 40.0 | 28.1 | -11.9 | 2342 | 10 | +310/-36 | 59m |
| phase 2: Multi-profile routing | 20 | 20.0 | 0.6 | -19.4 | 51 | 4 | +103/-24 | 1m |
| unexpected | 10 | 10.0 | 0.1 | -9.9 | 10 | 2 | +368/-0 | 0m |
| wrap-up | 10 | 10.0 | 1.8 | -8.2 | 152 | 6 | +49/-38 | 4m |
| **Total** | 100 | | | | 8343 | 23 | +940/-98 | **2h 42m** |

---

## Future improvements (out of scope)

- Manual window claim via extension popup ("use this existing window for the current session").
- Per-session window position memory (`chrome.storage.local`).
- Cross-profile session migration (move a session's binding to a different profile mid-flight).
- Explicit `CLAUDESURF_PROFILE` env var override if focus-based routing proves insufficient.
- Pretty session UI: session.html could embed a live log of recent actions for visibility.
