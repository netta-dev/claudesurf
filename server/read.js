// The claudesurf_read actions: page, info, and screenshot. `page` settles the page for
// up to two seconds, renders its region through region.js, and assembles the payload
// around it: the overlay blocks ahead of the region, `find`, the links index, the
// hidden list, and the paging cut under the header lines. A paging read slices the
// tab's retained render instead, and a `since` read diffs a fresh render against it
// through changes.js. Each returns { head, body?, images?, outcome? }; anything that
// maps to a non-success outcome before the payload is assembled throws an OutcomeError
// (action-support.js).

const envelope = require('./envelope');
const render = require('./render');
const retained = require('./retained');
const { renderRegion, requireSameDocument, requireSameDocuments, RenderError, DocumentChangedError } = require('./region');
const { renderChanges } = require('./changes');
const { settle, settledLine, UNCHECKED } = require('./settle');
const { ConnectionClosedError } = require('./cdp');
const { TargetGoneError } = require('./sessions');
const { OutcomeError, stateLines, workingTarget, requireHttp, pageState, currentStateLines, SETTLE_SOURCE } = require('./action-support');

const MAX_SEGMENTS = 4;
// The milliseconds that a fresh read settles for at most before it reads regardless.
const READ_SETTLE_MS = 2_000;
// What a Paged: line calls each source of a retained render.
const PAGED_FROM = {
  read: 'the read',
  since: 'the render the last since read made',
  summary: 'the render the last action made',
};

// Reads the working tab's page. `since` diffs a fresh render against the tab's retained
// render and takes the defaults of the other parameters, and a paging offset comes
// without `find`, both of which dispatch.js enforces. The read becomes the session's
// last read of that tab.
async function readPage(sessions, session, {
  scope = 'main', find = '', article = false, links = 'inline', hidden = false, since = false, maxChars, offset = 0, deadline,
}) {
  const t = workingTarget(sessions, session);
  requireHttp(t);
  const params = { scope, article, links, hidden };
  let result;
  try {
    const kept = offset > 0 ? retained.current(session, t) : null;
    if (kept && !kept.tooLarge && sameParams(kept.params, params)) {
      result = await pagedRead(sessions, t, kept, { maxChars, offset, deadline });
    } else {
      const settled = await settleRead(sessions, t, deadline);
      const opts = { settled, find, maxChars, offset, deadline };
      result = since
        ? await sinceRead(sessions, session, t, params, opts)
        : await assembled(sessions, t, await renderRegion(sessions, session, t, { ...params, source: 'read', deadline }), opts);
      if (settled) result.outcome = 'unsettled';
    }
  } catch (e) {
    throw mapped(e, { since, article });
  }
  session.refsTarget = t.targetId;
  return result;
}

// Resolves with a paging read: the retained render sliced, without a settle wait or a
// render, under state lines read fresh. The Paged: line says where the text came from
// when it wasn't a plain read, and when the page has changed since.
async function pagedRead(sessions, t, kept, { maxChars, offset, deadline }) {
  const probe = await sessions.callInWorld(t.targetId, SETTLE_SOURCE, [], { deadline }).catch((e) => {
    if (e instanceof ConnectionClosedError || e instanceof TargetGoneError) throw e;
    return null;
  });
  const changed = Boolean(probe) && probe.lastMutationAt !== null && probe.lastMutationAt > kept.startedAt;
  let paged = null;
  if (kept.source !== 'read' || changed) {
    const age = Math.max(0, Math.round((Date.now() - kept.startedAt) / 1000));
    paged = `Paged: from ${PAGED_FROM[kept.source]} ${age} s ago`;
    if (changed) paged += '; the page has changed since, so read without offset for its current state';
  }
  const state = await pageState(sessions, t, { deadline });
  requireSameDocument(t, kept.generation);
  return assemble(kept, { state, links: kept.params.links, find: '', maxChars, offset, paged });
}

// Resolves with a `since` read: the diff of a fresh render against the retained one as
// the region, under its Since: line. Without a retained render to diff against, or
// past the edit cap, the read is a whole one instead, under a Since: line saying why.
async function sinceRead(sessions, session, t, params, opts) {
  const answer = await renderChanges(sessions, session, t, { source: 'since', deadline: opts.deadline });
  if (answer.untracked) {
    const since = `Since: ${answer.untracked}; the whole page follows`;
    const rendered = answer.render && sameParams(answer.render.params, params)
      ? answer.render
      : await renderRegion(sessions, session, t, { ...params, source: 'read', deadline: opts.deadline });
    return assembled(sessions, t, rendered, { ...opts, since });
  }
  if (answer.gaveUp) {
    // The render uses the retained parameters, so the offset that its cut offers names them.
    return assembled(sessions, t, answer.render, { ...opts, since: answer.line, links: answer.render.params.links, resume: resumeWith(answer.render.params) });
  }
  const { render: rendered } = answer;
  const state = await stateAfter(sessions, t, rendered, opts.deadline);
  const cut = render.slice(answer.body, { maxChars: opts.maxChars, offset: 0, resume: () => ' Read without since for the whole page.' });
  const { header } = rendered;
  const head = render.header(state, {
    truncation: cut.truncation, settled: opts.settled, since: answer.line,
    scope: header.scope, omissions: header.omissions, overlays: header.overlays, hidden: header.hidden, hiddenListed: false,
  });
  return { head, body: cut.text };
}

// Resolves with a fresh render's payload, under state lines read after it.
async function assembled(sessions, t, rendered, { links, ...opts }) {
  const state = await stateAfter(sessions, t, rendered, opts.deadline);
  return assemble(rendered, { ...opts, state, links: links || rendered.params.links });
}

// Resolves with the page state read after a render, and throws DocumentChangedError
// when a document that the render describes has changed since: a navigation between the
// two would leave the payload describing two documents.
async function stateAfter(sessions, t, rendered, deadline) {
  const state = await pageState(sessions, t, { deadline });
  requireSameDocuments(rendered.documents);
  return state;
}

// Returns { head, body } for a render. Everything after the header is one region: the
// overlay blocks and the rendered region, narrowed to the matching blocks under
// `find`, then the links index and the hidden list at its end, then the paging cut.
function assemble(rendered, { state, links, find, maxChars, offset, settled, paged, since, resume }) {
  let region = [...rendered.overlayBlocks, rendered.region].join('\n\n');
  let found = null;
  let kept = null;
  let marks = null;
  if (find) {
    found = render.findBlocks(region, find);
    ({ region, marks } = findRegion(found.blocks));
    kept = render.markedRefs(region);
  }
  let index = null;
  if (links === 'index') {
    const list = render.linksIndex(rendered.linkLists.map((unitLinks) => ({ links: unitLinks })), kept);
    if (list.text) {
      index = { count: list.count, offset: region.length + 2 };
      region += `\n\n${list.text}`;
    }
  }
  // A find read lists the page's own blocks, and the hidden section is not one of them.
  const listed = rendered.hiddenSection && !find;
  if (listed) region += `\n\n${rendered.hiddenSection}`;

  const cut = render.slice(region, { maxChars, offset, resume: find ? resumeFind(marks) : resume });
  const { header } = rendered;
  const head = render.header(state, {
    truncation: cut.truncation,
    settled,
    paged,
    since,
    scope: header.scope,
    omissions: header.omissions,
    overlays: header.overlays,
    hidden: header.hidden,
    hiddenListed: Boolean(listed),
    links: index,
    find: found && { needle: find, count: found.count },
    article: header.article,
  });
  return { head, body: cut.text };
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

// Returns the resume text that names the next part of a render made with `params`,
// which a paging read has to repeat to slice it.
function resumeWith({ scope, article, links, hidden }) {
  const named = [];
  if (scope !== 'main') named.push(`scope=${scope}`);
  if (article) named.push('article=true');
  if (links !== 'inline') named.push(`links=${links}`);
  if (hidden) named.push('hidden=true');
  return (end) => ` Pass ${[...named, `offset=${end}`].join(' ')} for the next part.`;
}

function sameParams(a, b) {
  return a.scope === b.scope && a.article === b.article && a.links === b.links && a.hidden === b.hidden;
}

// Resolves with the Settled: line of a page that didn't settle within the read's
// budget, or null.
async function settleRead(sessions, t, deadline) {
  try {
    const answer = await settle(sessions, t, { budget: READ_SETTLE_MS, deadline });
    return answer.settled ? null : settledLine(answer);
  } catch (e) {
    if (e instanceof ConnectionClosedError || e instanceof TargetGoneError) throw e;
    sessions.log.info(`settling before a read failed: ${e.message}`);
    return UNCHECKED;
  }
}

// Maps a render's failure to the read's answer. The renderer's exception text, which a
// page can shape, stays in the journal.
function mapped(e, { since, article }) {
  if (e instanceof RenderError) {
    const recourse = since
      ? 'Read without since, which takes scope=all or scope=<ref> for another subtree, or screenshot.'
      : `Try scope=all or scope=<ref> for another subtree${article ? ', article=false' : ''}, or screenshot.`;
    return new OutcomeError(envelope.error(`Rendering the page failed. ${recourse}`));
  }
  if (e instanceof DocumentChangedError) return new OutcomeError(envelope.error(e.message));
  return e;
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
  return { head: lines.join('\n') };
}

async function screenshot(sessions, session, { fullPage, deadline }) {
  const t = workingTarget(sessions, session);
  const opts = { deadline };
  const header = await currentStateLines(sessions, t, opts);
  if (!fullPage) {
    const { data } = await sessions.send(t.targetId, 'Page.captureScreenshot', { format: 'png' }, opts);
    return { head: header, images: [{ data, mimeType: 'image/png' }] };
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
    head: `${header}\nCaptured: 0–${covered} of ${pageHeight} px in ${segments} segment${segments === 1 ? '' : 's'}${cut}`,
    images,
  };
}

module.exports = { readPage, pageInfo, screenshot };
