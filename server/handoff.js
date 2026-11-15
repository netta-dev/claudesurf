// A handoff lasts from a needs_human result until the session's next call other than
// policy reaches its queue slot. This module sends a desktop notification and marks
// the session's browser window when the handoff opens, and clears the mark on close.
// Notifications are limited to one per session, challenge type, and URL origin and
// path in 10 minutes. Refusals during an open handoff produce notices once per host,
// with at most three notices per session in 10 minutes across handoffs.
//
// daemon.js calls `closed` at the start of a queue slot and `opened` at its end.
// The session queue preserves the order of those calls. Neither method waits for
// desktop tools. Commands for a window's mark run in sequence, so a clear runs after
// an earlier set.
//
// Desktop notifications use the session's label and host and omit the page's title.

const { challengeName, oneLineLabel } = require('./envelope');
const { hostOf } = require('./policy');
const { cutText } = require('./action-support');

const LIMIT_MS = 10 * 60_000;
const REFUSAL_NOTICES = 3;
const LABEL_CHARS = 60;
const HOST_CHARS = 80;

class Handoff {
  constructor({ notifier, browserPid, log }) {
    this.notifier = notifier;
    this.browserPid = browserPid;
    this.log = log;
    this.open = new Map();
    // session id → [{ host, at }], the refusal notices of the last LIMIT_MS.
    this.notices = new Map();
    this.notified = new Map();
    this.marking = new Map();
  }

  opened(session, challenge, url) {
    const handoff = { windowId: null };
    this.open.set(session.id, handoff);
    const now = Date.now();
    prune(this.notified, (at) => now - at >= LIMIT_MS);
    this.pruneNotices(now);
    const key = `${session.id} ${challenge.type} ${originAndPath(url)}`;
    if (!this.notified.has(key)) {
      this.notified.set(key, now);
      const name = challengeName(challenge.type);
      this.notifier.notify({
        summary: `ClaudeSurf: ${labelText(session)} needs you`,
        body: `${name[0].toUpperCase()}${name.slice(1)} on ${hostText(hostOf(url))} is waiting in that session's window.`,
        urgency: 'critical',
      });
    }
    this.markWindow(session.id, handoff, challenge.title).catch((e) => this.log.warn(`marking the window: ${e.stack || e.message}`));
  }

  // Announces the gate's refusal `entry` (refusals.js) in the session's tabs while its
  // handoff is open, once per host and REFUSAL_NOTICES times at most per LIMIT_MS.
  refused(session, entry) {
    if (!this.open.has(session.id)) return;
    const now = Date.now();
    this.pruneNotices(now);
    const notices = this.notices.get(session.id) || [];
    if (notices.length >= REFUSAL_NOTICES || notices.some((notice) => notice.host === entry.host)) return;
    notices.push({ host: entry.host, at: now });
    this.notices.set(session.id, notices);
    const host = hostText(entry.host);
    this.notifier.notify({
      summary: `ClaudeSurf stopped ${host}`,
      body: `In ${labelText(session)}. Sign in from a tab you open yourself (Ctrl+T), which shares the cookies, or ask Claude to allow ${host}.`,
      urgency: 'normal',
    });
  }

  closed(sessionId) {
    const handoff = this.open.get(sessionId);
    if (!handoff) return;
    this.open.delete(sessionId);
    if (handoff.windowId) this.queueMark(handoff.windowId, false);
  }

  // Resolves after searching for the window and queuing its mark if the same handoff
  // remains open. A missing browser or window skips the mark.
  async markWindow(sessionId, handoff, title) {
    const pid = this.browserPid();
    if (!pid) {
      this.log.info('urgency hint skipped: the browser is not running');
      return;
    }
    const windowId = await this.notifier.findWindow({ pid, title });
    if (!windowId || this.open.get(sessionId) !== handoff) return;
    handoff.windowId = windowId;
    this.queueMark(windowId, true);
  }

  queueMark(windowId, on) {
    const last = this.marking.get(windowId) || Promise.resolve();
    const next = last.then(() => this.notifier.mark(windowId, on))
      .catch((e) => this.log.warn(`marking window ${windowId}: ${e.stack || e.message}`));
    this.marking.set(windowId, next);
    next.then(() => { if (this.marking.get(windowId) === next) this.marking.delete(windowId); });
  }

  pruneNotices(now) {
    for (const [sessionId, notices] of this.notices) {
      const recent = notices.filter((notice) => now - notice.at < LIMIT_MS);
      if (recent.length) this.notices.set(sessionId, recent); else this.notices.delete(sessionId);
    }
  }
}

function labelText(session) {
  const name = oneLineLabel(session.name);
  return name ? `"${cutText(name, LABEL_CHARS)}"` : 'an unnamed session';
}

function hostText(host) {
  return cutText(String(host || 'an unknown host'), HOST_CHARS);
}

// Returns the URL's origin and path, the part that a sign-in or a challenge keeps
// across its retries, which vary the query.
function originAndPath(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return String(url);
  }
}

function prune(map, stale) {
  for (const [key, value] of map) if (stale(value)) map.delete(key);
}

module.exports = { Handoff };
