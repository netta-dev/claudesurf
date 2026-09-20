// The claudesurf_read actions: page (the walk, refs, payload assembly), info, and
// screenshot. Handlers take the registry and the caller's Session and return
// { payload, images? }; anything that maps to a non-success outcome throws an
// OutcomeError (action-support.js).

const envelope = require('./envelope');
const { fail, stateLines, workingTarget, requireHttp, pageState, WALK_SOURCE } = require('./action-support');

const MAX_SEGMENTS = 4;
// A read releases the remote object handles it takes under this group when it ends.
const OBJECT_GROUP = 'claudesurf-read';
const DOCUMENT_CHANGED = 'The document changed while it was being read; read the page again.';

function elementLine(el, ref) {
  let line = `[e${ref}] ${el.kind} ${JSON.stringify(el.label)}`;
  if (el.href) line += ` → ${el.href}`;
  if (el.disabled) line += ' (disabled)';
  if (el.checked) line += ' (checked)';
  if (!el.visible) line += ' (hidden)';
  return line;
}

// Steps a cut back so it never splits a surrogate pair.
function codePointBoundary(text, index) {
  if (index > 0 && index < text.length) {
    const code = text.charCodeAt(index);
    if (code >= 0xdc00 && code <= 0xdfff) return index - 1;
  }
  return index;
}

// Builds the page payload from a walk summary and the ref per element (same order).
// Everything after the two state lines is one region that offset and max_chars slice.
function assemblePage(summary, refs, { maxChars, offset, hidden }) {
  const visibleCount = summary.elements.filter((e) => e.visible).length;
  const hiddenCount = summary.elements.length - visibleCount;
  const listed = summary.elements
    .map((el, i) => ({ el, ref: refs[i] }))
    .filter(({ el }) => hidden || el.visible);
  const heading = `## Interactive elements (${visibleCount} visible, ${hiddenCount} hidden)`;
  const lines = listed.map(({ el, ref }) => elementLine(el, ref));
  const bodyRegion = `\n${summary.text}\n\n`;
  const elementsStart = bodyRegion.length;
  const region = bodyRegion + [heading, ...lines].join('\n');
  const total = region.length;
  if (offset > total) fail(envelope.error(`offset ${offset} is past the end of the page text (${total} characters)`));

  let end = Math.min(offset + maxChars, total);
  let cutInBody = false;
  if (end < total) {
    if (end < elementsStart) {
      end = codePointBoundary(region, end);
      cutInBody = true;
    } else {
      const lineEnd = region.lastIndexOf('\n', end);
      // Always deliver at least the heading or one whole line past the offset.
      end = lineEnd > offset ? lineEnd : region.indexOf('\n', Math.max(offset, elementsStart));
      if (end === -1) end = total;
    }
  }
  const slice = region.slice(offset, end);
  let shown = 0;
  let lineStart = elementsStart + heading.length + 1;
  for (const line of lines) {
    if (lineStart >= offset && lineStart + line.length <= end) shown++;
    lineStart += line.length + 1;
  }

  let truncation = '';
  if (offset > 0 || end < total) {
    const shownCount = `${shown} of ${listed.length} ${hidden ? '' : 'visible '}elements (${hiddenCount} hidden${hidden ? ', included' : ''}) shown`;
    const where = cutInBody ? `; they start at offset ${elementsStart}` : '';
    const next = end < total ? ` Pass offset=${end} for the next part.` : '';
    truncation = `\n[Showing characters ${offset}–${end} of ${total}; ${shownCount}${where}.${next}]`;
  }
  return {
    payload: stateLines(summary.url, summary.title) + truncation + '\n' + slice,
    total, end, shown,
  };
}

// Reads the walk's element handles: one Runtime.getProperties on the stashed array,
// then one DOM.describeNode per element, pipelined. The array is missing when the
// document changed since the walk (a new document gets a new world).
async function elementRefs(sessions, t, count, opts) {
  if (count === 0) return [];
  const contextId = await sessions.world(t.targetId, opts);
  const { result } = await sessions.send(t.targetId, 'Runtime.evaluate', { expression: 'globalThis.__claudesurfElements', contextId, objectGroup: OBJECT_GROUP }, opts);
  if (!result.objectId) fail(envelope.error(DOCUMENT_CHANGED));
  const props = await sessions.send(t.targetId, 'Runtime.getProperties', { objectId: result.objectId, ownProperties: true }, opts);
  const handles = props.result.filter((p) => /^\d+$/.test(p.name)).sort((a, b) => Number(a.name) - Number(b.name));
  const described = await Promise.all(handles.map((p) => sessions.send(t.targetId, 'DOM.describeNode', { objectId: p.value.objectId }, opts)));
  return described.map((d) => d.node.backendNodeId);
}

async function readPage(sessions, session, { maxChars, offset, hidden, deadline }) {
  const t = workingTarget(sessions, session);
  requireHttp(t);
  const opts = { deadline };
  const generation = t.generation;
  const summary = await sessions.callInWorld(t.targetId, WALK_SOURCE, [], opts);
  if (t.generation !== generation) fail(envelope.error(DOCUMENT_CHANGED));
  let refs;
  try {
    refs = await elementRefs(sessions, t, summary.elements.length, opts);
  } finally {
    await sessions.send(t.targetId, 'Runtime.releaseObjectGroup', { objectGroup: OBJECT_GROUP }, opts).catch(() => {});
  }
  const set = session.refs.get(t.targetId);
  if (set && set.generation === generation) {
    for (const id of refs) set.ids.add(id);
  } else {
    session.refs.set(t.targetId, { generation, ids: new Set(refs) });
  }
  return { payload: assemblePage(summary, refs, { maxChars, offset, hidden }).payload };
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

module.exports = { readPage, pageInfo, screenshot, assemblePage };
