# ClaudeSurf

Chrome extension + MCP server that lets Claude Code read and interact with web pages in your already-open Chrome browser. Uses your real browser session — cookies, logins, everything.

Each Claude Code session gets its **own dedicated Chrome window** with a pinned identity tab, so Claude can browse without hijacking the window you're currently using.

## Architecture

```
Claude Code session 1 ─┐                    ┌─ Extension (profile A) ─── Window 1 ── Web Page
Claude Code session 2 ─┼─ (HTTP) ─ daemon ──┼─ Extension (profile B) ─── Window 2 ── Web Page
Claude Code session N ─┘                    └─ …                          …
```

- **`daemon.js`** — one persistent process **per OS user**. Owns WebSocket connections to that user's loaded extension instances and serves a command API. Two channels, split for isolation (see [Multiple OS users](#multiple-os-users-isolation)): commands come in over a per-user Unix socket (`$XDG_RUNTIME_DIR/claudesurf.sock`, mode `0600`), and extensions connect over a loopback TCP port (default 7865) whose connections are peer-uid-filtered so only this user's Chrome can attach. Routes each Claude session to a Chrome profile based on which profile had OS focus when the session first called a tool; bindings stick for the daemon's lifetime.
- **`server.js`** — thin MCP stdio bridge, one per Claude Code session. Uses Claude Code's own session id (`CLAUDE_CODE_SESSION_ID`, falling back to a hash of `CLAUDE_PROJECT_DIR`, then a random id) as a stable session identity, so the dedicated window is reused across MCP reconnects/respawns. Forwards requests to the daemon over its per-user Unix socket. Optionally cold-starts the browser on demand (`CLAUDESURF_BROWSER_CMD`).
- **`extension/`** — manifest v3 Chrome extension. Per-session dedicated window: pinned `session.html` marker tab + working tab Claude navigates. Load the extension once per Chrome profile you want to be eligible for routing.

## Setup

### 1. Install dependencies

```bash
cd server
npm install
```

### 2. Load the Chrome extension (once per profile)

1. In each Chrome profile you want claudesurf to be able to use, open `chrome://extensions/`
2. Enable **Developer mode** (toggle top right)
3. Click **Load unpacked** → select the `extension/` folder
4. "ClaudeSurf" should appear

> The daemon routes each new Claude session to whichever loaded profile had OS focus at the moment of the first tool call. Load it in every profile you'd want a session bound to.

### 3. Start the daemon

```bash
node /home/z/workspaces/claudesurf/server/daemon.js
```

Keep this running in a terminal (or set up as a systemd service — see below).

### 4. Add MCP server to Claude Code

In `~/.claude.json`:

```json
{
  "mcpServers": {
    "claudesurf": {
      "command": "node",
      "args": ["/home/z/workspaces/claudesurf/server/server.js"]
    }
  }
}
```

Restart Claude Code. Any number of sessions can use ClaudeSurf simultaneously, each in its own dedicated window.

## Optional: Run daemon as a systemd user service

Ready-to-use units live in [`systemd/`](systemd/) and use `%h` so they work for any user's clone:

```bash
mkdir -p ~/.config/systemd/user
# First/only user (extension port 7865):
cp ~/workspaces/claudesurf/systemd/claudesurf.service ~/.config/systemd/user/
# A second OS user on the same host uses the second-user unit instead (port 7866) —
# see "Multiple OS users" below:
#   cp ~/workspaces/claudesurf/systemd/claudesurf-second-user.service ~/.config/systemd/user/claudesurf.service

systemctl --user daemon-reload
systemctl --user enable --now claudesurf
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `read_page` | Get full text content and all links from the active tab |
| `click_element` | Click by CSS selector or link/button text |
| `navigate` | Go to a URL in the working tab. **Requires `name`** (short session label, shown on the pinned tab so you can tell windows apart); optional `description`. |
| `scroll` | Scroll up/down/top/bottom |
| `get_page_info` | Get current URL, title, and scroll position |
| `screenshot` | Capture PNG screenshot of the visible tab area |

## How dedicated windows work

When a Claude session calls its first tool, the extension opens a new Chrome window containing:

- A **pinned `session.html` tab** showing the session name + start time. Always visible in the tab strip as the window's identity.
- A **working tab** (`about:blank` initially) where Claude actually navigates.

All tool calls target the active non-pinned tab. You can click the pinned tab to see which session a window belongs to — Claude's calls still operate on the working tab via the most-recently-accessed fallback.

If you close the dedicated window, the next tool call from that session creates a fresh one. If you end the Claude session, the window stays open until you close it.

## Troubleshooting

- **"Cannot reach ClaudeSurf daemon"**: Start it with `systemctl --user restart claudesurf` (or `node server/daemon.js` if you didn't install the service — see above). The MCP bridge retries connection-refused for a few seconds, so a quick restart is usually invisible.
- **"Chrome extension not connected"**: Load the extension at `chrome://extensions/`. Check service worker console for `[ClaudeSurf] Connected to server`. Check health via the socket: `curl --unix-socket "$XDG_RUNTIME_DIR/claudesurf.sock" http://x/health` for `extensionsConnected > 0`.
- **Session window went to the wrong profile**: bindings are decided at first-call time based on which profile had OS focus. Restart Claude Code (new session ID) while focused on the desired profile, or close and reopen the working window.
- **Content script errors / "navigate to a URL first"**: `chrome://`, extension pages, `view-source:`, `file://`, and `about:blank` block content scripts. Use a regular http(s) page.
- **Port conflict on 7865**: Set `CLAUDESURF_WS_PORT` for the daemon and, in each Chrome profile, set the matching port via `extension/port.json` or `chrome.storage.local` (see [Multiple OS users](#multiple-os-users-isolation)). The command socket is per-user and needs no port; override its path with `CLAUDESURF_SOCKET` if needed (set it identically for the daemon and `server.js`).

## Multiple OS users (isolation)

claudesurf partitions users at the OS level, so a second user (say `c`) can use it without any possibility of reaching the first user's (`z`'s`) Chrome — not even a confused or hand-crafted request gets across:

- **Command channel** — each daemon's `/api` + `/health` live on a Unix socket at `$XDG_RUNTIME_DIR/claudesurf.sock`, mode `0600`, inside a `0700` per-user runtime dir. Another user physically cannot open it, so cannot send commands. This is the boundary; it does not depend on routing logic.
- **Extension channel** — Chrome extensions can only speak `ws://` TCP, so this stays a loopback port. The daemon resolves each incoming connection's real peer uid (via `/proc/net/tcp`) and rejects any that isn't its own — a foreign Chrome can't register as a profile or eavesdrop.

**Setup for a second user `c`:**

1. `c` runs its **own** daemon on a **different** TCP port — it shares nothing with `z`'s:
   ```bash
   # in c's claudesurf.service
   Environment=CLAUDESURF_WS_PORT=7866
   ExecStart=/usr/bin/node /home/c/workspaces/claudesurf/server/daemon.js
   ```
2. Point `c`'s Chrome at that port. Drop an untracked `port.json` next to the extension code and reload the extension (or restart Chrome):
   ```bash
   echo '{ "port": 7866 }' > ~/workspaces/claudesurf/extension/port.json
   ```
   Alternatively, set `chrome.storage.local.set({ claudesurf_ws_port: 7866 })` in the ClaudeSurf service-worker console (`chrome://extensions/` → **service worker**); the storage key wins over `port.json` if both are set. The default is 7865, so `z`'s profiles need no change.
3. `c`'s `server.js` needs no port config — it derives `c`'s own socket from `c`'s runtime dir automatically.

## Optional: cold-start the browser on demand

By default the browser must already be running. Set `CLAUDESURF_BROWSER_CMD` in a session's MCP-server env and `server.js` will, on the first tool call with no browser attached, launch it and wait for the extension to connect:

```json
{
  "mcpServers": {
    "claudesurf": {
      "command": "node",
      "args": ["/home/c/workspaces/claudesurf/server/server.js"],
      "env": { "CLAUDESURF_BROWSER_CMD": "/usr/bin/google-chrome" }
    }
  }
}
```

Relaunching an already-running profile is harmless (it just signals the live instance), so this is safe to leave on. Needs a graphical session (`DISPLAY`); it won't help a headless login.
