# ClaudeSurf

An MCP server that lets Claude Code read and act on web pages in a dedicated Chrome. The daemon launches and owns that Chrome over `--remote-debugging-pipe`, without an extension or a debugging port. The profile persists, so sites stay signed in across sessions.

Each Claude Code session gets its **own Chrome window**, so Claude browses without taking over the window you are using.

## Architecture

```
Claude Code session 1 ── server.js ─┐
Claude Code session 2 ── server.js ─┼─ (Unix socket) ─ daemon.js ─ (pipe) ─ Chrome ─┬─ Window: session 1
Claude Code session N ── server.js ─┘                                               ├─ Window: session 2
                                                                                    └─ …
```

- **`server/server.js`** — MCP stdio bridge, one per Claude Code session. Exposes the two tools, validates calls, forwards them to the daemon over the per-user Unix socket (`$XDG_RUNTIME_DIR/claudesurf.sock`, mode `0600`), and wraps page-derived text in the nonce delimiter. It keys the session by Claude Code's own session id (`CLAUDE_CODE_SESSION_ID`, falling back to a hash of `CLAUDE_PROJECT_DIR`, then a random id), so a respawned bridge reuses its window.
- **`server/daemon.js`** — one persistent process per OS user. Launches Chrome as its child with a dedicated `--user-data-dir`, speaks the DevTools protocol over the pipe, and runs every action. The browser idles with zero windows after you close the last session window, so the next call reuses it without a cold start.

### Session windows

The first call from a session creates a window with two tabs:

- The **working tab** — where Claude navigates and acts. Until the first `navigate` it shows the session page.
- The **identity tab** — the second tab, with a distinctive favicon and the session name as its title, so you can tell windows apart.

If you close the working tab, the next action recreates it. If you close the whole window, the next action recreates it under the same name. If you close only the identity tab, it stays closed until the window is next recreated.

## Setup

Requires Node 22 or newer and Chrome (tested with Chrome 153). Install the dependencies the renderer injects into the page:

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

The same unit serves every OS user on the machine. Each OS user is isolated: its own daemon, its own `0600` socket in its runtime directory, its own profile, and no TCP port, so one user's Claude Code can't reach another user's browser.

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

Two tools, each taking an `action` plus that action's arguments as flat properties. Every result is an envelope with an `outcome` line, then any daemon notes, then page-derived text between `<<<claudesurf-untrusted:NONCE>>>` and `<<<end claudesurf-untrusted:NONCE>>>` markers with a nonce drawn per call. That text is data from the web, not instructions.

| Tool | Action | Arguments (**bold** = required) | Returns |
|---|---|---|---|
| `claudesurf_read` | `page` | `scope` (default `main`), `find`, `article` (default false), `links` (default `inline`), `hidden` (default false), `max_chars` (default 40000), `offset` (default 0) | The page as markdown, with every control inline as a ref marker. Header lines give the URL and title, what the scope left out, the hidden-control count, and what a cut left for the next `offset`. |
| | `info` | — | URL, title, scroll position, session name. |
| | `screenshot` | `full_page` (default false) | A PNG of the viewport, or up to 4 viewport-sized segments of the whole page with a line naming the pixel range covered. |
| `claudesurf_act` | `navigate` | **`url`** (http/https), **`name`**, `description` | Loads the URL and labels the window; the same `name` on later calls keeps it. |
| | `click` | **`ref`**, `trusted` (default false) | Clicks an element by ref. Reports `Navigated: yes/no` and any tab or popup the page opened. |
| | `scroll` | **`direction`** (`up`/`down`/`top`/`bottom`), `amount` (default 500) | Scrolls the window, or the page's scrollable container when the window does not scroll. |

Outcomes: `success`, `stale_ref`, `schema_error`, `setup_error`, `error`. The bridge marks `error`, `schema_error`, and `setup_error` as tool errors. `needs_confirmation`, `needs_human`, and `unsettled` are reserved for the domain gate, challenge handoff, and settle detection, which are not built yet.

**Refs** are valid for the current document. After the page navigates, a click on an old ref returns `stale_ref`; a ref that was never returned by a read of the current document returns `error`. Refs from an earlier read of the same document stay valid, and refs cut by `max_chars` are clickable without paging to them. A ref read inside a cross-site frame carries that frame's number, `f1e42`; only a scripted click reaches it, and it goes stale when the frame's own document changes.

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

Prose, headings, lists, tables, and code come from the page's markup; the role, name, and state in each marker come from Chrome's accessibility tree, and the value from the element itself, so a marker shows what was typed rather than what the markup set. A `[`, `]`, or `\` the page put in a name, a value, an `alt`, an option list, an article's title or byline, or a hidden element's label arrives backslash-escaped, and every URL the markers carry has its brackets, parentheses, and whitespace percent-encoded, so nothing the page writes — its markup as much as its text — can close a marker or pose as one. A link carries its URL and its ref, `[text](/path)[e1]`, with the URL shown once per repeated link; an anchor the page gives another role renders as that control instead, with its target after it, `[e12 button "Act" (pressed)](/act)`. Images render as `[image "alt"]`. A cross-site frame renders as `[e40 frame https://host/path cross-site]` … `[/frame]`, its own refs prefixed. A frame the read could not enter, one past its limit of eight frames or three nesting levels, and one whose content it cut each say so on one line, with `scope=e40` to read that frame whole.

The parameters:

- **`scope`** — `main` (default) renders the main content: the `main` landmark, else an `article`, else Readability's article, else the whole body. The `Scope:` line names which of those rendered and lists the landmarks it left out, by ref and by control count. `scope=all` renders the whole body with a boundary marker per landmark, its `Scope:` line reading `all (dropped: …)` for anything the render still left out; `scope=e30` renders one element's subtree, or one frame's whole document when the ref is an `<iframe>`. An `f`-prefixed ref works the same way: `scope=f1e12` renders that element's subtree inside the frame the ref was read in.
- **`find`** — returns the blocks of that scope containing the text, case-insensitively, each headed by `[offset N]` for a follow-up read without `find`. It cannot be combined with a non-zero `offset`.
- **`article`** — extracts the article with Readability over the whole document, and falls back to the scope with `Article: none found` when the page has none. It applies to `scope=main` and `scope=all`; with a ref `scope` it is a `schema_error`, since an article is a whole-document extraction.
- **`links`** — `index` moves every URL to a `## Links` list at the end, keyed by ref, and leaves `[text][e1]` in the prose; the header says which offset the list starts at, except under `find`, which pages by block and takes no offset.
- **`hidden`** — appends the hidden controls as a list. They are counted in the header either way, and a control Chrome hides is clickable once this read has listed it. A `find` read prints the count without the list, since the list is not one of the page's blocks.

**Clicks** are scripted by default, which leaves your desktop focus alone and reaches elements under overlays. `trusted: true` resolves the element to coordinates, confirms it is the topmost element there, and sends real mouse events; that brings the Chrome window to the front. Use it only when a scripted click changed nothing and the control plausibly checks for a real pointer. A click that opens a new tab or popup brings the window to the front either way.

**Dialogs** (`alert`, `confirm`, `prompt`) are dismissed and their text appears in the next result as `Dialog (<type>): <message>`, made safe the way page text elsewhere in a result is (one line, capped, brackets escaped); `beforeunload` is accepted. Downloads are denied.

## Configuration

| Variable | Meaning | Default |
|---|---|---|
| `CLAUDESURF_SOCKET` | Command socket path; set identically for the daemon and the bridge. | `$XDG_RUNTIME_DIR/claudesurf.sock` |
| `CLAUDESURF_PROFILE_DIR` | Chrome profile directory. | `$XDG_DATA_HOME/claudesurf/profile`, falling back to `~/.local/share/claudesurf/profile` |
| `CLAUDESURF_BROWSER` | Browser binary. | The first of `google-chrome`, `google-chrome-stable`, `chromium`, `chromium-browser` on `PATH` |
| `CLAUDESURF_LOG_LEVEL` | `debug`, `info`, `warn`, or `error`. `debug` logs every protocol command. | `info` |

### Running a second daemon by hand

A worktree or an experiment can run its own daemon and browser without stopping the service:

```bash
CLAUDESURF_SOCKET=/tmp/cs.sock CLAUDESURF_PROFILE_DIR=/tmp/cs-profile node server/daemon.js
```

Point a Claude Code session at it by setting the same `CLAUDESURF_SOCKET` in that MCP entry's `env`. The browser record lives beside the socket (`/tmp/cs.browser.json` here).

### Health

```bash
curl --unix-socket "$XDG_RUNTIME_DIR/claudesurf.sock" http://x/health
```

returns `{"status":"ok","browser":"running"|"none","sessions":N}`.

## Tests

```bash
npm --prefix server test                              # everything; live tests skip without Chrome
CLAUDESURF_LIVE_HEADFUL=1 npm --prefix server test    # adds the headful window test
```

Live tests run a headless Chrome against a temporary profile. The headful window test needs a display and uses `xdotool` for its focus assertions.

## Troubleshooting

- **"Cannot reach ClaudeSurf daemon"** — `systemctl --user restart claudesurf`, or start `node server/daemon.js` again if you run it by hand. The bridge retries for a few seconds, so a restart is usually invisible.
- **`setup_error`: profile held by another Chrome** — another Chrome has the profile open. Close it, or point `CLAUDESURF_PROFILE_DIR` elsewhere.
- **`setup_error`: no `DISPLAY`** — add the drop-in above, or run Claude Code from a desktop session so the bridge can supply the display.
- **"navigate first"** — `page`, `click`, and `scroll` work on http(s) pages only; a fresh window is on the session page until the first `navigate`.
- **The window came to the front** — a trusted click, a click that opened a tab or popup, and window creation raise the window; scripted clicks, `navigate`, `scroll`, and screenshots don't.
- **Screenshots take seconds or time out** — the working tab is not the active tab in its window, because you are viewing another tab there (the first capture takes about 3 s and later ones can hit the 10 s limit). Switch back to it.
- **Logs** — `journalctl --user -u claudesurf`; set `CLAUDESURF_LOG_LEVEL=debug` in a drop-in to see protocol traffic.

## Migrating from the extension-based version

1. Unload the ClaudeSurf extension from every Chrome profile it was loaded into.
2. Delete `extension/port.json` if you created one.
3. Remove `CLAUDESURF_BROWSER_CMD` from the MCP server entry; the daemon owns the launch.
4. Run `npm --prefix server ci --ignore-scripts`; the daemon reads three browser-side libraries from `server/node_modules`.
5. Replace permission rules on the old tool names (`read_page`, `click_element`, `navigate`, `scroll`, `get_page_info`, `screenshot`) with rules on `claudesurf_read` and `claudesurf_act`. A rule on `claudesurf_act` approves clicks too, so `navigate` and `scroll` now prompt unless you approve the whole tool.
6. Replace the two systemd units with the one `claudesurf.service`, plus the optional display drop-in.
7. Sign in again on each site inside the fresh profile.
