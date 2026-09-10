# Use cases — browsing-overhaul

Behavioral scenarios: the exact system response to a specific situation. Permanent spec — HLDs and LLDs append rather than rewrite.

## Domain policy

### UC1 — Navigation to an unlisted domain

The agent calls `claudesurf_act` with `navigate` to a host absent from the policy file.

The daemon returns `needs_confirmation` carrying the host and the URL, without navigating. The agent ends its turn and asks the human in chat, naming the host and why it wants to go there. On approval the agent issues `policy` with `allow_always`, which the daemon appends to the policy file, then retries the navigation. If the human approves the visit but declines to persist it, the agent issues `policy` with `allow_once`, which grants the host to this session alone without touching the file. Another session reaching the same host asks on its own account, and a daemon restart drops the grant.

### UC2 — A click navigates off an allowed domain

The agent clicks a ref on an allowed page and the resulting navigation targets an unlisted host.

The daemon intercepts the navigation and cancels it before content loads, then returns `needs_confirmation` with the host and the ref that triggered it. Handling from there matches UC1. The page the agent clicked from remains loaded.

### UC2a — A link opens a new tab

The agent clicks a `target=_blank` link, or the page calls `window.open`. Chrome creates a new target, as a tab in the session's window or as a popup window; the daemon attaches to it paused, attributes it to the session through its opener, checks the destination host, and releases it only if the host is listed. The new target shows up in `tabs list`, but the working tab is unchanged until the agent switches to it deliberately. An unlisted destination returns `needs_confirmation` and the target is closed rather than left blank.

### UC3 — Page-context fetch to an unlisted domain

The agent calls `fetch` with a URL whose host is unlisted. The daemon gates it as in UC1 (unlisted host on `navigate`), before any request leaves the browser.

## Challenge handoff

### UC4 — A challenge blocks a navigation

A navigation completes onto a Cloudflare turnstile, a login wall, or a two-factor prompt.

The daemon's detection fires and the action returns `needs_human` carrying the challenge type, the URL, the page title, and the session name. A desktop notification fires naming the session and what is blocking; a window urgency hint is attempted and its failure ignored. No tool call blocks, and focus stays where it is. The agent ends its turn and tells the human which window needs her.

When the human says she has cleared it, the agent re-reads. The clearance cookie persists in the profile, so a later visit to the same site does not re-challenge.

### UC5 — Repeated challenge detection on one page

Detection fires more than once for the same session and URL within a short window. The notification fires once; subsequent detections return `needs_human` without re-notifying, so the channel stays credible.

### UC6 — Challenge detection fires on a page that is not a challenge

The agent receives `needs_human` for a page that loaded normally. `needs_human` reports a condition rather than locking the session, so the agent can read the page anyway.

## Refs

### UC7 — A ref is used after navigation

The agent reads a page, the page navigates, and the agent then acts on a ref from the earlier read.

The action returns `stale_ref` naming the ref and saying the document changed. Nothing is clicked. The agent re-reads to obtain fresh refs.

### UC7a — A ref from an earlier read of the same document

The agent reads, scrolls, reads again, then clicks a ref that appeared only in the first read. The document has not navigated, so the ref resolves and the click proceeds. A pushState or hash change between the reads leaves refs valid too.

### UC7b — A ref whose node has been removed

The agent clicks a ref from a read of the current document, but the page has since removed that element. The action returns `error` saying the element is gone, since the document is the same one the ref came from; `stale_ref` is reserved for a navigated document.

### UC8 — A ref is used against a different tab

The agent reads tab A, switches to tab B, and acts on a ref from A. Because refs are scoped to the target and document generation they were read from, the action returns the same `stale_ref` rather than resolving against whatever node in B shares the identifier.

## Session windows and tabs

### UC9 — The human closes the working tab

The agent's next action finds the session's recorded working target gone. The daemon creates a fresh working tab in the session's window, records it, and the action runs against it: a `navigate` proceeds, while an action that needs a loaded page returns the outcome that page state gives it — `error` saying to navigate first for a read or scroll, `stale_ref` for a click. Either way the agent is told the tab was recreated, since the previous page's state is gone. The new tab is the window's active tab, so the window shows the agent's page rather than the identity page, and the window comes to the front once as it is created.

### UC10 — The human closes the whole session window

The next action from that session recreates the window with its identity tab and a fresh working tab. The session label is held apart from window state, so the recreated window carries the name it had rather than coming back anonymous.

### UC11 — The agent tries to close the identity tab

`tabs` with `close` targeting a session's identity tab returns `error` naming the refusal. The window keeps its identity.

### UC11b — The human closes the identity tab

The session's working tab stays, and actions continue against it. The identity tab is not recreated: `info` notes that the window has no identity tab, and one returns when the whole window is recreated (UC10).

### UC11a — A page opens a JavaScript dialog

The page calls `alert`, `confirm`, or `prompt`. The renderer blocks until the dialog is answered, so the daemon dismisses it and the action returns with a note naming the dialog type and, inside the wrapped payload, what it said. The agent learns a page asked something rather than seeing a command time out.

A `beforeunload` dialog is accepted instead, so a navigation or a window close the human initiated proceeds.

## Reads

### UC12 — A page exceeds the read budget

A read produces more content than `max_chars` allows. The response carries the truncated content, the total size, what was dropped and why, and the parameter that retrieves the rest. Nothing is cut silently.

### UC13 — The page is still loading

A read lands on a single-page application that has rendered a skeleton. The response reports the page as unsettled rather than presenting the skeleton as the finished page, so the agent re-reads instead of concluding from placeholders.

## Browser lifecycle

### UC14 — The daemon restarts mid-session

systemd restarts the daemon. The browser, being its child, goes with it, closing every session window and the tabs in them. `server.js`'s retry loop rides out the restart, so the agent's next call succeeds against a freshly cold-started browser with a new window. Cookies and cleared challenges survive in the profile; open tabs and in-page state do not. The new daemon finds the previous run's browser record and announces the loss on the desktop, so the human learns a window went away rather than discovering it.

### UC15 — The browser exits while the daemon lives

Chrome is quit, killed, or crashes. The pipe reaches EOF. The daemon drops all window and target state, keeping session labels, and the next command from any session cold-starts a fresh browser with a fresh window carrying the session's name, as UC10's window-close path does.

Closing every session window is not this case: the pipe keeps Chrome alive with no windows, each closed window drops its own session's state as in UC10, and the next command creates a window in the idle browser.

### UC16 — A browser was orphaned by an unclean shutdown

The daemon starts and finds a recorded process id for a browser it no longer controls. It reaps that process before launching a new one, so profile lock contention does not accumulate.

### UC17 — The human has Chrome open against claudesurf's profile

A launch against a `--user-data-dir` already in use hands off to the running instance and the child exits with a dead pipe. The daemon returns `setup_error` naming the profile directory, rather than failing every subsequent tool call with a protocol error.

## Frames

### UC18 — A page embeds a cross-origin iframe

The agent reads a page carrying an embedded login, payment form, or comment widget. Because the daemon auto-attaches to child targets, the read includes that frame's content inline, marked so the agent knows a boundary was crossed and which origin it belongs to. Refs from inside the frame are scoped to that frame's target, so UC8's rule covers reuse against the parent document.

### UC19 — A challenge lives inside an iframe

A Cloudflare turnstile is a child target. Detection runs across attached targets rather than the page target alone, so the challenge is found and UC4 proceeds normally.

### UC19a — The agent clicks a download link

A click produces a file download rather than a document. The daemon declines it and the action returns saying so, since a download would write to the profile owner's disk on the agent's action and the domain gate never sees it. The refusal is reported from phase 4, where network capture can see the response; before that the download is denied silently and the click returns as one that changed nothing.

## Input

### UC21 — A scripted click changes nothing

The agent clicks a ref and the result reports the same URL and title and no change. The agent retries with `trusted: true`; the daemon dispatches real pointer events at the element's coordinates, which brings the session window to the front, and the page's handler receives a trusted event. The tool description tells the agent both facts, so a trusted click is a deliberate second attempt rather than the default.

## Untrusted content

### UC20 — A page contains text addressed to the agent

Page content includes instructions aimed at the agent rather than at a reader. That content arrives inside the nonce delimiter like all page-derived data. The delimiter marks the boundary; the domain allowlist enforces it. An action the injected text provokes toward an unlisted host is refused (UC1, UC2), and the log records every action taken.
