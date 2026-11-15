# ClaudeSurf

An MCP server that lets Claude Code read and act on web pages in a dedicated Chrome. The daemon launches and owns that Chrome over `--remote-debugging-pipe`, without an extension or a debugging port. The profile persists, so sites stay signed in across sessions.

Each Claude Code session gets its **own Chrome window**, so Claude browses without taking over the window you are using. Claude's tabs load pages only from hosts on an allowlist you approve, and the daemon logs every call the bridge forwards to it.

## Architecture

```
Claude Code session 1 ── server.js ─┐
Claude Code session 2 ── server.js ─┼─ (Unix socket) ─ daemon.js ─ (pipe) ─ Chrome ─┬─ Window: session 1
Claude Code session N ── server.js ─┘                                               ├─ Window: session 2
                                                                                    └─ …
```

- **`server/server.js`** — MCP stdio bridge, one per Claude Code session. Exposes the two tools, validates calls, forwards them to the daemon over the per-user Unix socket (`$XDG_RUNTIME_DIR/claudesurf.sock`, mode `0600`), and wraps page-derived text in the nonce delimiter. It keys the session by Claude Code's own session id (`CLAUDE_CODE_SESSION_ID`, falling back to a hash of `CLAUDE_PROJECT_DIR`, then a random id), so a respawned bridge reuses its window.
- **`server/daemon.js`** — one persistent process per OS user. Launches Chrome as its child with a dedicated `--user-data-dir`, speaks the DevTools protocol over the pipe, runs every action, enforces the allowlist on the session tabs, and logs every call it receives. The browser idles with zero windows after you close the last session window, so the next call reuses it without a cold start.

### Session windows

The first call from a session, other than a `policy` call, creates a window with two tabs:

- The **working tab** — where Claude navigates and acts. Until the first `navigate` it shows the session page.
- The **identity tab** — the second tab, with a distinctive favicon and the session name as its title, so you can tell windows apart.

The tabs that the session's pages open, and the tabs Claude opens with `tabs new`, belong to the session too. `tabs list` names each one `t<n>`, and `tabs switch` moves Claude's work to one of them.

Each call except `policy` first repairs the window. If you close the working tab, the next call returns Claude to the most recent tab it left with `tabs switch` or `tabs new` that is still open, and its result carries a note saying so; when none is open, the call recreates the working tab. The window's state lasts while the working tab or another of the session's tabs remains in the window. If you close the whole window, the next call recreates it under the same name, unless Claude is working in a popup outside the window: Claude keeps working there until the popup closes. If you close only the identity tab, it stays closed until the window is next recreated.

## Setup

Requires Node 22 or newer and Chrome (tested with Chrome 156). Install the dependencies the renderer injects into the page:

```bash
npm --prefix server ci --ignore-scripts
```

They are Readability, Turndown, and Turndown's GFM plugin, which the daemon reads from `server/node_modules` and evaluates in the page's isolated world. The lockfile pins four packages, none of which ships an install script; `--ignore-scripts` keeps a future one from running.

### 1. Run the daemon

As a systemd user service:

```bash
mkdir -p ~/.config/systemd/user
cp ~/workspaces/claudesurf/systemd/claudesurf.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now claudesurf
```

The unit uses `%h/workspaces/claudesurf`, so one unit works for any user's clone; adjust the path if your clone lives elsewhere.

Without systemd, run `node ~/workspaces/claudesurf/server/daemon.js` from a terminal in your desktop session, or from your session's autostart, and leave it running; the bridge reaches it through the same socket. A daemon started this way inherits the display from its shell, so the graphical-environment note below doesn't apply to it.

**Graphical environment.** The daemon launches a headful Chrome, so it needs `DISPLAY` (or `WAYLAND_DISPLAY`). The unit ships without display values, and one of three things supplies them:

1. A desktop user whose session imported its environment into the user manager (`systemctl --user import-environment`, which most desktops do at login) needs nothing.
2. Otherwise the bridge sends `DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY`, and `DBUS_SESSION_BUS_ADDRESS` from Claude Code's environment with each request, and the daemon uses them when its own environment has no display.
3. Or add a drop-in at `~/.config/systemd/user/claudesurf.service.d/display.conf`:
   ```ini
   [Service]
   Environment=DISPLAY=:0 XAUTHORITY=
   ```
   A second OS user reaches the X server through an `xhost` local-user grant rather than a cookie, so its `XAUTHORITY` must be empty. The daemon drops any `XAUTHORITY` that names a file it cannot read.

The same unit serves every OS user on the machine. Each OS user is isolated: its own daemon, its own `0600` socket in its runtime directory, its own profile, allowlist, and action log, and no TCP port, so one user's Claude Code can't reach another user's browser.

### 2. Add the MCP server to Claude Code

In `~/.claude.json`:

```json
{
  "mcpServers": {
    "claudesurf": {
      "command": "node",
      "args": ["/home/you/workspaces/claudesurf/server/server.js"]
    }
  }
}
```

Restart Claude Code. Any number of sessions can use ClaudeSurf at once, each in its own window.

### 3. Sign in

The dedicated profile starts empty. Sign into each site once in the ClaudeSurf window; the logins persist in the profile.

## Tools

Two tools, each taking an `action` plus that action's arguments as flat properties. Every result is an envelope with an `outcome` line, then a message line when the outcome carries one (an error's reason, or what to do about a `needs_confirmation`), then any daemon notes, then page-derived text between `<<<claudesurf-untrusted:NONCE>>>` and `<<<end claudesurf-untrusted:NONCE>>>` markers with a nonce drawn per call. That text is data from the web, not instructions.

| Tool | Action | Arguments (**bold** = required) | Returns |
|---|---|---|---|
| `claudesurf_read` | `page` | `scope` (default `main`), `find`, `article` (default false), `links` (default `inline`), `hidden` (default false), `max_chars` (default 40000), `offset` (default 0), `since` (default false) | The page as markdown, with every control inline as a ref marker and open dialogs as blocks ahead of it. Header lines give the URL and title, what the scope left out, the hidden-control count, and what a cut left for the next `offset`. `since=true` returns what changed since the last read or action instead. |
| | `info` | — | URL, title, scroll position, session name. |
| | `screenshot` | `full_page` (default false) | A PNG of the viewport, or up to 4 viewport-sized segments of the whole page with a line naming the pixel range covered. |
| | `console` | `after` (default 0) | The working tab's console messages and Chrome's own messages, numbered, oldest first. `after=N` returns the entries numbered above N (see Console and network capture). |
| | `network` | `filter`, `after` (default 0) | The working tab's requests, one numbered line each, then those still in flight. `filter` keeps the requests whose URL contains the text, case-insensitively, as Chrome reports it or in its percent-encoded form, and prints their text response bodies; `after=N` returns the entries numbered above N. |
| `claudesurf_act` | `navigate` | **`url`** (http/https), **`name`**, `description` | Loads the URL and labels the window; the same `name` on later calls keeps it. |
| | `click` | **`ref`**, `trusted` (default false) | Clicks an element by ref. |
| | `scroll` | **`direction`** (`up`/`down`/`top`/`bottom`), `amount` (default 500) | Scrolls the window, or the page's scrollable container when the window does not scroll, and reports the scroll position. |
| | `type` | **`ref`**, **`text`** | Replaces a text field's content with `text`; empty text clears it. It doesn't press Enter. |
| | `press` | **`keys`** | Sends up to 16 space-separated presses, each `Modifier+…+Key` (`Enter`, `Control+a Backspace`, `ArrowDown ArrowDown Enter`, `Shift+Tab`), to whatever holds focus, and names it. |
| | `select` | **`ref`**, **`option`** | Chooses an option of a native `<select>` by its label, else its value. |
| | `history` | **`op`** (`back`/`forward`/`reload`) | Goes back, forward, or reloads in the working tab. |
| | `tabs` | **`op`** (`list`/`new`/`switch`/`close`), `target` (a URL for `new`, a tab id like `t2` for `switch` and `close`) | Lists the session's tabs, opens a URL in a new tab and works there, makes another tab the working tab, or closes one. |
| | `fetch` | **`url`** (http/https, without a user name or password) | GETs the URL from the working tab with the page's cookies, as the page's own script would, and returns the response; redirects aren't followed (see `fetch`). |
| | `policy` | **`op`** (`allow_once`/`allow_always`), **`host`** (a bare host such as `example.com`) | Allows a host for this session, or saves it to the allowlist. Claude calls it only after you approve a host that a `Blocked:` line named. |

`navigate`, `click`, `scroll`, `type`, `press`, `select`, `history`, and `tabs new` are acting calls: each result says what the action did and what changed on the page (see What an acting call returns).

Outcomes: `success`, `needs_confirmation`, `needs_human`, `unsettled`, `stale_ref`, `schema_error`, `setup_error`, `error`. The bridge marks `error`, `schema_error`, and `setup_error` as tool errors. `needs_confirmation` means the domain gate stopped a navigation or a `fetch` to a host off the allowlist (see The allowlist). `needs_human` means the page needs a person to clear it, a bot check, a sign-in, or a two-factor code; the result is complete, with a `Challenge:` line (see Challenges and the handoff). `unsettled` means the page was still busy when the wait ran out; the result is complete otherwise. When more than one applies, `needs_confirmation` comes first, then `needs_human`, then `unsettled`.

**Refs** are valid for the current document. After the page navigates, an action on an old ref returns `stale_ref`; a ref that was never returned by a read of the current document returns `error`. Refs from an earlier read of the same document stay valid, and refs cut by `max_chars` are clickable without paging to them. A ref doesn't name its tab, so once the working tab changes, by `tabs switch`, by `tabs new`, or by the return to an earlier tab after the working tab closed, every ref returns `stale_ref` until a read of the new working tab, unless that tab is the one Claude last read. A ref read inside a cross-site frame carries that frame's number, `f1e42`; a scripted click, `type`, and `select` reach it, a trusted click doesn't, and it goes stale when the frame's own document changes. `press` sends its keys to whatever holds focus, a field inside a frame included, so Claude clicks or types into a field before pressing keys there.

### What a `page` read returns

Header lines, a blank line, then the page as markdown:

```
URL: https://en.wikipedia.org/wiki/Web_browser
Title: Web browser - Wikipedia
[Showing characters 0–39987 of 52636. Pass offset=39987 for the next part.]
Scope: main (omitted: banner [e11], navigation "Contents" [e30] 41 links, contentinfo [e43] 9 links; scope=e30 expands one, scope=all everything)
Hidden: 145 controls on the page (hidden=true lists them)

# Web browser

A **web browser** is an application for accessing [websites](/wiki/Website)[e1041]. …

[e2 textbox "Email"] [e13 button "Search" (disabled)]
Choices [e3 radio "One" (checked)] [e4 radio "Two"]
```

After `URL:` and `Title:`, the header lines come in this order, each only when it applies: `Challenge:` (see Challenges and the handoff), the truncation line, `Settled:`, `Paged:`, `Since:`, `Scope:`, `Overlays:`, `Hidden:`, `Links:`, `Find:`, and `Article:`.

Prose, headings, lists, tables, and code come from the page's markup; the role, name, and state in each marker come from Chrome's accessibility tree, and the value from the element itself, so a marker shows what was typed rather than what the markup set. A `[`, `]`, or `\` the page put in a name, a value, an `alt`, an option list, an article's title or byline, or a hidden element's label arrives backslash-escaped, and every URL the markers carry has its brackets, parentheses, and whitespace percent-encoded, so nothing the page writes — its markup as much as its text — can close a marker or pose as one. A link carries its URL and its ref, `[text](/path)[e1]`, with the URL shown once per repeated link; an anchor the page gives another role renders as that control instead, with its target after it, `[e12 button "Act" (pressed)](/act)`. Images render as `[image "alt"]`. A cross-site frame renders as `[e40 frame https://host/path cross-site]` … `[/frame]`, its own refs prefixed. A frame the read could not enter, one past its limit of eight frames or three nesting levels, and one whose content it cut each say so on one line, with `scope=e40` to read that frame whole.

A combobox or listbox lists its first 12 options on its marker, then the count of the rest. An option of a custom list or an ARIA combobox carries its ref, `(options: Newest [e91], Oldest [e92], Price [e93])`, so Claude can click it after opening the control; a native `<select>`'s options print by name, since `select` takes the label. A read scoped to a combobox or listbox, `scope=e42`, renders its marker with up to 500 options.

**Overlays.** Open dialogs, and the menus, alerts, and status messages outside the scope, print as blocks ahead of the region, so a modal is on the first screen however long the page behind it is:

```
URL: https://code.example/acme/widget/settings
Title: Settings · acme/widget
Scope: main (omitted: banner [e11] 14 links, navigation "Repository" [e30] 9 links; scope=e11 expands one, scope=all everything)
Overlays: dialog "Delete this repository?" [e88] (modal) (above the page)

[e88 dialog "Delete this repository?" (modal)]
This will permanently delete acme/widget.
[e89 textbox "Type acme/widget to confirm"] [e90 button "Cancel"] [e91 button "Delete this repository" (disabled)]
[/dialog]

# Settings
…
```

A dialog or alert dialog becomes a block wherever it sits, unless it holds the scope's root, and the region leaves it out, since the library that opens one often hides the rest of the page from the accessibility tree. A menu, an alert, or a status becomes a block only under `scope=main` on a page with a `main` landmark or an `article`, or under a ref scope in the page's own document, and only when it lies outside the scope; one inside the scope stays where it reads, as a validation error beside its field does. Under `scope=all`, `article=true`, a page with neither a `main` landmark nor an `article`, and a read scoped into a frame, dialogs alone become blocks. Each block closes with a marker named by its role: `[/dialog]`, `[/alertdialog]`, `[/menu]`, `[/alert]`, or `[/status]`. At most four render, from at most eight attempts. A block's own text is cut at 4,000 characters with `… cut; scope=e88 reads it whole`, and the frames it holds are inlined after that cut, within the frame limits above. The `Overlays:` line names the rest by ref, `… and 2 more: [e93], [e94]`, or reads `Overlays: not rendered: [e93], [e94]` when every attempt was skipped. A hidden overlay, one the page has already removed, one whose render is empty, and an alert or status 2 px or less across, which marks a screen-reader announcement, are skipped, each using up an attempt. A block that fails to render reads `[e88 dialog (not readable)]`. When the region holds nothing but the blocks, it reads `(nothing readable outside the overlays above)`.

The parameters:

- **`scope`** — `main` (default) renders the main content: the `main` landmark, else an `article`, else Readability's article, else the whole body. The `Scope:` line names which of those rendered and lists the landmarks it left out, by ref and by control count. `scope=all` renders the whole body with a boundary marker per landmark, its `Scope:` line reading `all (dropped: …)` for anything the render still left out; `scope=e30` renders one element's subtree, or one frame's whole document when the ref is an `<iframe>`. An `f`-prefixed ref works the same way: `scope=f1e12` renders that element's subtree inside the frame the ref was read in.
- **`find`** — returns the blocks of that scope containing the text, case-insensitively, each headed by `[offset N]` for a follow-up read without `find`. It cannot be combined with a non-zero `offset`.
- **`article`** — extracts the article with Readability over the whole document, and falls back to the scope with `Article: none found` when the page has none. It applies to `scope=main` and `scope=all`; with a ref `scope` it is a `schema_error`, since an article is a whole-document extraction.
- **`links`** — `index` moves every URL to a `## Links` list at the end, keyed by ref, and leaves `[text][e1]` in the prose; the header says which offset the list starts at, except under `find`, which pages by block and takes no offset.
- **`hidden`** — appends the hidden controls as a list. They are counted in the header either way, and a control Chrome hides is clickable once this read has listed it. A `find` read prints the count without the list, since the list is not one of the page's blocks.
- **`offset`** — a read with `offset` above 0 and the same `scope`, `article`, `links`, and `hidden` as the tab's last render slices that render instead of rendering again, so the offset lands where the truncation line said. That render is the last one a read, a `since` read, or an action's change summary made. A `Paged:` line names the render's source and age, as in `Paged: from the render the last action made 40 s ago`, when that source wasn't a plain read or the page has changed since the render was made; a change adds `; the page has changed since, so read without offset for its current state`.
- **`since`** — `since=true` returns what changed since the tab's last read or action, as a diff in the change summary's format (see What an acting call returns), under a `Since:` line: `Since: 2 lines added, 1 removed` or `Since: no change`. It renders with that earlier render's parameters, so it doesn't take `scope`, `article`, `links`, `hidden`, `find`, or `offset`. Without an earlier render to compare against it returns a whole read under `Since: no earlier read of this document; the whole page follows`, or `the page is too large to keep`, or `the scope e42 is gone`; past 1,000 changed lines it reads `Since: most of the page changed (N lines differ); the region follows` above the page, and `Since: most of the overlays changed (N lines differ)` when the overlay blocks are past them and the region is unchanged. When the overlay blocks are past 1,000 changed lines and the region changed by fewer, the line counts the region's lines alone, and `… the overlays changed too much to list; read the page` takes the place of the overlays' hunks.

A fresh read first waits up to 2 s for the page to settle (see Settling below). A page still busy after that is read anyway, and the read returns `unsettled` with a line such as `Settled: no — after 2.0 s, 1 request in flight`. A paging read, `info`, `screenshot`, `tabs list`, `tabs switch`, `tabs close`, and `policy` don't wait.

### What an acting call returns

An acting call acts, waits for the page to settle, and returns head lines, then what changed:

```
URL: https://app.example/settings
Title: Settings
Navigated: no
Changed: 2 lines added, 1 removed

@@
  ## Notifications
- [e42 button "Save"]
+ [e42 button "Saved" (disabled)]
+ Your changes were saved.
```

**Settling.** A page is settled when none of its document, script, stylesheet, XHR, or fetch requests is in flight, its document has finished parsing, and 500 ms have passed since the latest of the action's end, the last start or end of one of those requests, the last change to its document's structure or text, and the daemon's first check of that document, so the first settle of a new document takes at least 500 ms. Images, media, and animations that change only attributes don't hold it, and a request in flight for more than 5 s stops counting unless the action started it. When the action started a navigation, the call first waits for a new page that has fired its own `DOMContentLoaded`, and then settles there. The wait lasts up to 25 s for `navigate`, what is left of 25 s once `tabs new` has opened its tab, and 10 s otherwise, including the wait for Chrome's error page after a `tabs new` whose navigation answered an error. A navigation stopped at the allowlist, one that turns into a download, or one that Chrome cancels without loading a new page, as it does for a link or form answered `204 No Content` and for `window.stop()`, ends the wait. `navigate` returns `error` instead of waiting for a page when its own navigation turns into a download, `Navigation to <url> was a download, which is denied; the page is unchanged`, or when Chrome cancels it, `Navigation to <url> failed: net::ERR_ABORTED`; when the allowlist stops its redirect, it returns `needs_confirmation` (see The allowlist). An input action into a frame waits for that frame's document too. After 5 s of settling the call returns `unsettled` with its full result and a line naming what was still busy: `Settled: no — after 5.0 s, 2 requests in flight`, `… the document is still changing`, `… a request just finished`, `… the page has not finished loading`, or `… the frame holding f1e42 did not answer`; after a `press` into a frame, the last form reads `… the frame e40 did not answer`, or `… a frame did not answer` when Claude's last read didn't return that frame's ref. When the check itself fails, the line reads `Settled: no — the page could not be checked`.

The head lines come in this order, each only when it applies:

- `URL:` and `Title:`, or `State: not read` when the page didn't answer.
- `Challenge: sign-in — a password field`, or another type and signal, when the page needs a person to clear it (see Challenges and the handoff).
- The action's own lines. `scroll` prints `Scroll: 1200 of 5400 (viewport 900)`. `press` prints where its keys went, `Keys to: [e42] input "Search"`, `Keys to: the page (nothing focused)`, or `Keys to: [e40] frame`, with the ref when Claude's last read of this document returned it. An input action that stopped partway prints `Input: incomplete (the page stopped answering)`, or `Input: incomplete (the field lost focus; click it, then type again)` for `type`. A `tabs new` whose tab closed before its page loaded prints `Tab: the new tab closed before its page loaded; tabs list shows the open tabs`, and the lines around it describe the tab the call began on.
- `Focus now: [e13] button "Next"`, after a `press` that moved focus and stayed on its document.
- `Navigated:`, judged from the tab as the head is built: `yes` when the tab is on a new page that has fired its own `DOMContentLoaded` and isn't navigating again, `started (the new page has not finished loading)` when the new page hasn't fired it or a navigation that started during the call is still under way, and `no` otherwise. A navigation stopped at the allowlist, one that turned into a download, or one that Chrome cancelled without loading a new page is over.
- `Navigation error: net::ERR_NAME_NOT_RESOLVED`, Chrome's name for the failure, after a `tabs new` whose page failed to load.
- `Opened: t4, a new tab (not the working tab)` or `Opened: t4, a popup window (not the working tab)` for each tab the page opened during the call; `tabs switch` with `target=t4` works there.
- `Download: denied — report.pdf from https://app.example/export?id=9` for each download that the working tab's page began during the call, at most three, then `… and N more`.
- `Settled: no — …`, as above.
- `Changed:`, when the call ended on the document and the tab it started on. After `tabs new`, the new tab counts as the tab it started on, so a navigation that Chrome cancelled, which leaves the tab on its blank first page, prints `Changed: not tracked (read the page first)`.
- `Dialog (<type>): <message>` for each dialog the page raised, then `Blocked:` and `Blocked by the page:` lines (see The allowlist).

When the page closes its own tab during the call, `Tab: the working tab closed during the call; the next call returns to a working tab` replaces the lines that describe the closed tab, and the `Opened:` lines stay.

**`Changed:`** compares the page with the tab's last read, `since` read, or change summary, rendered again with that read's `scope`, `article`, `links`, and `hidden`, so a control the action revealed arrives with its ref and is clickable without a read. It reads `Changed: 2 lines added, 1 removed` with the hunks after a blank line, `Changed: nothing`, or `Changed: most of the page (N lines differ); read the page` past 1,000 changed lines, and `Changed: most of the overlays (N lines differ); read the page` when the overlay blocks are past them and the region is unchanged. When the overlay blocks are past 1,000 changed lines and the region changed by fewer, the line counts the region's lines alone, and `… the overlays changed too much to list; read the page` takes the place of the overlays' hunks. Each hunk opens with `@@` and one line of context, and every line of it carries a two-character prefix, `+ `, `- `, or two spaces, so a page line reading `@@` or `+ x` can't pass for structure. The overlay blocks are compared apart from the region and their hunks print first, cut at 4,000 characters, so a dialog that opened shows whole when its added lines fit in them with their prefixes; a block near its own 4,000-character cut, or one holding a frame, can lose its last lines. The region's hunks are cut at 3,000. A cut ends with `… N more changed lines; read the page for the rest`. The `## Links` index and the hidden list aren't compared. Two more forms leave the call's outcome alone:

- `Changed: not tracked (…)` when there is nothing to compare against: `read the page first`, `the page is too large to keep`, `the scope e42 is gone; read the page again`, or, when Claude's last read was of another tab, as after a `tabs switch` back to a tab it read before, `the working tab changed; read the page`.
- `Changed: not measured (…)` when rendering the page again failed: `the document changed while it was rendered`, `the renderer failed`, `the deadline passed`, or `the frame e40 was not readable`.

When the command that acts times out, the call returns `error` with `the action may have run, but its command timed out; read the page before repeating it`. `tabs new` differs: when its open times out it returns `error` with `no tab opened; …`, and when its navigation command times out the call still reports on the new tab.

**Clicks** are scripted by default, which leaves your desktop focus alone and reaches elements under overlays. `trusted: true` resolves the element to coordinates, confirms it is the topmost element there, and sends real mouse events; that brings the Chrome window to the front. Use it only when a scripted click's result reads `Changed: nothing` and the control plausibly checks for a real pointer. An action that opens a new tab or popup brings the window to the front either way.

**Typing and choosing.** `type` focuses the field by script, selects its content, and inserts the text as one input event, which replaces what was there; a newline in the text doesn't submit a form, and `press Enter` does. It refuses a field that is disabled, read-only, or not a text field. `select` sets a native `<select>` to the first option whose label matches, else whose value does, else the one option whose label matches ignoring case, and dispatches `input` and `change`; for a custom list, Claude clicks the control open and then clicks the option's ref.

**Dialogs** (`alert`, `confirm`, `prompt`) are dismissed and their text appears among the head lines of the next result that carries page text, as `Dialog (<type>): <message>`, made safe the way page text elsewhere in a result is (one line, capped, brackets escaped); `beforeunload` is accepted. Downloads are denied, and an acting call prints a `Download:` line for each one the page began, three at most, then a count of the rest.

### Tabs

`tabs list` prints the session's tabs, the working tab first and the rest by number:

```
Tabs: 3
[t1] working "Settings" https://app.example/settings
[t2] identity (the session's label; not a page to work in)
[t4] popup "Sign in" https://accounts.example/oauth
```

A tab's kind is `working`, `identity`, `tab` (another tab in the session's window), or `popup` (a tab in another window). Numbers aren't reused, so a recreated window's tabs take new ones. `tabs new` opens `target` in a new tab, through the allowlist, and makes it the working tab. It opens the tab beside the working tab, or else the latest earlier working tab, when that tab is in the session's window, and otherwise beside the identity tab, in whichever window the identity tab is. Opening it brings that window to the front once, as a link that opens a tab does. `tabs switch` makes `target` the working tab without bringing it to the front and prints `Working tab: t3`; input reaches a background tab, though screenshots of one are slow (see Troubleshooting). `tabs close` closes a tab without running its `beforeunload` handlers and prints `Closed: t3`; when that was the working tab, the next call returns to a working tab as when you close it. Claude can't switch to the identity tab or close it.

### Console and network capture

Each of the session's tabs records its console and its network traffic while it belongs to the session, and `console` and `network` print the working tab's records:

- The last 500 console entries: the page's `console` calls, as flat text with their source location (an object logs as `\[object Object\]`), and Chrome's own messages, such as failed loads and blocked content. Uncaught exceptions aren't reported, since Chrome reports them only through its `Runtime` domain, which the daemon keeps off because a page's script can detect it.
- The last 500 requests that ended, each with its method, URL, resource type, status, MIME type, transferred size, timing, and how it ended. The requests still in flight print after them, unnumbered and at most 20, when the answer isn't cut.
- Response bodies stay in Chrome's buffer, up to 10 MiB per tab and 1 MiB per response, where a filtered `network` read finds them. Chrome drops bodies past those limits, and a dropped body prints `(body not kept)`.

An entry's text, and a request's MIME type and failure, print with `[`, `]`, and `\` escaped by a backslash, and a URL with its brackets, parentheses, and whitespace percent-encoded, so a record can't pose as another line. The records last across navigations and go when the tab leaves the session or closes. They leave out every request and response header, apart from the values of two challenge headers that the daemon keeps for each main-frame document (`cf-mitigated` and `x-amzn-waf-action`), so cookies and authorization headers aren't stored. They also leave out post bodies, so a password you type during a handoff isn't stored. A cross-site frame's console messages and requests aren't recorded either, apart from the request that loads the frame, which ends `(continued in a cross-site frame)`. URLs are kept verbatim, query strings included, up to their first 2,000 characters for a request and 1,000 for a console entry, and a console entry keeps the 1,000 characters of its text that print.

```
URL: https://app.example/settings
Title: Settings
Console: 3 entries after 0; the tab keeps its last 500
Next: after=64

[41] log https://app.example/main.js:12:5 saving draft 17
[42] error https://app.example/main.js:88:13 Error: save failed: 500
[43] error (chrome network) Failed to load resource: the server responded with a status of 500 (Internal Server Error) https://app.example/api/save
```

```
URL: https://app.example/settings
Title: Settings
Requests: 1 entry after 0, filter "/api/save"; the tab keeps its last 500 ended
Next: after=64

[61] POST 500 fetch https://app.example/api/save (application/json, 87 B transferred, 220 ms)
    {"error":"draft is locked by another editor"}
```

A request's other endings print as `[63] GET 302 document https://app.example/old (redirect)`, `[64] GET — image https://cdn.example/x.png failed: net::ERR_ABORTED (canceled)`, `(ended by a navigation)`, and `(continued in a cross-site frame)`. A request in flight prints as `[in flight] GET 200 fetch https://app.example/api/poll (3.2 s so far)`, and past 20 of them as `… and 4 more in flight`.

**Reading after a cursor.** One counter in the daemon numbers the entries of both lists across every tab: a console entry as it arrives, and a request as it ends. Each answer's head carries `Next: after=<n>`; pass it back as `after` to see only what came since, including how each request that was in flight at the earlier read ended. A cursor belongs to the action, the tab, and the filter of the read that gave it, so start again from 0 when any of them changes. An answer is cut at 40,000 characters at an entry's boundary and ends with `… 17 more; call again with after=230`. When the tab has dropped entries above the cursor, the head adds `Missed: the tab dropped entries up to [<n>]`, and a cursor above the counter's latest number, as one from before a daemon restart can be, lists every entry kept under `Missed: the daemon restarted since after=<n>`.

**`filter`** keeps the requests whose URL contains the text, case-insensitively, as Chrome reports it or with its whitespace (U+0085 included), brackets, and parentheses percent-encoded as its line prints them, and prints each one's response body under its line when the request is an XHR, a fetch, or a document that finished with a textual MIME type (`text/*`, JSON, XML, JavaScript, form-encoded, or a type ending in `+json` or `+xml`) or none. Each body is cut at 4,000 characters and indented four spaces; a binary body prints `(binary body, <n> bytes)`, and an empty one `(empty body)`. The bodies share the call's deadline, and a list that runs out of time or of its 40,000 characters is cut at the request whose body went unread or unprinted.

### `fetch`

`fetch` GETs a URL from the working tab's isolated world, as the page's own script would, and prints the response:

```
URL: https://app.example/orders
Title: Orders
Fetched: https://app.example/api/orders.json
Status: 200 OK (application/json, 3214 bytes)

{"orders":[{"id":17,"state":"shipped"}]}
```

These rules apply:

- It sends only GET requests, with the page's cookies, past the HTTP cache. A same-origin URL gets every cookie, `SameSite=Strict` included; a cross-origin one answers only when its server allows the page's origin under CORS; and a cross-site one carries only its `SameSite=None` cookies. A cross-origin failure tells Claude to navigate to that origin and fetch there.
- The page's content security policy applies: on a page whose `connect-src` is `'self'`, a fetch to another site fails even when its server allows the page's origin with credentials.
- It doesn't follow a redirect. `Redirected: not followed; navigate to the URL to follow it through the domain gate` takes the place of `Status:`, without a body, and the redirect's target receives nothing.
- The domain gate checks the URL's host before anything is sent, as it does for `navigate`; an unlisted host returns `needs_confirmation` with `Blocked: [t1] api.other.example — fetch of https://api.other.example/v1/me (not sent)`. The request goes out under the URL's absolute form, which `Fetched:` prints, so a short form such as `http:api.other.example/v1` reaches the host that the gate checked, whatever `<base href>` the page set. A URL with a user name or password answers `schema_error`, since the page's fetch refuses one.
- A text body is cut at 40,000 characters under `Body: the first 40000 characters; the response is longer`, or 39999 when the cut would split a character, and its `Status:` line gives the size as `at least <n> bytes`. A binary body prints its type and size alone, as in `Status: 200 OK (application/pdf, 48211 bytes; binary, not shown)`; its bytes are counted up to 10 MiB, and `over 10 MiB` takes the size's place past that. A body without a `Content-Type` prints as text when it decodes as UTF-8 and is counted as binary otherwise, with `no type` in the `Status:` line.
- It fails with `error` after 20 s, or sooner when the call's deadline leaves less, and when the page navigates during the fetch, since the request may have been sent. A navigation that lands before the request goes out fails the call with nothing sent, and so does a call that would leave the request under 0.5 s.
- It needs an http(s) page in the working tab, and it only reads: it doesn't settle, print `Changed:`, or check for a challenge.

## The allowlist

The daemon's domain gate lets a session's tabs load a new page only from a host on the allowlist. It covers the working tab, the tabs Claude worked in before, and every tab that one of the session's tabs opened, a tab you open from a link in one of them with a middle click or Ctrl and a click included. The identity tab and any other tab you open, such as one from Ctrl+T, are outside it. The page a tab already shows isn't checked again, and neither are frames and subresources, so an allowed page's embeds load from any host.

The allowlist is `$XDG_CONFIG_HOME/claudesurf/allowed-hosts`, or `~/.config/claudesurf/allowed-hosts` without `XDG_CONFIG_HOME`, and it starts empty:

```
# claudesurf allowlist: one host per line; a host covers its subdomains
example.com
github.com
127.0.0.1
```

An entry covers its host and every subdomain of it, so `example.com` allows `www.example.com` and refuses `badexample.com`; an IP address covers itself alone. Blank lines and lines starting with `#` are skipped, and so is a line holding a scheme, a port, a path, a wildcard, or a single label other than `localhost`, with a warning in the journal. You can edit the file by hand: the daemon reads it again whenever its modification time or size changes, so an edit applies to the next navigation. When the file is missing, `allow_always` creates it with mode `0600`, and its directory with mode `0700` when that is missing too.

When Claude's action leads to an unlisted host — a link, a form whose redirect goes elsewhere, or a `navigate` to an allowed page that redirects — the gate stops the request, the page stays where it was, and the call returns `needs_confirmation` with a line naming the host:

```
Blocked: [t1] evil.example — navigation to https://evil.example/collect?d=…
```

The message tells Claude to ask you about that host and then call `policy`: `allow_once` allows it for the session until the daemon restarts, and `allow_always` appends it to the file. The other forms of the line are these:

- `… (not started)` for a `navigate` or `history` whose own URL is unlisted, `… — a new tab to … (not opened)` for such a `tabs new`, and `… — fetch of … (not sent)` for such a `fetch`; each left the page as it was.
- `… — a new tab to …, closed` for a tab a page opened toward an unlisted host, which the gate closes.
- `… — the tab reached … without a request the gate could see, so it went to about:blank`, or `…, so it was closed` for a new tab. A back-forward cache restore doesn't make a request for the gate to stop, so `history` checks its entry first, and a restore that the page itself starts is caught when it commits. This form always prints as `Blocked by the page:` and leaves the call's outcome as it was.

A refusal that Claude's call didn't lead to, such as a timer redirect between calls or a popup from a background tab, prints as `Blocked by the page:` on the next result. A repeat shows its count, `(×3)`, and at most five lines print, then `… and N more`.

Approving the whole `claudesurf_act` tool in Claude Code's permissions approves `policy` too, so Claude can then allow a host without a permission prompt; the tool description tells it to ask you first.

**Your own browsing in a session tab** goes through the gate as well. A URL you type into a session tab's address bar, or a link you follow there, toward an unlisted host is stopped without a message on screen, and the tab stays where it was. Browse such a site in a tab of your own. During a handoff, a desktop notification names the stopped host (see Challenges and the handoff).

**Service workers.** The session tabs bypass service workers, so every navigation reaches the gate, and they don't prerender pages. A site's offline pages, and routes that only its service worker serves, fail to load in a session tab; your own tabs keep their workers.

## Challenges and the handoff

After a `page` read that renders, and after an acting call that the domain gate didn't stop before it started, the daemon checks the working tab for a page that a person has to clear. It judges strictly, by a short list of signals for each of three types, and the first match in this order decides:

- **Bot check** — the page's own response carries Cloudflare's `cf-mitigated: challenge` or AWS WAF's `x-amzn-waf-action: challenge` or `captcha`; a visible, unsolved CAPTCHA widget from Cloudflare Turnstile, reCAPTCHA, hCaptcha, DataDome, or Arkose sits on the page; or HUMAN's press-and-hold element (`#px-captcha`) is visible.
- **Two-factor** — a visible field with `autocomplete="one-time-code"`, a visible field whose name or label names a sign-in code (`otp`, `mfa`, `verification code`, and the like), or a row of 4 to 8 single-character boxes within one document or shadow root. A postal code, a card's security code, and a promo or gift code don't count.
- **Sign-in** — a visible password field.

A field counts when it is visible, at least 10 × 10 CSS pixels, and not wholly above or left of the page, where pages park autofill traps. A widget counts when it is visible, at least 20 × 20, and its response field hasn't filled; one inside a frame of another site counts only while that frame is visible and at least 20 × 20 too. A DataDome or Arkose widget lacks a solved state that the daemon can read, so it counts once per document, in the first `needs_human` result that reports it. The scan covers the document, its open shadow roots, and each same-origin frame that counts as a field would, and checks each widget frame that it finds there by the same rules, so a widget served from the page's own site, such as reCAPTCHA on Google's own pages, counts too. A page that doesn't match any of these reads as ordinary content. So does a challenge inside a frame of another origin, other than the widgets above, and a page waiting on a passkey or security-key dialog, which Chrome draws outside the page. A paging read, `info`, `screenshot`, `console`, `network`, `fetch`, `policy`, and the `tabs` ops other than `new` don't check.

A challenge that may clear itself gets a wait: after an acting call lands on Cloudflare's header challenge, AWS WAF's `challenge`, or DataDome's device check, the call waits up to 10 s for the check to pass and reload the page, and reports on the page it reloads to. A check of an unsolved widget waits up to 3 s for its response field to fill, since Turnstile can solve itself. Each wait runs once per document, on the first call with time left for it, so later calls on a check that needs a person answer at once.

**`needs_human`.** On a match the call returns `needs_human` with its full result, and the head gains a line after `URL:` and `Title:`, such as `Challenge: sign-in — a password field`. The other forms are `bot check — Cloudflare (the page's cf-mitigated header)`, `bot check — AWS WAF (the page's x-amzn-waf-action header)`, `bot check — reCAPTCHA (a visible widget)` and the same form with each other widget's name, `bot check — DataDome (a device check)`, `bot check — HUMAN (a press-and-hold element)`, `two-factor — a one-time-code field`, `two-factor — a verification-code field`, and `two-factor — a row of code boxes`. The message tells Claude to tell you which window needs you, by the session's name, to end its turn, and to read the page again once you say it is done. It also says that the page stays readable and actable, so on a false alarm Claude carries on, and that a sign-in through a host the allowlist lacks can go through a tab you open yourself (Ctrl+T), which shares the cookies. The result opens a handoff, which lasts until the session's next call other than `policy`.

**Notifications.** The daemon sends desktop notifications through `notify-send`:

| Event | Urgency | Summary | Body |
|---|---|---|---|
| `needs_human` | critical | `ClaudeSurf: <label> needs you` | `A sign-in on <host> is waiting in that session's window.`, or `A bot check` or `A two-factor code` in its place |
| A refusal during a handoff | normal | `ClaudeSurf stopped <host>` | `In <label>. Sign in from a tab you open yourself (Ctrl+T), which shares the cookies, or ask Claude to allow <host>.` |
| A restart after a run that launched the browser | normal | `ClaudeSurf restarted` | `Its browser closed, with any session windows it had open. Each Claude session reopens its window on its next call.` |

`<label>` is the session's name in quotes, cut at 60 characters, or `an unnamed session`, and `<host>` is the page's host, or the stopped one for a refusal, cut at 80 characters; a notification doesn't carry anything else from the page, so a page's title never reaches the desktop. A `critical` notification stays on screen until you dismiss it. The daemon sends one `needs_human` notification per session, challenge type, and page in 10 minutes, comparing the page's URL by its origin and path, since sign-in and challenge retries change the query on each attempt; the limit holds back the notification alone, and the call still returns `needs_human`.

**The taskbar.** Opening the handoff also marks the session's window as wanting attention with both the ICCCM urgency bit (`xdotool`) and EWMH's demands-attention state (`wmctrl`), since taskbars differ in which of the two they read; closing the handoff clears both. GNOME's and Cinnamon's window managers keep demands-attention off a window that is in plain view, which then carries the urgency bit alone. The daemon picks the window among the browser's X windows as the one whose title starts with the working tab's title followed by ` - `. It skips the mark, with an info line in the journal, on Wayland without `DISPLAY`, for an untitled page, without `xdotool`, and unless exactly one window matches; without `wmctrl` the window gets the urgency bit alone. A window's title is its active tab's, so when the working tab isn't its window's active tab, as after `tabs switch`, the mark is skipped or lands on another window whose active tab carries the same title.

**Refusals during a handoff.** While a handoff is open, a navigation that the domain gate stops in one of the session's tabs, yours included, sends the refusal notification above, once per host and three times at most per session in 10 minutes, so a page that cycles through hosts can't flood the desktop. The gate itself is unchanged, and the refusal still reaches Claude's next call as a `Blocked by the page:` line.

**Closing.** The handoff closes on the session's next call other than `policy`, which Claude calls when you allow a host partway through a sign-in; a call that fails before the session's queue takes it, such as a `schema_error` or a failed browser launch, leaves it open too. The closing call clears the window's marks, and when it returns `needs_human` again it opens a fresh handoff. The handoff doesn't lock the session, and a daemon restart drops it.

**Without a notification server.** A second OS user whose session bus lacks a notification server doesn't get notifications: `notify-send` fails there, the journal logs the failure, and Claude tells you in chat, which the `needs_human` message asks it to do anyway. Without `notify-send`, `xdotool`, or `wmctrl` the daemon goes without that tool and logs its absence once.

## The action log

The daemon appends one JSON line for each call it receives to `$XDG_STATE_HOME/claudesurf/actions.jsonl`, or `~/.local/state/claudesurf/actions.jsonl` without `XDG_STATE_HOME`, a `0600` file in a `0700` directory:

```json
{"ts":"2026-09-23T14:02:11.482Z","session":"4f2c9a1e-…","tool":"claudesurf_act","action":"type","args":{"ref":"e42","text":{"length":12,"hmac":"9b1f0c3a7d2e4b60"}},"url":"https://app.example/login","outcome":"needs_confirmation","blocked":[{"own":true,"tab":"t3","kind":"navigation","how":"stopped","host":"evil.example","url":"https://evil.example/x","count":1}]}
```

`url` is the working tab's URL after the call, and `blocked` lists every refusal the result took, those past its five printed lines included, `own` true for a `Blocked:` line and false for a `Blocked by the page:` one. Typed text stays out of the file: `type`'s text, and `press`'s keys when a press types a character, are recorded as their length and the first 16 hex characters of an HMAC-SHA256 under a key the daemon draws at start and keeps only in memory. Two records from one daemon run that typed the same text match, and the log reveals neither the text nor a guess at it, a short password included. Keys that type nothing, such as `Enter` or `Control+a`, are recorded as written, and URLs are recorded verbatim, query strings included. A call the bridge refuses as a `schema_error` doesn't reach the daemon and isn't logged. When a line would take the file past 10 MiB, the file is renamed to `actions.jsonl.1`, replacing an earlier one. A write that fails logs a warning to the journal, and the call's result is still returned.

## Configuration

| Variable | Meaning | Default |
|---|---|---|
| `CLAUDESURF_SOCKET` | Command socket path; set identically for the daemon and the bridge. | `$XDG_RUNTIME_DIR/claudesurf.sock` |
| `CLAUDESURF_PROFILE_DIR` | Chrome profile directory. | `$XDG_DATA_HOME/claudesurf/profile`, falling back to `~/.local/share/claudesurf/profile` |
| `CLAUDESURF_POLICY_FILE` | The allowlist file. | `$XDG_CONFIG_HOME/claudesurf/allowed-hosts`, falling back to `~/.config/claudesurf/allowed-hosts` |
| `CLAUDESURF_ACTION_LOG` | The action log. | `$XDG_STATE_HOME/claudesurf/actions.jsonl`, falling back to `~/.local/state/claudesurf/actions.jsonl` |
| `CLAUDESURF_BROWSER` | Browser binary. | The first of `google-chrome`, `google-chrome-stable`, `chromium`, `chromium-browser` on `PATH` |
| `CLAUDESURF_LOG_LEVEL` | `debug`, `info`, `warn`, or `error`. `debug` logs every protocol command. | `info` |

### Running a second daemon by hand

A worktree or an experiment can run its own daemon and browser without stopping the service:

```bash
CLAUDESURF_SOCKET=/tmp/cs.sock CLAUDESURF_PROFILE_DIR=/tmp/cs-profile \
  CLAUDESURF_POLICY_FILE=/tmp/cs-policy CLAUDESURF_ACTION_LOG=/tmp/cs-actions.jsonl \
  node server/daemon.js
```

Its own allowlist and log keep its approvals and records apart from the service's. Point a Claude Code session at it by setting the same `CLAUDESURF_SOCKET` in that MCP entry's `env`. The browser record lives beside the socket (`/tmp/cs.browser.json` here).

### Health

```bash
curl --unix-socket "$XDG_RUNTIME_DIR/claudesurf.sock" http://x/health
```

returns `{"status":"ok","browser":"running"|"none","sessions":N}`.

## Tests

```bash
npm --prefix server test                              # everything; live tests skip without Chrome
CLAUDESURF_LIVE_HEADFUL=1 npm --prefix server test    # adds the headful window test, act cases, and taskbar case
```

Live tests run a headless Chrome against a temporary profile. The headful run adds the window test, four act cases (`type` into a cross-site frame in a background tab, a screenshot after `tabs switch`, `tabs new` landing in its own session's window, and a trusted click after `tabs switch`), and the taskbar case, which checks the handoff's marks on the session window in plain view and minimized. They need a display, and use `xdotool` for their focus and window assertions; the taskbar case also reads the marks back with `xprop`, and needs `wmctrl` to set demands-attention.

## Troubleshooting

- **"Cannot reach ClaudeSurf daemon"** — `systemctl --user restart claudesurf`, or start `node server/daemon.js` again if you run it by hand. The bridge retries for a few seconds, so a restart is usually invisible.
- **`schema_error` for an action or argument the tool description lists** — the daemon is still running older code; restart it (see Upgrading). A Claude Code session started before the upgrade lists the old actions and refuses the new ones itself; restart Claude Code there.
- **`setup_error`: profile held by another Chrome** — another Chrome has the profile open. Close it, or point `CLAUDESURF_PROFILE_DIR` elsewhere.
- **`setup_error`: no `DISPLAY`** — add the drop-in above, or run Claude Code from a desktop session so the bridge can supply the display.
- **"navigate first"** — `page`, `click`, `scroll`, `type`, `press`, `select`, `history`, and `fetch` work on http(s) pages only; a fresh window is on the session page until the first `navigate` or `tabs new`.
- **`needs_confirmation`** — the domain gate stopped a navigation or a `fetch` to a host the allowlist lacks. Approve the host when Claude asks, or add it to the allowlist file.
- **Notifications don't appear** — the daemon sends them with `notify-send`, which needs a notification server on the session bus, and the journal logs each failure. Check that `notify-send` is installed (`libnotify-bin` on Debian and Ubuntu), that a notification server runs on your session bus, and that the daemon's environment carries `DBUS_SESSION_BUS_ADDRESS`: the bridge's value fills in for a handoff's notifications, but the restart announcement goes out before any request, under the daemon's own environment. A second OS user without a notification server hears about a handoff from Claude in chat.
- **`needs_human` keeps coming back** — a sign-up or password-change page shows a password field, so it reads as a sign-in, and every rendering read and acting call on it returns `needs_human`. A site that shows a sign-in form on every page, in a header or a sidebar, does the same on each page. The 10-minute limit keeps the desktop to one notification per page, and the result is complete, so Claude can carry on.
- **A session tab won't load a site you typed** — the domain gate applies to your own navigation in a session tab; browse the site in a tab of your own, or add it to the allowlist.
- **A site's offline page, or a route its service worker serves, fails in a session tab** — the session tabs bypass service workers; open it in a tab of your own.
- **`unsettled` on every call** — the page keeps changing or keeps requests open, as a page that polls or streams does. The result is complete, and its `Settled:` line says what was busy; each acting call on such a page takes about 5 s.
- **The window came to the front** — a trusted click, an action that opened a tab or popup, `tabs new`, window creation, and a repair that reopens the working tab or the identity tab raise the window; scripted clicks, `navigate`, `scroll`, `type`, `press`, `select`, `history`, `tabs switch`, and screenshots don't.
- **Screenshots take seconds or time out** — the working tab is not the active tab in its window, because you are viewing another tab there or Claude moved to a background tab with `tabs switch` (the first capture takes about 3 s and later ones can hit the 10 s limit). Click the working tab to make it the active one.
- **Logs** — `journalctl --user -u claudesurf`; set `CLAUDESURF_LOG_LEVEL=debug` in a drop-in to see protocol traffic.

## Upgrading

The daemon and each bridge keep the code they started with, apart from what is read from disk as it's needed: Chrome loads the session page, `server/static/session.html`, each time the daemon opens a session tab, and the daemon builds the page renderer from `server/page/render.js`, its three libraries, and `server/page/state.js` and `server/page/collapse.js`, which it splices in, at its first render and keeps it. The scripts that type, choose an option, and list hidden controls take their copies of `state.js` and `collapse.js` as the daemon starts, the one that clicks takes `state.js` alone, and the scripts that check for a challenge take theirs of `state.js` and `nearest.js`. So after a pull, an old daemon opens its new session tabs on the new session page, and one that hadn't rendered a page yet renders with the new renderer, `state.js`, and `collapse.js`, but clicks and types with the old ones. An old daemon answers a call to an action or an argument it lacks, such as `since`, with `schema_error`. A Claude Code session started before the pull keeps the old tool descriptions, and its bridge refuses the new actions and arguments with `schema_error` itself. After pulling a new version, restart each OS user's daemon: `systemctl --user restart claudesurf`, or stop and start `node server/daemon.js` by hand. Then restart Claude Code in each session that was running, so each starts a new bridge. A daemon restart closes the browser and every session window and drops the `allow_once` grants, any open handoff, and the console and network records; each session's next call other than `policy` opens a fresh window. When the previous run had launched the browser, the restarted daemon announces the restart once with a `ClaudeSurf restarted` notification (see Challenges and the handoff). An allowlist file that doesn't exist yet starts empty, so Claude asks you about each host it needs: once for a host saved with `allow_always`, and in each session for one granted with `allow_once`.

## Migrating from the extension-based version

1. Unload the ClaudeSurf extension from every Chrome profile it was loaded into.
2. Delete `extension/port.json` if you created one.
3. Remove `CLAUDESURF_BROWSER_CMD` from the MCP server entry; the daemon owns the launch.
4. Run `npm --prefix server ci --ignore-scripts`; the daemon reads three browser-side libraries from `server/node_modules`.
5. Replace permission rules on the old tool names (`read_page`, `click_element`, `navigate`, `scroll`, `get_page_info`, `screenshot`) with rules on `claudesurf_read` and `claudesurf_act`. A rule on `claudesurf_act` approves every action, clicks and `policy` included, so `navigate` and `scroll` now prompt unless you approve the whole tool.
6. Replace the two systemd units with the one `claudesurf.service`, plus the optional display drop-in.
7. Sign in again on each site inside the fresh profile.
8. The allowlist starts empty: approve each host once when Claude asks, or list the hosts you use in the allowlist file first.
