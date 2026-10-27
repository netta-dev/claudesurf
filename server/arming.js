// The commands that put a tab under the domain gate and take it back out, and the rule
// for a tab whose arming failed. sessions.js arms a tab that a session's page opened
// as the tab attaches, with the commands queued ahead of its release, and arms the
// working tab in `repair`; it disarms a tab that leaves its session, which then
// behaves as one of the human's own.
//
// Each arming and each disarm moves the target's arming epoch, so an outcome that
// arrives after the tab was disarmed, or armed again, leaves `armed` alone.

const { TimeoutError } = require('./cdp');
const requests = require('./requests');
const tabRecords = require('./tab-records');

const PRERENDER = 'Page.setPrerenderingAllowed';
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
    ['Network.enable', { maxTotalBufferSize: 0, maxResourceBufferSize: 0 }],
    ['Network.setBypassServiceWorker', { bypass: true }],
    [PRERENDER, { isAllowed: false }],
  ];
  if (sessions.interceptor) commands.push([FETCH, { patterns: DOCUMENT_REQUESTS }]);
  const sent = commands.map(([method, params]) => sessions.send(t.targetId, method, params, { deadline }));
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

// Sends Fetch.disable, restores the bypass and the prerendering switch while Network
// is still enabled, then sends Network.disable, without awaiting the commands. Drops
// the tab's in-flight requests. Sends the commands only for a tab that arming
// reached.
function disarm(sessions, t) {
  t.armingEpoch += 1;
  t.armed = false;
  if (!t.armingSent) return;
  requests.drop(t);
  t.armingSent = false;
  const send = (method, params) => sessions.send(t.targetId, method, params)
    .catch((e) => sessions.log.debug(`disarming ${t.targetId}: ${e.message}`));
  send('Fetch.disable');
  send('Network.setBypassServiceWorker', { bypass: false });
  send(PRERENDER, { isAllowed: true });
  send('Network.disable');
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
