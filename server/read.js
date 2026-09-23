// The claudesurf_read actions: page (the unit pipeline and the payload), info, and
// screenshot. Handlers take the registry and the caller's Session and return
// { payload, images? }; anything that maps to a non-success outcome throws an
// OutcomeError (action-support.js).
//
// A `page` read is a pipeline over frame units: one accessibility tree per unit, one
// render per unit, each frame's output inlined at its placeholder in its parent's
// prose, and one region that the header lines precede. snapshot.js reads the tree,
// render.js runs a unit and assembles what the units returned; walk.js survives for
// the hidden-control count and the `hidden=true` list alone.

const envelope = require('./envelope');
const render = require('./render');
const { refUnit } = require('./input');
const { Snapshot, resolveScope, omissions, BODY, NOTHING } = require('./snapshot');
const { REF_SOURCE } = require('./dispatch');
const { SetupError } = require('./browser');
const { TargetGoneError } = require('./sessions');
const { fail, stateLines, workingTarget, requireHttp, pageState, releaseObjects, WALK_SOURCE, LABEL_MAX, safeUrl } = require('./action-support');

const MAX_SEGMENTS = 4;
// Every ref a marker of the delivered region carries, in dispatch.js's grammar.
// A backslash ahead of the bracket is page text Turndown escaped, not a marker.
const MARKED_REF = new RegExp(`(?<!\\\\)\\[(${REF_SOURCE})[ \\]]`, 'g');
// The hidden walk releases the element handles it takes under this group when it ends.
const HIDDEN_GROUP = 'claudesurf-read-hidden';
const DOCUMENT_CHANGED = 'The document changed while it was being read; read the page again.';
const NO_TEXT = '(no readable text; use screenshot)';
// A frame unit gets this long, or what is left of the request deadline less the
// margin, and degrades to (not readable) when it runs out, so one stalled embed costs
// the read five seconds rather than its whole budget.
const FRAME_UNIT_MS = 5_000;
const FRAME_MARGIN_MS = 2_000;
// How many frame units a read renders, and how deep it follows them; a frame past
// either limit says so in its marker.
const MAX_FRAME_UNITS = 8;
const MAX_FRAME_LEVELS = 3;

// One line of the `## Hidden elements` list, which opens a ref bracket of its own: the
// label arrives from the walk with its brackets escaped, and the URL is encoded as
// every URL the daemon prints is, so neither of them closes that bracket.
function elementLine(el, ref) {
  let line = `[e${ref}] ${el.kind} ${JSON.stringify(el.label)}`;
  if (el.href) line += ` → ${safeUrl(el.href)}`;
  if (el.disabled) line += ' (disabled)';
  if (el.checked) line += ' (checked)';
  if (!el.visible) line += ' (hidden)';
  return line;
}

async function readPage(sessions, session, {
  scope = 'main', find = '', article = false, links = 'inline', hidden = false, maxChars, offset, deadline,
}) {
  const t = workingTarget(sessions, session);
  requireHttp(t);
  const opts = { deadline };
  const generation = t.generation;

  const snapshot = new Snapshot(await tree(sessions, t.targetId, null, 'page', opts));
  const page = { target: t, frameId: null, prefix: '', index: 0, label: 'page', snapshot, rootBackendId: null, generation };
  const scoped = await scopeUnit(sessions, session, page, scope, article, opts);
  const result = await renderPage(sessions, scoped.unit, scoped, links, article, opts);
  // An early exit: the frames and the walk below are work for a document that has
  // moved on, and the two checks after them fail the read either way. A frame-scoped
  // read has two documents to answer for, the page's and the frame's.
  requireSameDocument(t, generation);
  requireSameDocument(scoped.unit.target, scoped.unit.generation);
  recordRefs(session, scoped.unit);
  if (scoped.unit !== page) recordOffered(session, page);
  const root = { unit: scoped.unit, result };
  const frames = await readFrames(sessions, session, root, { links, deadline });

  const state = await pageState(sessions, t, opts);
  const walked = await hiddenElements(sessions, session, t, generation, hidden, opts);
  // Both documents, after the last line of the payload is taken: the state lines and
  // the hidden count are the page's and the region is the scoped unit's, so a
  // navigation in either would leave the payload describing two documents.
  requireSameDocument(t, generation);
  requireSameDocument(scoped.unit.target, scoped.unit.generation);

  const region = { root, frames, hidden: walked, links, find, article };
  return { payload: assemble(region, {
    state,
    scope: result.chain === 'ref' ? scope : result.chain,
    omissions: report(snapshot, scoped, result, frames.blocks),
    maxChars,
    offset,
  }) };
}

function requireSameDocument(t, generation) {
  if (t.generation !== generation) fail(envelope.error(DOCUMENT_CHANGED));
}

// What the page holds and the read left out, by difference against the page's own
// tree. The scope root counts as rendered: a ref scope that names a control or a frame
// renders it as the whole region, where a marker of its own would say nothing.
function report(snapshot, scoped, result, blocks) {
  const scopeRef = scoped.reportBackendId === null ? null : `e${scoped.reportBackendId}`;
  const rendered = scopeRef === null ? result.refs : [...result.refs, scopeRef];
  // An iframe the read left alone is one outside the scope, or one the render
  // dropped. A hidden frame is neither read nor counted, like any hidden element;
  // one that rendered a reason for its absence is already visible inline; and the
  // frame a frame-scoped read is reading is the region itself.
  const hidden = new Set(result.hiddenRefs);
  // An <iframe> with no DOM node behind it has no ref to name it by, as a landmark of
  // the report has none.
  const unread = snapshot.iframes
    .filter((frame) => frame.backendId !== undefined)
    .map((frame) => `e${frame.backendId}`)
    .filter((ref) => !blocks.has(ref) && !hidden.has(ref) && ref !== scopeRef);
  return omissions(snapshot, reportRoot(snapshot, scoped, result.chain), rendered, result.hiddenRefs, unread);
}

// Pulls one unit's accessibility tree. Frames answer on the session of the target
// whose renderer they share. `label` names the unit in the log, where the size of a
// tree and the time it took are the read's first diagnostic.
async function tree(sessions, targetId, frameId, label, opts) {
  const params = frameId ? { frameId } : {};
  const started = Date.now();
  const { nodes } = await sessions.send(targetId, 'Accessibility.getFullAXTree', params, opts);
  sessions.log.debug(`${label}: ${nodes.length} tree nodes in ${Date.now() - started} ms`);
  return nodes;
}

// The unit a scope names and the root inside it: `main` takes the tree-decided chain
// of decision 2, `all` renders the body, and a ref renders that element's subtree in
// the unit its ref set recorded it in — the frame itself when the ref names an
// <iframe>, since the page's own tree stops there. `reportBackendId` is the page node
// the omission report measures against.
async function scopeUnit(sessions, session, page, scope, article, opts) {
  const { target: t, snapshot } = page;
  let chain = 'ref';
  let unit = page;
  let reportBackendId = null;
  let landmarks = false;
  if (scope === 'all' || scope === 'main') {
    ({ rootBackendId: page.rootBackendId, chain } = resolveScope(snapshot, scope));
    reportBackendId = page.rootBackendId;
  } else {
    const located = refUnit(sessions, session, t, scope);
    const found = await unitOf(sessions, located, page, scope, opts);
    unit = found.unit;
    // A ref that named an <iframe> renders the frame behind it whole; any other ref
    // roots its own unit at the element it names.
    if (!found.frame) {
      if (!unit.snapshot.node(located.id)) fail(envelope.error(`${scope} is not in this document any more; read the page again`));
      unit.rootBackendId = located.id;
    } else {
      // The frame's whole document is the region, so its landmarks carry boundaries as
      // the page's do under `all` (decision 3.6).
      landmarks = true;
    }
    // A ref read in the page names its own node, which for an <iframe> is the frame
    // the read is rendering; a ref read inside a frame needs the <iframe> that holds
    // that frame's top-level ancestor.
    const inPage = located.target === t && located.frameId === null;
    reportBackendId = inPage ? located.id : await containingIframe(sessions, t, snapshot, located, opts);
  }
  // article=true extracts from the whole document and reports the scope it renders
  // instead when Readability finds nothing.
  const fallback = chain === 'auto' ? 'body' : chain;
  return { unit, chain: article ? 'forced-article' : chain, fallback, reportBackendId, landmarks };
}

// The unit a located ref belongs to, its tree pulled: the page itself, one of its
// frames, or — when the ref names an <iframe> element, which `frame` reports — the
// frame that element holds. Each unit carries the generation of its own target, taken
// before its tree is pulled, since its ids are read at that generation.
async function unitOf(sessions, located, page, ref, opts) {
  const own = located.target === page.target && located.frameId === null;
  const unit = own ? page : {
    target: located.target, frameId: located.frameId, prefix: prefixOf(located.target), index: 0,
    label: `scope ${ref}`, snapshot: null, rootBackendId: null, generation: located.target.generation,
  };
  if (!own) unit.snapshot = new Snapshot(await tree(sessions, unit.target.targetId, unit.frameId, unit.label, opts));
  if (!unit.snapshot.iframes.some((iframe) => iframe.backendId === located.id)) return { unit, frame: false };
  const { node } = await sessions.send(unit.target.targetId, 'DOM.describeNode', { backendNodeId: located.id }, opts);
  // A same-process frame shares the page's target, so its URL comes from the frame
  // tree, as it does for the marker the default read puts around it.
  const urls = await childFrames(sessions, unit.target.targetId, { deadline: frameDeadline(opts.deadline) }).catch(() => new Map());
  const child = frameUnitOf(sessions, unit, node.frameId, urls.get(node.frameId), ref);
  if (!child) unreadableFrame(ref);
  child.index = 0;
  try {
    child.snapshot = new Snapshot(await tree(sessions, child.target.targetId, child.frameId, child.label, opts));
  } catch (e) {
    // A cross-site frame whose target has not attached yet reads as a same-process
    // one, and Chrome refuses its frame id on the page's session; so does a frame
    // that went between the frame tree and the pull. Neither is readable.
    if (e instanceof TargetGoneError) throw e;
    sessions.log.info(`frame ${ref} (${child.url}) is not readable: ${e.message}`);
    unreadableFrame(ref);
  }
  return { unit: child, frame: true };
}

function unreadableFrame(ref) {
  fail(envelope.error(`the frame at ${ref} is not readable; read the page around it instead`));
}

// The <iframe> of the page that leads to a frame-scoped read's unit, so the omission
// report counts every control of the page as outside what rendered.
async function containingIframe(sessions, t, snapshot, located, opts) {
  const top = topFrame(sessions, t, located.target);
  const frameId = top ? top.targetId : located.frameId;
  if (!frameId) return null;
  const described = await Promise.all(snapshot.iframes.map((frame) => sessions
    .send(t.targetId, 'DOM.describeNode', { backendNodeId: frame.backendId }, opts)
    .then(({ node }) => ({ backendId: frame.backendId, frameId: node.frameId }), () => ({}))));
  const found = described.find((entry) => entry.frameId === frameId);
  return found ? found.backendId : null;
}

// The frame target directly under the page on a target's parent chain, or null when
// the target is the page itself.
function topFrame(sessions, page, target) {
  let current = target.type === 'iframe' ? target : null;
  while (current && current.parentTargetId !== page.targetId) current = sessions.target(current.parentTargetId);
  return current;
}

function prefixOf(target) {
  return target.type === 'iframe' ? `f${target.frameNumber}` : '';
}

// The page unit has no fallback: a renderer exception fails the read, naming the
// exception so the DOM shape behind it can be reported, and naming the recourses
// (risk 12).
async function renderPage(sessions, unit, scoped, links, article, opts) {
  try {
    return await render.renderUnit(sessions, unit, {
      chain: scoped.chain, fallback: scoped.fallback, landmarks: scoped.landmarks, links, deadline: opts.deadline,
    });
  } catch (e) {
    // A setup failure names its own recourse (an install command) and a gone target a
    // retry; neither is the DOM shape this message is about.
    if (e.envelope || e instanceof TargetGoneError || e instanceof SetupError) throw e;
    sessions.log.info(`the renderer failed on the page: ${e.message}`);
    const dropArticle = article ? ', article=false' : '';
    fail(envelope.error(`Rendering the page failed: ${e.message}. Try scope=all or scope=<ref> for another subtree${dropArticle}, or screenshot.`));
  }
}

// The frames inside what a read rendered, each pulled and rendered as a unit of its
// own and inlined where its parent left a placeholder. A level's frames are known only
// once it has rendered, so levels run one after another and the frames of a level in
// parallel; eight units render per read over three levels, and the rest say why they
// are not there. A frame never fails the read: anything that goes wrong with one is a
// (not readable) line in its place.
async function readFrames(sessions, session, root, { links, deadline }) {
  const blocks = new Map();
  const results = [];
  let budget = MAX_FRAME_UNITS;
  let level = [root];
  for (let depth = 0; level.length; depth++) {
    const wanted = [];
    for (const parent of level) {
      // Under the frame unit's budget rather than the request's: a renderer wedged on
      // its frame tree is one frame's cost, as a wedged render of it is.
      const urls = await childFrames(sessions, parent.unit.target.targetId, { deadline: frameDeadline(deadline) }).catch(() => new Map());
      // Every parent but the first is a frame, whose own render is inlined cut; the
      // region the first one renders is cut by max_chars alone, and after this.
      const placed = render.placedFrames(parent.result, depth > 0);
      for (const { ref, frameId } of parent.result.frames) {
        // A frame with no placeholder of its own in the render — hidden, dropped by
        // Readability, swallowed by the rule for a link or a control around it, or past
        // the cut its parent's own inlining takes — has nowhere to go, so it is left to
        // the omission line instead.
        if (!placed.has(ref)) continue;
        wanted.push({ ref, unit: frameUnitOf(sessions, parent.unit, frameId, urls.get(frameId), ref) });
      }
    }
    // The level past the last one is collected rather than read, so a frame too deep
    // says so with its URL, as one past the unit cap does; nothing renders there, so
    // the next round has no parents and the loop ends.
    const tooDeep = depth >= MAX_FRAME_LEVELS;
    const rendered = [];
    await Promise.all(wanted.map(async ({ ref, unit }) => {
      if (!unit) { blocks.set(ref, { reason: 'not readable' }); return; }
      const { url, cross } = unit;
      if (tooDeep || budget === 0) {
        const limit = tooDeep ? `${MAX_FRAME_LEVELS}-level` : `${MAX_FRAME_UNITS}-frame`;
        sessions.log.info(`frame ${ref} (${url}) is past the ${limit} limit of this read`);
        blocks.set(ref, { url, cross, reason: 'not read: frame limit' });
        return;
      }
      budget -= 1;
      unit.index = MAX_FRAME_UNITS - budget;
      try {
        const result = await renderFrame(sessions, session, unit, root.result.chain, links, deadline);
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

// One frame unit: its own tree, its own render of its whole document, its own budget.
// Landmark markers inside it render when the page's own render carries them.
async function renderFrame(sessions, session, unit, pageChain, links, deadline) {
  const own = { deadline: frameDeadline(deadline) };
  unit.snapshot = new Snapshot(await tree(sessions, unit.target.targetId, unit.frameId, unit.label, own));
  const chain = pageChain === 'all' || pageChain === 'body' ? 'all' : 'ref';
  const result = await render.renderUnit(sessions, unit, { chain, fallback: chain, links, deadline: own.deadline });
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

// One frame of a rendered unit as the unit that renders it: an out-of-process frame is
// its own target and takes an f<n> prefix, a same-process one renders on its parent's
// session under its parent's prefix. Null when nothing is there to read.
function frameUnitOf(sessions, parent, frameId, url, ref) {
  if (!frameId) return null;
  const label = `frame ${ref}`;
  const target = sessions.target(frameId);
  if (target && target.type === 'iframe') {
    // Its own URL until it has navigated once, and its parent's frame tree until then.
    return { target, frameId: null, prefix: prefixOf(target), label, url: target.url || url || '', cross: true, snapshot: null, rootBackendId: null, generation: target.generation };
  }
  if (!url || url === 'about:blank') return null;
  // A same-process frame has no generation of its own; its ids live in its parent's set.
  return { target: parent.target, frameId, prefix: parent.prefix, label, url, cross: false, snapshot: null, rootBackendId: null, generation: parent.target.generation };
}

// The URL of every frame under a target, by frame id: Page.getFrameTree lists the
// out-of-process children too, so a read names a frame it cannot enter.
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

// The root the omission report measures against: a tree subtree when one rendered, the
// BODY sentinel when everything did, since Readability's article and the whole body are
// both containment the tree cannot compute, and NOTHING when what rendered is a frame
// the page's own tree does not show, where every control of the page is outside it.
function reportRoot(snapshot, scoped, chain) {
  if (chain === 'readability' || chain === 'all' || chain === 'body') return BODY;
  if (scoped.reportBackendId === null) return NOTHING;
  const node = snapshot.node(scoped.reportBackendId);
  return node ? node.nodeId : NOTHING;
}

// Every control, group, landmark, and iframe node of a rendered unit's tree joins its
// target's ref set, whether its marker was delivered, cut, dropped by Readability, or
// skipped as hidden, so anything the tree found is clickable by a scripted click. The
// value is the frame the id was read in, null for the target's own main frame.
function recordRefs(session, unit) {
  const { snapshot } = unit;
  const ids = [...snapshot.controls, ...snapshot.groups, ...snapshot.landmarks, ...snapshot.iframes]
    .map((entry) => entry.backendId)
    .filter((id) => id !== undefined);
  mergeRefs(session, unit.target, ids.map((id) => [id, unit.frameId]), unit.generation);
}

// The refs a frame-scoped read offers in its omission line — the page's landmarks and
// the iframes it names — join the page's set too, so a `scope` on one of them resolves
// although no part of the page rendered.
function recordOffered(session, page) {
  const { snapshot } = page;
  const ids = [...snapshot.landmarks, ...snapshot.iframes]
    .map((entry) => entry.backendId)
    .filter((id) => id !== undefined);
  mergeRefs(session, page.target, ids.map((id) => [id, page.frameId]), page.generation);
}

// `generation` is the one the ids were read at, not the target's now: a read that a
// navigation overtook leaves its ids behind a generation no click can match.
function mergeRefs(session, t, entries, generation) {
  const set = session.refs.get(t.targetId);
  if (!set || set.generation !== generation) session.refs.set(t.targetId, { generation, ids: new Map(entries) });
  else for (const [id, frameId] of entries) set.ids.set(id, frameId);
}

// The hidden-control count, and their refs when the section is asked for: phase 1's
// walk restricted to hidden elements, over the page target's whole document whatever
// the scope, so the number counts the whole document.
async function hiddenElements(sessions, session, t, generation, wanted, opts) {
  const summary = await sessions.callInWorld(t.targetId, WALK_SOURCE, [true, LABEL_MAX], opts);
  const count = summary.elements.length;
  if (!wanted || count === 0) return { count, section: '' };
  let refs;
  try {
    refs = await elementRefs(sessions, t, opts);
  } finally {
    await releaseObjects(sessions, t.targetId, HIDDEN_GROUP);
  }
  mergeRefs(session, t, refs.map((id) => [id, null]), generation);
  const lines = summary.elements.map((el, i) => elementLine(el, refs[i]));
  return { count, section: `## Hidden elements (${count})\n${lines.join('\n')}` };
}

// Reads the walk's element handles: one Runtime.getProperties on the stashed array,
// then one DOM.describeNode per element, pipelined. The array is missing when the
// document changed since the walk (a new document gets a new world).
async function elementRefs(sessions, t, opts) {
  const contextId = await sessions.world(t.targetId, null, opts);
  const { result } = await sessions.send(t.targetId, 'Runtime.evaluate', { expression: 'globalThis.__claudesurfElements', contextId, objectGroup: HIDDEN_GROUP }, opts);
  if (!result.objectId) fail(envelope.error(DOCUMENT_CHANGED));
  const props = await sessions.send(t.targetId, 'Runtime.getProperties', { objectId: result.objectId, ownProperties: true }, opts);
  const handles = props.result.filter((p) => /^\d+$/.test(p.name)).sort((a, b) => Number(a.name) - Number(b.name));
  const described = await Promise.all(handles.map((p) => sessions.send(t.targetId, 'DOM.describeNode', { objectId: p.value.objectId }, opts)));
  return described.map((d) => d.node.backendNodeId);
}

// Everything after the header is one region: the page unit's markdown with each
// frame inlined, narrowed to the matching blocks under `find`, then the links index
// and the hidden list at its end, then the paging cut.
function assemble({ root, frames, hidden, links, find, article }, { state, scope, omissions: omitted, maxChars, offset }) {
  const page = root.result;
  let region = render.inlineFrames(page.markdown, frames.blocks) || NO_TEXT;
  let found = null;
  let kept = null;
  let marks = null;
  if (find) {
    found = render.findBlocks(region, find);
    ({ region, marks } = findRegion(found.blocks));
    kept = new Set([...region.matchAll(MARKED_REF)].map((match) => match[1]));
  }
  let index = null;
  if (links === 'index') {
    const list = render.linksIndex([page, ...frames.results], kept);
    if (list.text) {
      index = { count: list.count, offset: region.length + 2 };
      region += `\n\n${list.text}`;
    }
  }
  // A find read lists the page's own blocks, and the hidden section is not one of them.
  const listed = hidden.section && !find;
  if (listed) region += `\n\n${hidden.section}`;

  const cut = render.slice(region, { maxChars, offset, resume: find ? resumeFind(marks) : undefined });
  const lines = render.header(state, {
    truncation: cut.truncation,
    scope,
    omissions: omitted,
    hidden: hidden.count,
    hiddenListed: Boolean(listed),
    links: index,
    find: found && { needle: find, count: found.count },
    article: article ? page.article : null,
  });
  return cut.text ? `${lines}\n\n${cut.text}` : lines;
}

// The matching blocks as one region, each opened by the offset a follow-up read
// without `find` passes, with where in the region each of those lines ends: a page
// that wrote an `[offset N]` line of its own — inside a fenced block, the one place
// its text arrives unescaped — would answer a search of the region for them.
function findRegion(blocks) {
  const marks = [];
  const parts = [];
  let at = 0;
  for (const block of blocks) {
    const mark = `[offset ${block.offset}]`;
    marks.push({ end: at + mark.length, offset: block.offset });
    const text = `${mark}\n${block.text}`;
    parts.push(text);
    at += text.length + 2;
  }
  return { region: parts.join('\n\n'), marks };
}

// A find read pages by block, so its truncation line resumes at the last block whose
// mark the cut delivered whole.
function resumeFind(marks) {
  return (cut) => {
    const delivered = marks.filter((mark) => mark.end <= cut);
    return ` Narrow find, or read without it from offset ${delivered.length ? delivered.at(-1).offset : 0}.`;
  };
}

async function pageInfo(sessions, session, { deadline }) {
  const t = workingTarget(sessions, session);
  const info = await pageState(sessions, t, { deadline });
  const lines = [
    stateLines(info.url, info.title),
    `Scroll: ${info.scrollY} of ${info.pageHeight} (viewport ${info.viewportHeight})`,
    `Session: ${session.name ? session.name : '(unnamed)'}`,
  ];
  if (!session.identityTargetId) lines.push('Identity tab: closed');
  return { payload: lines.join('\n') };
}

async function screenshot(sessions, session, { fullPage, deadline }) {
  const t = workingTarget(sessions, session);
  const opts = { deadline };
  const info = await pageState(sessions, t, opts);
  const header = stateLines(info.url, info.title);
  if (!fullPage) {
    const { data } = await sessions.send(t.targetId, 'Page.captureScreenshot', { format: 'png' }, opts);
    return { payload: header, images: [{ data, mimeType: 'image/png' }] };
  }
  const metrics = await sessions.send(t.targetId, 'Page.getLayoutMetrics', {}, opts);
  const width = Math.ceil(metrics.cssVisualViewport.clientWidth);
  const viewport = Math.ceil(metrics.cssVisualViewport.clientHeight);
  const pageHeight = Math.ceil(metrics.cssContentSize.height);
  const segments = Math.max(1, Math.min(MAX_SEGMENTS, Math.ceil(pageHeight / viewport)));
  const images = [];
  let covered = 0;
  for (let i = 0; i < segments; i++) {
    const height = Math.min(viewport, pageHeight - covered);
    const { data } = await sessions.send(t.targetId, 'Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: true,
      clip: { x: 0, y: covered, width, height, scale: 1 },
    }, opts);
    images.push({ data, mimeType: 'image/png' });
    covered += height;
  }
  const cut = covered < pageHeight ? ` (${pageHeight - covered} px below not captured; scroll and capture again)` : '';
  return {
    payload: `${header}\nCaptured: 0–${covered} of ${pageHeight} px in ${segments} segment${segments === 1 ? '' : 's'}${cut}`,
    images,
  };
}

module.exports = { readPage, pageInfo, screenshot };
