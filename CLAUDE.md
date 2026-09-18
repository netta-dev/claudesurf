# claudesurf

MCP server that lets Claude Code read and interact with web pages in a dedicated Chrome it launches and owns. Each Claude Code session gets its own window in that browser; the browser's profile keeps its own logins.

## Stack

node.js 22 (no dependencies), Chrome DevTools Protocol over `--remote-debugging-pipe`, MCP stdio

Two processes in `server/`: `daemon.js` is one persistent process per OS user that launches Chrome as its child, speaks CDP to it over the pipe, and serves an HTTP API on a per-user Unix socket; `server.js` is a thin MCP stdio bridge, one per Claude Code session, that validates calls, forwards them to the daemon, and wraps page-derived text in a nonce delimiter. The MCP surface is two tools, `claudesurf_read` and `claudesurf_act`, each taking an `action`.

See `README.md` for setup, systemd, the tool table, and troubleshooting.

---

See `.claude/context/` for workspace context (conventions, capabilities, architecture, docs, etc.).
