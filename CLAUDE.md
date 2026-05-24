# claudesurf

Chrome extension + MCP server that lets Claude Code read and interact with web pages in your already-open Chrome browser. Uses your real browser session — cookies, logins, everything.

## Stack

node.js, ws, chrome extension (manifest v3), MCP stdio

Two pieces in `server/`: `daemon.js` is one persistent process that owns WebSocket connections to all loaded Chrome extension instances (one per profile) and serves an HTTP API; `server.js` is a thin MCP stdio bridge, one per Claude Code session, that forwards to the daemon. `extension/` is a manifest v3 Chrome extension that connects to the daemon over WebSocket (port 7865). Each Claude Code session gets its own dedicated Chrome window; multiple loaded profiles let the daemon route different sessions to different profiles based on which had OS focus at bind time.

See `README.md` for install, systemd setup, MCP tool list, and troubleshooting.

---

See `.claude/context/` for workspace context (conventions, capabilities, architecture, docs, etc.).
