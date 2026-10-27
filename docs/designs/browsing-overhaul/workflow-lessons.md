# browsing-overhaul — workflow-lessons

## A. Human triage overrides

1. The implementer was told to land the LLD's five sub-commits itself; each subagent `git commit` raised a permission prompt, and the human denied one, which stopped the run with 1.2–1.5 uncommitted. The orchestrator then committed them by hand.
   - [ ] Resolution:

2. The implementer's context hit ~308k tokens in one phase, past the human's 200k reuse cap. The cap is a session instruction; the build playbook's fix loop ("fix passes reuse the implementer's pick") assumes an unbounded reuse.
   Phase 2: the orchestrator split the six sub-commits into two implementer runs (2.1–2.3, 2.4–2.6) to stay under the cap; run 1 still used ~407k tokens (135 tool calls, 42 min), so a split at sub-commit boundaries does not bound a run. Fix passes for phase 2 go to fresh implementers with the finding list, not the original run.
   Phase 3: four runs by dependency layer. Run 1, the smallest slice (moves and leaf modules), used ~440k tokens (203 tool calls, 31 min) against a brief that said to stop near 350k, so a token stop rule in a brief didn't bind. Run 2 (the gate) used ~472k (191 calls, 43 min), run 3 (settling, the change summary, overlays) ~716k (393 calls, 75 min), and run 4 (the actions, wiring, and docs) ~524k (277 calls, 54 min), with four subagents of its own.
   - [ ] Resolution:

3. Approved skip: the reviewer flagged the `package.json` 1.0.0 → 2.0.0 bump as unsanctioned by the LLD. Kept; the phase deletes the extension and replaces the tool surface. An LLD that changes a package's public surface could name the version bump so a reviewer doesn't have to guess.
   - [ ] Resolution:

4. Phase-2 build: the orchestrator planned to let the implementer land the LLD's six sub-commits itself because bypass-permissions was active. The human overruled: a commit always goes through her, permission mode notwithstanding, and only after she reviews and approves the full implementation. Candidate: build.md and implement.md state that an implementer never commits; sub-commits an LLD names are landed by the orchestrator after approval.
   - [ ] Resolution:

## B. Deferred implementer observations

1. Chrome exits when the pipe closes, so a daemon exit takes the browser down and the record/reap path may be near-dead. Under review.
   - [ ] Resolution:

2. `document.visibilityState` is `visible` on both tabs of a headful window (contradicts LLD decision 19); `Emulation.setFocusEmulationEnabled` is the suspected cause, unverified. Needs a design-doc correction either way.
   - [ ] Resolution:

3. The systemd manual pass (LLD test plan item 2) was not run: no unit is installed on this machine.
   - [ ] Resolution:

4. Three LLD facts from the spike were wrong once the full implementation ran (decision 19's tab visibility, decision 21's download event, the attach-release ordering). The implementer recorded the corrections in `.claude/context/architecture.md` but left the LLD contradicting them; the reviewer caught the gap.
   - [ ] Resolution:

5. The first review caught five untested contract points (dialog line, auto-attach parameters, identity-tab-closed, EOF with a pending waiter, a test asserting nothing). All were LLD-listed behaviours whose tests the implementer wrote as calls without assertions or skipped.
   - [ ] Resolution:

6. Phase-2 build: every implementer fix pass flagged that its standing rule forbids editing `docs/designs/` while the brief asked for LLD corrections in place, and did them anyway. Candidate: implementer.md says design-doc corrections are in scope when the brief names them, so the flag stops recurring.
   - [ ] Resolution:

7. Phase-2 build: the review loop ran eleven rounds and twelve fix passes (~6M subagent tokens). Each round found one or two real correctness items in the same class — a page-controlled string reaching the payload unescaped (names, values, alt, option names, URLs, frame URLs, hidden labels, article title and byline, the `Title:`/`URL:` lines, a page-set `data-cs-ref`, a `<pre>` closing its own fence) — plus a majority of test-coverage findings (assertions that could not fail). Candidates: (a) an LLD whose output carries page-controlled text lists every such field and its sanitizer as one table, so review checks a list instead of discovering one field per round; (b) the implementer brief requires a mutation check per correctness test (revert the fix, see red) — the later passes did this on request and it cut the vacuous-test findings. After the Opus loop converged, one Fable (`high`) pass found three must-fix defects and its re-verify two more, all in the same class; the Opus rounds had reported "no findings" on that surface. Candidate (c): the build playbook's final Fable pass is the default for a change with a page-controlled-text surface, not an offer. Phase 3 repeated the pattern: after eight Opus rounds, the final Fable (`high`) and Codex Sol (`xhigh`) pass found eleven correctness findings between them. Among them were a working tab left outside the domain gate, an empty `select` value refused, a retained-render cap that skipped the link lists, and a `tabs new` close that left no working tab. Codex and Fable overlapped on two findings only.
   - [ ] Resolution:

8. Phase-2 build: two reviewer rounds delivered only an addendum from a delegated sub-audit, the main report lost; the orchestrator had to ask for a resend each time. The brief already said "report once, in one message"; the reviewer still spawned sub-audits and timers. Candidate: reviewer.md forbids background timers and requires the final message to be the complete report.
   - [ ] Resolution:

9. Phase-3 run 4: the implementer and one of its subagents red-checked by mutation in the same working tree at once. The implementer's backup of `sessions.js` caught the subagent's mutation in place, so its restore put the mutation back; the subagent noticed and restored the file. Candidate: an agent that red-checks while another agent shares the tree runs its mutations in a private copy of the tree, as the orchestrator did for the phase-3 baseline fix, or the brief forbids parallel red-checks.
   - [ ] Resolution:

10. Phase-3 build: comment and doc prose took a large share of every review round. Round 1 listed about 30 comment sites, and the fix pass's sweep fixed about 180. Round 2 still listed about 60 more (no-negation, garden paths, noun-phrase openings, stale pointers) and 11 doc-accuracy findings. The build playbook runs the comment review (step 6) only after the review loop converges, so each code-review round re-litigates prose. Candidate: run the comment-review pass once before the first code review, and tell the code reviewer to leave comment prose to that pass, keeping comment findings that mislead about behaviour.
   - [ ] Resolution:

11. Phase-3 build: every implementer brief ran the headful gate, which opens Chrome windows on the human's display. In fix pass G1 it ran while the human was playing a game there, and a window-focus check failed twice because the game held the active window. Candidate: a fix pass runs the headless gate only; the headful gate runs once, at the full-suite step, after the orchestrator asks the human whether the display is free.
   - [ ] Resolution:

12. Phase-3 build: the `Navigated:` verdict took a correctness finding in three review rounds running (round 2's M28, round 3's M40, round 4's M49 and M50). Each fix pass patched the last fix with one more mark, and each patch opened the next case. Round 4's triage replaced the marks with one table of tab states and verdicts, judged once. Candidate: when a review round finds a bug in an earlier round's fix to the same logic, the triage writes the logic out whole (a table of states against outcomes, one test per row) and the fix pass rewrites it against the table instead of patching.
   - [ ] Resolution:

13. Phase-3 build: on a 13,000-line diff the review loop didn't converge on test coverage. Rounds 5 and 6 found three coverage gaps and none, then a fresh round-7 reviewer mutation-tested code that every earlier round had passed and listed 30 more (operators, boundaries, unpinned head lines). Each fresh reviewer samples different corners by hand, so coverage findings keep arriving at a rate the loop can't drain. Candidate: run a mutation-testing tool (Stryker for JavaScript) over the changed files once the implementation lands, give the surviving mutants to the implementer as one list, and keep the review rounds for correctness and design. The human ended the phase-3 loop with one round (round 8) scoped to correctness and the work changed since round 6, with coverage gaps outside that scope left to a follow-up.
   - [ ] Resolution:

14. Phase-3 build: the orchestrator's `perl -0pi` edit to the LLD wrote `$1` followed by `24.` in the replacement, which perl read as capture group 124, so risk 23 was deleted and the new entry lost its number. The substitution count reported a match, as `~/.claude/CLAUDE.md` §Shell asks to check, and the damage showed only on reading the result. Candidate: §Shell adds "write `${1}` in a perl replacement, and read the changed lines (or `git diff`) after a multi-line substitution; a count shows that it matched, not what it wrote".
   - [ ] Resolution:

## C. Human-review findings

Phase-2 approved skips (build step 8), for wrap-up triage. None is a process lesson on its own; the pattern is in B7.
1. Kept for design reasons: `walk.js`'s unfiltered branch (risk 12 fallback); the `## Links` index printing a long URL whole (decision 12); a trusted click refusing a boxless control; a control inside a fenced block unmarked; `unstamp()` guarding an invariant no path reaches; the LLD Tests section listing designed tests only.
2. Accepted duplication: the bracket escape and `plain`/`collapse`/`cap` in the two page scripts and `snapshot.js`; `refsIn`'s grammar copies; the page script's raw `links` array.
3. Accepted test shape: `renderSource()` memo ordering; `render.html` carrying ~40 behaviours; hardcoded "impossible" refs; the live suites re-opening a fixture per test.
4. Accepted residue: a `find` read delivering a deduplicated link; `describeNode` per iframe from two sites; the unreachable `finally` release; `resolveScope`'s `main` guard; the redundant early-exit generation checks; five perf/equivalence items; two long sentences in `architecture.md`.

5. Phase 1 was merged to main, which both users' checkouts follow through hub sync, and nothing restarted either user's long-running daemon or ran the README migration. The new bridge (two-tool contract, same socket path) then talked to the old extension-era daemon, and every claudesurf call failed on z (`Unknown action: info`, `Unexpected response from daemon (HTTP 200)`); c's daemon had been stale since Aug 9. A migration script per user fixed it, followed after phase 2 by `npm ci` and a restart. Candidate: the merge-to-main step (worktree.md Integrate, or build.md step 13) ends with each user's deployment steps when the repo's code runs as a long-lived per-user service. Complete the dependency install, unit changes, restart, and any one-off migration, or hand the human a script for them.
   - [ ] Resolution:

Phase-3 approved skips (build step 8), for wrap-up triage. None is a process lesson on its own; the coverage pattern is in B13.
6. Kept as designed: a `"` inside a quoted page field (a tab title, the focused element's label) can make its line read as if the field ended early, while the real URL still prints and brackets stay escaped; the backstop refusing and closing a tab already closing, so a rejected close can't leave a page on a refused host; `Settled: no` reading "the document is still changing" for a quiet window held by the observer's start; `contenteditable` reading as `generic` (phase-2 behaviour).
7. Accepted residue: recursive `mkdirSync` hanging under `/proc` on a misconfigured path; the fake's back-forward-cache restore carrying its document's loader id without a test; the load-time `toolDefinitions()` call untested; test-only parameters and exports; `sessions.js`'s window lifecycle, `region.js`'s frame levels, and the fake browser left unsplit; coverage gaps outside review round 8's scope, left for a follow-up.

## D. Design-review loop

1. The phase-2 LLD took five design-review rounds; rounds 2–4 each found real gaps that a check of the draft against the shipped code's seams would have caught before dispatch — an error class the daemon maps by `instanceof` from one module (`SetupError`), a shared object-group name across units on one protocol session, an attach handler's early return for non-page targets, a per-read frame index against phase 1's "refs stay valid within a generation" promise. Candidate: before the first review dispatch, the LLD author walks each new mechanism against the module it plugs into (error mapping, handler early-returns, shared names, prior-phase promises) and records the check in the doc's Context block.
   - [ ] Resolution:
