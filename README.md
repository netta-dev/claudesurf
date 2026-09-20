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

Requires Node 22 or newer and Chrome (tested with Chrome 153). The server needs only Node, so there is nothing to install.

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
| `claudesurf_read` | `page` | `max_chars` (default 40000), `offset` (default 0), `hidden` (default false) | URL, title, body text, and the interactive elements with refs like `[e42]`. A truncation line says what was cut and which `offset` continues. |
| | `info` | — | URL, title, scroll position, session name. |
| | `screenshot` | `full_page` (default false) | A PNG of the viewport, or up to 4 viewport-sized segments of the whole page with a line naming the pixel range covered. |
| `claudesurf_act` | `navigate` | **`url`** (http/https), **`name`**, `description` | Loads the URL and labels the window; the same `name` on later calls keeps it. |
| | `click` | **`ref`**, `trusted` (default false) | Clicks an element by ref. Reports `Navigated: yes/no` and any tab or popup the page opened. |
| | `scroll` | **`direction`** (`up`/`down`/`top`/`bottom`), `amount` (default 500) | Scrolls the window, or the page's scrollable container when the window does not scroll. |

Outcomes: `success`, `stale_ref`, `schema_error`, `setup_error`, `error`. The bridge marks `error`, `schema_error`, and `setup_error` as tool errors. `needs_confirmation`, `needs_human`, and `unsettled` are reserved for the domain gate, challenge handoff, and settle detection, which are not built yet.

**Refs** are valid for the current document. After the page navigates, a click on an old ref returns `stale_ref`; a ref that was never returned by a read of the current document returns `error`. Refs from an earlier read of the same document stay valid, and refs cut by `max_chars` are clickable without paging to them.

**Clicks** are scripted by default, which leaves your desktop focus alone and reaches elements under overlays. `trusted: true` resolves the element to coordinates, confirms it is the topmost element there, and sends real mouse events; that brings the Chrome window to the front. Use it only when a scripted click changed nothing and the control plausibly checks for a real pointer. A click that opens a new tab or popup brings the window to the front either way.

**Dialogs** (`alert`, `confirm`, `prompt`) are dismissed and their text appears in the next result as `Dialog (<type>): <message>`; `beforeunload` is accepted. Downloads are denied.

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
4. Delete `server/node_modules`; the server has no dependencies now.
5. Replace permission rules on the old tool names (`read_page`, `click_element`, `navigate`, `scroll`, `get_page_info`, `screenshot`) with rules on `claudesurf_read` and `claudesurf_act`. A rule on `claudesurf_act` approves clicks too, so `navigate` and `scroll` now prompt unless you approve the whole tool.
6. Replace the two systemd units with the one `claudesurf.service`, plus the optional display drop-in.
7. Sign in again on each site inside the fresh profile.
