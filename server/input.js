// The claudesurf_act actions: navigate, click (scripted by default, real pointer
// events on request), and scroll. Same contract as read.js: { payload } back, an
// OutcomeError for a non-success outcome.

const envelope = require('./envelope');
const { ProtocolError } = require('./cdp');
const { fail, stateLines, workingTarget, requireHttp, pageState, CLICK_SOURCE, SCROLL_SOURCE } = require('./action-support');

const NAVIGATE_LOAD_MS = 25_000;
// How long after an aborted navigate the denied-download event may still arrive.
const DOWNLOAD_EVENT_MS = 300;
// After a click: how long a navigation may take to start, and then to load.
const NAVIGATION_START_MS = 300;
const NAVIGATION_LOAD_MS = 10_000;
// A load wait stops this far before the request deadline, so the page state that
// follows it still has time to be read.
const LOAD_MARGIN_MS = 2_000;
// A click releases the remote object handles it takes under this group when it ends.
const OBJECT_GROUP = 'claudesurf-click';

function loadBudget(limit, deadline) {
  if (deadline === undefined) return limit;
  return Math.max(1, Math.min(limit, deadline - LOAD_MARGIN_MS - Date.now()));
}

async function navigate(sessions, session, { url, name, description, deadline }) {
  await sessions.setLabel(session, name, description);
  const t = workingTarget(sessions, session);
  const opts = { deadline };
  const before = { loads: t.loads, downloads: t.downloads, sameDocument: t.sameDocument };
  const r = await sessions.send(t.targetId, 'Page.navigate', { url }, opts);
  const downloaded = () => t.downloads > before.downloads;
  const denied = () => fail(envelope.error(`Navigation to ${url} was a download, which is denied; the page is unchanged`));
  if (r.errorText) {
    // A denied download answers ERR_ABORTED, with Page.downloadWillBegin just before or after.
    if (r.errorText === 'net::ERR_ABORTED' && await sessions.waitUntil(t.targetId, downloaded, { timeout: DOWNLOAD_EVENT_MS, deadline })) denied();
    fail(envelope.error(`Navigation to ${url} failed: ${r.errorText}`));
  }
  const budget = loadBudget(NAVIGATE_LOAD_MS, deadline);
  // A load, a same-document change (fragment), or a denied download each end the wait.
  const settled = () => t.loads > before.loads || t.sameDocument > before.sameDocument || downloaded();
  if (!await sessions.waitUntil(t.targetId, settled, { timeout: budget })) {
    const within = budget > 1 ? `within ${(budget / 1000).toFixed(1)} s` : 'before the request deadline passed';
    fail(envelope.error(`Navigation to ${url} started but the page did not finish loading ${within}`));
  }
  if (t.loads === before.loads && t.sameDocument === before.sameDocument) denied();
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
    const { object } = await sessions.send(t.targetId, 'DOM.resolveNode', { backendNodeId: id, executionContextId: contextId, objectGroup: OBJECT_GROUP }, opts);
    if (!object.objectId) fail(envelope.error(`${ref} no longer resolves to an element`));
    return object.objectId;
  } catch (e) {
    if (e instanceof ProtocolError) fail(envelope.error(`${ref} no longer resolves to an element (it was removed from the page)`));
    throw e;
  }
}

// Content quads and mouse events are in viewport coordinates; the hit test takes
// document coordinates, so the scroll offset is added for it.
async function trustedClick(sessions, t, objectId, ref, opts) {
  const { quads } = await sessions.send(t.targetId, 'DOM.getContentQuads', { objectId }, opts);
  if (!quads || quads.length === 0) fail(envelope.error(`${ref} is hidden and has no position to click; a trusted click needs a visible element`));
  const [x1, y1, , , x2, y2] = quads[0];
  const x = (x1 + x2) / 2;
  const y = (y1 + y2) / 2;
  const { cssLayoutViewport: viewport } = await sessions.send(t.targetId, 'Page.getLayoutMetrics', {}, opts);
  let hit;
  try {
    hit = await sessions.send(t.targetId, 'DOM.getNodeForLocation', {
      x: Math.round(x + viewport.pageX), y: Math.round(y + viewport.pageY), includeUserAgentShadowDOM: false,
    }, opts);
  } catch (e) {
    if (e instanceof ProtocolError) fail(envelope.error(`${ref} has no hit-testable point at its centre (it is covered, or lies outside the document); a trusted click cannot reach it`));
    throw e;
  }
  const contextId = await sessions.world(t.targetId, opts);
  const { object } = await sessions.send(t.targetId, 'DOM.resolveNode', { backendNodeId: hit.backendNodeId, executionContextId: contextId, objectGroup: OBJECT_GROUP }, opts);
  // The hit node reaches the element when one is inside the other, shadow roots
  // included: a host's painted content lives in its shadow tree.
  const reaches = await sessions.callFunction(t.targetId, {
    objectId,
    functionDeclaration: 'function (hit) { for (let n = hit; n; n = n.parentNode || (n instanceof ShadowRoot ? n.host : null)) if (n === this) return true; return Boolean(hit) && hit.contains(this); }',
    args: [{ objectId: object.objectId }],
  }, opts);
  if (!reaches) fail(envelope.error(`${ref} is covered by another element at its centre; a trusted click cannot reach it`));
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await sessions.send(t.targetId, 'Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, opts);
  }
}

// Waits for a main-frame navigation the click started and reports it, plus any
// target the page opened meanwhile. A denied download starts a navigation that
// never loads; its event ends the wait and it reads as no navigation.
async function afterClick(sessions, session, t, before, opts) {
  const { deadline } = opts;
  const changed = () => t.navigations > before.navigations || t.downloads > before.downloads || session.opened.size > before.opened;
  await sessions.waitUntil(t.targetId, changed, { timeout: NAVIGATION_START_MS, deadline });
  let navigated = 'no';
  if (t.navigations > before.navigations) {
    const settled = () => t.loads > before.loads || t.downloads > before.downloads;
    await sessions.waitUntil(t.targetId, settled, { timeout: loadBudget(NAVIGATION_LOAD_MS, deadline) });
    if (t.loads > before.loads) navigated = 'yes';
    else if (t.downloads === before.downloads) navigated = 'started (the new page has not finished loading)';
  }
  const lines = [];
  lines.push(`Navigated: ${navigated}`);
  for (const id of session.opened) {
    if (before.openedIds.has(id)) continue;
    const windowId = await sessions.windowOf(id, opts).catch(() => null);
    const popup = windowId !== null && windowId !== session.windowId;
    lines.push(`Opened: ${popup ? 'a popup window' : 'a new tab'} (not the working tab)`);
  }
  return lines;
}

async function click(sessions, session, ref, { trusted, deadline }) {
  const t = workingTarget(sessions, session);
  requireHttp(t);
  const opts = { deadline };
  try {
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
  } finally {
    // A navigation the click started has already discarded the handles.
    await sessions.send(t.targetId, 'Runtime.releaseObjectGroup', { objectGroup: OBJECT_GROUP }, opts).catch(() => {});
  }
}

async function scroll(sessions, session, direction, amount, { deadline }) {
  const t = workingTarget(sessions, session);
  requireHttp(t);
  const info = await sessions.callInWorld(t.targetId, SCROLL_SOURCE, [direction, amount], { deadline });
  return { payload: `${stateLines(info.url, info.title)}\nScroll: ${info.scrollY} of ${info.pageHeight} (viewport ${info.viewportHeight})` };
}

module.exports = { navigate, click, scroll };
