// The overlay blocks that a read prints ahead of its region: the open dialogs, menus,
// and messages that blockOverlays picked from the page unit's tree. Each renders in the
// page unit the way that a ref scope renders its root, one at a time, after the region's
// unit and before the frame levels. Dialogs take the render slots first, since a modal
// one has to be answered first.

const { TargetGoneError } = require('./sessions');
const render = require('./render');
const { DIALOG_ROLES } = require('./snapshot');

const OBJECT_GROUP = 'claudesurf-read-overlay';
// The caps on the blocks that render and on the render calls that they take; a skipped
// overlay spends a call but not a block.
const MAX_BLOCKS = 4;
const MAX_CALLS = 8;
// The cap on a block's own text, which is cut at a line end within it before its
// frames are inlined.
const BLOCK_CHARS = 4_000;

// Renders the picked overlays of `page`, the page unit, with the read's `links`.
// Resolves { overlayBlocks, more }: each block { ref, nodeId, backendId, role, name,
// modal, markdown, refs, hiddenRefs, links, frames, unreadable? }, its markdown cut
// and holding its frames' placeholders, its refs the ones left in that text; `more`,
// the refs of the overlays left unrendered past either limit. An overlay whose root is
// hidden, gone, or a screen-reader announcement is skipped: it spends a call but takes
// neither a block nor a place in `more`. A block whose render fails is marked
// unreadable, except for a TargetGoneError, which fails the read.
async function renderOverlayBlocks(sessions, page, picked, { links, deadline }) {
  const ordered = [...picked.filter((o) => DIALOG_ROLES.has(o.role)), ...picked.filter((o) => !DIALOG_ROLES.has(o.role))];
  const overlayBlocks = [];
  const more = [];
  let calls = 0;
  for (const overlay of ordered) {
    const ref = `${page.prefix}e${overlay.backendId}`;
    if (overlayBlocks.length === MAX_BLOCKS || calls === MAX_CALLS) {
      more.push(ref);
      continue;
    }
    calls += 1;
    const block = { ref, nodeId: overlay.nodeId, backendId: overlay.backendId, role: overlay.role, name: overlay.name, modal: overlay.modal };
    let result;
    try {
      result = await render.renderUnit(sessions, { ...page, rootBackendId: overlay.backendId, label: `overlay ${ref}` }, {
        chain: 'ref', fallback: 'ref', links, deadline, overlay: { role: overlay.role }, objectGroup: OBJECT_GROUP,
      });
    } catch (e) {
      if (e instanceof TargetGoneError) throw e;
      sessions.log.info(`overlay ${ref} is not readable: ${e.message}`);
      overlayBlocks.push({ ...block, unreadable: true, markdown: '', refs: [], hiddenRefs: [], links: [], frames: [] });
      continue;
    }
    if (result.skipped || !result.markdown) continue;
    const kept = render.cutToLine(result.markdown, BLOCK_CHARS);
    const markdown = kept.length < result.markdown.length ? `${kept}\n… cut; scope=${ref} reads it whole` : kept;
    // A ref outlives the cut as a marker, a link's trailing ref, or a frame's placeholder.
    const marked = render.markedRefs(kept);
    const left = new Set(result.refs.filter((r) => marked.has(r) || kept.includes(render.placeholder(r))));
    overlayBlocks.push({
      ...block, markdown, refs: [...left], hiddenRefs: result.hiddenRefs, links: result.links, frames: result.frames,
    });
  }
  return { overlayBlocks, more };
}

module.exports = { renderOverlayBlocks, BLOCK_CHARS };
