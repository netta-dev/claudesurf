# Worktree manifest — claudesurf

MCP server (Node/ws) bridging Claude Code to Chrome — npm install under server/; no local secrets.

## Copy-list
None

## Setup

    cd server && npm install

## Runtime notes
The daemon binds a fixed port 7865 (`server/daemon.js`; overridable via `CLAUDESURF_DAEMON_PORT`, read by `server/server.js`) and bridges to a single Chrome browser session — a single-instance resource. Don't start a second daemon from the worktree while the main-checkout one is up: either point the worktree's MCP server at the running daemon (`CLAUDESURF_DAEMON_PORT=7865`) or override the port for an isolated one. No absolute paths or `cd`-into-main in the tooling.
