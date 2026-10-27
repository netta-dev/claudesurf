// One retained render per tab: the last region that a read, a `since` read, or a change
// summary rendered there, uncut and before `find`, so a paging read slices it rather
// than rendering again, and a summary or a `since` read diffs against it. The store is
// the session's `retained` map, by target id; sessions.js clears an entry with its
// target and the whole map with the window's state and on the pipe's closing. An entry
// counts only at the generation that it was rendered at.

// The size in characters past which a render isn't kept; a size marker stands in its
// place for that generation, so a summary reports the size rather than a missing read.
// The link lists' URLs and refs count with the text, since a URL is kept whole however
// long it is.
const MAX_CHARS = 500_000;

// Keeps a render as the tab's, replacing the one before it. `params` are the scope,
// article, links, and hidden that it was rendered with; `source` is 'read', 'since', or
// 'summary'; `startedAt` the Date.now() time that the render began, before its tree pull;
// `generation` the tab's generation then. Returns false when the render is past
// MAX_CHARS, and keeps the size marker instead.
function keep(session, t, { params, overlayBlocks, region, linkLists, hiddenSection, header, source, startedAt, generation }) {
  const size = region.length + hiddenSection.length + sum(overlayBlocks, (block) => block.length)
    + sum(linkLists, (links) => sum(links, ({ ref, url }) => ref.length + url.length));
  if (size > MAX_CHARS) {
    session.retained.set(t.targetId, { tooLarge: true, generation, size });
    return false;
  }
  session.retained.set(t.targetId, { params, overlayBlocks, region, linkLists, hiddenSection, header, source, startedAt, generation });
  return true;
}

// Returns the tab's render at its current generation, the size marker ({ tooLarge:
// true }) for it, or null.
function current(session, t) {
  const entry = session.retained.get(t.targetId);
  return entry && entry.generation === t.generation ? entry : null;
}

function drop(session, t) {
  session.retained.delete(t.targetId);
}

// Drops every tab's retained render, as the window's state is dropped.
function dropAll(session) {
  session.retained.clear();
}

function sum(items, size) {
  return items.reduce((total, item) => total + size(item), 0);
}

module.exports = { keep, current, drop, dropAll };
