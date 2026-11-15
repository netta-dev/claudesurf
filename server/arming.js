// This module puts tabs under the domain gate, disarms them, and handles arming
// failures. sessions.js arms a tab opened by a session page during attach, with the
// commands queued before its release, and arms the working tab in `repair`.
// sessions.js disarms a tab that leaves its session; the tab then behaves as one
// of the human's own.
//
// Arming and disarming advance the target's arming epoch. A result from an earlier
// epoch doesn't change `armed`. Arming also enables Console and Log capture, and
// disarming disables them. Their outcomes are excluded from the arming result, so
// capture failures can't close a tab or fail a call.

const { TimeoutError } = require('./cdp');
const requests = require('./requests');
const network = require('./network');
const consoleCapture = require('./console-capture');
const tabRecords = require('./tab-records');

const PRERENDER = 'Page.setPrerenderingAllowed';
// Chrome's buffer of a tab's response bodies, in total and per response; a filtered
// network read takes the bodies from it.
const BODY_BUFFER = 10 * 1024 * 1024;
const RESPONSE_BUFFER = 1024 * 1024;
const FETCH = 'Fetch.enable';
// The Fetch patterns that pause a tab's document requests, a child frame's included;
// the gate's handler judges the main frame's and continues the rest.
const DOCUMENT_REQUESTS = [{ resourceType: 'Document', requestStage: 'Request' }];

// Sends the arming commands and resolves with their outcomes, [{ method, ok, error }];
// doesn't reject. Fetch.enable goes only while a Gate is the registry's interceptor.
// Network.enable comes first, since the service-worker bypass takes effect only with
// it. The tab's `armed` flag goes up once every command but the prerendering switch
// has succeeded; that switch is experimental, so its rejection only warns.
function arm(sessions, t, { deadline } = {}) {
  const epoch = ++t.armingEpoch;
  t.armingSent = true;
  const commands = [
    ['Network.enable', { maxTotalBufferSize: BODY_BUFFER, maxResourceBufferSize: RESPONSE_BUFFER }],
    ['Network.setBypassServiceWorker', { bypass: true }],
    [PRERENDER, { isAllowed: false }],
  ];
  if (sessions.interceptor) commands.push([FETCH, { patterns: DOCUMENT_REQUESTS }]);
  const sent = commands.map(([method, params]) => sessions.send(t.targetId, method, params, { deadline }));
  consoleCapture.enable(sessions, t, { deadline });
  t.arming = Promise.allSettled(sent).then((settled) => {
    const outcomes = settled.map((s, i) => ({ method: commands[i][0], ok: s.status === 'fulfilled', error: s.reason }));
    const prerender = outcomes.find((o) => o.method === PRERENDER && !o.ok);
    if (prerender) sessions.log.warn(`target ${t.targetId}: prerendering stays allowed, which the domain gate can't see: ${prerender.error.message}`);
    if (t.armingEpoch === epoch) t.armed = !failure(outcomes);
    return outcomes;
  });
  return t.arming;
}

// Applies the rule for a tab armed at attach, after its claim step. A page-opened tab
// whose arming failed is closed with a session note, unless the only failures were
// timeouts of Network.enable or the bypass, which leave its requests pausing at the
// gate. A working tab is left for the next repair, the identity tab stays unarmed, and
// a tab that is closing or has left its session or the registry is left alone.
function onRejections(sessions, t, outcomes) {
  const failed = failure(outcomes);
  if (!failed || sessions.target(t.targetId) !== t || t.closing) return;
  const session = t.sessionId && sessions.peek(t.sessionId);
  if (!session) return;
  const what = `target ${t.targetId} could not be put under the domain gate (${failed.error.message})`;
  if (t.role === 'working') { sessions.log.warn(`${what}; the next repair arms it again`); return; }
  if (t.role !== 'opened') { sessions.log.warn(`${what}; it stays unarmed`); return; }
  if (!closesTab(outcomes)) { sessions.log.warn(`${what}; left open`); return; }
  sessions.log.warn(`${what}; closing it`);
  session.notes.push(`${tabRecords.tabId(session, t.targetId)} was closed because it could not be put under the domain gate`);
  sessions.closeTab(t);
}

function disarm(sessions, t) {
  t.armingEpoch += 1;
  t.armed = false;
  if (!t.armingSent) return;
  requests.drop(t);
  network.drop(t);
  t.armingSent = false;
  const send = (method, params) => sessions.send(t.targetId, method, params)
    .catch((e) => sessions.log.debug(`disarming ${t.targetId}: ${e.message}`));
  send('Fetch.disable');
  send('Network.setBypassServiceWorker', { bypass: false });
  send(PRERENDER, { isAllowed: true });
  send('Network.disable');
  consoleCapture.disable(sessions, t);
}

// Returns the first outcome of Network.enable, the bypass, or Fetch.enable that failed,
// or null; null outcomes, as for a tab destroyed before its arming settled, give null.
function failure(outcomes) {
  return (outcomes || []).find((o) => !o.ok && o.method !== PRERENDER) || null;
}

// Returns whether the outcomes close a page-opened tab: a protocol error from any
// command but the prerendering switch, or a Fetch.enable that failed in any way.
function closesTab(outcomes) {
  return (outcomes || []).some((o) => !o.ok && o.method !== PRERENDER && (o.method === FETCH || !(o.error instanceof TimeoutError)));
}

module.exports = { arm, onRejections, disarm, failure, closesTab };
