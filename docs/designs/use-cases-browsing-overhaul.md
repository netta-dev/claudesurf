# Use cases — browsing-overhaul

Behavioral scenarios: the exact system response to a specific situation. Permanent spec — HLDs and LLDs append rather than rewrite.

## Domain policy

### UC1 — Navigation to an unlisted domain

The agent calls `claudesurf_act` with `navigate` to a host absent from the policy file.

The daemon returns `needs_confirmation` carrying the host and the URL, without navigating. The agent ends its turn and asks the human in chat, naming the host and why it wants to go there. On approval the agent issues `policy` with `allow_always`, which the daemon appends to the policy file, then retries the navigation. If the human approves the visit but declines to persist it, the agent issues `policy` with `allow_once`, which grants the host to this session alone without touching the file. Another session reaching the same host asks on its own account, and a daemon restart drops the grant.

### UC2 — A click navigates off an allowed domain

The agent clicks a ref on an allowed page and the resulting navigation targets an unlisted host.

The daemon intercepts the navigation and cancels it before content loads, then returns `needs_confirmation` with the host and the URL, and with the click's own result lines, since the click ran. Handling from there matches UC1, with one caution in the message: before clicking again, the agent checks whether the click already did something, such as submitting a form whose redirect the gate stopped. The page the agent clicked from remains loaded.

### UC2a — A link opens a new tab

The agent clicks a `target=_blank` link, or the page calls `window.open`. Chrome creates a new target, as a tab in the session's window or as a popup window. The target's opener is in the session. The daemon therefore arms the gate on the target while Chrome holds it paused during attachment. The target's first document request waits at the gate for a destination-host check. The new target shows up in `tabs list`, but the working tab is unchanged until the agent switches to it deliberately. A target whose destination is unlisted is closed rather than left blank; the click returns `needs_confirmation` when it opened the tab, and a tab that the page opens on its own later is reported by a `Blocked by the page:` line on the next call (UC28).

### UC3 — Page-context fetch to an unlisted domain

The agent calls `fetch` with a URL whose host is unlisted. The daemon gates it as in UC1 (unlisted host on `navigate`), before any request leaves the browser: the result is `needs_confirmation` with the line `Blocked: [t1] api.other.example — fetch of https://api.other.example/v1/me (not sent)`, and the agent asks the human before calling `policy`.

### UC28 — A page navigates to an unlisted host while no action runs

An allowed page sets `location` from a timer a few seconds after the agent's last action returned, or opens a tab from a timer inside the few seconds of activation that a click gave it; without that activation, Chrome's popup blocker stops the tab before any target exists. The gate stops the request, so the page stays where it was, or the new tab is closed. Nothing is waiting on the result, so the refusal is held for the session, and the agent's next call carries a `Blocked by the page:` line naming the tab, the host, and the URL, with that call's own outcome unchanged. The agent did not ask to go there, so there is nothing to retry; the line tells it the page tried.

### UC29 — The human navigates a session tab to an unlisted host

The human types an unlisted URL into the address bar of a session's working tab. The gate cannot tell her navigation from the page's, so the request is aborted and the tab stays on its page with nothing on screen to say why. The README tells her to browse in a tab that she opens herself, which is outside the gate. During a handoff the stop is announced on the desktop instead (UC41).

### UC36 — `history back` onto a page whose host is no longer allowed

The agent visited an allowed host, moved on, and the human then removed that host from the allowlist. `history back` checks the entry's host before navigating and returns `needs_confirmation`, since a page that the back-forward cache restores doesn't make a request that the gate could stop. Had the page script gone back instead, the gate's commit check would have seen the restored page and sent the tab to `about:blank`, with a `Blocked by the page:` line on the next call.

## Challenge handoff

### UC4 — A challenge blocks a navigation

A navigation completes onto a Cloudflare turnstile, a login wall, or a two-factor prompt.

The daemon's detection fires and the action returns `needs_human`. The message names the type and the session's label, and the payload carries the action's full result with a `Challenge:` line, such as `Challenge: bot check — Cloudflare (the page's cf-mitigated header)`, `Challenge: sign-in — a password field`, or `Challenge: two-factor — a one-time-code field`. A desktop notification fires naming the session and what is blocking; a window urgency hint is attempted and its failure ignored. No tool call blocks, and focus stays where it is. The agent ends its turn and tells the human which window needs her. The second OS user has no notification server, so its handoff reaches the human through chat alone.

When the human says she has cleared it, the agent re-reads. That call ends the handoff and clears the urgency hint. The clearance cookie persists in the profile, so a later visit to the same site does not re-challenge.

### UC5 — Repeated challenge detection on one page

Detection fires more than once for the same session, type, and page, its URL compared without the query or fragment, within 10 minutes. The notification fires once; subsequent detections return `needs_human` without re-notifying, so the channel stays credible.

### UC6 — Challenge detection fires on a page that is not a challenge

The agent receives `needs_human` for a page that loaded normally, such as a sign-up form, which shows a password field. `needs_human` reports a condition rather than locking the session, so the agent can read the page and act on it anyway; the message says so.

### UC40 — A challenge that clears itself

A navigation lands on Cloudflare's "Just a moment…" page, whose response carries `cf-mitigated: challenge`, and the check passes without a click a few seconds later, reloading the original page. The acting call waits up to 10 s, within its request budget, for a navigation to start from the challenge page, follows it, and returns the original page as `success` without a notification. A challenge still in place when the wait ends returns `needs_human` (UC4). An AWS WAF `captcha` answer gets no wait, since a person has to solve it.

### UC41 — Signing in through an unlisted host during a handoff

The agent navigated to an allowed app whose sign-in, which the human allowed when the agent asked, forwards her to her company's identity provider, a host the allowlist lacks. The gate stops that request in the session tab, as in UC29. A handoff is open, since the session's last result was `needs_human` and its next call hasn't arrived, so the daemon fires a notification, "ClaudeSurf stopped adfs.company.com", whose body reads "In "reviewing PR #42". Sign in from a tab you open yourself (Ctrl+T), which shares the cookies, or ask Claude to allow adfs.company.com." She opens a tab of her own in the ClaudeSurf window, signs in there, and tells the agent, which reloads the session tab, now signed in. The refusal also prints as a `Blocked by the page:` line on the agent's next call. A session gets one notice per host and at most three notices in 10 minutes.

### UC42 — A CAPTCHA embedded in a form the agent fills

The agent reads a sign-up form carrying a visible reCAPTCHA checkbox. The widget's response field is empty, so the read returns `needs_human` with `Challenge: bot check — reCAPTCHA (a visible widget)`. The agent can fill the other fields first, then asks the human to tick the box. Once she has, the response field holds a token, the widget counts as solved, and the agent's next call returns `success`. A badge-only, invisible widget doesn't count.

## Refs

### UC7 — A ref is used after navigation

The agent reads a page, the page navigates, and the agent then acts on a ref from the earlier read.

The action returns `stale_ref` naming the ref and saying the document changed. Nothing is clicked. The agent re-reads to obtain fresh refs.

### UC7a — A ref from an earlier read of the same document

The agent reads, scrolls, reads again, then clicks a ref that appeared only in the first read. The document has not navigated, so the ref resolves and the click proceeds. A pushState or hash change between the reads leaves refs valid too.

### UC7b — A ref whose node has been removed

The agent clicks a ref from a read of the current document, but the page has since removed that element. The action returns `error` saying the element is gone, since the document is the same one the ref came from; `stale_ref` is reserved for a navigated document.

### UC8 — A ref is used against a different tab

The agent reads tab A, switches to tab B, and acts on a ref from A. Until the agent reads B, every ref returns `stale_ref` saying the working tab changed, rather than resolving against whatever node in B shares the identifier. Once B has been read, a ref is taken as B's, since a ref doesn't name a tab: a ref from A resolves in B when B's read also returned its number.

## Session windows and tabs

### UC9 — The human closes the working tab

The agent's next action finds the session's recorded working target gone. If an earlier working tab is still open and still the session's, UC35 (a sign-in popup closes itself) applies. Otherwise the daemon creates a fresh working tab in the session's window, records it, and runs the action against it: a `navigate` proceeds, while an action that needs a loaded page — a read, `click`, `type`, `select`, `press`, `scroll`, or `history` — returns `error` saying to navigate first because the page is blank. Either way the agent is told the tab was recreated, since the previous page's state is gone. The new tab is the window's active tab, so the window shows the agent's page rather than the identity page, and the window comes to the front once as the tab is created.

### UC10 — The human closes the whole session window

The next action from that session recreates the window with its identity tab and a fresh working tab. A session that is working in a popup outside the window when the window closes keeps working there until the popup closes too, and the next action after that recreates the window. The session label is held apart from window state, so the recreated window carries the name it had rather than coming back anonymous.

### UC11 — The agent tries to close the identity tab

`tabs` with `close` targeting a session's identity tab returns `error` naming the refusal. The window keeps its identity.

### UC11b — The human closes the identity tab

The session's working tab stays, and actions continue against it. The identity tab is not recreated: `info` notes that the window has no identity tab, and one returns when the whole window is recreated (UC10).

### UC11a — A page opens a JavaScript dialog

The page calls `alert`, `confirm`, or `prompt`. The renderer blocks until the dialog is answered, so the daemon dismisses it and the action returns with a note naming the dialog type and, inside the wrapped payload, what it said. The agent learns a page asked something rather than seeing a command time out.

A `beforeunload` dialog is accepted instead, so a navigation or a window close the human initiated proceeds.

### UC35 — A sign-in popup closes itself while it is the working tab

The agent clicks "Sign in with …" and the page opens a popup. The agent switches to it with `tabs switch` and signs in, and the popup calls `window.close()`. The next action finds the working tab gone and the tab that the agent switched from still open, so that tab becomes the working tab again and the action runs there, with the note `the working tab closed; t1 is the working tab again`. A session that never switched and never opened a tab with `tabs new` does not have an earlier tab to return to, so UC9 (the human closes the working tab) applies and the daemon creates a fresh working tab.

## Reads

### UC12 — A page exceeds the read budget

A read produces more content than `max_chars` allows. The response carries the truncated content, the total size, what was dropped and why, and the parameter that retrieves the rest. Nothing is cut silently.

### UC13 — The page is still loading

A read lands on a single-page application that has rendered a skeleton. The response reports the page as unsettled rather than presenting the skeleton as the finished page, so the agent re-reads instead of concluding from placeholders.

### UC24 — `article=true` on a page with no article

The agent asks for the article on a dashboard or a listing page. Readability finds no candidate. The response renders the default scope instead, with a header line `Article: none found` and the `Scope:` line naming what rendered, so the agent gets the page and knows the extraction did not apply.

### UC25 — A read of a page with no landmarks

The page has no `main`, `article`, or other landmark. When Readability judges it readerable, the read renders its article candidate and the `Scope:` line reads `readability`, with the controls outside the article counted as omitted; otherwise the whole body renders and the line reads `body`.

### UC26 — The renderer throws on a page

Turndown, Readability, or the clone walk raises on an unusual DOM. The read returns `error` with the agent's recourse: `scope=all` or `scope=<ref>` to render a different subtree, `article=false` if it was set, or `screenshot`. The exception text goes to the daemon's journal rather than the message, since a page can shape it. The read doesn't fall back to a flat read; the page is unreadable as text until one of those works.

### UC27 — `find` matches nothing

The agent passes a `find` needle absent from the scoped render. The header reads `0 blocks`, the region is empty, and no truncation line prints. A match in an omitted landmark needs `scope=all`, which the tool description says.

### UC37 — `since` after the page changed on its own

The agent reads a CI run's page, waits, and reads again with `since=true`. The daemon renders the page with the first read's scope and diffs it against that read: the region holds only the changed lines, with one line of context each, and the header says `Since: 1 line added, 1 removed`. The new render becomes the one that the next `since` compares against. Without an earlier read of this document, the header says so and the whole page follows.

### UC38 — Paging through a long read of a page that keeps changing

A read of a feed is cut at `max_chars`, and the agent passes the offset that the truncation line gave. The daemon slices the region that it rendered for the first read rather than rendering the feed again, so the second part starts where the first ended although new items arrived meanwhile. An action between the two reads replaces that region with its own change summary's render, and the second read's header says so. The state lines are read fresh. A later read without `offset` renders the feed as it is now.

## Browser lifecycle

### UC14 — The daemon restarts mid-session

systemd restarts the daemon. The browser, being its child, goes with it, closing every session window and the tabs in them. `server.js`'s retry loop rides out the restart, so the agent's next call succeeds against a freshly cold-started browser with a new window. Cookies and cleared challenges survive in the profile; open tabs and in-page state do not. The new daemon finds the previous run's browser record and announces the loss on the desktop with one notification, "ClaudeSurf restarted. Its browser closed, with any session windows it had open. Each Claude session reopens its window on its next call.", so the human learns a window went away rather than discovering it. The announcement goes out before any request arrives, so it uses the daemon's own session bus, and it fires after every restart that found a record, an upgrade's included.

### UC15 — The browser exits while the daemon lives

Chrome is quit, killed, or crashes. The pipe reaches EOF. The daemon drops all window and target state, keeping session labels, and the next command from any session cold-starts a fresh browser with a fresh window carrying the session's name, as UC10's window-close path does.

Closing every session window is not this case: the pipe keeps Chrome alive with no windows, each closed window drops its own session's state as in UC10, and the next command creates a window in the idle browser.

### UC16 — A browser was orphaned by an unclean shutdown

The daemon starts and finds a recorded process id for a browser it no longer controls. It reaps that process before launching a new one, so profile lock contention does not accumulate.

### UC17 — The human has Chrome open against claudesurf's profile

A launch against a `--user-data-dir` already in use hands off to the running instance and the child exits with a dead pipe. The daemon returns `setup_error` naming the profile directory, rather than failing every subsequent tool call with a protocol error.

## Frames

### UC18 — A page embeds a cross-origin iframe

The agent reads a page carrying an embedded login, payment form, or comment widget. Because the daemon auto-attaches to child targets, the read includes that frame's content inline, marked so the agent knows a boundary was crossed and which origin it belongs to. Refs from inside a frame Chrome runs as its own target (a cross-site frame) carry a frame prefix (`f1e42`) and are scoped to that frame's target, so UC8's rule covers reuse against the parent document; a frame in the page's own renderer, cross-origin or not, has plain `e42` refs scoped to the page.

### UC22 — A frame the read cannot render

A frame has no attached target yet, is `about:blank`, fails its tree pull, or misses the request deadline, or the page carries more frames than the read renders. The frame's position in the output shows `[e40 frame url (not readable)]` or `[e40 frame url (not read: frame limit)]`, the ref being the iframe element's so `scope=e40` reads that frame alone, and the rest of the page is delivered; a frame never fails a read.

### UC23 — A trusted click on a frame ref

The agent clicks an `f`-prefixed ref with `trusted: true`. The action returns `error` saying trusted clicks inside cross-site frames are not supported yet and that a scripted click is. A scripted click on the same ref runs inside the frame.

### UC23a — A frame ref after the parent navigates

The parent page navigates, so Chrome destroys its frame targets. A click on an `f`-ref from the earlier read returns `stale_ref` saying the frame is gone. If instead the frame alone navigated, the ref returns `stale_ref` saying the frame's document changed.

### UC19 — A challenge lives inside an iframe

A Cloudflare turnstile is a child target. Detection runs across attached targets rather than the page target alone: a frame target whose URL belongs to a known CAPTCHA vendor, and whose `<iframe>` element in its parent is visible, counts, even when the page put the element in a closed shadow root. The challenge is found and UC4 proceeds normally.

### UC19a — The agent clicks a download link

A click produces a file download rather than a document. The daemon declines it and the action returns saying so, since a download would write to the profile owner's disk on the agent's action and the domain gate never sees it. The result carries `Download: denied — report.pdf from https://app.example/export`, from the file name and URL that Chrome's download event reports.

## Input

### UC21 — A scripted click changes nothing

The agent clicks a ref and the result reports `Changed: nothing`. The agent retries with `trusted: true`; the daemon dispatches real pointer events at the element's coordinates, which brings the session window to the front, and the page's handler receives a trusted event. The tool description tells the agent both facts, so a trusted click is a deliberate second attempt rather than the default.

### UC30 — A click opens a menu

The agent clicks a toolbar's "More" button. The page settles, the daemon renders the page again with the last read's scope, and the result's `Changed:` section lists the menu's items as added lines, each with its ref. The re-render recorded those refs, so the agent clicks "Delete" from the summary without reading the page first.

### UC39 — A click opens a modal dialog outside the main content

The agent clicks "Delete repository" in a settings page's main content, and the page's dialog library appends a confirmation dialog to the end of `<body>`, outside `<main>`. The action's change summary renders the scope that the agent last read, which is `main`. It renders every open dialog as a block of its own, and under a `main` scope it renders every open menu, alert, or status message outside the scope the same way. It prints the blocks' changes first. So the dialog arrives as added lines at the top of the summary: its text, its confirmation textbox, and its buttons, each with a ref. That holds when the dialog is a native modal or the library hides the rest of the page from the accessibility tree as it opens. A later default read carries an `Overlays:` line naming the dialog and renders it ahead of the page. The agent answers the dialog instead of retrying the click.

### UC31 — An action on a page that never settles

The agent clicks on a page whose ticker rewrites a line of text every 100 ms. The document keeps changing past the 5 s settle budget, so the action returns `unsettled` with its full result and the line `Settled: no — after 5.0 s, the document is still changing`. The outcome is not an error: the agent reads the result as it would a success, knowing the page was still moving when it was taken.

### UC32 — `type` into a field that already holds text

The agent types `new@example.com` into an email field holding `old@example.com`. The field ends up holding exactly the new text, since `type` selects the field's content before inserting. Empty text clears the field. `type` does not press Enter; the agent calls `press` with `Enter` to submit. A ref naming a checkbox, a date input, or a disabled or read-only field returns `error` naming the reason.

### UC33 — `press` with nothing focused

The agent presses `Escape` to close a dialog without focusing anything first. The keys go to the page, and the result's header reads `Keys to: the page (nothing focused)`, so the agent can tell a page-level shortcut from a key that went into a field.

### UC34 — `select` on a dropdown that is not a native `<select>`

The agent calls `select` with a ref naming a styled listbox that the page built from `div`s. The action returns `error` saying the control is not a native select and to click it open and then click the option's ref. The click's summary lists the list's options with their refs when the list renders inside the read's scope (UC30, a click opens a menu); a list that the page attaches outside it shows in a `scope=all` read.

## Capture and fetch

### UC43 — `console` after a click that broke the page

The agent clicks "Save" and the result reads `Changed: nothing`. It calls `console` and gets the messages that the working tab kept, across its navigations, oldest first, each numbered: a `console.error` from the page's script with its source location, and Chrome's own `Failed to load resource: … 500` for the request behind it. The head's `Exceptions:` line reads `Uncaught at https://app.example/main.js:1:20334 (×1), from the messages Chrome stores for this document` for the exception that followed. The line carries no message, since only Chrome's replay of the document's stored messages reports an exception, and the replay gives its location alone. The answer's head carries `Next: after=64`, and a later `console` with `after=64` returns only what came after. Capture never turns on the protocol's `Runtime` channel, so the page can't tell that it is being watched.

### UC44 — `network` to see what an API answered

After the same click the agent calls `network` and sees `[61] POST 500 fetch https://app.example/api/save (application/json, 87 B transferred, 220 ms)` among the tab's requests. It calls `network` with `filter=/api/save`, which lists the matching requests and prints the text body of each under its line, cut at 4,000 characters, so the agent reads the server's error. The request's own body, such as a form's fields, is never captured.

### UC45 — The human signs in while capture runs

During a handoff the human types her password into a sign-in form in a session tab and submits it. The form's post is listed by `network` with its URL and status like any request, while its body, which carries the password, is never stored. The responses of the sign-in, an OAuth callback's URL included, stay readable, as the HLD's secrets decision accepts.

### UC46 — `fetch` of another origin's API

The agent is on `app.example.com` and fetches `https://api.example.com/v1/orders`, an allowed host whose server allows `app.example.com`'s origin. The two hosts are one site, so the request carries the page's origin and `api.example.com`'s cookies, and the result prints the status, type, size, and body; a host of another site would get only its `SameSite=None` cookies. A server that doesn't allow the page's origin makes the request fail; the result is `error` saying so, and telling the agent to navigate to that origin and fetch there.

### UC47 — `fetch` of a URL that redirects

The agent fetches a URL on an allowed host that answers with a redirect. The fetch doesn't follow it, so no request reaches the redirect's target, and the result reads `Redirected: not followed`. The browser hides a redirect's target from page script, so the result can't name it; the agent navigates to the URL to follow the redirect through the gate.

## Untrusted content

### UC20 — A page contains text addressed to the agent

Page content includes instructions aimed at the agent rather than at a reader. That content arrives inside the nonce delimiter like all page-derived data. The delimiter marks the boundary; the domain allowlist enforces it. An action the injected text provokes toward an unlisted host is refused (UC1, UC2), and the log records every action taken.
