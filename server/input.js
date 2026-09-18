// The claudesurf_act actions: navigate, click (scripted by default, real pointer
// events on request), and scroll. Same contract as read.js: { payload } back, an
// OutcomeError for a non-success outcome.

const fs = require('fs');
const path = require('path');
const envelope = require('./envelope');
const { ProtocolError, TimeoutError } = require('./cdp');
const { fail, stateLines, workingTarget, requireHttp, SCROLL_SOURCE } = require('./read');

const CLICK_SOURCE = fs.readFileSync(path.join(__dirname, 'page', 'click.js'), 'utf8');
const NAVIGATE_LOAD_MS = 25_000;
const NAVIGATE_MARGIN_MS = 2_000;
// After a click: how long a navigation may take to start, and then to load.
const NAVIGATION_START_MS = 300;
const NAVIGATION_LOAD_MS = 10_000;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function pageState(sessions, t, opts) {
  const info = await sessions.callInWorld(t.targetId, SCROLL_SOURCE, [], opts);
  return info;
}

async function navigate(sessions, session, { url, name, description, deadline }) {
  await sessions.setLabel(session, name, description);
  const t = workingTarget(sessions, session);
  const opts = { deadline };
  const since = t.loads;
  const r = await sessions.send(t.targetId, 'Page.navigate', { url }, opts);
  if (r.errorText) fail(envelope.error(`Navigation to ${url} failed: ${r.errorText}`));
  const budget = deadline === undefined ? NAVIGATE_LOAD_MS : Math.min(NAVIGATE_LOAD_MS, deadline - NAVIGATE_MARGIN_MS - Date.now());
  try {
    await sessions.waitForLoad(t.targetId, since, { timeout: Math.max(1, budget) });
  } catch (e) {
    if (e instanceof TimeoutError) fail(envelope.error(`Navigation to ${url} started but the page did not finish loading within ${Math.round(budget / 1000)} s`));
    throw e;
  }
  const info = await pageState(sessions, t, opts);
  return { payload: stateLines(info.url, info.title) };
}

// Resolves a ref against the session's ref set for the working tab, per the
// generation rules: a set from another document is stale, an unread ref is an error.
async function resolveRef(sessions, session, t, ref, opts) {
  const id = Number(ref.slice(1));
  const set = session.refs.get(t.targetId);
  if (!set || set.generation !== t.generation) fail(envelope.staleRef(ref, 'the document changed since it was read; read the page again'));
  if (!set.ids.has(id)) fail(envelope.error(`${ref} was not returned by a read of this document`));
  const contextId = await sessions.world(t.targetId, opts);
  try {
    const { object } = await sessions.send(t.targetId, 'DOM.resolveNode', { backendNodeId: id, executionContextId: contextId }, opts);
    if (!object.objectId) fail(envelope.error(`${ref} no longer resolves to an element`));
    return object.objectId;
  } catch (e) {
    if (e instanceof ProtocolError) fail(envelope.error(`${ref} no longer resolves to an element (it was removed from the page)`));
    throw e;
  }
}

async function trustedClick(sessions, t, objectId, ref, opts) {
  const { quads } = await sessions.send(t.targetId, 'DOM.getContentQuads', { objectId }, opts);
  if (!quads || quads.length === 0) fail(envelope.error(`${ref} is hidden and has no position to click; a trusted click needs a visible element`));
  const [x1, y1, , , x2, y2] = quads[0];
  const x = (x1 + x2) / 2;
  const y = (y1 + y2) / 2;
  const hit = await sessions.send(t.targetId, 'DOM.getNodeForLocation', { x: Math.round(x), y: Math.round(y), includeUserAgentShadowDOM: false }, opts);
  const contextId = await sessions.world(t.targetId, opts);
  const { object } = await sessions.send(t.targetId, 'DOM.resolveNode', { backendNodeId: hit.backendNodeId, executionContextId: contextId }, opts);
  const reaches = await sessions.callFunction(t.targetId, {
    objectId, functionDeclaration: 'function (hit) { return hit === this || this.contains(hit) || (hit && hit.contains(this)); }', args: [{ objectId: object.objectId }],
  }, opts);
  if (!reaches) fail(envelope.error(`${ref} is covered by another element at its centre; a trusted click cannot reach it`));
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await sessions.send(t.targetId, 'Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, opts);
  }
}

// Waits for a main-frame navigation the click started and reports it, plus any
// target the page opened meanwhile.
async function afterClick(sessions, session, t, before, opts) {
  const startBy = Date.now() + NAVIGATION_START_MS;
  while (Date.now() < startBy && t.navigations === before.navigations && t.downloads === before.downloads && session.opened.size === before.opened) {
    await sleep(20);
  }
  let navigated = false;
  if (t.navigations > before.navigations) {
    const loadBy = Date.now() + NAVIGATION_LOAD_MS;
    while (Date.now() < loadBy && t.loads === before.loads && t.downloads === before.downloads) await sleep(20);
    navigated = t.loads > before.loads;
  }
  const lines = [];
  lines.push(`Navigated: ${navigated ? 'yes' : 'no'}`);
  for (const id of session.opened) {
    if (before.openedIds.has(id)) continue;
    const opened = sessions.target(id);
    const popup = opened && opened.windowId !== null && opened.windowId !== session.windowId;
    lines.push(`Opened: ${popup ? 'a popup window' : 'a new tab'} (not the working tab)`);
  }
  return lines;
}

async function click(sessions, session, ref, { trusted, deadline }) {
  const t = workingTarget(sessions, session);
  requireHttp(t);
  const opts = { deadline };
  const objectId = await resolveRef(sessions, session, t, ref, opts);
  const before = { navigations: t.navigations, loads: t.loads, downloads: t.downloads, opened: session.opened.size, openedIds: new Set(session.opened) };
  const { state } = await sessions.callFunction(t.targetId, {
    objectId, functionDeclaration: CLICK_SOURCE, args: [trusted ? 'prepare' : 'scripted'], userGesture: true,
  }, opts);
  if (state === 'detached') fail(envelope.error(`${ref} no longer resolves to an element (it was removed from the page)`));
  if (state === 'disabled') fail(envelope.error(`${ref} is disabled; clicking it would change nothing`));
  if (trusted) {
    if (state === 'hidden') fail(envelope.error(`${ref} is hidden; a trusted click needs a visible element`));
    await trustedClick(sessions, t, objectId, ref, opts);
  }
  const lines = await afterClick(sessions, session, t, before, opts);
  const info = await pageState(sessions, t, opts);
  return { payload: [stateLines(info.url, info.title), ...lines].join('\n') };
}

async function scroll(sessions, session, direction, amount, { deadline }) {
  const t = workingTarget(sessions, session);
  requireHttp(t);
  const info = await sessions.callInWorld(t.targetId, SCROLL_SOURCE, [direction, amount], { deadline });
  return { payload: `${stateLines(info.url, info.title)}\nScroll: ${info.scrollY} of ${info.pageHeight} (viewport ${info.viewportHeight})` };
}

module.exports = { navigate, click, scroll };
