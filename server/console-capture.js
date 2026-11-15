// This module captures page messages through Console and Chrome messages through
// Log for armed tabs. Runtime remains disabled because enabling it runs page hooks
// used by bot-detection scripts. Uncaught exceptions aren't captured because Chrome
// reports them through Runtime.
//
// Captured messages persist across navigation until disarm or tab removal.
// Chrome replays stored document messages on enable, so rearming after disarm
// records those messages again. Stored text is collapsed and capped because Chrome
// doesn't limit message length.
//
// Callers pass the registry to avoid the dependency cycle described in network.js.

const { Ring, readAfter, printEntries, cursorHead } = require('./ring');
const { workingTarget, currentStateLines, cappedText, collapsedText, cappedUrl, letters } = require('./action-support');

const KEPT = 500;
const TEXT_CHARS = 1_000;
// The characters of a URL that an entry keeps. Every line prints a kept URL through
// cappedUrl, so the prefix only has to run past URL_MAX for a cut URL to still print
// its `…`.
const URL_KEPT = 1_000;

const rings = new WeakMap();

function attachConsole(conn, sessions) {
  conn.on('Console.messageAdded', ({ message }, cdpSessionId) => {
    const t = sessions.byCdpSession(cdpSessionId);
    if (!t || !message || !t.armingSent) return;
    ringOf(t).push({ kind: 'console', level: message.level, text: collapsedText(message.text, TEXT_CHARS), url: keptUrl(message.url), line: message.line, column: message.column });
  });
  conn.on('Log.entryAdded', ({ entry }, cdpSessionId) => {
    const t = sessions.byCdpSession(cdpSessionId);
    if (!t || !entry || !t.armingSent) return;
    ringOf(t).push({ kind: `chrome ${letters(entry.source)}`, level: entry.level, text: collapsedText(entry.text, TEXT_CHARS), url: keptUrl(entry.url), line: null, column: null });
  });
}

// Sends Console.enable and Log.enable without awaiting them, as arming sends its own
// commands; a rejection is logged and leaves arming's outcomes alone.
function enable(sessions, t, opts = {}) {
  for (const method of ['Console.enable', 'Log.enable']) {
    sessions.send(t.targetId, method, {}, opts).catch((e) => {
      const level = sessions.target(t.targetId) === t ? 'warn' : 'debug';
      sessions.log[level](`capturing the console of ${t.targetId}: ${e.message}`);
    });
  }
}

function disable(sessions, t) {
  rings.delete(t);
  for (const method of ['Console.disable', 'Log.disable']) {
    sessions.send(t.targetId, method).catch((e) => sessions.log.debug(`disarming ${t.targetId}: ${e.message}`));
  }
}

function drop(t) {
  rings.delete(t);
}

async function read({ sessions }, session, { after = 0 }, deadline) {
  const t = workingTarget(sessions, session);
  const state = await currentStateLines(sessions, t, { deadline });
  const listing = readAfter(rings.get(t), after);
  const { lines, printed, next } = await printEntries(listing.entries, listing.next, entryLine);
  const head = cursorHead({ state, label: 'Console', printed, after, kept: KEPT, missed: listing.missed, next });
  return { head, body: lines.join('\n') };
}

// Returns an entry's line. It starts at column 0 with its number, and its text is one
// collapsed, capped field, so a message can't start a line of its own.
function entryLine(entry) {
  const level = letters(entry.level) || 'log';
  const text = cappedText(entry.text, TEXT_CHARS);
  if (entry.kind === 'console') {
    const where = location(entry);
    return `[${entry.n}] ${level}${where ? ` ${where}` : ''} ${text}`;
  }
  return `[${entry.n}] ${level} (${entry.kind}) ${text}${entry.url ? ` ${cappedUrl(entry.url)}` : ''}`;
}

function location({ url, line, column }) {
  if (!url) return null;
  const numbers = [line, column].filter(Number.isInteger);
  return [cappedUrl(url), ...numbers].join(':');
}

function keptUrl(url) {
  return String(url || '').slice(0, URL_KEPT);
}

function ringOf(t) {
  let ring = rings.get(t);
  if (!ring) {
    ring = new Ring(KEPT);
    rings.set(t, ring);
  }
  return ring;
}

module.exports = { attachConsole, enable, disable, drop, read };
