// The daemon side of a read's rendering: one unit through the page script, and the
// assembly of what the units returned into the payload — frames inlined, `find`, the
// links index, the header lines, and the paging cut.
//
// A unit is one document the daemon can pull a tree from and run script in: the page's
// main frame, a same-process child frame, or an out-of-process one. Everything but
// renderUnit is pure over unit results and strings, so the payload's shape is tested
// without a browser.

const envelope = require('./envelope');
const { fail, stateLines, codePointBoundary, releaseObjects, renderSource, safeUrl, LABEL_MAX, URL_MAX, RESERVED } = require('./action-support');
const { isMissingContext } = require('./sessions');
const { OPTION_OWNERS } = require('./snapshot');
const { REF_SOURCE } = require('./dispatch');

const CALL = 'function (options, descriptors, ...nodes) { return claudesurfRender(options, descriptors, ...nodes); }';
// A unit releases the remote objects it resolved under this group, named per unit
// because a page and its same-process frames share one protocol session and render in
// parallel, and Runtime.releaseObjectGroup takes only a name.
const OBJECT_GROUP = 'claudesurf-read-';
// A frame block replaces the placeholder together with the whitespace around it. The
// global flag survives the nested replace a frame inside a frame runs: String.replace
// collects every match before it calls the replacer, so the outer pass is done matching
// by the time the inner one resets lastIndex.
const PLACEHOLDER = /[ \t\n]*\u0000frame:([^\u0000]*)\u0000[ \t\n]*/g;
// What the page script leaves where a frame's own render goes; placedFrames looks for
// it to tell a frame that the render placed from one that it dropped.
const placeholder = (ref) => `\u0000frame:${ref}\u0000`;
// The ref inside a marker or a link's trailing ref, in dispatch.js's grammar. A
// backslash ahead of the bracket is page text that Turndown escaped, not a marker.
const MARKED_REF = new RegExp(`(?<!\\\\)\\[(${REF_SOURCE})[ \\]]`, 'g');
// How much of a frame's own render is inlined, per frame and per read, so an embed
// above the fold cannot displace the page's own content.
const FRAME_CHARS = 8_000;
const READ_FRAME_CHARS = 16_000;

// Renders one unit: the descriptors its tree yields, the libraries evaluated once per
// world, its nodes and its iframes' frame ids resolved into that world, and one call.
// `unit` is { target, frameId, prefix, index, label, snapshot, rootBackendId }, `label`
// naming it in the log. Returns the page script's answer plus `frames`, the iframe
// nodes joined to the frames they hold. `landmarks` asks for landmark boundaries where
// the chain cannot: a frame a ref scope reads whole, whose whole document renders.
// `picked`, the page unit's overlays that render as blocks, are cut from what renders;
// `overlay`, { role }, renders an overlay's own block, rooted at it, and has the page
// script skip a root that is hidden, gone, or a screen-reader announcement.
// `objectGroup` names the group that holds the remote objects; a finally releases it,
// so the objects don't outlive the read. The release ends by `requestDeadline`, the
// request's deadline, which comes after a frame unit's own `deadline`.
async function renderUnit(sessions, unit, { chain, fallback, links, landmarks = false, deadline, requestDeadline = deadline, picked = [], overlay = null, objectGroup = `${OBJECT_GROUP}${unit.index}` }) {
  const { targetId } = unit.target;
  const descriptors = describe(unit, chain, picked);
  const opts = { deadline };
  return sessions.withWorld(targetId, unit.frameId, async (contextId, world) => {
    if (!world.injected) {
      // An exception thrown as the libraries evaluate comes back in the answer rather
      // than as a protocol error, and leaves the world without a renderer; `injected`
      // stays false, so the next read of this document evaluates them again.
      const { exceptionDetails } = await sessions.send(targetId, 'Runtime.evaluate', { expression: renderSource(), contextId }, opts);
      if (exceptionDetails) throw new Error(`the renderer's libraries did not evaluate: ${thrownText(exceptionDetails)}`);
      world.injected = true;
    }
    const started = Date.now();
    try {
      const [nodes, frames] = await Promise.all([
        resolveAll(sessions, targetId, descriptors, contextId, objectGroup, opts),
        frameIds(sessions, targetId, descriptors, opts),
      ]);
      const resolved = Date.now();
      // A same-process frame shares its parent's generation, so its own navigation
      // moves nothing the caller can check afterwards: withWorld's retry rebuilds a
      // world in the new document, where every node of the old tree resolves to null.
      // A whole-document render always describes something when the document is the
      // one the tree was pulled from, so this is the frame's own signal to give up
      // rather than render that document's prose with no markers at all.
      if (unit.frameId !== null && descriptors.length > 0 && nodes.every((node) => node === null)) {
        throw new Error('its document changed while it was being read');
      }
      const options = { chain, fallback, links, landmarks, overlay, labelMax: LABEL_MAX, urlMax: URL_MAX };
      const result = await sessions.callFunction(targetId, {
        executionContextId: contextId, functionDeclaration: CALL, args: [options, descriptors, ...nodes],
      }, opts);
      sessions.log.debug(`${unit.label}: ${descriptors.length} nodes resolved in ${resolved - started} ms, rendered in ${Date.now() - resolved} ms`);
      return { ...result, frames };
    } finally {
      await releaseObjects(sessions, targetId, objectGroup, requestDeadline);
    }
  }, opts);
}

// What an exception in a Runtime.evaluate answer says it was: the thrown value's
// description, which carries the stack, or the summary line when it has none.
function thrownText({ exception, text }) {
  return (exception && (exception.description || exception.value)) || text;
}

// Returns the descriptors of the nodes that the page script places markers for: the
// scope root, then every control, group, landmark, and iframe of the unit's tree
// inside it. A named region is both a landmark and a group and takes one descriptor,
// the group's, since a group's marker renders under every scope where a landmark's
// renders under `all` alone.
//
// An article is extracted from the whole document, so under that chain every node of
// the unit is described whatever the root is: a control Readability keeps from outside
// the root would otherwise render bare. The root is described either way, since the
// page script renders it when Readability fails to find an article. A root that is a
// combobox or a listbox is described as the control it is, marked as the root, with
// every option that the tree kept, and renders as its marker.
//
// Each overlay in `picked` gets an `overlay` descriptor whatever the root, so the clone
// walk can leave it out of the region wherever it sits.
function describe(unit, chain, picked = []) {
  const { snapshot, rootBackendId, prefix } = unit;
  const root = rootBackendId === null ? null : snapshot.node(rootBackendId);
  const inScope = root && chain !== 'forced-article' ? snapshot.subtree(root.nodeId) : null;
  // A tree node with no DOM node behind it has nothing to resolve and no ref to name
  // it by, so it is described as little as it is recorded in the ref set.
  const within = (entry) => entry.backendId !== undefined && (!inScope || inScope.has(entry.nodeId));
  const ref = (backendId) => `${prefix}e${backendId}`;
  const descriptors = [];
  if (root) {
    const listed = snapshot.controls.find((c) => c.backendId === rootBackendId && OPTION_OWNERS.has(c.role));
    descriptors.push(listed ? { ...controlDescriptor(listed, ref, true), root: true } : { ref: ref(rootBackendId), backendId: rootBackendId, kind: 'root' });
  }
  for (const o of picked) descriptors.push({ ref: ref(o.backendId), backendId: o.backendId, kind: 'overlay', role: o.role, name: o.name });
  for (const c of snapshot.controls.filter(within)) descriptors.push(controlDescriptor(c, ref, false));
  for (const g of snapshot.groups.filter(within)) descriptors.push({ ref: ref(g.backendId), backendId: g.backendId, kind: 'group', role: g.role, name: g.name });
  for (const l of snapshot.landmarks.filter(within)) descriptors.push({ ref: ref(l.backendId), backendId: l.backendId, kind: 'landmark', role: l.role, name: l.name });
  for (const f of snapshot.iframes.filter(within)) descriptors.push({ ref: ref(f.backendId), backendId: f.backendId, kind: 'iframe' });
  const seen = new Set();
  return descriptors.filter((d) => !seen.has(d.ref) && seen.add(d.ref));
}

// The number of options that a marker in the prose lists before it counts the rest.
const MAX_OPTIONS = 12;

// Returns a control's descriptor. Its options carry their refs, with the unit's
// prefix: the first MAX_OPTIONS for a marker in the prose, every kept one for a root,
// and in `more` how many the list leaves out.
function controlDescriptor(c, ref, whole) {
  const descriptor = {
    ref: ref(c.backendId), backendId: c.backendId, kind: 'control', role: c.role, name: c.name,
    state: c.state, range: c.range,
  };
  if (c.options) {
    const listed = whole ? c.options.kept : c.options.kept.slice(0, MAX_OPTIONS);
    descriptor.options = {
      names: listed.map((o) => ({ name: o.name, ref: o.backendId === undefined ? null : ref(o.backendId) })),
      more: c.options.total - listed.length,
    };
  }
  return descriptor;
}

// One DOM.resolveNode per descriptor, pipelined into the unit's world. A node the tree
// holds and the DOM no longer has resolves to null, which keeps the descriptors and
// the nodes aligned and the rest of the unit rendering; a world that is gone is the
// retry signal withWorld watches for.
function resolveAll(sessions, targetId, descriptors, contextId, objectGroup, opts) {
  return Promise.all(descriptors.map((descriptor) => sessions
    .send(targetId, 'DOM.resolveNode', {
      backendNodeId: descriptor.backendId, executionContextId: contextId, objectGroup,
    }, opts)
    .then(({ object }) => (object.objectId ? { objectId: object.objectId } : null), (e) => {
      if (isMissingContext(e)) throw e;
      return null;
    })));
}

// The frame behind each <iframe> of this unit: DOM.describeNode reports an iframe
// element's frameId, which equals the target id when the frame is out-of-process.
function frameIds(sessions, targetId, descriptors, opts) {
  return Promise.all(descriptors.filter((d) => d.kind === 'iframe').map((descriptor) => sessions
    .send(targetId, 'DOM.describeNode', { backendNodeId: descriptor.backendId }, opts)
    .then(({ node }) => ({ ref: descriptor.ref, frameId: node.frameId || null }), () => ({ ref: descriptor.ref, frameId: null }))));
}

// The frames a unit's render left room for: the placeholders its markdown carries,
// narrowed to the refs it reported emitting. Both halves are needed. A placeholder the
// rule for a link or a control around the <iframe> discarded with the rest of that
// element's content is a frame with nowhere to go, so reading it would spend a unit on
// output no payload could hold; and page text that spells a placeholder — the raw text
// of a fenced block, say — reaches the markdown without the frame rule having run for
// it at all.
//
// `inlined` says this unit's own markdown goes inside a parent's, where inlineFrames
// cuts it at FRAME_CHARS: a placeholder past that cut has nowhere to go either, so the
// cut is taken here, ahead of the read, by the rule that will take it there.
function placedFrames({ markdown, refs }, inlined = false) {
  const emitted = new Set(refs);
  const text = inlined ? cutToLine(markdown, FRAME_CHARS) : markdown;
  const placed = [...text.matchAll(PLACEHOLDER)].map((match) => match[1]);
  return new Set(placed.filter((ref) => emitted.has(ref)));
}

// Replaces each frame placeholder with its unit's markdown between boundary markers, or
// with a one-line marker saying why the frame was not read. `frames` maps a ref to
// { url, cross, markdown } or { url, cross, reason }; a ref with no entry is a frame
// the read never reached.
//
// A block stands on blank lines of its own. The match consumes the placeholder's own
// surrounding whitespace, so the blank lines a block brings are the only ones this
// touches and a run inside the page's own fenced text survives.
//
// `budget`, { chars }, is the read's frame-text budget, which every call of one read
// draws down in turn.
function inlineFrames(markdown, frames, budget = frameBudget()) {
  const expand = (text) => text.replace(PLACEHOLDER, (match, ref) => {
    const frame = frames.get(ref) || { reason: 'not readable' };
    const open = `[${ref} frame${frame.url ? ` ${markerUrl(frame.url)}` : ''}`;
    if (frame.markdown === undefined) return `\n\n${open} (${frame.reason})]\n\n`;
    // Only the frame's own text counts against the budget; the frames inside it
    // are expanded after the cut and count for themselves.
    const kept = cutToLine(frame.markdown, Math.min(FRAME_CHARS, budget.chars));
    budget.chars -= kept.length;
    const left = frame.markdown.length - kept.length;
    const cut = left > 0 ? `\n(frame content cut: ${left} more characters; scope=${ref} reads it whole)` : '';
    return `\n\n${open}${frame.cross ? ' cross-site' : ''}]\n${expand(kept).trim()}${cut}\n[/frame]\n\n`;
  });
  // A cut that landed inside a placeholder leaves an opening NUL behind; no payload
  // carries one, so the text after it reads as the prose it looks like.
  return expand(markdown).replaceAll('\u0000', '').trim();
}

// Returns a read's frame-text budget, which inlineFrames draws on.
function frameBudget() {
  return { chars: READ_FRAME_CHARS };
}

// Returns an overlay block: its marker, which names the role, the accessible name, and
// whether the tree marks it modal, then what it rendered, then a closing marker named
// by the role. The name is the tree's, capped and escaped as a marker's name is, and
// quoted.
function overlayBlock({ ref, role, name, modal }, content) {
  return `${overlayMarker({ ref, role, name, modal })}\n${content}\n[/${role}]`;
}

// Returns the block of an overlay whose render failed.
function unreadableOverlay({ ref, role }) {
  return `[${ref} ${role} (not readable)]`;
}

function overlayMarker({ ref, role, name, modal }) {
  return `[${ref} ${overlayTitle(role, name)}${modalMark(modal)}]`;
}

// Returns an overlay's role and its name, quoted, as its marker and the Overlays: line
// print them.
function overlayTitle(role, name) {
  return `${role}${name ? ` ${JSON.stringify(name)}` : ''}`;
}

function modalMark(modal) {
  return modal ? ' (modal)' : '';
}

// Returns the URL for a frame marker. It comes from the page, so it follows a link's
// rule: a data: URL and one too long to navigate render as their length.
function markerUrl(url) {
  const text = url.replace(RESERVED, '').replace(/\s+/g, ' ').trim();
  if (/^data:/i.test(text) || text.length > URL_MAX) return omitted(text.length);
  return safeUrl(text);
}

// The ## Links section: one line per distinct URL, absolute, with every ref that points
// at it, merged across the page and its frames, so a frame's /login and the page's stay
// two lines. `keep`, when given, narrows it to the refs a find delivered.
function linksIndex(results, keep) {
  const byUrl = new Map();
  for (const result of results) {
    for (const { ref, url } of result.links || []) {
      if (keep && !keep.has(ref)) continue;
      if (!byUrl.has(url)) byUrl.set(url, []);
      const refs = byUrl.get(url);
      if (!refs.includes(ref)) refs.push(ref);
    }
  }
  const lines = [...byUrl].map(([url, refs]) => `[${refs.join(', ')}] ${indexed(url)}`);
  return { count: byUrl.size, text: lines.length ? `## Links\n${lines.join('\n')}` : '' };
}

// A data: URL is no more navigable in the index than inline, so it keeps the form the
// prose gave it; every other URL is printed whole.
function indexed(url) {
  return /^data:/i.test(url) ? omitted(url.length) : safeUrl(url);
}

function omitted(length) {
  return `(url omitted: ${String(length).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} chars)`;
}

// Returns the refs that the markers and the links' trailing refs in `text` carry.
function markedRefs(text) {
  return new Set([...text.matchAll(MARKED_REF)].map((match) => match[1]));
}

// The blank-line-delimited blocks of a render holding `needle`, case-insensitively,
// each with its offset in the full render so a follow-up read without find continues
// there.
function findBlocks(markdown, needle) {
  const lower = needle.toLowerCase();
  const separator = /(?:\n[ \t]*){2,}/g;
  const blocks = [];
  let start = 0;
  for (;;) {
    const match = separator.exec(markdown);
    const end = match ? match.index : markdown.length;
    const text = markdown.slice(start, end);
    if (text.toLowerCase().includes(lower)) blocks.push({ offset: start, text });
    if (!match) break;
    start = separator.lastIndex;
  }
  return { count: blocks.length, blocks };
}

// The region cut to `max_chars` from `offset`: back to the last newline, or at a
// code-point boundary when one line is longer than the budget, so a response is never
// empty and the offset always advances. `resume` names how to ask for the rest.
function slice(region, { maxChars, offset, resume = nextPart }) {
  const total = region.length;
  if (offset > total) fail(envelope.error(`offset ${offset} is past the end of the page text (${total} characters)`));
  let end = Math.min(offset + maxChars, total);
  if (end < total) {
    const lineEnd = region.lastIndexOf('\n', end);
    const cut = lineEnd > offset ? lineEnd : codePointBoundary(region, end);
    // A budget of one character at a surrogate pair steps the cut back onto the offset
    // it was given, which would deliver nothing and name that offset again; the pair
    // ends two characters along, so the cut steps forward past it instead.
    end = cut > offset ? cut : offset + 2;
  }
  const truncation = offset > 0 || end < total
    ? `[Showing characters ${offset}–${end} of ${total}.${end < total ? resume(end) : ''}]`
    : '';
  return { text: region.slice(offset, end), truncation, end, total };
}

function nextPart(end) {
  return ` Pass offset=${end} for the next part.`;
}

// Returns the lines before the region, in this order; they are never cut, so a small
// budget still returns the whole header. `settled`, `paged`, and `since` are whole
// lines; `overlays` is { blocks, more }, the blocks that rendered ahead of the region
// and the refs of the overlays left out.
function header(state, { truncation, settled, paged, since, scope, omissions, overlays, hidden, hiddenListed, links, find, article }) {
  const lines = [stateLines(state.url, state.title)];
  if (truncation) lines.push(truncation);
  for (const line of [settled, paged, since]) if (line) lines.push(line);
  lines.push(scopeLine(scope, omissions));
  const listed = overlays && overlaysLine(overlays);
  if (listed) lines.push(listed);
  if (hidden) lines.push(`Hidden: ${count(hidden, 'control')} on the page (${hiddenNote(hiddenListed, find)})`);
  // A find read pages by block and takes no offset, so the one it would name is of no
  // use to the agent; the count still says how many URLs are in the blocks it kept.
  if (links) lines.push(`Links: ${links.count}${find ? '' : ` (index at offset ${links.offset})`}`);
  if (find) lines.push(`Find: ${JSON.stringify(find.needle)} — ${count(find.count, 'block')}`);
  if (article) lines.push(article.found ? `Article: ${JSON.stringify(article.title)}${byline(article.byline)}` : 'Article: none found');
  return lines.join('\n');
}

// Returns the line listing the overlays that a read put ahead of its region, each by
// its role, its name, its ref, and whether it is modal, and the refs of those left
// unrendered past the block or call cap, so scope= reads any of them.
function overlaysLine({ blocks, more }) {
  const refs = more.map((ref) => `[${ref}]`).join(', ');
  if (!blocks.length) return more.length ? `Overlays: not rendered: ${refs}` : null;
  const items = blocks.map(({ ref, role, name, modal }) => `${overlayTitle(role, name)} [${ref}]${modalMark(modal)}`);
  if (more.length) items.push(`… and ${more.length} more: ${refs}`);
  return `Overlays: ${items.join(', ')} (above the page)`;
}

// Where the hidden controls are: at the end of this region, or a read away. A find read
// returns the blocks that matched and omits the section, so there hidden=true changes
// the count alone.
function hiddenNote(listed, find) {
  if (find) return 'not listed under find';
  return listed ? 'listed at the end' : 'hidden=true lists them';
}

// A byline Readability took from the page usually starts with "By", which this line
// supplies itself, so the prefix is stripped. It is quoted as the title is, and as a
// marker quotes its fields: the page script escaped its brackets at the cap, and the
// quoting escapes those backslashes in turn, so a byline built out of a meta tag cannot
// close a marker.
function byline(value) {
  return value ? ` by ${JSON.stringify(value.replace(/^by\s+/i, ''))}` : '';
}

// What rendered, and what it left out: every landmark outside it by ref with the
// controls under it, the controls under no landmark, the controls the render dropped
// from inside it, and the frames the read did not reach.
function scopeLine(scope, omissions) {
  const parts = omissions.landmarks.map((landmark) => {
    const name = landmark.name ? ` ${JSON.stringify(landmark.name)}` : '';
    const counts = countsOf(landmark);
    return `${landmark.role}${name} [e${landmark.backendId}]${counts ? ` ${counts}` : ''}`;
  });
  if (omissions.more) parts.push(`… and ${omissions.more} more (scope=all)`);
  const elsewhere = countsOf(omissions.elsewhere);
  if (elsewhere) parts.push(`${elsewhere} elsewhere`);
  const dropped = countsOf(omissions.droppedInside);
  if (dropped) parts.push(`dropped inside: ${dropped}`);
  if (omissions.framesNotRead.length) parts.push(`frames not read: ${omissions.framesNotRead.map((ref) => `[${ref}]`).join(', ')}`);
  if (!parts.length) return `Scope: ${scope}`;
  // A whole-body render rendered everything it could: what the counts name
  // is what the render dropped, the landmarks holding it are in the payload already,
  // and every ref stays clickable, so there is no narrower read to propose.
  if (scope === 'all' || scope === 'body') return `Scope: ${scope} (dropped: ${parts.join(', ')})`;
  // The landmark the recourse names is the first that holds something, so the example
  // read it proposes returns more than the prose of an empty landmark.
  const expand = omissions.landmarks.find((landmark) => countsOf(landmark)) || omissions.landmarks[0];
  const recourse = expand ? `scope=e${expand.backendId} expands one, scope=all everything` : 'scope=all shows everything';
  return `Scope: ${scope} (omitted: ${parts.join(', ')}; ${recourse})`;
}

function countsOf({ links, buttons, other }) {
  const parts = [];
  if (links) parts.push(count(links, 'link'));
  if (buttons) parts.push(count(buttons, 'button'));
  if (other) parts.push(count(other, 'other control'));
  return parts.join(', ');
}

function count(n, noun) {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

// Cuts at the last newline within the limit, or at the limit when the first line is
// longer than it.
function cutToLine(text, limit) {
  if (text.length <= limit) return text;
  const lineEnd = text.lastIndexOf('\n', limit);
  return text.slice(0, lineEnd > 0 ? lineEnd : codePointBoundary(text, limit));
}

module.exports = { renderUnit, placedFrames, inlineFrames, frameBudget, overlayBlock, unreadableOverlay, linksIndex, findBlocks, slice, header, cutToLine, placeholder, markedRefs };
