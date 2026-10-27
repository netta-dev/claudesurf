// A target's frames: which frame id is its main frame's, for the events that name a
// frame, and whether a frame that a call depends on is still there, for settling's frame
// signal and a frame-scoped read's loss of its frame.

// Returns the id of the target's main frame: the one that its latest commit recorded, and
// until then its target id, which Chrome gives the main frame of a page and of an
// out-of-process frame alike.
function mainFrame(t) {
  return t.mainFrameId || t.targetId;
}

// Returns whether `frameId` names the target's main frame rather than a child frame
// whose events arrive on the same protocol session.
function isMainFrame(t, frameId) {
  return frameId === mainFrame(t);
}

// Resolves whether a frame is still there. With `frameId` null, `target` is a frame
// target, there while the registry holds it. Otherwise `frameId` names a same-process
// frame of `target`, there while `target`'s frame tree holds it and no registered
// frame target bears its id, since a frame that moved to a process of its own takes
// its id along. `opts.frameTrees`, a Map, keeps each target's tree across one check of
// several frames; `opts.deadline` bounds the frame-tree read, whose failure rejects.
async function frameThere(sessions, target, frameId, opts = {}) {
  if (frameId === null || frameId === undefined) return sessions.target(target.targetId) === target;
  const moved = sessions.target(frameId);
  if (moved && moved.type === 'iframe') return false;
  if (sessions.target(target.targetId) !== target) return false;
  const ids = await frameIds(sessions, target, opts);
  return ids.has(frameId);
}

function frameIds(sessions, target, { frameTrees, deadline }) {
  const cached = frameTrees && frameTrees.get(target.targetId);
  if (cached) return cached;
  const read = sessions.send(target.targetId, 'Page.getFrameTree', {}, { deadline }).then(({ frameTree }) => {
    const ids = new Set();
    const visit = (node) => {
      ids.add(node.frame.id);
      for (const child of node.childFrames || []) visit(child);
    };
    visit(frameTree);
    return ids;
  });
  if (frameTrees) frameTrees.set(target.targetId, read);
  return read;
}

module.exports = { mainFrame, isMainFrame, frameThere };
