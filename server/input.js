// The claudesurf_act actions on the working tab's document: click (scripted by
// default, real pointer events on request), scroll, type, press, and select. Each takes
// the handler context, the caller's Session, its arguments, and the request deadline,
// and ends with act-result.js's finishAction, returning its { head, body, outcome,
// blocked }; an OutcomeError carries a non-success outcome from before the action
// acted. Only the trusted click uses coordinates: type and select reach their element
// by script in its frame's world, and keys go on the page target's session, which
// Chrome routes to whatever holds focus, a frame's field included.

const envelope = require('./envelope');
const { ProtocolError, ConnectionClosedError } = require('./cdp');
const { refUnit, resolveNode, removed } = require('./refs');
const { parseKeys, keyEvents } = require('./keys');
const { beforeAction, finishAction, acting } = require('./act-result');
const { readFocus, focusMoved, focusLine, focusedFrame } = require('./focus');
const {
  fail, workingTarget, requireHttp, releaseObjects, CLICK_SOURCE, SCROLL_SOURCE, EDIT_SOURCE, SELECT_SOURCE,
} = require('./action-support');

// The object group of a click's remote handles, and the one that type, select, and
// press's focus read share.
const CLICK_GROUP = 'claudesurf-click';
const INPUT_GROUP = 'claudesurf-input';
const INCOMPLETE = 'Input: incomplete (the page stopped answering)';
const LOST_FOCUS = 'Input: incomplete (the field lost focus; click it, then type again)';
// The Control+a press that type sends ahead of its text. typeInto adds the selectAll
// editing command to the `a` key's down event, since the command updates a rich-text
// editor's own selection model as a script selection might not.
const [SELECT_ALL] = parseKeys('Control+a');
// The input types that an error message may name: the browser's fixed set of those that
// aren't text fields.
const OTHER_INPUT_TYPES = new Set(['button', 'checkbox', 'color', 'date', 'datetime-local', 'file', 'hidden', 'image', 'month', 'radio', 'range', 'reset', 'submit', 'time', 'week']);

// Clicks the element that `ref` names, by script, or with mouse events when `trusted`.
// The click runs on the session of the target that the ref was read in — a frame's own
// for an f-ref — while the navigation wait, settling, and the state lines stay the page
// target's, so a navigation confined to a frame reads as Navigated: no. A ref that was
// read in a frame has that frame's document settle too.
async function click(ctx, session, { ref, trusted }, deadline) {
  const { sessions } = ctx;
  const refuse = (located) => {
    if (trusted && located.frame !== null) {
      fail(envelope.error(`${ref} is inside a cross-site frame, where trusted clicks are not supported yet; click it without trusted=true`));
    }
  };
  return onElement(ctx, session, ref, deadline, { group: CLICK_GROUP, refuse }, async ({ t, located, on, objectId, opts }) => {
    const run = () => sessions.callFunction(on, {
      objectId, functionDeclaration: CLICK_SOURCE, args: [trusted ? 'prepare' : 'scripted'], userGesture: true,
    }, opts);
    // The trusted path's script only scrolls; its first mouse event acts.
    const { state } = trusted ? await run() : await acting(run);
    if (state === 'detached') fail(removed(ref));
    if (state === 'disabled') fail(envelope.error(`${ref} is disabled; clicking it would change nothing`));
    if (!trusted) return [];
    if (state === 'hidden') fail(envelope.error(`${ref} is hidden; a trusted click needs a visible element`));
    return trustedClick(sessions, t, located, objectId, ref, opts);
  });
}

// Clicks the element at its centre with mouse events, once a hit test there reaches
// it, and resolves with the head lines that finishAction prints: an empty list, or the
// incomplete-input line when a mouse event after the first failed. Content quads and
// mouse events are in viewport coordinates; the hit test takes document coordinates,
// so the scroll offset is added for it. A same-process frame is laid out in its
// parent's renderer, so its quads are the page's coordinates already; `located` is
// only needed for the world that its node lives in.
async function trustedClick(sessions, t, located, objectId, ref, opts) {
  const { quads } = await sessions.send(t.targetId, 'DOM.getContentQuads', { objectId }, opts);
  if (!quads || quads.length === 0) fail(envelope.error(`${ref} is hidden and has no position to click; a trusted click needs a visible element`));
  const [x1, y1, , , x2, y2] = quads[0];
  const x = (x1 + x2) / 2;
  const y = (y1 + y2) / 2;
  const { cssLayoutViewport: viewport } = await sessions.send(t.targetId, 'Page.getLayoutMetrics', {}, opts);
  let hit;
  try {
    hit = await sessions.send(t.targetId, 'DOM.getNodeForLocation', {
      x: Math.round(x + viewport.pageX), y: Math.round(y + viewport.pageY), includeUserAgentShadowDOM: false,
    }, opts);
  } catch (e) {
    if (e instanceof ProtocolError) fail(envelope.error(`${ref} has no hit-testable point at its centre (it is covered, or lies outside the document); a trusted click cannot reach it`));
    throw e;
  }
  // The hit node goes into the element's own world: callFunctionOn refuses an argument
  // from another one. A hit outside the element's frame resolves there too, and the
  // comparison below reports it as the covering element it is.
  const contextId = await sessions.world(t.targetId, located.frameId, opts);
  const { object } = await sessions.send(t.targetId, 'DOM.resolveNode', { backendNodeId: hit.backendNodeId, executionContextId: contextId, objectGroup: CLICK_GROUP }, opts);
  // The hit node reaches the element when one is inside the other, shadow roots
  // included: a host's painted content lives in its shadow tree.
  const reaches = await sessions.callFunction(t.targetId, {
    objectId,
    functionDeclaration: 'function (hit) { for (let n = hit; n; n = n.parentNode || (n instanceof ShadowRoot ? n.host : null)) if (n === this) return true; return Boolean(hit) && hit.contains(this); }',
    args: [{ objectId: object.objectId }],
  }, opts);
  if (!reaches) fail(envelope.error(`${ref} is covered by another element at its centre; a trusted click cannot reach it`));
  const [first, ...rest] = ['mouseMoved', 'mousePressed', 'mouseReleased'];
  const event = (type) => sessions.send(t.targetId, 'Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, opts);
  return sendInput(sessions, () => event(first), async () => {
    for (const type of rest) await event(type);
    return [];
  }, `a trusted click on ${ref}`);
}

async function scroll({ sessions }, session, { direction, amount }, deadline) {
  const t = workingTarget(sessions, session);
  requireHttp(t);
  const opts = { deadline };
  const before = beforeAction(sessions, session, t);
  // The world is made outside acting(): the page scrolls only once the scroll script
  // runs.
  const info = await sessions.withWorld(t.targetId, null, (executionContextId) => acting(() => (
    sessions.callFunction(t.targetId, { executionContextId, functionDeclaration: SCROLL_SOURCE, args: [direction, amount] }, opts)
  )), opts);
  const lines = [`Scroll: ${info.scrollY} of ${info.pageHeight} (viewport ${info.viewportHeight})`];
  return finishAction(sessions, session, t, before, { deadline, lines });
}

// Replaces a text field's content with `text`: the field is focused by script in its
// frame's world, everything in it is selected by the select-all key event, and the text
// is inserted with Input.insertText on the page target's session, which Chrome routes to
// the focused frame. The field is checked between the two, so a page that moved focus
// on the key event doesn't get the text in another field, and when the selection falls
// short of the field's value, the page script selects the value instead.
async function type(ctx, session, { ref, text }, deadline) {
  const { sessions } = ctx;
  return onElement(ctx, session, ref, deadline, { group: INPUT_GROUP }, async ({ t, on, objectId, opts }) => {
    const edit = (step) => sessions.callFunction(on, { objectId, functionDeclaration: EDIT_SOURCE, args: [step] }, opts);
    refuseEdit(ref, await edit('focus'));
    return typeInto(sessions, t, edit, text, ref, opts);
  });
}

// Sends the select-all and the text, and resolves with the head lines that
// finishAction prints: an empty list, or the line saying where the input stopped.
function typeInto(sessions, t, edit, text, ref, opts) {
  const key = (event) => sessions.send(t.targetId, 'Input.dispatchKeyEvent', event, opts);
  const [first, ...rest] = keyEvents(SELECT_ALL).map((event) => (event.key === 'a' && event.type !== 'keyUp' ? { ...event, commands: ['selectAll'] } : event));
  return sendInput(sessions, () => key(first), async () => {
    for (const event of rest) await key(event);
    const { state } = await edit('select');
    if (state === 'focus-lost') return [LOST_FOCUS];
    await sessions.send(t.targetId, 'Input.insertText', { text }, opts);
    return [];
  }, `typing into ${ref}`);
}

function refuseEdit(ref, { state, type: kind }) {
  if (state === 'ok') return;
  if (state === 'detached') fail(removed(ref));
  if (state === 'disabled') fail(envelope.error(`${ref} is disabled; typing into it would change nothing`));
  if (state === 'readonly') fail(envelope.error(`${ref} is read-only; typing into it would change nothing`));
  if (state === 'no-focus') fail(envelope.error(`${ref} did not take focus; click it first, then type again`));
  if (kind === 'select-one' || kind === 'select-multiple') fail(envelope.error(`${ref} is a select, not a text field; choose its option with select`));
  if (OTHER_INPUT_TYPES.has(kind)) fail(envelope.error(`${ref} is an input of type ${kind}, not a text field; click it instead`));
  fail(envelope.error(`${ref} is not a text field; type fills a text input, a textarea, or an editable region, and click reaches anything else`));
}

// Chooses an option of a native <select> by script in the element's frame's world;
// the page script dispatches input and change. A message leaves out the option's
// text, which is the page's.
async function select(ctx, session, { ref, option }, deadline) {
  const { sessions } = ctx;
  return onElement(ctx, session, ref, deadline, { group: INPUT_GROUP }, async ({ on, objectId, opts }) => {
    const { state } = await acting(() => sessions.callFunction(on, { objectId, functionDeclaration: SELECT_SOURCE, args: [option] }, opts));
    if (state === 'detached') fail(removed(ref));
    if (state === 'not-select') fail(envelope.error(`${ref} is not a native select; click the control to open it, then click the option's ref`));
    if (state === 'disabled') fail(envelope.error(`${ref} is disabled; choosing an option would change nothing`));
    if (state === 'option-disabled') fail(envelope.error(`the option of ${ref} with that label or value is disabled`));
    if (state === 'no-match') fail(envelope.error(`no option of ${ref} has that label or value; read the page with scope=${ref} for every option`));
    return [];
  });
}

// Sends key presses to whatever holds focus in the working tab, and reports where they
// went and, when the call stayed on its document, where focus went, since the markdown
// and the diff both leave focus out. When an <iframe> holds focus, the keys reach the
// frame's own focused element, and the frame's document settles too.
async function press({ sessions }, session, { keys }, deadline) {
  const t = workingTarget(sessions, session);
  requireHttp(t);
  const opts = { deadline };
  const presses = parseKeys(keys);
  const focus = await readFocus(sessions, t, INPUT_GROUP, opts);
  const frame = focusedFrame(sessions, session, t, focus);
  const before = beforeAction(sessions, session, t);
  const lines = [() => focusLine('Keys to:', session, t, focus)];
  const events = presses.flatMap(keyEvents);
  const key = (event) => sessions.send(t.targetId, 'Input.dispatchKeyEvent', event, opts);
  lines.push(...await sendInput(sessions, () => key(events[0]), async () => {
    for (const event of events.slice(1)) await key(event);
    return [];
  }, `pressing ${presses.length} keys`));
  const focusNow = () => focusMoved(sessions, session, t, focus, INPUT_GROUP, opts);
  return finishAction(sessions, session, t, before, { deadline, frame, lines, focusNow });
}

// Runs an action on the element that `ref` names in the working tab and ends it with
// finishAction. `refuse(located)`, when given, can fail the call before the ref
// resolves. Once the node has resolved under `group`, beforeAction takes the call's
// marks, so what `act` starts, the page's focus handlers included, is the call's own.
// `act({ t, located, on, objectId, opts })`, where `on` is the id of the target that the
// ref was read in, resolves with the head lines that print after the state lines.
async function onElement({ sessions }, session, ref, deadline, { group, refuse = null }, act) {
  const t = workingTarget(sessions, session);
  requireHttp(t);
  const opts = { deadline };
  const located = refUnit(sessions, session, t, ref);
  if (refuse) refuse(located);
  const on = located.target.targetId;
  let before;
  let lines;
  try {
    const objectId = await resolveNode(sessions, located, ref, group, opts);
    before = beforeAction(sessions, session, t);
    lines = await act({ t, located, on, objectId, opts });
  } finally {
    // A navigation that the action started has already discarded the handles; the summary
    // renders after the release, under the read's own groups.
    await releaseObjects(sessions, on, group, deadline);
  }
  return finishAction(sessions, session, t, before, { deadline, frame: touchedFrame(t, located, ref), lines });
}

// Sends an input's events: `first`, after which the input counts as having acted,
// under acting(), then `rest`, and resolves with the head lines that `rest` resolves with.
// A failure of `rest` other than a closed pipe resolves with the incomplete-input line
// instead, and the journal says what stopped, as `what` names it.
async function sendInput(sessions, first, rest, what) {
  await acting(first);
  try {
    return await rest();
  } catch (e) {
    if (e instanceof ConnectionClosedError) throw e;
    sessions.log.info(`${what} stopped: ${e.message}`);
    return [INCOMPLETE];
  }
}

// Returns the child frame that an action on `located` touched, which settling watches
// too, or null for the page's own document.
function touchedFrame(t, located, ref) {
  const inFrame = located.target !== t || located.frameId !== null;
  return inFrame ? { target: located.target, frameId: located.frameId, label: `the frame holding ${ref}` } : null;
}

module.exports = { click, scroll, type, press, select };
