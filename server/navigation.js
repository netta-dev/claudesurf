// The actions that move the working tab to another document: navigate, by URL, and
// history, through the tab's own history. Each checks its destination at the domain
// gate before it sends anything, and a refusal there returns the working tab's state
// lines with the gate's entry as `blocked`.

const envelope = require('./envelope');
const { isWeb } = require('./policy');
const { fail, workingTarget, requireHttp, currentStateLines, loadBudget } = require('./action-support');
const { beforeAction, finishAction, acting } = require('./act-result');
const { waitForDocument, refusedOwn, NAVIGATION_MS } = require('./navigation-wait');

// How long a navigation by URL may take to commit and fire DOMContentLoaded.
const NAVIGATE_LOAD_MS = 25_000;
// How long after an aborted navigate the denied-download event may still arrive.
const DOWNLOAD_EVENT_MS = 300;

// Navigates the working tab to `url`. When the domain gate refuses `url`, the call
// doesn't navigate: the result carries the working tab's state lines and the gate's
// entry as `blocked`. Otherwise the call waits for the new document's commit and
// DOMContentLoaded, then settles there, and ends as every acting call does. A refused
// redirect hop answers net::ERR_ABORTED, as a denied download does, so the refusal is
// looked for first.
async function navigate({ sessions, gate }, session, { url, name, description }, deadline) {
  await sessions.setLabel(session, name, description);
  const t = workingTarget(sessions, session);
  const opts = { deadline };
  const refused = await precheck(gate, sessions, session, t, url, 'navigation', opts);
  if (refused) return refused;
  const before = beforeAction(sessions, session, t);
  const r = await acting(() => sessions.send(t.targetId, 'Page.navigate', { url }, opts));
  if (r.errorText) {
    if (r.errorText === 'net::ERR_ABORTED') {
      // The gate's refusal stopped the navigation, which ends finishAction's wait at
      // once.
      if (refusedOwn(session, t, before.marks)) return finishAction(sessions, session, t, before, { deadline });
      // A denied download answers ERR_ABORTED, with Page.downloadWillBegin just before
      // or after.
      const downloaded = () => t.downloads > before.downloads;
      if (await sessions.waitUntil(t.targetId, downloaded, { timeout: DOWNLOAD_EVENT_MS, deadline })) {
        fail(envelope.error(`Navigation to ${url} was a download, which is denied; the page is unchanged`));
      }
    }
    fail(envelope.error(`Navigation to ${url} failed: ${r.errorText}`));
  }
  const budget = loadBudget(NAVIGATE_LOAD_MS, deadline);
  // A same-document change (a fragment) ends the wait too.
  const waited = await waitForDocument(sessions, t, before, { timeout: budget, deadline, sameDocument: true });
  const landed = waited.committed || t.sameDocument > before.sameDocument;
  if (!landed) {
    const within = budget > 1 ? `within ${(budget / 1000).toFixed(1)} s` : 'before the request deadline passed';
    fail(envelope.error(`Navigation to ${url} started but the page did not finish loading ${within}`));
  }
  return finishAction(sessions, session, t, before, { deadline, navigation: waited.committed ? waited : null });
}

// Goes back, forward, or reloads in the working tab's own history. An entry that isn't
// http(s) — the session page that a working tab starts on, in practice — counts as the
// end of the history, since a read there answers "navigate first". The gate checks the
// entry's host before the step. A back-forward cache restore doesn't make a request,
// so without that check the gate would first judge it at its commit, in the backstop.
async function history({ sessions, gate }, session, { op }, deadline) {
  const t = workingTarget(sessions, session);
  requireHttp(t);
  const opts = { deadline };
  const { currentIndex, entries } = await sessions.send(t.targetId, 'Page.getNavigationHistory', {}, opts);
  const index = op === 'back' ? currentIndex - 1 : op === 'forward' ? currentIndex + 1 : currentIndex;
  const entry = entries[index];
  if (!entry || !isWeb(entry.url)) {
    fail(envelope.error(op === 'back'
      ? 'The working tab has no earlier web page to go back to; navigate instead'
      : 'The working tab has no later web page to go forward to; navigate instead'));
  }
  const refused = await precheck(gate, sessions, session, t, entry.url, 'navigation', opts);
  if (refused) return refused;
  const before = beforeAction(sessions, session, t);
  await acting(() => (op === 'reload'
    ? sessions.send(t.targetId, 'Page.reload', {}, opts)
    : sessions.send(t.targetId, 'Page.navigateToHistoryEntry', { entryId: entry.id }, opts)));
  // A step between entries of one document lands without a commit; a back-forward
  // cache restore fires neither DOMContentLoaded nor load, and the registry counts its
  // commit as both.
  const waited = await waitForDocument(sessions, t, before, { timeout: loadBudget(NAVIGATION_MS, deadline), deadline, sameDocument: true });
  return finishAction(sessions, session, t, before, { deadline, navigation: waited });
}

// Resolves with the result of a navigation that the gate refused before it started:
// the state lines of the tab `t`, which stays where it is, and the gate's entry of
// `kind` (Gate.check) as `blocked`. Resolves with null when the gate lets `url` through
// or the call runs without a gate.
async function precheck(gate, sessions, session, t, url, kind, opts) {
  const refused = gate && gate.check(url, session, kind);
  if (!refused) return null;
  return { head: await currentStateLines(sessions, t, opts), blocked: [refused] };
}

module.exports = { navigate, history, precheck, NAVIGATE_LOAD_MS };
