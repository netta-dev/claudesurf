// The claudesurf_act actions: navigate, click (scripted by default, real pointer
// events on request), and scroll. Same contract as read.js: { payload } back, an
// OutcomeError for a non-success outcome.

const envelope = require('./envelope');
const { ProtocolError } = require('./cdp');
const { isMissingContext } = require('./sessions');
const { REF } = require('./dispatch');
const { fail, stateLines, workingTarget, requireHttp, pageState, releaseObjects, CLICK_SOURCE, SCROLL_SOURCE } = require('./action-support');

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

// The frame number and the backend id a ref names (dispatch.js's grammar), or null
// when it is no ref at all.
function parseRef(ref) {
  const match = REF.exec(ref);
  return match ? { frame: match[1] === undefined ? null : Number(match[1]), id: Number(match[2]) } : null;
}

// The target, frame, and id a ref names, under phase 1's generation rules widened to
// frames: a frame target that is gone or has moved on is stale, a frame number never
// assigned and a ref never read are errors. `frameId` is the frame of that target the
// id was read in, null for its own main frame.
function refUnit(sessions, session, t, ref) {
  const parsed = parseRef(ref);
  if (!parsed) fail(envelope.error(`${ref} is not a ref; refs look like e42, or f1e42 inside a frame`));
  const { frame, id } = parsed;
  const unread = () => fail(envelope.error(`${ref} was not returned by a read of this document`));
  let target = t;
  if (frame !== null) {
    // The page's own generation answers first: Chrome destroys a page's frame targets
    // after its frameNavigated, so between the two the frame target still stands, at
    // the generation the read left it, for a document the page has moved off.
    const page = session.refs.get(t.targetId);
    if (page && page.generation !== t.generation) {
      fail(envelope.staleRef(ref, 'the frame it was read in is gone; read the page again'));
    }
    target = sessions.frameTarget(t.targetId, frame);
    if (!target) {
      // Numbering starts at 1, so anything outside 1..the counter was never a frame of
      // this page and reads as a ref no read returned.
      if (frame > 0 && frame < t.nextFrameNumber) fail(envelope.staleRef(ref, 'the frame it was read in is gone; read the page again'));
      unread();
    }
  }
  const set = session.refs.get(target.targetId);
  if (!set) unread();
  if (set.generation !== target.generation) {
    const what = frame === null ? 'the document' : "the frame's document";
    fail(envelope.staleRef(ref, `${what} changed since it was read; read the page again`));
  }
  if (!set.ids.has(id)) unread();
  return { target, frame, frameId: set.ids.get(id), id };
}

// Resolves the node a ref names into the isolated world of the frame it was read in,
// which is the only world it resolves in. A frame that navigated on its own leaves no
// generation behind, so the world it discarded is found here and recreated once.
function resolveNode(sessions, located, ref, opts) {
  const { target, frameId, id } = located;
  return sessions.withWorld(target.targetId, frameId, async (contextId) => {
    try {
      const { object } = await sessions.send(target.targetId, 'DOM.resolveNode', { backendNodeId: id, executionContextId: contextId, objectGroup: OBJECT_GROUP }, opts);
      if (!object.objectId) fail(envelope.error(`${ref} no longer resolves to an element`));
      return object.objectId;
    } catch (e) {
      // A missing context is withWorld's retry signal and is rethrown; a missing element fails the click here.
      if (isMissingContext(e)) throw e;
      if (e instanceof ProtocolError) fail(envelope.error(`${ref} no longer resolves to an element (it was removed from the page)`));
      throw e;
    }
  }, opts);
}

// Content quads and mouse events are in viewport coordinates; the hit test takes
// document coordinates, so the scroll offset is added for it. A same-process frame is
// laid out in its parent's renderer, so its quads are the page's coordinates already;
// `located` is only needed for the world its node lives in.
async function trustedClick(sessions, t, located, objectId, ref, opts) {
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
  // The hit node goes into the element's own world: callFunctionOn refuses an argument
  // from another one. A hit outside the element's frame resolves there too, and the
  // comparison below reports it as the covering element it is.
  const contextId = await sessions.world(t.targetId, located.frameId, opts);
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

// The click runs on the session of the target the ref was read in — a frame's own for
// an f-ref — while the navigation wait and the state lines stay the page target's, so
// a navigation confined to a frame reads as Navigated: no.
async function click(sessions, session, ref, { trusted, deadline }) {
  const t = workingTarget(sessions, session);
  requireHttp(t);
  const opts = { deadline };
  const located = refUnit(sessions, session, t, ref);
  if (trusted && located.frame !== null) {
    fail(envelope.error(`${ref} is inside a cross-site frame, where trusted clicks are not supported yet; click it without trusted=true`));
  }
  const on = located.target.targetId;
  try {
    const objectId = await resolveNode(sessions, located, ref, opts);
    const before = { navigations: t.navigations, loads: t.loads, downloads: t.downloads, opened: session.opened.size, openedIds: new Set(session.opened) };
    const { state } = await sessions.callFunction(on, {
      objectId, functionDeclaration: CLICK_SOURCE, args: [trusted ? 'prepare' : 'scripted'], userGesture: true,
    }, opts);
    if (state === 'detached') fail(envelope.error(`${ref} no longer resolves to an element (it was removed from the page)`));
    if (state === 'disabled') fail(envelope.error(`${ref} is disabled; clicking it would change nothing`));
    if (trusted) {
      if (state === 'hidden') fail(envelope.error(`${ref} is hidden; a trusted click needs a visible element`));
      await trustedClick(sessions, t, located, objectId, ref, opts);
    }
    const lines = await afterClick(sessions, session, t, before, opts);
    const info = await pageState(sessions, t, opts);
    return { payload: [stateLines(info.url, info.title), ...lines].join('\n') };
  } finally {
    // A navigation the click started has already discarded the handles.
    await releaseObjects(sessions, on, OBJECT_GROUP);
  }
}

async function scroll(sessions, session, direction, amount, { deadline }) {
  const t = workingTarget(sessions, session);
  requireHttp(t);
  const info = await sessions.callInWorld(t.targetId, SCROLL_SOURCE, [direction, amount], { deadline });
  return { payload: `${stateLines(info.url, info.title)}\nScroll: ${info.scrollY} of ${info.pageHeight} (viewport ${info.viewportHeight})` };
}

module.exports = { navigate, click, scroll, refUnit };
