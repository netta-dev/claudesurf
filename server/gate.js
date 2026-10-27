// The domain gate, which stops a gated tab's route to a new top-level document whose
// host that the allowlist doesn't cover. Three checks make it up:
//   - the request handler, which judges each paused document request of an armed tab
//     (arming.js sends Fetch.enable) and answers every one of them, since a pause left
//     unanswered wedges the tab's navigation;
//   - the pre-check, which navigate, history, and tabs new run on their own URL
//     before they send anything;
//   - the backstop, which judges each commit of a gated tab's main frame, for a
//     document that arrived without a request that the handler saw, such as a
//     back-forward cache restore.
//
// A tab is gated while it belongs to a session and isn't its identity tab. A refusal
// closes a tab that still counts as new, which would otherwise sit on about:blank.

const { hostOf, isWeb } = require('./policy');
const { isMainFrame } = require('./frames');
const refusals = require('./refusals');

// Milliseconds, from a refusal that logs at info, during which further refusals of its
// host on its tab log at debug.
const LOG_REPEAT_MS = 60_000;

class Gate {
  // Takes `sessions`, the target registry, `policy`, the allowlist store, and `log`,
  // the daemon's logger.
  constructor({ sessions, policy, log }) {
    this.sessions = sessions;
    this.policy = policy;
    this.log = log;
    this.conn = null;
    this.logged = new Map();
  }

  // Takes the paused requests of a launch's connection and makes the gate the
  // registry's interceptor, so arming sends Fetch.enable. Runs on every launch.
  attach(conn) {
    this.conn = conn;
    conn.on('Fetch.requestPaused', (p, sid) => this.onPaused(p, sid));
    this.sessions.interceptor = this;
  }

  // Returns null when the session may load `url`, and otherwise the refusal entry, which
  // the caller returns as its `blocked` without recording it. `kind` is 'navigation', or
  // 'new tab' for tabs new. A URL other than http(s) passes.
  check(url, session, kind) {
    if (!isWeb(url)) return null;
    const host = hostOf(url);
    if (this.policy.allows(host, session.id)) return null;
    const targetId = session.workingTargetId;
    const entry = { kind, how: 'not started', url, host, targetId, tab: session.tabIds.get(targetId), count: 1 };
    this.logRefusal(entry);
    return entry;
  }

  // Records the gate's refusal `entry` on the session and wakes the refused tab's
  // waiters. Returns the recorded entry.
  refuse(session, entry) {
    const recorded = refusals.record(session, entry);
    this.logRefusal(entry);
    const t = this.sessions.target(entry.targetId);
    if (t) this.sessions.notify(t);
    return recorded;
  }

  // Judges a commit of a page target's main frame, after the registry has set `t.url`
  // and before it sets `committedWeb`: a gated tab that reached a host that the allowlist
  // doesn't cover is closed when new, and otherwise sent to about:blank.
  onCommitted(t) {
    const session = this.gatedSession(t);
    if (!session || !isWeb(t.url)) return;
    const host = hostOf(t.url);
    if (this.policy.allows(host, session.id)) return;
    const fresh = isNew(t);
    this.refuse(session, this.entry(t, session, { kind: 'restore', how: fresh ? 'closed' : 'blanked', url: t.url, host }));
    if (fresh) {
      this.sessions.closeTab(t);
    } else {
      this.sessions.send(t.targetId, 'Page.navigate', { url: 'about:blank' })
        .catch((e) => this.log.warn(`sending ${t.targetId} to about:blank: ${e.message}`));
    }
  }

  // Answers a paused document request. The request continues when its tab is outside
  // the gate, it comes from a child frame, its URL isn't http(s), or its host is
  // allowed. Otherwise the gate fails the request with Aborted, which leaves the tab's
  // document in place, and, unless the tab is closing, records the refusal and closes
  // the tab when it is new. A throw while judging fails a gated tab's request and
  // continues any other.
  onPaused({ requestId, request, frameId }, cdpSessionId) {
    let gated = false;
    let verdict;
    try {
      const t = this.sessions.byCdpSession(cdpSessionId);
      const session = t && this.gatedSession(t);
      gated = Boolean(session);
      verdict = session ? this.judge(t, session, request.url, frameId) : 'continue';
    } catch (e) {
      this.log.warn(`judging a paused request: ${e.stack || e.message}`);
      verdict = gated ? { fail: true } : 'continue';
    }
    if (verdict === 'continue') {
      this.log.debug(`gate: continuing ${request && request.url}`);
      this.answer('Fetch.continueRequest', { requestId }, cdpSessionId);
      return;
    }
    this.answer('Fetch.failRequest', { requestId, errorReason: 'Aborted' }, cdpSessionId);
    if (verdict.close) this.sessions.closeTab(verdict.close);
  }

  judge(t, session, url, frameId) {
    if (!isWeb(url) || !isMainFrame(t, frameId)) return 'continue';
    const host = hostOf(url);
    if (this.policy.allows(host, session.id)) return 'continue';
    // A tab that the daemon is closing is already gone to every call, so its request fails
    // without an entry or another close.
    if (t.closing) return { fail: true, close: null };
    const fresh = isNew(t);
    this.refuse(session, this.entry(t, session, { kind: fresh ? 'new tab' : 'navigation', how: 'stopped', url, host }));
    return { fail: true, close: fresh ? t : null };
  }

  entry(t, session, fields) {
    return { ...fields, targetId: t.targetId, tab: session.tabIds.get(t.targetId), opener: t.openerPage, count: 1 };
  }

  gatedSession(t) {
    if (!t.sessionId || t.role === 'identity') return null;
    return this.sessions.peek(t.sessionId) || null;
  }

  answer(method, params, cdpSessionId) {
    this.conn.send(method, params, { sessionId: cdpSessionId })
      .catch((e) => this.log.debug(`${method}: ${e.message}`));
  }

  logRefusal(entry) {
    const now = Date.now();
    for (const [key, at] of this.logged) if (now - at >= LOG_REPEAT_MS) this.logged.delete(key);
    const key = `${entry.targetId} ${entry.host}`;
    const repeat = this.logged.has(key);
    if (!repeat) this.logged.set(key, now);
    const tab = entry.tab === undefined ? '' : ` on t${entry.tab}`;
    this.log[repeat ? 'debug' : 'info'](`gate: refused ${entry.kind}${tab} to ${entry.host} (${entry.how})`);
  }
}

// Returns whether `t` counts as new: a tab that a page opened counts as new until it
// commits a web page or becomes the working tab.
function isNew(t) {
  return Boolean(t.openerPage) && !t.committedWeb && !t.everWorking;
}

module.exports = { Gate };
