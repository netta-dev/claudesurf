# browsing-overhaul — workflow-lessons

## A. Human triage overrides

1. The implementer was told to land the LLD's five sub-commits itself; each subagent `git commit` raised a permission prompt, and the human denied one, which stopped the run with 1.2–1.5 uncommitted. The orchestrator then committed them by hand.
   - [ ] Resolution:

2. The implementer's context hit ~308k tokens in one phase, past the human's 200k reuse cap. The cap is a session instruction; the build playbook's fix loop ("fix passes reuse the implementer's pick") assumes an unbounded reuse.
   - [ ] Resolution:

3. Approved skip: the reviewer flagged the `package.json` 1.0.0 → 2.0.0 bump as unsanctioned by the LLD. Kept; the phase deletes the extension and replaces the tool surface. An LLD that changes a package's public surface could name the version bump so a reviewer doesn't have to guess.
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

## C. Human-review findings

## D. Design-review loop

1. The phase-2 LLD took five design-review rounds; rounds 2–4 each found real gaps that a check of the draft against the shipped code's seams would have caught before dispatch — an error class the daemon maps by `instanceof` from one module (`SetupError`), a shared object-group name across units on one protocol session, an attach handler's early return for non-page targets, a per-read frame index against phase 1's "refs stay valid within a generation" promise. Candidate: before the first review dispatch, the LLD author walks each new mechanism against the module it plugs into (error mapping, handler early-returns, shared names, prior-phase promises) and records the check in the doc's Context block.
   - [ ] Resolution:
