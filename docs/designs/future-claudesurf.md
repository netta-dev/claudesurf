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
- **A region screenshot by ref.** `screenshot(ref)` clipping to one element's box would give a small legible image of the control the agent wants when a read fails, instead of viewport or full-page captures. Raised by the phase 1 LLD's alternatives.
- **A `dialog` action.** Auto-dismissal cannot complete a flow whose `confirm` guards a save or whose `prompt` asks for a name; a `dialog(op, text)` action would let the agent answer one, with the renderer wedged for the round trip in which it decides. Raised by the phase 1 LLD's alternatives.
- **Behavioral input shaping.** Input is trusted at the event level, but a click dispatched at exact coordinates with no preceding pointer movement has a different shape from a human's, and sites scoring behavior can see that. The design answers with the `needs_human` handoff instead of shaping input.
- **A per-key `type` mode.** `type` inserts its text as one input event, so a widget that listens for `keydown` alone — an old autocomplete, some terminal emulators — sees nothing until the agent presses a key. A mode that sends each character as a key press would reach it, at two protocol commands per character. Raised by the phase 3 LLD.
- **Tab-qualified refs.** A ref names a node by its backend id, which is unique per renderer rather than per tab. A ref from the earlier tab can therefore resolve in the current one after a switch and a read. A tab prefix in the ref grammar would make that use fail. Raised by the phase 3 LLD.
- **A `wait_for` argument on acting calls.** Settling is a network-and-DOM heuristic, which returns early on a page that renders its result in steps and late on one that long-polls. An optional `wait_for` argument would let the agent specify text or a ref to wait for when it can predict the condition for settling; the heuristic stays for the rest. Raised by the phase 3 LLD's alternatives.
- **A hidden-UI affordance graph.** `hidden=true` lists hidden controls flat. A graph connecting each trigger to the dialog, menu, popover, or collapsed region it reveals (`aria-controls`, `aria-haspopup`, `details`/`summary`, `popovertarget`) would tell the agent how hidden content becomes visible instead of inventorying controls it cannot yet use. Most sites encode the relationship only in script, so the graph would be partial. Raised by the phase 2 LLD's alternatives.
