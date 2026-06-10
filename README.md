# ClaudeSurf

Chrome extension + MCP server that lets Claude Code read and interact with web pages in your already-open Chrome browser. Uses your real browser session — cookies, logins, everything.

Each Claude Code session gets its **own dedicated Chrome window** with a pinned identity tab, so Claude can browse without hijacking the window you're currently using.

## Architecture

```
Claude Code session 1 ─┐                    ┌─ Extension (profile A) ─── Window 1 ── Web Page
Claude Code session 2 ─┼─ (HTTP) ─ daemon ──┼─ Extension (profile B) ─── Window 2 ── Web Page
Claude Code session N ─┘                    └─ …                          …
```

- **`daemon.js`** — one persistent process. Owns WebSocket connections to all loaded extension instances + serves an HTTP API. Run it once. Routes each Claude session to a Chrome profile based on which profile had OS focus when the session first called a tool; bindings stick for the daemon's lifetime.
- **`server.js`** — thin MCP stdio bridge, one per Claude Code session. Uses Claude Code's own session id (`CLAUDE_CODE_SESSION_ID`, falling back to a hash of `CLAUDE_PROJECT_DIR`, then a random id) as a stable session identity, so the dedicated window is reused across MCP reconnects/respawns. Forwards requests to the daemon via HTTP.
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

```bash
mkdir -p ~/.config/systemd/user

cat > ~/.config/systemd/user/claudesurf.service << 'EOF'
[Unit]
Description=ClaudeSurf daemon
# Never give up restarting — otherwise systemd parks it in "failed" after 5 quick
# restarts, defeating Restart=always for a long-lived daemon.
StartLimitIntervalSec=0

[Service]
ExecStart=/usr/bin/node /home/z/workspaces/claudesurf/server/daemon.js
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF

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
- **"Chrome extension not connected"**: Load the extension at `chrome://extensions/`. Check service worker console for `[ClaudeSurf] Connected to server`. Check `curl localhost:7865/health` for `extensionsConnected > 0`.
- **Session window went to the wrong profile**: bindings are decided at first-call time based on which profile had OS focus. Restart Claude Code (new session ID) while focused on the desired profile, or close and reopen the working window.
- **Content script errors / "navigate to a URL first"**: `chrome://`, extension pages, `view-source:`, `file://`, and `about:blank` block content scripts. Use a regular http(s) page.
- **Port conflict on 7865**: Change `PORT` in `daemon.js` and `DAEMON_PORT` in `server.js` and `WS_URL` in `extension/background.js`
