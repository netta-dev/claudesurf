# Architecture

## Modules

- **`server/server.js`** — MCP stdio bridge, one per Claude Code session. Validates calls with `dispatch.js`, POSTs `{sessionId, tool, action, args, env}` to the daemon over the `0600` Unix socket, renders the envelope with page text inside the nonce delimiter, and maps its own failures onto outcomes (unreachable daemon → `setup_error`, request timeout → `error`). `sessionId` comes from `CLAUDE_CODE_SESSION_ID` so a respawned bridge reuses its window.
- **`server/daemon.js`** — one per OS user: the HTTP server on the socket, the action handlers, and `ensureBrowser` (coalesced launch; retains the last request's graphical environment).
- **`server/dispatch.js`, `envelope.js`, `diagnostics.js`, `paths.js`** — loaded by both: the action table with validation and tool definitions, the outcome vocabulary, the leveled stderr logger (journald `<N>` prefixes under `JOURNAL_STREAM`), and the socket, profile, and record paths with their overrides plus the graphical-variable allowlist the bridge forwards.
- **`server/cdp.js`** — the protocol client: NUL-delimited JSON over the pipe's fds 3 and 4, id correlation, `sessionId` routing, event fan-out, timeouts and deadlines, EOF and pipe error both as close.
- **`server/browser.js`** — binary lookup, graphical environment, launch and handshake, the browser record, orphan reap, `enableTargets` (auto-attach and download denial).
- **`server/sessions.js`** — `Session` records (window, identity and working targets, label, queue, notes, ref sets, page-opened targets) and the target registry (window, generation, isolated world, load and navigation counters, dialogs). Window creation and repair live here.
- **`server/read.js`** — `page` (walk, refs, payload assembly), `info`, `screenshot`. **`server/input.js`** — `navigate`, `click`, `scroll`. **`server/action-support.js`** — what both share: `OutcomeError`, the state lines, the working-target lookup, the http check, the page-state read, and the page-script sources.
- **`server/page/*.js`** — page-side scripts (walk, click, scroll) run in the browser and sent as source; never `require`d. `state.js` holds the one definition of hidden and disabled and is spliced into walk and click at their `// @include state.js` line by `action-support.js`.
- **`server/static/session.html`** — the session page both tabs start on, addressed by `file://`; role, session id, and start time in the URL fragment; `render(name, description)` for the label; two `target=_blank` links to itself that the daemon clicks to open the other role's tab.

## Request flow

`validate` → `ensureBrowser` (one launch for a burst of first calls) → `sessions.ensure(sessionId)` (serialized per session, creates or repairs the window) → the handler under the session's queue → notes and dismissed-dialog lines added → envelope. The bridge times out at 35 s; the daemon runs every request under a 33 s deadline (launch 15 s, window creation 5 s, `navigate` load ≤ 25 s or what remains minus 2 s).

## Targets and attach

`Target.setAutoAttach` runs with `flatten` and `waitForDebuggerOnStart` for `page` and `iframe` targets. The attach handler records the target, queues `Browser.getWindowForTarget`, `Page.enable`, and `Emulation.setFocusEmulationEnabled`, sends `Runtime.runIfWaitingForDebugger`, and only then awaits the queued commands: awaiting first deadlocks on a noopener-opened tab, whose `Page.enable` answers only after the commit the pause holds back. A target whose URL is the session page with `#role=<identity|working>&session=<id>` is claimed for that role, at attach or on its first main-frame `Page.frameNavigated` (or from `Page.getFrameTree` when the attach carried no URL); otherwise a target with an `openerId` owned by a session is recorded as page-opened under that session; anything else stays unowned.

## Session windows

`Target.createTarget({newWindow: true, background: true})` opens the session page as the working tab. The identity tab is opened from it by Ctrl-clicking the page's identity link with real mouse events (`modifiers: 2`), which yields a background tab, so the working tab stays active. Repairs on the next `ensure`: working tab gone and identity page intact → a scripted `userGesture` click on the identity page's working link (a foreground tab, in whatever window the identity tab now sits); working tab gone and identity tab gone or navigated away → the whole window recreated under the retained label; identity tab gone alone → left absent; identity tab failed at window creation while the working tab came up → reopened in place from the working tab's link on the next `ensure` (note "identity tab was recreated"), or left absent when that fails again or the working tab has left the session page (note "identity tab could not be recreated; it returns with the next window"). Pipe EOF drops every window and target; labels survive.

## Refs and worlds

A ref is `e<backendDOMNodeId>`. Each session keeps a `{generation, ids}` set per target: the union of every id a read found at that generation. The generation increments on a main-frame `Page.frameNavigated` only (pushState leaves it). A click against a set of another generation returns `stale_ref`; an id not in the set, or one that no longer resolves, returns `error`. Every page-side script runs in one isolated world per target and generation (`Page.createIsolatedWorld`, world name `claudesurf`), recreated once when a command reports the context missing; the one main-world call is `render` on the session page.

## Dialogs, clicks, downloads

`Page.javascriptDialogOpening` is answered at once (`accept: false`, `beforeunload` accepted) and queued on the target; the daemon appends `Dialog (<type>): <message>` to the next payload. After a click the daemon waits up to 300 ms for `Page.frameStartedNavigating` with a cross-document `navigationType`, then up to 10 s (cut to 2 s before the request deadline) for the load event; `Page.downloadWillBegin` ends the wait, since a denied download never commits. The waits are event-driven (`Sessions.waitUntil`, notified on every counted event). A load that misses the wait reports `Navigated: started`. A target attributed to the session during the wait is reported as a tab (same `windowId`) or a popup.

## Storage

Persistent state is the Chrome profile directory and the browser record beside the socket (`<socket basename>.browser.json`, `{pid, startTime}`): written at launch, cleared on pipe close, left in place on daemon exit. The next daemon reaps the recorded browser if it outlived its pipe and otherwise clears the record.

## Non-obvious gotchas

- `Input.dispatchMouseEvent` raises the session window; so does any page-initiated target creation. Scripted clicks, keys, navigation, and screenshots don't.
- Input into a tab that is not its window's active tab stalls about 5 s per event without `Emulation.setFocusEmulationEnabled`; every attached page target gets it.
- `Runtime.enable` and `DOM.enable` are never sent: everything used works without them, and `Runtime.enable` is detectable by page script.
- `document.visibilityState` reports `visible` on both tabs in headful, so it can't tell the active tab; the X window title can. A screenshot of the inactive tab takes about 3 s and later ones can time out.
- Chrome exits when the pipe closes, so a daemon exit takes the browser with it; the record and reap path covers the case where it doesn't.
- `Page.enable` on a paused noopener-opened tab answers only after the release.
- `Target.targetInfoChanged` needs `Target.setDiscoverTargets`, which is not enabled; URL changes come from `Page.frameNavigated`, whose `frame.url` omits the fragment (`frame.urlFragment` carries it).
- `Page.frameStartedLoading` also fires for pushState; `Page.frameStartedNavigating` carries the `navigationType` that tells them apart.
- `--no-startup-window` plus the pipe keep Chrome alive with zero windows.
- Exit code 21 before the handshake means the profile is held by another instance.
