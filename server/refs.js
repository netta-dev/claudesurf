// A ref's resolution, shared by the actions that take a ref and by a read scoped to one:
// the grammar's parse, the target and frame where a ref was read, under the staleness
// rules, and the node that it names in that frame's isolated world.

const envelope = require('./envelope');
const { ProtocolError } = require('./cdp');
const { isMissingContext } = require('./sessions');
const { REF } = require('./dispatch');
const { fail } = require('./action-support');

// The stale-ref reason for a ref whose frame is gone, whether refUnit finds it gone or
// the call loses it after that check.
const FRAME_GONE = 'the frame it was read in is gone; read the page again';
const TAB_CHANGED = 'the working tab changed since the ref was read; read the page again';

// Returns the error envelope of an action on a ref whose element was removed by the page.
function removed(ref) {
  return envelope.error(`${ref} no longer resolves to an element (it was removed from the page)`);
}

// Returns the frame number and the backend id that a ref names (dispatch.js's grammar), or
// null when it isn't a ref.
function parseRef(ref) {
  const match = REF.exec(ref);
  return match ? { frame: match[1] === undefined ? null : Number(match[1]), id: Number(match[2]) } : null;
}

// Returns the target, frame, and id that a ref names, with a document's generation deciding
// staleness in a frame as in the page: a frame target that is gone or has moved on is
// stale, a frame number never assigned and a ref never read are errors. `frameId` is
// the frame of that target where the id was read, null for its own main frame.
//
// A ref doesn't name its tab, and each renderer numbers its nodes from low ids, so
// once the working tab changes every ref is stale until a read of the new working tab:
// a ref from the old tab would otherwise resolve to whatever the new one numbered the
// same. `ownRender` waives that for the ref that scoped the tab's own retained render.
function refUnit(sessions, session, t, ref, { ownRender = false } = {}) {
  const parsed = parseRef(ref);
  if (!parsed) fail(envelope.error(`${ref} is not a ref; refs look like e42, or f1e42 inside a frame`));
  if (!ownRender && session.refsTarget !== null && session.refsTarget !== t.targetId) fail(envelope.staleRef(ref, TAB_CHANGED));
  const { frame, id } = parsed;
  const unread = () => fail(envelope.error(`${ref} was not returned by a read of this document`));
  let target = t;
  if (frame !== null) {
    // The page's own generation answers first: Chrome destroys a page's frame targets
    // after its frameNavigated, so between the two the frame target still stands, at
    // the generation that the read left it, for a document that the page has moved off.
    const page = session.refs.get(t.targetId);
    if (page && page.generation !== t.generation) fail(envelope.staleRef(ref, FRAME_GONE));
    target = sessions.frameTarget(t.targetId, frame);
    if (!target) {
      // Numbering starts at 1, so anything outside 1..the counter was never a frame of
      // this page and fails as a ref that a read didn't return.
      if (frame > 0 && frame < t.nextFrameNumber) fail(envelope.staleRef(ref, FRAME_GONE));
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

// Resolves the node that a ref names, under `objectGroup`, into the isolated world of the
// frame where the ref was read, the only world where the node resolves; the caller
// releases the group. A frame that navigated on its own doesn't move a generation, so
// the world that it discarded is found here and recreated once.
function resolveNode(sessions, located, ref, objectGroup, opts) {
  const { target, frameId, id } = located;
  return sessions.withWorld(target.targetId, frameId, async (contextId) => {
    try {
      const { object } = await sessions.send(target.targetId, 'DOM.resolveNode', { backendNodeId: id, executionContextId: contextId, objectGroup }, opts);
      if (!object.objectId) fail(removed(ref));
      return object.objectId;
    } catch (e) {
      // A missing context is withWorld's retry signal and is rethrown; a missing
      // element fails the action here.
      if (isMissingContext(e)) throw e;
      if (e instanceof ProtocolError) fail(removed(ref));
      throw e;
    }
  }, opts);
}

module.exports = { refUnit, resolveNode, removed, FRAME_GONE };
