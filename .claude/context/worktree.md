# Worktree manifest — claudesurf

MCP server (Node 22, no dependencies) driving a dedicated Chrome over the DevTools protocol for Claude Code; no local secrets.

## Copy-list
None

## Setup

Nothing to install.

## Runtime notes
The daemon owns one Chrome per profile directory and listens on one Unix socket (`server/daemon.js`). Both paths are overridable, so a worktree daemon runs its own browser without stopping the main checkout's: `CLAUDESURF_SOCKET=/tmp/cs-<tag>.sock CLAUDESURF_PROFILE_DIR=/tmp/cs-profile-<tag> node server/daemon.js`, with the session's MCP entry pointed at the worktree `server.js` under the same `CLAUDESURF_SOCKET`. Never start a daemon on the default socket or profile from a worktree. Tests create their own temp sockets and profiles.
