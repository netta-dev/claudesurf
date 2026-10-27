// Where press's keys go: the innermost focused element of the working tab's main
// document, read before and after the keys, the Keys to: and Focus now: lines that
// name it, and the child frame that an <iframe> or a <frame> holding focus contains.
// The element's tag and label are the page's to choose, so each line makes them safe.

const { releaseObjects, cappedText, FOCUSED_SOURCE } = require('./action-support');

// The longest a focused element's tag prints.
const TAG_MAX = 40;
// The tags of an element that holds a child frame.
const FRAME_TAGS = new Set(['iframe', 'frame']);
// The innermost focused element of the main frame's document, through open shadow
// roots, or null when only the body holds focus.
const ACTIVE_ELEMENT = `(() => {
${FOCUSED_SOURCE}
  const top = document.activeElement;
  return !top || top === document.body || top === document.documentElement ? null : claudesurfFocused();
})()`;

// Resolves with the DOM.describeNode answer for the innermost focused element of the
// tab's main document, its direct children included for its own text, or null when
// nothing is focused. The element's handle is taken under `objectGroup`, which is
// released before this resolves.
async function readFocus(sessions, t, objectGroup, opts) {
  try {
    return await sessions.withWorld(t.targetId, null, async (contextId) => {
      const { result, exceptionDetails } = await sessions.send(t.targetId, 'Runtime.evaluate', { expression: ACTIVE_ELEMENT, contextId, objectGroup }, opts);
      if (exceptionDetails) throw new Error(`reading the focused element failed: ${exceptionDetails.text}`);
      if (!result.objectId) return null;
      const { node } = await sessions.send(t.targetId, 'DOM.describeNode', { objectId: result.objectId, depth: 1 }, opts);
      return node;
    }, opts);
  } finally {
    await releaseObjects(sessions, t.targetId, objectGroup, opts.deadline);
  }
}

// Resolves with the Focus now: line when focus has moved off `focus`, a readFocus
// answer from before the keys, or with null when it hasn't.
async function focusMoved(sessions, session, t, focus, objectGroup, opts) {
  const now = await readFocus(sessions, t, objectGroup, opts);
  return idOf(now) === idOf(focus) ? null : focusLine('Focus now:', session, t, now);
}

// Returns a Keys to: or Focus now: line for a describeNode answer: the element's ref
// when the session's last read covered this document and returned it, its tag, and its
// label, all made safe, since the page chose them.
function focusLine(prefix, session, t, node) {
  if (!node) return `${prefix} the page (nothing focused)`;
  const ref = readRef(session, t, node) ? `[e${node.backendNodeId}] ` : '';
  const tag = tagOf(node);
  if (FRAME_TAGS.has(tag)) return `${prefix} ${ref}frame`;
  const label = labelOf(node);
  return `${prefix} ${ref}${tag || 'element'}${label ? ` "${label}"` : ''}`;
}

// Returns the child frame that an <iframe> or a <frame> holding focus contains, which
// settling watches as the keys' target. A Settled: line names the frame by the ref
// that Keys to: prints for it, judged as the head is built, as Keys to: is.
function focusedFrame(sessions, session, t, focus) {
  if (!focus || !FRAME_TAGS.has(tagOf(focus)) || !focus.frameId) return null;
  const label = () => (readRef(session, t, focus) ? `the frame e${focus.backendNodeId}` : 'a frame');
  const own = sessions.target(focus.frameId);
  if (own && own.type === 'iframe') return { target: own, frameId: null, label };
  return { target: t, frameId: focus.frameId, label };
}

// Returns whether the session's last read covered the working tab's current document
// and returned this node.
function readRef(session, t, node) {
  if (session.refsTarget !== t.targetId) return false;
  const set = session.refs.get(t.targetId);
  return Boolean(set) && set.generation === t.generation && set.ids.has(node.backendNodeId);
}

function tagOf(node) {
  return (node.localName || node.nodeName || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, TAG_MAX);
}

// Returns the first of the element's aria-label, placeholder, name, own text, and id
// that is not blank.
function labelOf(node) {
  const attributes = new Map();
  const flat = node.attributes || [];
  for (let i = 0; i + 1 < flat.length; i += 2) attributes.set(flat[i], flat[i + 1]);
  const ownText = (node.children || []).filter((child) => child.nodeType === 3).map((child) => child.nodeValue).join(' ');
  for (const value of [attributes.get('aria-label'), attributes.get('placeholder'), attributes.get('name'), ownText, attributes.get('id')]) {
    const label = cappedText(value);
    if (label) return label;
  }
  return '';
}

function idOf(node) {
  return node ? node.backendNodeId : null;
}

module.exports = { readFocus, focusMoved, focusLine, focusedFrame };
