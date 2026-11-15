// The pipeline that renders the region of a read, a `since` read, or a change summary;
// read.js assembles a read's payload around the region. It runs over frame units: one
// accessibility tree per unit, one render per unit, and each frame's output inlined at
// its placeholder in its parent's prose. snapshot.js reads the tree and render.js runs
// a unit; overlays.js renders the open dialogs, menus, and messages as blocks ahead of
// the region; walk.js gives the hidden-control count and the `hidden=true` list.
//
// A rendered unit's controls, groups, landmarks, iframes, overlays, and kept options
// join the session's ref sets as the unit renders, so the refs that a region delivers
// resolve once renderRegion returns, and the render replaces the tab's retained render.

const envelope = require('./envelope');
const render = require('./render');
const retained = require('./retained');
const { refUnit, FRAME_GONE } = require('./refs');
const { Snapshot, resolveScope, omissions, blockOverlays, BODY, NOTHING } = require('./snapshot');
const { renderOverlayBlocks } = require('./overlays');
const { frameThere } = require('./frames');
const { SetupError } = require('./browser');
const { ConnectionClosedError } = require('./cdp');
const { TargetGoneError } = require('./sessions');
const { OutcomeError, fail, releaseObjects, pipeClosedOrTabGone, WALK_SOURCE, LABEL_MAX, safeUrl } = require('./action-support');

// The object group that holds the hidden walk's element handles until hiddenElements
// releases it.
const HIDDEN_GROUP = 'claudesurf-read-hidden';
const DOCUMENT_CHANGED = 'The document changed while it was being read; read the page again.';
const NO_TEXT = '(no readable text; use screenshot)';
const NOTHING_OUTSIDE = '(nothing readable outside the overlays above)';
const NAMED_FRAME_GONE = 'the frame it names is gone; read the page again';
// The milliseconds that a frame unit gets, or what is left of the request deadline less
// the margin, before it degrades to (not readable): one stalled embed costs the read
// five seconds rather than its whole budget.
const FRAME_UNIT_MS = 5_000;
const FRAME_MARGIN_MS = 2_000;
// How many frame units a read renders, and how deep it follows them; a frame past
// either limit says so in its marker.
const MAX_FRAME_UNITS = 8;
const MAX_FRAME_LEVELS = 3;

// The region's own unit failed to render; `cause` is what it threw, whose text a page
// can shape.
class RenderError extends Error {
  constructor(cause) {
    super(`the page's render failed: ${cause.message}`);
    this.name = 'RenderError';
    this.cause = cause;
  }
}

// The document moved on under the render: a generation moved, the hidden walk's
// stashed array was discarded with its world, or the root that the `main` scope
// resolved to was lost in a render that had to match an earlier one.
class DocumentChangedError extends Error {
  constructor() {
    super(DOCUMENT_CHANGED);
    this.name = 'DocumentChangedError';
  }
}

// Returns one line of the `## Hidden elements` list. The line opens a ref bracket of
// its own: the label arrives from the walk with its brackets escaped, and the URL is
// encoded as every URL that the daemon prints is, so neither of them closes that bracket.
function elementLine(el, ref) {
  let line = `[e${ref}] ${el.kind} ${JSON.stringify(el.label)}`;
  if (el.href) line += ` → ${safeUrl(el.href)}`;
  if (el.disabled) line += ' (disabled)';
  if (el.checked) line += ' (checked)';
  if (!el.visible) line += ' (hidden)';
  return line;
}

// Renders the region that `scope`, `article`, and `links` name in the working tab `t`,
// the overlay blocks ahead of it, and the hidden-control count, with the hidden list
// when `hidden` asks for it; then keeps the render as the tab's retained render,
// recording `source` ('read', 'since', or 'summary'). Under `since` or `summary` the
// scope is the retained render's own, so a ref scope resolves whatever tab the session
// last read, and a scope root that is gone fails rather than rendering the body.
//
// Returns { params, kept, overlayBlocks, region, linkLists, hiddenSection, header,
// documents }: `overlayBlocks`, each block's text with its frames inlined;
// `region`, the markdown with its frames inlined; `linkLists`, each rendered unit's
// { ref, url } links, the blocks' first; `hiddenSection`, empty unless listed;
// `header`, the header inputs other than the state lines; `documents`, the { target,
// generation } pairs that the region describes, for a caller that reads more of the
// page afterwards to check again with requireSameDocuments; `kept`, false when the
// render was past the retained size cap. Throws RenderError, DocumentChangedError, an
// OutcomeError from resolving the scope, a TargetGoneError, SetupError, a timeout,
// ConnectionClosedError, or a protocol error.
async function renderRegion(sessions, session, t, { scope = 'main', article = false, links = 'inline', hidden = false, source = 'read', deadline }) {
  const againstRetained = source !== 'read';
  const opts = { deadline, ownRender: againstRetained };
  const startedAt = Date.now();
  const generation = t.generation;

  const snapshot = new Snapshot(await tree(sessions, t.targetId, null, 'page', opts));
  // A commit during the pull is a changed document for a summary or `since` render,
  // where resolving the retained render's ref scope against the earlier document's ref
  // set would report the scope as gone. A read answers its caller's ref as stale.
  if (againstRetained) requireSameDocument(t, generation);
  const page = { target: t, frameId: null, prefix: '', index: 0, label: 'page', snapshot, rootBackendId: null, generation };
  // What resolving the scope reached, for the check of its frames when a step fails.
  const trail = { located: null, named: null };
  const guarded = (fn) => guardFrames(sessions, t, scope, trail, fn, deadline);
  const scoped = await guarded(() => scopeUnit(sessions, session, page, scope, article, trail, opts));
  const own = scoped.unit === page;
  const picked = pick(page, scoped);
  const result = await guarded(() => renderPage(sessions, scoped.unit, scoped, links, article, own ? picked : [], opts));
  const documents = [{ target: t, generation }];
  if (scoped.unit.target !== t) documents.push({ target: scoped.unit.target, generation: scoped.unit.generation });
  // An early exit: the frames and the walk below are work for a document that has
  // moved on, and the check after them fails the render either way. It comes before
  // the lost root's check, since a navigation also loses the root.
  requireSameDocuments(documents);
  if (result.lostRoot && againstRetained) lostScope(scope);
  recordRefs(session, scoped.unit);
  const { overlayBlocks, more } = await renderOverlayBlocks(sessions, page, picked, { links, deadline });
  if (!own) recordOffered(session, page, overlayBlocks);
  const readable = overlayBlocks.filter((block) => !block.unreadable);
  const parents = [...readable.map((block) => ({ unit: page, result: block })), { unit: scoped.unit, result }];
  const frames = await readFrames(sessions, session, parents, { chain: result.chain, links, deadline });
  const walked = await hiddenElements(sessions, session, t, generation, hidden, opts);
  // The hidden count is the page's and the region is the scoped unit's, so a
  // navigation in either would leave the region describing two documents.
  requireSameDocuments(documents);

  // The blocks print ahead of the region, so their frames draw on the read's frame
  // text first.
  const budget = render.frameBudget();
  const blocks = overlayBlocks.map((block) => (block.unreadable
    ? render.unreadableOverlay(block)
    : render.overlayBlock(block, render.inlineFrames(block.markdown, frames.blocks, budget))));
  const region = render.inlineFrames(result.markdown, frames.blocks, budget) || (readable.length ? NOTHING_OUTSIDE : NO_TEXT);
  const params = { scope, article, links, hidden };
  const header = {
    scope: result.chain === 'ref' ? scope : result.chain,
    omissions: report(snapshot, scoped, result, frames.blocks, overlayBlocks),
    overlays: { blocks: overlayBlocks.map(({ ref, role, name, modal }) => ({ ref, role, name, modal })), more },
    hidden: walked.count,
    article: article ? result.article : null,
  };
  const linkLists = [...readable.map((block) => block.links || []), result.links || [], ...frames.results.map((unit) => unit.links || [])];
  const rendered = { overlayBlocks: blocks, region, linkLists, hiddenSection: walked.section, header };
  const kept = retained.keep(session, t, { ...rendered, params, source, startedAt, generation });
  return { ...rendered, params, kept, documents };
}

// Throws DocumentChangedError when the target's document is no longer the one at
// `generation`.
function requireSameDocument(t, generation) {
  if (t.generation !== generation) throw new DocumentChangedError();
}

// Throws DocumentChangedError when any of `documents`, { target, generation } pairs, is
// no longer its target's current document.
function requireSameDocuments(documents) {
  for (const { target, generation } of documents) requireSameDocument(target, generation);
}

// Fails a `since` or summary render whose scope root is gone, since the body that it fell back
// to can't be compared with the retained render of that root: a ref scope fails as
// gone from the document, and the `main` scope as a document that changed.
function lostScope(scope) {
  if (scope === 'main') throw new DocumentChangedError();
  scopeGone(scope);
}

// Fails a call whose ref scope names an element no longer in the document.
function scopeGone(scope) {
  fail(envelope.error(`${scope} is not in this document any more; read the page again`));
}

// Returns the overlays that render as blocks: for a scope in the page, those that
// blockOverlays picks under the chain that the scope resolved to; for a read scoped into a
// frame, dialogs alone, with the page's <iframe> leading to the frame as the root, so a
// dialog holding the frame isn't picked and the frame doesn't render twice.
function pick(page, scoped) {
  const { snapshot } = page;
  if (scoped.unit !== page) {
    const iframe = scoped.reportBackendId === null ? null : snapshot.node(scoped.reportBackendId);
    return blockOverlays(snapshot, iframe ? iframe.nodeId : null, 'all');
  }
  const root = page.rootBackendId === null ? null : snapshot.node(page.rootBackendId);
  return blockOverlays(snapshot, root ? root.nodeId : null, scoped.chain);
}

// Runs one step of a read scoped into a frame, the scope's pull or the region's render,
// and turns its failure into a stale ref when a frame that the scope runs through is
// gone: the ref's own frame and the frames above it, or the frame that an <iframe> ref
// names. A failure after the pipe closed or the working tab disappeared, or one that the
// check can't decide, keeps its own error.
async function guardFrames(sessions, t, scope, trail, fn, deadline) {
  try {
    return await fn();
  } catch (e) {
    const gone = trail.located ? await lostFrame(sessions, t, trail, e, deadline) : null;
    if (gone) fail(envelope.staleRef(scope, gone));
    throw e;
  }
}

async function lostFrame(sessions, t, { located, named }, e, deadline) {
  if (pipeClosedOrTabGone(sessions, t, e)) return null;
  const opts = { frameTrees: new Map(), deadline: frameDeadline(deadline) };
  const there = (target, frameId) => frameThere(sessions, target, frameId, opts);
  try {
    for (let frame = located.target; frame && frame.type === 'iframe'; frame = sessions.target(frame.parentTargetId)) {
      if (!await there(frame, null)) return FRAME_GONE;
    }
    if (located.frameId !== null && !await there(located.target, located.frameId)) return FRAME_GONE;
    if (named && !await there(named.target, named.frameId)) return NAMED_FRAME_GONE;
  } catch (failure) {
    sessions.log.debug(`checking the frames of ${t.targetId}: ${failure.message}`);
  }
  return null;
}

// Returns what the page holds and the read left out, by difference against the page's
// own tree. The scope root counts as rendered: a ref scope that names a control or a
// frame renders it as the whole region, where a marker of its own would be redundant.
// The overlay blocks' refs left after their cuts count as rendered, and their hidden
// refs as hidden; an overlay that didn't render keeps its controls counted.
function report(snapshot, scoped, result, frames, overlayBlocks) {
  const scopeRef = scoped.reportBackendId === null ? null : `e${scoped.reportBackendId}`;
  const blockRefs = overlayBlocks.flatMap((block) => block.refs);
  const rendered = [...result.refs, ...blockRefs, ...(scopeRef === null ? [] : [scopeRef])];
  const hiddenRefs = [...result.hiddenRefs, ...overlayBlocks.flatMap((block) => block.hiddenRefs)];
  // An iframe that the read left alone is one outside the scope, or one that the render
  // dropped. A hidden frame is neither read nor counted, like any hidden element;
  // one that rendered a reason for its absence is already visible inline; and the
  // frame that a frame-scoped read is reading is the region.
  const hidden = new Set(hiddenRefs);
  // An <iframe> without a DOM node behind it lacks a ref, so the report skips it, as it
  // skips such a landmark.
  const unread = snapshot.iframes
    .filter((frame) => frame.backendId !== undefined)
    .map((frame) => `e${frame.backendId}`)
    .filter((ref) => !frames.has(ref) && !hidden.has(ref) && ref !== scopeRef);
  return omissions(snapshot, reportRoot(snapshot, scoped, result.chain), rendered, hiddenRefs, unread);
}

// Pulls one unit's accessibility tree. Frames answer on the protocol session of the
// target whose renderer they share. `label` names the unit in the log, where the size
// of a tree and the time it took are the read's first diagnostic.
async function tree(sessions, targetId, frameId, label, opts) {
  const params = frameId ? { frameId } : {};
  const started = Date.now();
  const { nodes } = await sessions.send(targetId, 'Accessibility.getFullAXTree', params, { deadline: opts.deadline });
  sessions.log.debug(`${label}: ${nodes.length} tree nodes in ${Date.now() - started} ms`);
  return nodes;
}

// Resolves with the unit that a scope names and the root inside it: `main` takes the
// chain chosen from the tree, `all` renders the body, and a ref renders that element's subtree
// in the unit that its ref set recorded it in — the frame itself when the ref names an
// <iframe>, since the page's own tree stops there. `reportBackendId` is the page node
// that the omission report measures against. `trail` records the located ref and the
// frame that an <iframe> ref names as each is reached.
async function scopeUnit(sessions, session, page, scope, article, trail, opts) {
  const { target: t, snapshot } = page;
  let chain = 'ref';
  let unit = page;
  let reportBackendId = null;
  let landmarks = false;
  if (scope === 'all' || scope === 'main') {
    ({ rootBackendId: page.rootBackendId, chain } = resolveScope(snapshot, scope));
    reportBackendId = page.rootBackendId;
  } else {
    const located = refUnit(sessions, session, t, scope, { ownRender: opts.ownRender });
    trail.located = located;
    const found = await unitOf(sessions, located, page, scope, trail, opts);
    unit = found.unit;
    // A ref that named an <iframe> renders the frame behind it whole; any other ref
    // roots its own unit at the element that it names.
    if (!found.frame) {
      if (!unit.snapshot.node(located.id)) scopeGone(scope);
      unit.rootBackendId = located.id;
    } else {
      // The frame's whole document is the region, so its landmarks carry boundaries as
      // the page's do under `all`.
      landmarks = true;
    }
    // A ref from the page names its own node, which for an <iframe> is the frame that the
    // read is rendering; a ref from inside a frame needs the <iframe> that holds that
    // frame's top-level ancestor.
    const inPage = located.target === t && located.frameId === null;
    reportBackendId = inPage ? located.id : await containingIframe(sessions, t, snapshot, located, opts);
  }
  // article=true extracts from the whole document and reports the scope it renders
  // instead when Readability fails to find an article.
  const fallback = chain === 'auto' ? 'body' : chain;
  return { unit, chain: article ? 'forced-article' : chain, fallback, reportBackendId, landmarks };
}

// Resolves with the unit that a located ref belongs to, its tree pulled: the page itself,
// one of its frames, or — when the ref names an <iframe> element, which `frame`
// reports — the frame that the element holds. Each unit carries the generation of its own
// target, taken before its tree is pulled, since its ids are read at that generation.
async function unitOf(sessions, located, page, ref, trail, opts) {
  const own = located.target === page.target && located.frameId === null;
  const unit = own ? page : {
    target: located.target, frameId: located.frameId, prefix: prefixOf(located.target), index: 0,
    label: `scope ${ref}`, snapshot: null, rootBackendId: null, generation: located.target.generation,
  };
  if (!own) unit.snapshot = new Snapshot(await tree(sessions, unit.target.targetId, unit.frameId, unit.label, opts));
  if (!unit.snapshot.iframes.some((iframe) => iframe.backendId === located.id)) return { unit, frame: false };
  const { node } = await sessions.send(unit.target.targetId, 'DOM.describeNode', { backendNodeId: located.id }, { deadline: opts.deadline });
  // A same-process frame shares the page's target, so its URL comes from the frame
  // tree, as it does for the marker that the default read puts around it.
  const urls = await childFrames(sessions, unit.target.targetId, { deadline: frameDeadline(opts.deadline) }).catch(() => new Map());
  const child = frameUnitOf(sessions, unit, node.frameId, urls.get(node.frameId), ref);
  if (node.frameId) {
    const moved = sessions.target(node.frameId);
    trail.named = moved && moved.type === 'iframe' ? { target: moved, frameId: null } : { target: unit.target, frameId: node.frameId };
  }
  if (!child) unreadableFrame(ref);
  child.index = 0;
  try {
    child.snapshot = new Snapshot(await tree(sessions, child.target.targetId, child.frameId, child.label, opts));
  } catch (e) {
    // A cross-site frame whose target has not attached yet reads as a same-process one,
    // and Chrome refuses its frame id on the page's protocol session; so does a frame
    // that disappeared between the frame tree and the pull. Neither is readable.
    if (e instanceof TargetGoneError || e instanceof ConnectionClosedError) throw e;
    sessions.log.info(`frame ${ref} (${child.url}) is not readable: ${e.message}`);
    unreadableFrame(ref);
  }
  return { unit: child, frame: true };
}

// Fails a read scoped to a frame that it can't read, marked so a change summary tells it
// from a scope that is gone.
function unreadableFrame(ref) {
  const e = new OutcomeError(envelope.error(`the frame at ${ref} is not readable; read the page around it instead`));
  e.unreadable = true;
  throw e;
}

// Resolves with the <iframe> of the page that leads to a frame-scoped read's unit, so
// the omission report counts every control of the page as outside what rendered.
async function containingIframe(sessions, t, snapshot, located, opts) {
  const top = topFrame(sessions, t, located.target);
  const frameId = top ? top.targetId : located.frameId;
  if (!frameId) return null;
  const described = await Promise.all(snapshot.iframes.map((frame) => sessions
    .send(t.targetId, 'DOM.describeNode', { backendNodeId: frame.backendId }, { deadline: opts.deadline })
    .then(({ node }) => ({ backendId: frame.backendId, frameId: node.frameId }), () => ({}))));
  const found = described.find((entry) => entry.frameId === frameId);
  return found ? found.backendId : null;
}

// Returns the frame target directly under the page on a target's parent chain, or null
// when the target is the page itself.
function topFrame(sessions, page, target) {
  let current = target.type === 'iframe' ? target : null;
  while (current && current.parentTargetId !== page.targetId) current = sessions.target(current.parentTargetId);
  return current;
}

function prefixOf(target) {
  return target.type === 'iframe' ? `f${target.frameNumber}` : '';
}

// Renders the region's own unit, the page's or, for a frame-scoped read, the frame's.
// A failure becomes a RenderError carrying what the render threw; the read maps it to
// the recovery options and the summary to its `not measured` line. A setup failure names its
// own recovery instruction (an install command), and a gone target or a closed pipe isn't the DOM
// shape that a RenderError is about; each passes through.
async function renderPage(sessions, unit, scoped, links, article, picked, opts) {
  try {
    return await render.renderUnit(sessions, unit, {
      chain: scoped.chain, fallback: scoped.fallback, landmarks: scoped.landmarks, links, picked, deadline: opts.deadline,
    });
  } catch (e) {
    if (e.envelope || e instanceof TargetGoneError || e instanceof SetupError || e instanceof ConnectionClosedError) throw e;
    sessions.log.info(`the renderer failed on the page: ${e.message}`);
    throw new RenderError(e);
  }
}

// Reads the frames inside what a read rendered, each pulled and rendered as a unit of
// its own, for inlining where its parent left a placeholder. The first level's parents
// are the overlay blocks, in their order, and then the region's unit, so a dialog's
// frame is read ahead of the page's own when units run short. A level's frames are
// known only once it has rendered, so levels run one after another and the frames of a
// level in parallel; at most eight units render per read, over at most three levels,
// and the rest say why they are not there. A frame doesn't fail the read: anything that
// goes wrong with one is a (not readable) line in its place. `chain` is the region's,
// which decides whether a frame's landmarks carry boundaries.
async function readFrames(sessions, session, parents, { chain, links, deadline }) {
  const blocks = new Map();
  const results = [];
  let budget = MAX_FRAME_UNITS;
  let level = parents;
  for (let depth = 0; level.length; depth++) {
    const placedIn = level.map((parent) => {
      // A first-level parent's markdown comes from the region, which max_chars alone cuts
      // after this step, or an overlay block, which is already cut. Every deeper parent is
      // a frame, whose render is cut before inlining.
      const placed = render.placedFrames(parent.result, depth > 0);
      // A frame without a placeholder of its own in the render — hidden, dropped by
      // Readability, swallowed by the rule for a link or a control around it, or past
      // the cut that its parent's own inlining takes — has nowhere to go. The omission line
      // names it only when the page unit's tree holds its <iframe>.
      return { parent, frames: parent.result.frames.filter(({ ref }) => placed.has(ref)) };
    });
    // One frame tree per target per level, read together under the frame unit's budget
    // rather than the request's: a renderer wedged on its frame tree costs the level one
    // frame's time, as a wedged render of it does.
    const targetIds = [...new Set(placedIn.filter(({ frames }) => frames.length).map(({ parent }) => parent.unit.target.targetId))];
    const own = { deadline: frameDeadline(deadline) };
    const trees = new Map(await Promise.all(targetIds.map(async (targetId) => [targetId, await childFrames(sessions, targetId, own).catch(() => new Map())])));
    const wanted = placedIn.flatMap(({ parent, frames }) => frames.map(({ ref, frameId }) => (
      { ref, unit: frameUnitOf(sessions, parent.unit, frameId, trees.get(parent.unit.target.targetId).get(frameId), ref) }
    )));
    // The level past the last one is collected rather than read, so a frame too deep
    // says so with its URL, as one past the unit cap does; its frames stay unrendered,
    // so the next level is empty and the loop ends.
    const tooDeep = depth >= MAX_FRAME_LEVELS;
    const rendered = [];
    // The units are numbered in the order they were wanted, so the blocks' frames take
    // the budget ahead of the region's whichever answers first.
    const numbered = wanted.map((entry) => {
      if (!entry.unit || tooDeep || budget === 0) return { ...entry, index: null };
      budget -= 1;
      return { ...entry, index: MAX_FRAME_UNITS - budget };
    });
    await Promise.all(numbered.map(async ({ ref, unit, index }) => {
      if (!unit) { blocks.set(ref, { reason: 'not readable' }); return; }
      const { url, cross } = unit;
      if (index === null) {
        const limit = tooDeep ? `${MAX_FRAME_LEVELS}-level` : `${MAX_FRAME_UNITS}-frame`;
        sessions.log.info(`frame ${ref} (${url}) is past the ${limit} limit of this read`);
        blocks.set(ref, { url, cross, reason: 'not read: frame limit' });
        return;
      }
      unit.index = index;
      try {
        const result = await renderFrame(sessions, session, unit, chain, links, deadline);
        blocks.set(ref, { url, cross, markdown: result.markdown });
        results.push(result);
        rendered.push({ unit, result });
      } catch (e) {
        sessions.log.info(`frame ${ref} (${url}) is not readable: ${e.message}`);
        blocks.set(ref, { url, cross, reason: 'not readable' });
      }
    }));
    level = rendered;
  }
  return { blocks, results };
}

// Renders one frame unit: its own tree, its own render of its whole document, its own
// budget. Landmark markers inside it render when the page's own render carries them.
async function renderFrame(sessions, session, unit, pageChain, links, deadline) {
  const own = { deadline: frameDeadline(deadline) };
  unit.snapshot = new Snapshot(await tree(sessions, unit.target.targetId, unit.frameId, unit.label, own));
  const chain = pageChain === 'all' || pageChain === 'body' ? 'all' : 'ref';
  const result = await render.renderUnit(sessions, unit, { chain, fallback: chain, links, deadline: own.deadline, requestDeadline: deadline });
  // The frame navigated under its own render: withWorld built a world in the new
  // document, where every node of the old tree resolved to null, so what came back is
  // the new document's prose without markers. The caller turns it into a (not readable)
  // line.
  if (unit.target.generation !== unit.generation) throw new Error('its document changed while it was being read');
  recordRefs(session, unit);
  return result;
}

function frameDeadline(deadline) {
  const own = Date.now() + FRAME_UNIT_MS;
  return deadline === undefined ? own : Math.min(own, deadline - FRAME_MARGIN_MS);
}

// Returns one frame of a rendered unit as the unit that renders it: an out-of-process
// frame is its own target and takes an f<n> prefix, a same-process one renders on its
// parent's protocol session under its parent's prefix. Returns null for a frame without
// an id, and for a same-process frame whose URL is empty or about:blank.
function frameUnitOf(sessions, parent, frameId, url, ref) {
  if (!frameId) return null;
  const label = `frame ${ref}`;
  const target = sessions.target(frameId);
  if (target && target.type === 'iframe') {
    // The target's own URL once it has one, and until then the URL that its parent's
    // frame tree lists.
    return { target, frameId: null, prefix: prefixOf(target), label, url: target.url || url || '', cross: true, snapshot: null, rootBackendId: null, generation: target.generation };
  }
  if (!url || url === 'about:blank') return null;
  // A same-process frame shares its parent's generation; its ids live in its parent's
  // set.
  return { target: parent.target, frameId, prefix: parent.prefix, label, url, cross: false, snapshot: null, rootBackendId: null, generation: parent.target.generation };
}

// Resolves with the URL of every frame under a target, by frame id: Page.getFrameTree
// lists the out-of-process children too, so a read names a frame that it cannot enter.
async function childFrames(sessions, targetId, opts) {
  const { frameTree } = await sessions.send(targetId, 'Page.getFrameTree', {}, opts);
  const urls = new Map();
  const visit = (node) => {
    for (const child of node.childFrames || []) {
      urls.set(child.frame.id, child.frame.url + (child.frame.urlFragment || ''));
      visit(child);
    }
  };
  visit(frameTree);
  return urls;
}

// Returns the root that the omission report measures against: a subtree of the tree when
// one rendered, or the BODY sentinel when everything did. The tree cannot compute
// containment for Readability's article or the whole body. Returns NOTHING when the
// render is a frame absent from the page's own tree, since every control of the page
// is outside it.
function reportRoot(snapshot, scoped, chain) {
  if (chain === 'readability' || chain === 'all' || chain === 'body') return BODY;
  if (scoped.reportBackendId === null) return NOTHING;
  const node = snapshot.node(scoped.reportBackendId);
  return node ? node.nodeId : NOTHING;
}

// Adds every control, group, landmark, iframe, overlay, and kept option of a rendered
// unit's tree to its target's ref set, whether its marker was delivered, cut, dropped
// by Readability, or skipped as hidden, so anything that the tree found is clickable by
// a scripted click and a scope on it resolves. The value is the frame that the id was
// read in, null for the target's own main frame.
function recordRefs(session, unit) {
  const { snapshot } = unit;
  merge(session, unit, [...snapshot.controls, ...snapshot.groups, ...snapshot.landmarks, ...snapshot.iframes, ...snapshot.overlays, ...keptOptions(snapshot.controls)]);
}

// Adds the refs that a frame-scoped read offers in its header — the page's landmarks, the
// iframes and overlays it names, and the contents of each overlay block it rendered —
// to the page's set too, so a scope on one of them, or a click on a block's control,
// resolves although the page's own region didn't render.
function recordOffered(session, page, overlayBlocks) {
  const { snapshot } = page;
  const entries = [...snapshot.landmarks, ...snapshot.iframes, ...snapshot.overlays];
  for (const block of overlayBlocks) {
    if (block.unreadable) continue;
    const inside = snapshot.subtree(block.nodeId);
    const within = (entry) => inside.has(entry.nodeId);
    const controls = snapshot.controls.filter(within);
    entries.push(...controls, ...snapshot.groups.filter(within), ...snapshot.iframes.filter(within), ...keptOptions(controls));
  }
  merge(session, page, entries);
}

function keptOptions(controls) {
  return controls.flatMap((control) => (control.options ? control.options.kept : []));
}

function merge(session, unit, entries) {
  const ids = entries.map((entry) => entry.backendId).filter((id) => id !== undefined);
  mergeRefs(session, unit.target, ids.map((id) => [id, unit.frameId]), unit.generation);
}

// Merges `entries` into the target's ref set. `generation` is the one that the ids were
// read at, not the target's now: a read that a navigation overtook files its ids under
// a generation that a click can't match.
function mergeRefs(session, t, entries, generation) {
  const set = session.refs.get(t.targetId);
  if (!set || set.generation !== generation) session.refs.set(t.targetId, { generation, ids: new Map(entries) });
  else for (const [id, frameId] of entries) set.ids.set(id, frameId);
}

// Resolves with the hidden-control count, and the section listing them when it is
// asked for: walk.js restricted to hidden elements, over the page target's whole
// document whatever the scope, so the number counts the whole document.
async function hiddenElements(sessions, session, t, generation, wanted, opts) {
  const summary = await sessions.callInWorld(t.targetId, WALK_SOURCE, [true, LABEL_MAX], { deadline: opts.deadline });
  const count = summary.elements.length;
  if (!wanted || count === 0) return { count, section: '' };
  let refs;
  try {
    refs = await elementRefs(sessions, t, opts);
  } finally {
    await releaseObjects(sessions, t.targetId, HIDDEN_GROUP, opts.deadline);
  }
  mergeRefs(session, t, refs.map((id) => [id, null]), generation);
  const lines = summary.elements.map((el, i) => elementLine(el, refs[i]));
  return { count, section: `## Hidden elements (${count})\n${lines.join('\n')}` };
}

// Reads the walk's element handles: one Runtime.getProperties on the stashed array,
// then one DOM.describeNode per element, pipelined. The array is missing when the
// document changed since the walk (a new document gets a new world).
async function elementRefs(sessions, t, { deadline }) {
  const opts = { deadline };
  const contextId = await sessions.world(t.targetId, null, opts);
  const { result } = await sessions.send(t.targetId, 'Runtime.evaluate', { expression: 'globalThis.__claudesurfElements', contextId, objectGroup: HIDDEN_GROUP }, opts);
  if (!result.objectId) throw new DocumentChangedError();
  const props = await sessions.send(t.targetId, 'Runtime.getProperties', { objectId: result.objectId, ownProperties: true }, opts);
  const handles = props.result.filter((p) => /^\d+$/.test(p.name)).sort((a, b) => Number(a.name) - Number(b.name));
  const described = await Promise.all(handles.map((p) => sessions.send(t.targetId, 'DOM.describeNode', { objectId: p.value.objectId }, opts)));
  return described.map((d) => d.node.backendNodeId);
}

module.exports = { renderRegion, requireSameDocument, requireSameDocuments, RenderError, DocumentChangedError };
