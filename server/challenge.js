// This module detects pages that may need a person to clear them after a read
// renders or an acting call settles. The detector checks bot checks, two-factor
// prompts, and sign-in forms in that order and uses the first match.
// It treats unmatched pages as ordinary content and excludes challenges inside
// cross-origin frames unless the frame matches VENDORS.
//
// The daemon limits the widget-response wait and the wait for a challenge to reload
// the page to once per document generation. `keep` marks a widget without a response
// field as reported for that generation.

const { ProtocolError } = require('./cdp');
const network = require('./network');
const { DETECT_SOURCE, VISIBLE_SOURCE, releaseObjects, pageState, pipeClosedOrTabGone } = require('./action-support');

// The least size, in CSS pixels on each side, of a field and of a widget that counts.
const FIELD_MIN = 10;
const WIDGET_MIN = 20;
const WIDGET_WAIT_MS = 3_000;
const WIDGET_POLL_MS = 500;
// What the widget wait leaves of the deadline for its last check, whose page scan reads
// the title.
const WIDGET_MARGIN_MS = 500;
const GROUP = 'claudesurf-detect';

const HEADERS = {
  cloudflare: { signal: "Cloudflare (the page's cf-mitigated header)", clears: true },
  'aws-challenge': { signal: "AWS WAF (the page's x-amzn-waf-action header)", clears: true },
  'aws-captcha': { signal: "AWS WAF (the page's x-amzn-waf-action header)", clears: false },
};
const TWO_FACTOR = {
  'one-time-code': 'a one-time-code field',
  'verification-code': 'a verification-code field',
  'code-boxes': 'a row of code boxes',
};

const within = (url, host) => url.hostname === host || url.hostname.endsWith(`.${host}`);

// CAPTCHA widget definitions, with one row per vendor. Add a row to support another
// vendor. `frame(url)` identifies a widget by its frame target's URL or the src of an
// <iframe> or <frame> in the page scan. `notWidget(url)` excludes invisible widget
// variants. `field` selects the response field filled when the widget is solved.
// A null `field` means that detection can't determine whether the widget is solved;
// its visible frame is reported once per document. `clears(url)` identifies a device
// check that reloads the page when it passes.
const VENDORS = [
  {
    vendor: 'Cloudflare Turnstile',
    frame: (url) => url.href.startsWith('https://challenges.cloudflare.com/'),
    field: '[name="cf-turnstile-response"]',
  },
  {
    vendor: 'reCAPTCHA',
    frame: (url) => url.href.startsWith('https://www.google.com/recaptcha/') || url.href.startsWith('https://www.recaptcha.net/recaptcha/'),
    notWidget: (url) => url.searchParams.get('size') === 'invisible',
    field: '[name="g-recaptcha-response"]',
  },
  {
    vendor: 'hCaptcha',
    frame: (url) => within(url, 'hcaptcha.com'),
    notWidget: (url) => url.hash.includes('checkbox-invisible'),
    field: '[name="h-captcha-response"]',
  },
  {
    vendor: 'DataDome',
    frame: (url) => within(url, 'captcha-delivery.com'),
    field: null,
    clears: (url) => url.pathname.startsWith('/interstitial/'),
  },
  {
    // Arkose's fc-token field may fill as the widget loads, before anyone solves it.
    vendor: 'Arkose',
    frame: (url) => within(url, 'arkoselabs.com') || within(url, 'funcaptcha.com'),
    field: null,
  },
];

// Resolves { challenge, generation, once }: `challenge` is { type, signal, title, clears }
// or null, and `generation` is the tab's as detection began; a commit that lands before
// detection ends makes `challenge` null. `type` is 'bot check', 'two-factor', or
// 'sign-in'; `signal` is the Challenge: line's text after the type; `title` is the
// document's title, empty when a header matched and the title read then failed;
// `clears` says whether the challenge may clear itself. `once` says that the challenge
// is a widget without a response field, which `keep` spends on `generation`.
// `opts.deadline` bounds every command and the widget wait, and `opts.vendors` replaces
// VENDORS. Rejects as the page's commands do.
async function detect(sessions, t, { deadline, vendors = VENDORS } = {}) {
  const generation = t.generation;
  const opts = { deadline };
  const header = network.documentSignal(t);
  let match;
  let title;
  if (header) {
    match = { type: 'bot check', ...HEADERS[header] };
    title = await titleAfterMatch(sessions, t, opts);
  } else {
    const { widget, scan } = await widgetChallenge(sessions, t, { generation, vendors, opts });
    match = widget || scanned(scan);
    title = scan.title;
  }
  if (!match || t.generation !== generation) return { challenge: null, generation, once: false };
  const { once = false, ...challenge } = match;
  return { challenge: { ...challenge, title: String(title || '') }, generation, once };
}

// Resolves detect's answer, or null after a detection that failed, which it logs at info.
// A closed pipe and a tab gone from the registry reject, so the caller's own paths
// answer them.
async function detectOrLog(sessions, t, opts) {
  try {
    return await detect(sessions, t, opts);
  } catch (e) {
    if (pipeClosedOrTabGone(sessions, t, e)) throw e;
    sessions.log.info(`detecting a challenge on ${t.targetId} failed: ${e.message}`);
    return null;
  }
}

// Returns the challenge from `detected`, detectOrLog's answer, or null. The caller must
// confirm that the challenge belongs to the document described by its state lines.
// A widget without a response field is marked as reported on that document, so later
// detections skip it.
function keep(t, detected) {
  if (!detected || !detected.challenge) return null;
  if (detected.once) t.widgetReported = detected.generation;
  return detected.challenge;
}

function challengeLine({ type, signal }) {
  return `Challenge: ${type} — ${signal}`;
}

// Resolves { widget, scan }: `widget` is the challenge of the first visible unsolved
// widget, carrying `once` for a widget without a response field, or null, and `scan` is
// the answer of the page scan that ran with the last widget check. On a document whose
// widget wait isn't spent, a widget whose response field isn't filled gets up to
// WIDGET_WAIT_MS, checked every WIDGET_POLL_MS, to fill, until a navigation starts or
// WIDGET_MARGIN_MS before the deadline; a wait that a navigation ends checks once more,
// so the final check treats a field that filled before that navigation as solved. A
// wait with less than WIDGET_POLL_MS before that point stays unspent.
async function widgetChallenge(sessions, t, { generation, vendors, opts }) {
  const navigations = t.navigations;
  let { widgets, scan } = await checkWidgets(sessions, t, vendors, opts);
  const waiting = () => widgets.some((w) => w.visible && w.row.field && w.field !== 'filled');
  const end = Math.min(Date.now() + WIDGET_WAIT_MS, opts.deadline === undefined ? Infinity : opts.deadline - WIDGET_MARGIN_MS);
  if (waiting() && t.widgetWaited !== generation && end - Date.now() >= WIDGET_POLL_MS) {
    t.widgetWaited = generation;
    while (waiting() && t.navigations === navigations && Date.now() < end) {
      await sessions.waitUntil(t.targetId, (tab) => tab.navigations !== navigations, { timeout: Math.max(1, Math.min(WIDGET_POLL_MS, end - Date.now())) });
      ({ widgets, scan } = await checkWidgets(sessions, t, vendors, opts));
    }
  }
  for (const widget of widgets) {
    if (!widget.visible) continue;
    if (widget.row.field) {
      if (widget.field !== 'filled') return { widget: { type: 'bot check', signal: `${widget.row.vendor} (a visible widget)`, clears: false }, scan };
      continue;
    }
    if (t.widgetReported === generation) continue;
    const clears = Boolean(widget.row.clears && widget.row.clears(widget.url));
    return { widget: { type: 'bot check', signal: `${widget.row.vendor} (${clears ? 'a device check' : 'a visible widget'})`, clears, once: true }, scan };
  }
  return { widget: null, scan };
}

// Resolves { widgets, scan }, with the page scan's answer as `scan`. `widgets` contains
// { row, url, visible, field } entries for vendor widgets, first from frame targets
// whose <iframe>s resolve, then from frame elements listed by the scan.
// The scan includes visible http(s) frame elements that meet its size rule
// (page/detect.js), including frames in the page's process that lack a target.
// A widget can appear through both checks. widgetChallenge uses the first visible
// unsolved match, so duplicate entries don't cause duplicate reports.
async function checkWidgets(sessions, t, vendors, opts) {
  const widgets = [];
  for (const frame of sessions.frameTargets(t.targetId)) {
    const named = widgetRow(vendors, frame.url);
    if (!named) continue;
    const answer = await checkWidget(sessions, frame, named.row, opts);
    if (answer) widgets.push({ ...named, ...answer });
  }
  const selectors = [...new Set(vendors.map((row) => row.field).filter(Boolean))];
  const scan = await sessions.callInWorld(t.targetId, DETECT_SOURCE, [{ fieldMin: FIELD_MIN, widgetMin: WIDGET_MIN, selectors }], opts);
  for (const frame of scan.frames) {
    const named = widgetRow(vendors, frame.src);
    if (named) widgets.push({ ...named, visible: true, field: named.row.field ? frame.fields[named.row.field] : 'absent' });
  }
  return { widgets, scan };
}

function widgetRow(vendors, href) {
  const url = parsed(href);
  const row = url && vendors.find((r) => r.frame(url));
  return row && !(row.notWidget && row.notWidget(url)) ? { row, url } : null;
}

// Resolves with page/visible.js's answer for the widget frame's <iframe>, with
// `visible` false when the <iframe> of any frame between it and the page fails the same
// rule, since a hidden frame's style stops at its own document and leaves the widget's
// <iframe> visible there. Resolves null when one of those <iframe>s doesn't resolve or
// answer (ownerState).
async function checkWidget(sessions, frame, row, opts) {
  const answer = await ownerState(sessions, frame, row.field, opts);
  if (!answer || !answer.visible) return answer;
  for (let outer = sessions.target(frame.parentTargetId); outer && outer.type === 'iframe'; outer = sessions.target(outer.parentTargetId)) {
    const shown = await ownerState(sessions, outer, null, opts);
    if (!shown) return null;
    if (!shown.visible) return { ...answer, visible: false };
  }
  return answer;
}

// Resolves with page/visible.js's answer for the frame's <iframe> under `selector`,
// resolved in its parent's main-frame world; or null when the world can't resolve the
// <iframe>, such as one inside a same-process child frame, or when its read fails
// with a protocol error, as when a commit lands after the <iframe> resolved. A box
// alone can't stand in, since it misses visibility: hidden, which standby widget frames
// use.
async function ownerState(sessions, frame, selector, opts) {
  const parent = sessions.target(frame.parentTargetId);
  if (!parent) return null;
  try {
    let objectId;
    try {
      const { backendNodeId } = await sessions.send(parent.targetId, 'DOM.getFrameOwner', { frameId: frame.targetId }, opts);
      const executionContextId = await sessions.world(parent.targetId, null, opts);
      ({ object: { objectId } } = await sessions.send(parent.targetId, 'DOM.resolveNode', { backendNodeId, executionContextId, objectGroup: GROUP }, opts));
    } catch (e) {
      if (!(e instanceof ProtocolError)) throw e;
      sessions.log.debug(`detection: the <iframe> of frame ${frame.targetId} did not resolve: ${e.message}`);
      return null;
    }
    try {
      return await sessions.callFunction(parent.targetId, { objectId, functionDeclaration: VISIBLE_SOURCE, args: [selector, WIDGET_MIN] }, opts);
    } catch (e) {
      if (!(e instanceof ProtocolError)) throw e;
      sessions.log.debug(`detection: the <iframe> of frame ${frame.targetId} did not answer: ${e.message}`);
      return null;
    }
  } finally {
    await releaseObjects(sessions, parent.targetId, GROUP, opts.deadline);
  }
}

// Resolves with the document's title, read after a header matched; '' when the read
// fails, since the match stands without it. Rejects when the pipe has closed or the tab
// is gone from the registry.
async function titleAfterMatch(sessions, t, opts) {
  try {
    return (await pageState(sessions, t, opts)).title;
  } catch (e) {
    if (pipeClosedOrTabGone(sessions, t, e)) throw e;
    sessions.log.info(`reading the title of ${t.targetId} for the urgency hint failed: ${e.message}`);
    return '';
  }
}

function scanned({ px, twoFactor, password }) {
  if (px) return { type: 'bot check', signal: 'HUMAN (a press-and-hold element)', clears: false };
  if (TWO_FACTOR[twoFactor]) return { type: 'two-factor', signal: TWO_FACTOR[twoFactor], clears: false };
  if (password) return { type: 'sign-in', signal: 'a password field', clears: false };
  return null;
}

function parsed(url) {
  try { return new URL(url); } catch { return null; }
}

module.exports = { detect, detectOrLog, keep, challengeLine, VENDORS };
