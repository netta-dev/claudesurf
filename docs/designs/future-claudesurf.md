# Future — claudesurf

Ideas deliberately out of scope for the project that raised them. Projects append; nothing here is committed work.

## Carried from per-session-windows

That project closed with five out-of-scope items; `browsing-overhaul` changes what each of them means.

- **Manual window claim ("use this existing window for the current session")** — *foreclosed.* It was an extension popup, and the extension is deleted. An equivalent would now be an action on `claudesurf_act` that adopts an existing target, which is a different design.
- **Per-session window position memory** — *still open, and now cheaper.* It was to live in `chrome.storage.local`; the daemon already holds per-session window state, so remembering bounds is a field rather than a storage integration.
- **Cross-profile session migration** — *foreclosed.* There is one dedicated instance per OS user, so there is no second profile to migrate to.
- **`CLAUDESURF_PROFILE` override if focus routing proves insufficient** — *foreclosed as stated.* That item meant choosing which profile a session routes to, which focus routing's deletion removes; see the explicit profile argument below. The profile-directory environment variable the HLD introduces is a different thing — where this instance's profile lives, so a worktree daemon can run its own browser.
- **Session identity page showing a live action log** — *still open, and now nearly free.* The action log requirement produces exactly this feed, and the identity page is a `file://` document the daemon owns.

## Raised by browsing-overhaul

- **Subresource-level domain gating.** The allowlist gates document navigation, so an allowed page can still make subresource requests to arbitrary hosts — the cheapest exfiltration path, accepted as residual risk. Closing it means inspecting every request the browser makes, which is a performance and false-positive problem in its own right.
- **A policy store the agent cannot write.** The allowlist and the log sit in the same home directory as an agent holding Write and Bash. Enforcement would need root ownership or a separate OS user, and that setup cost was judged out of proportion to a tool used occasionally.
- **An explicit profile argument on `navigate`**, if running two claudesurf profiles — one signed into a personal account, one into a work account — ever becomes wanted. It expresses the choice better than an environment variable would.
- **Downloads into a scoped directory.** Downloads are declined outright, since a click that fetches a file writes to the profile owner's disk and the domain gate never sees it. Allowing them into a directory the daemon owns, surfaced as a path in the result, would make file-fetching tasks possible without that exposure.
- **Behavioral input shaping.** Input is trusted at the event level, but a click dispatched at exact coordinates with no preceding pointer movement has a different shape from a human's, and sites scoring behavior can see that. The design answers with the `needs_human` handoff instead of shaping input.
