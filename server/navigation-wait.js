// The wait for a navigation that an acting call started, and two verdicts on it.
// waitForDocument waits for the new document or for Chrome's drop of the navigation,
// and navigatedVerdict judges the Navigated: line, both from the tab's navigation
// counters (sessions.js's targetRecord); refusedOwn says whether the gate refused the
// navigation, from the session's refusal list (refusals.js).

// How long a navigation that an action or a history step started may take to commit
// and fire DOMContentLoaded.
const NAVIGATION_MS = 10_000;
const STARTED = 'started (the new page has not finished loading)';

// Resolves once the tab's current document is newer than `from`'s and has fired its
// own DOMContentLoaded, once its latest navigation, which started since `from`, has
// stopped without a commit (navigationsStopped, sessions.js), or once `timeout` ms have
// passed; with `sameDocument`, also once a same-document navigation has landed. `from`
// holds the tab's generation, navigations, and sameDocument counts from before the
// navigation. Answers { committed, loaded, ended }: `ended` holds the tab's generation
// and navigations counts as the wait ended, which the next wait starts from; its
// `navigations` is the count that the wait covered: those started by the loaded
// document's commit, or else by the end of the wait. Rejects with TargetGoneError when
// the tab disappears.
async function waitForDocument(sessions, t, from, { timeout, deadline, sameDocument = false }) {
  const loaded = () => t.generation > from.generation && t.loadedGeneration === t.generation;
  const stopped = () => t.navigations > from.navigations && t.navigationsStopped === t.navigations;
  const state = () => ({ generation: t.generation, navigations: loaded() ? t.navigationsAtCommit : t.navigations });
  let ended = null;
  // The final state is recorded inside the event that ends the wait. A later event of
  // the same pipe read can commit a document or start a navigation before this call
  // resumes; that belongs to the next wait.
  const done = () => {
    const over = loaded() || stopped() || (sameDocument && t.sameDocument > from.sameDocument);
    if (over) ended = state();
    return over;
  };
  await sessions.waitUntil(t.targetId, done, { timeout, deadline });
  return { committed: t.generation > from.generation, loaded: loaded(), ended: ended || state() };
}

// Returns the Navigated: verdict from the tab's state against `before`, its state as
// the call began. A navigation is under way when it started after both the call's
// start and the current document's commit, and Chrome hasn't dropped it since without
// a commit, as it drops a refused navigation or a download.
function navigatedVerdict(t, before) {
  const underWay = t.navigations > Math.max(before.navigations, t.navigationsAtCommit, t.navigationsStopped);
  if (t.generation === before.generation) return underWay ? STARTED : 'no';
  return t.loadedGeneration === t.generation && !underWay ? 'yes' : STARTED;
}

// Returns whether the gate refused a navigation of the tab `t` since the call's marks.
function refusedOwn(session, t, marks) {
  return session.refusals.some((e) => e.targetId === t.targetId && e.seq > marks.seq && (e.kind === 'navigation' || e.kind === 'new tab'));
}

module.exports = { waitForDocument, navigatedVerdict, refusedOwn, NAVIGATION_MS };
