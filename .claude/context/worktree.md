# Worktree manifest — claudesurf

MCP server (Node 22, three direct dependencies (four packages in the lockfile)) driving a dedicated Chrome over the DevTools protocol for Claude Code; no local secrets.

## Copy-list
None

## Setup

`npm --prefix server ci --ignore-scripts`

## Runtime notes
A worktree daemon runs with its own socket, profile, allowlist, and action log, as README.md's "Running a second daemon by hand" shows, with a per-worktree tag in each path; `server/paths.js` holds the four overrides. Point the session's MCP entry at the worktree `server.js` under the same `CLAUDESURF_SOCKET`. Never start a daemon on the default socket, profile, allowlist, or log from a worktree. Tests create their own temp sockets, profiles, allowlists, and logs.
