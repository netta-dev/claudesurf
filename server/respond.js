// The response to a call: the handler's result, or the failure that it or a step before
// its queue slot threw, as the envelope, together with what the session holds for the
// next payload — the dismissed dialogs, the domain-gate refusals not yet reported, and
// the notes. A builder takes the session's refusals only inside the handler's queue
// slot, so it can't take a refusal that a later call led to; failureEnvelope, for a
// failure before the slot, leaves them on the session.
//
// A payload is the result's head, the dialog lines, the Blocked: lines of the
// refusals that the call led to, the Blocked by the page: lines of the rest, and then the
// body after a blank line, so a long body can't push the lines that say what happened
// out of a cut.

const envelope = require('./envelope');
const { SetupError } = require('./browser');
const { TargetGoneError } = require('./sessions');
const { FRAME_GONE } = require('./refs');
const { hostOf } = require('./policy');
const refusals = require('./refusals');
const { OutcomeError, WORKING_TAB_GONE, safeUrl, cappedText, cappedUrl } = require('./action-support');

// The most Blocked: and Blocked by the page: lines that print, the call's own first.
const MAX_BLOCKED_LINES = 5;

// Returns { envelope, carried, url } for a handler's `result`:
// { head, body?, images?, outcome?, blocked?, challenge? }.
// `notes` contains ensureWithNotes's notes. The response adds the session's notes
// from the queue slot and a note for each dismissed dialog.
// `carried` includes refusals incorporated into the response, including those omitted
// from the printed lines, with an `own` flag on each.
// `url` is the working tab's URL from the registry, or undefined without a working tab.
function respond(sessions, session, result, { notes = [] } = {}) {
  const dialogs = takeDialogs(sessions, session);
  const own = result.blocked || [];
  const rest = refusals.takeRest(session);
  const head = [result.head, ...dialogs.lines, ...blockedLines(own, rest)].join('\n');
  const payload = result.body ? `${head}\n\n${result.body}` : head;
  const merged = [...notes, ...session.takeNotes(), ...dialogs.notes];
  const images = result.images || [];
  let built;
  if (own.length) built = envelope.needsConfirmation(payload, { notes: merged, acted: !own.every((e) => e.how === 'not started') });
  else if (result.challenge) built = envelope.needsHuman(payload, { notes: merged, type: result.challenge.type, label: session.name });
  else if (result.outcome === 'unsettled') built = envelope.unsettled(payload, { notes: merged, images });
  else built = envelope.success(payload, { notes: merged, images });
  return { envelope: built, carried: carried(own, rest.entries), url: workingUrl(sessions, session) };
}

// Returns { envelope, carried, url } for an error that a handler threw, or that a step
// before its slot threw when `session` is null. Inside the slot the envelope carries
// the pending Blocked by the page: lines as its payload and the notes that the session
// took during the slot; outside it the refusals and notes stay on the session. A
// TargetGoneError for a target other than the working tab, while the working tab is
// still there, means that the frame of the call's `ref` disappeared. An error outside
// these mappings is logged at warn.
function failureEnvelope(e, sessions, session, { notes = [], ref, log }) {
  const failed = { ...mapFailure(e, sessions, session, ref, log) };
  if (!session) return { envelope: withNotes(failed, notes), carried: [], url: undefined };
  const rest = refusals.takeRest(session);
  const lines = blockedLines([], rest);
  if (lines.length) failed.payload = [failed.payload, ...lines].filter((part) => part !== undefined).join('\n');
  return {
    envelope: withNotes(failed, [...notes, ...session.takeNotes()]),
    carried: carried([], rest.entries),
    url: workingUrl(sessions, session),
  };
}

// Returns one Blocked: line for a refusal that the call led to, or a Blocked by the page:
// line for any other. The URL and the host are the page's to choose, so the URL is
// encoded and capped as a marker's is, and a host prints only as the URL parser
// normalizes it.
function blockedLine(entry, own) {
  const url = cappedUrl(entry.url || '');
  let what;
  if (entry.kind === 'restore') {
    what = `the tab reached ${url} without a request the gate could see, so it ${entry.how === 'closed' ? 'was closed' : 'went to about:blank'}`;
  } else if (entry.kind === 'new tab') {
    what = entry.how === 'not started' ? `a new tab to ${url} (not opened)` : `a new tab to ${url}, closed`;
  } else if (entry.kind === 'fetch') {
    what = `fetch of ${url} (not sent)`;
  } else {
    what = `navigation to ${url}${entry.how === 'not started' ? ' (not started)' : ''}`;
  }
  const tab = entry.tab === undefined || entry.tab === null ? '' : `[t${entry.tab}] `;
  const repeated = entry.count > 1 ? ` (×${entry.count})` : '';
  return `${own ? 'Blocked:' : 'Blocked by the page:'} ${tab}${hostText(entry.host)} — ${what}${repeated}`;
}

function blockedLines(own, rest) {
  const all = [...own.map((entry) => blockedLine(entry, true)), ...rest.entries.map((entry) => blockedLine(entry, false))];
  const lines = all.slice(0, MAX_BLOCKED_LINES);
  const more = all.length - lines.length + rest.dropped;
  if (more > 0) lines.push(`… and ${more} more`);
  return lines;
}

function carried(own, rest) {
  return [...own.map((entry) => ({ ...entry, own: true })), ...rest.map((entry) => ({ ...entry, own: false }))];
}

function hostText(host) {
  const text = String(host || '');
  return hostOf(`http://${text}/`) === text ? text : safeUrl(text);
}

function mapFailure(e, sessions, session, ref, log) {
  if (e instanceof OutcomeError) return e.envelope;
  if (e instanceof TargetGoneError) {
    const working = session && sessions.target(session.workingTargetId);
    if (ref && working && e.targetId !== working.targetId) return envelope.staleRef(ref, FRAME_GONE);
    return envelope.error(WORKING_TAB_GONE);
  }
  if (e instanceof SetupError) return envelope.setupError(e.message);
  log.warn(`action failed: ${e.stack || e.message}`);
  return envelope.error(e.message);
}

function withNotes(failed, notes) {
  if (notes.length) failed.notes = [...notes, ...(failed.notes || [])];
  return failed;
}

// Takes the dialogs queued on the working target and returns their lines and notes.
// Chrome delivers a frame's dialog on the page target's session, so the working
// target's queue holds it; the frame targets are drained with it because each is
// Page.enabled and a future Chrome may route it there.
function takeDialogs(sessions, session) {
  const lines = [];
  const notes = [];
  const targets = [session.workingTargetId, ...sessions.frameTargets(session.workingTargetId).map((f) => f.targetId)];
  for (const targetId of targets) {
    for (const { type, message } of sessions.takeDialogs(targetId)) {
      notes.push(`a ${type} dialog was dismissed`);
      // The message is the page's to set, and capped as a marker field is, so one
      // built to open a `## Hidden elements` section or a live ref marker can't.
      lines.push(`Dialog (${type}): ${cappedText(message)}`);
    }
  }
  return { lines, notes };
}

// Returns the URL of the session's working tab as the registry holds it, the action
// log's `url`; undefined without a session or a working tab.
function workingUrl(sessions, session) {
  const t = session && sessions.target(session.workingTargetId);
  return t ? t.url : undefined;
}

module.exports = { respond, failureEnvelope, blockedLine, workingUrl };
