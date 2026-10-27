// One Accessibility.getFullAXTree answer, read as what a read needs from it: the
// controls with the options that a combobox or a listbox keeps, the landmarks and named
// groups, the frames, the overlays, and the scope root. The tree is the sole
// classifier of controls and landmarks; the DOM supplies structure, which the page
// script renders, so container and text roles are never looked at here.
//
// Everything in this file is pure over protocol data and ref lists, so the read's tree
// logic is tested without a browser.

const { cappedText } = require('./action-support');

// Chrome's role strings, compared case-sensitively; the capitalized ones are
// Blink-internal (a <summary>, and the date, datetime-local, time, and colour inputs).
const CONTROL_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'switch', 'combobox',
  'listbox', 'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'slider',
  'spinbutton', 'treeitem', 'DisclosureTriangle', 'Date', 'DateTime', 'InputTime', 'ColorWell',
]);
// The roles whose nested options render as the control's value list, kept to
// MAX_KEPT_OPTIONS entries; any other control nested in a control folds into it.
const OPTION_OWNERS = new Set(['combobox', 'listbox']);
const MAX_KEPT_OPTIONS = 500;
const RANGE_ROLES = new Set(['slider', 'spinbutton']);
const LANDMARK_ROLES = new Set(['banner', 'navigation', 'main', 'complementary', 'contentinfo', 'search']);
// A form or a region is a landmark once it is named.
const NAMED_LANDMARK_ROLES = new Set(['form', 'region']);
// A named group or region carries a boundary marker wherever it renders, since its
// name has no prose to survive in; a region is therefore both a landmark and a group.
const GROUP_ROLES = new Set(['group', 'region']);
const IFRAME_ROLES = new Set(['Iframe', 'IframePresentational']);
const DIALOG_ROLES = new Set(['dialog', 'alertdialog']);
// What a page opens over its content: dialogs and menus always, and an alert or a
// status once it holds text, since a page often keeps an empty live region in place
// for a later message.
const OVERLAY_ROLES = new Set([...DIALOG_ROLES, 'menu']);
const ANNOUNCEMENT_ROLES = new Set(['alert', 'status']);
// The chains that render one subtree rather than the whole document.
const ROOTED_CHAINS = new Set(['main', 'article', 'ref']);
// Past this many landmarks the omission line says how many more there are.
const MAX_LANDMARKS = 12;
// The omission report's root when the whole body rendered, or when Readability chose
// a subtree the tree cannot compute containment against.
const BODY = 'body';
// And when nothing of this page rendered: a read scoped into a frame whose <iframe>
// the page's own tree does not show, where every control of the page is outside it.
const NOTHING = 'nothing';

class Snapshot {
  // `nodes` is one getFullAXTree answer's node list, in tree order.
  constructor(nodes) {
    this.nodes = nodes;
    this.byNodeId = new Map(nodes.map((node) => [node.nodeId, node]));
    this.byBackendId = new Map();
    this.parentOf = new Map();
    for (const node of nodes) {
      if (node.backendDOMNodeId !== undefined && !this.byBackendId.has(node.backendDOMNodeId)) {
        this.byBackendId.set(node.backendDOMNodeId, node);
      }
      for (const child of node.childIds || []) this.parentOf.set(child, node.nodeId);
    }
    this.root = nodes[0] || null;
    this.controls = [];
    this.landmarks = [];
    this.groups = [];
    this.iframes = [];
    // [{ nodeId, backendId, role, name, modal }], outermost only, in tree order.
    this.overlays = [];
    if (this.root) this.collect();
  }

  // The tree node behind a DOM node, or null: how a ref scope and the omission report
  // look an element up.
  node(backendId) {
    return this.byBackendId.get(backendId) || null;
  }

  // Every node id under `nodeId`, the node itself included.
  subtree(nodeId) {
    const ids = new Set();
    const stack = [nodeId];
    while (stack.length) {
      const id = stack.pop();
      if (ids.has(id)) continue;
      ids.add(id);
      const node = this.byNodeId.get(id);
      if (node && node.childIds) stack.push(...node.childIds);
    }
    return ids;
  }

  // The outermost landmark of `landmarks` containing `nodeId`, or null when no
  // landmark does.
  enclosingLandmark(nodeId, landmarks) {
    let found = null;
    for (let id = nodeId; id !== undefined; id = this.parentOf.get(id)) {
      const landmark = landmarks.get(id);
      if (landmark) found = landmark;
    }
    return found;
  }

  // One pre-order walk classifying every node, so a control inside a control, a
  // landmark inside a landmark, and an option of a combobox are each seen in context.
  collect() {
    const stack = [{ id: this.root.nodeId, control: null, inLandmark: false, inOverlay: false }];
    while (stack.length) {
      const { id, ...context } = stack.pop();
      const node = this.byNodeId.get(id);
      if (!node) continue;
      const next = node.ignored ? context : this.classify(node, context);
      const children = node.childIds || [];
      for (let i = children.length - 1; i >= 0; i--) stack.push({ id: children[i], ...next });
    }
  }

  classify(node, { control, inLandmark, inOverlay }) {
    const role = roleOf(node);
    const properties = propertiesOf(node);
    const name = cappedText(nameOf(node));
    const entry = { nodeId: node.nodeId, backendId: node.backendDOMNodeId, role, name };
    if (isControl(role, properties)) {
      if (!control) {
        const state = stateOf(properties);
        const range = RANGE_ROLES.has(role) ? rangeOf(properties) : null;
        const own = { ...entry, state };
        if (range) own.range = range;
        this.controls.push(own);
        return { control: own, inLandmark, inOverlay };
      }
      if (role === 'option' && OPTION_OWNERS.has(control.role)) addOption(control, name, node.backendDOMNodeId);
      return { control, inLandmark, inOverlay };
    }
    const overlay = !inOverlay && this.isOverlay(node, role, name);
    if (overlay) this.overlays.push({ ...entry, modal: properties.modal === true });
    const next = { control, inLandmark, inOverlay: inOverlay || overlay };
    if (IFRAME_ROLES.has(role)) this.iframes.push({ nodeId: entry.nodeId, backendId: entry.backendId });
    if (name && GROUP_ROLES.has(role)) this.groups.push({ nodeId: entry.nodeId, backendId: entry.backendId, role, name });
    if (LANDMARK_ROLES.has(role) || (name && NAMED_LANDMARK_ROLES.has(role))) {
      this.landmarks.push({ ...entry, topLevel: !inLandmark });
      return { ...next, inLandmark: true };
    }
    return next;
  }

  // Returns whether the node is an overlay. Chrome names an alert or a status from
  // author attributes alone, so one that says something without a name says it in the
  // text under it.
  isOverlay(node, role, name) {
    if (OVERLAY_ROLES.has(role)) return true;
    if (!ANNOUNCEMENT_ROLES.has(role)) return false;
    if (name) return true;
    for (const id of this.subtree(node.nodeId)) {
      const inner = this.byNodeId.get(id);
      if (inner && !inner.ignored && roleOf(inner) === 'StaticText' && nameOf(inner).trim()) return true;
    }
    return false;
  }
}

// Returns the overlays that a read renders as blocks ahead of its region. `rootNodeId` is
// the scope root's tree node, or null when the read has none; an overlay containing it
// is left out, since the read renders the part of it that the scope names. A dialog or an
// alert dialog is picked under every chain, wherever it sits, so the region can cut
// it. An alert, a status, or a menu is picked only under the chains `main`, `article`,
// and `ref`, and only outside the root, so a validation error beside its field stays
// where it reads. `chain` is the one that the scope resolved to before the render's
// fallback, `forced-article` under article=true; a read scoped into a frame passes
// `all`.
function blockOverlays(snapshot, rootNodeId, chain) {
  const inRoot = rootNodeId === null ? null : snapshot.subtree(rootNodeId);
  return snapshot.overlays.filter((overlay) => {
    if (overlay.backendId === undefined) return false;
    if (inRoot && snapshot.subtree(overlay.nodeId).has(rootNodeId)) return false;
    if (DIALOG_ROLES.has(overlay.role)) return true;
    return ROOTED_CHAINS.has(chain) && !(inRoot && inRoot.has(overlay.nodeId));
  });
}

// Returns the scope root and the link of the chain that reached it, for the two scopes
// that are the page's own: 'main' (the default chain) and 'all'. A ref scope names a
// unit rather than a link of this chain, and region.js resolves it. The 'auto' link
// hands the choice to the page script, which tries Readability and falls back to the
// body.
function resolveScope(snapshot, scope) {
  if (scope === 'all') return { rootBackendId: null, chain: 'all' };
  const main = snapshot.landmarks.find((landmark) => landmark.role === 'main');
  if (main) return { rootBackendId: main.backendId, chain: 'main' };
  const article = snapshot.nodes.find((node) => !node.ignored && roleOf(node) === 'article' && node.backendDOMNodeId !== undefined);
  if (article) return { rootBackendId: article.backendDOMNodeId, chain: 'article' };
  return { rootBackendId: null, chain: 'auto' };
}

// The Scope: line's report, by difference: an omitted control is one the tree holds,
// the render emitted no marker for, and the page script did not report as hidden.
// `root` is the scope root's node id, BODY when the whole body rendered or Readability
// chose the subtree, whose containment the tree cannot decide, or NOTHING when what
// rendered is no part of this page; a control omitted under BODY is grouped by landmark
// rather than counted as dropped.
// Refs are the page unit's, `unreadFrames` the refs of the frames the read left alone.
function omissions(snapshot, root, renderedRefs, hiddenRefs, unreadFrames = []) {
  const rendered = new Set(renderedRefs);
  const hidden = new Set(hiddenRefs);
  const inScope = subtreeOf(snapshot, root);
  // A landmark with no DOM node behind it has no ref to name it by, so the report
  // skips it as the descriptors and the ref set skip it; the controls under it fall to
  // the enclosing listed landmark, or to elsewhere.
  const listed = new Map(snapshot.landmarks
    .filter((landmark) => landmark.backendId !== undefined && landmark.topLevel && !(inScope && inScope.has(landmark.nodeId)))
    .map((landmark) => [landmark.nodeId, { role: landmark.role, name: landmark.name, backendId: landmark.backendId, ...counts() }]));
  const elsewhere = counts();
  const droppedInside = counts();
  for (const control of snapshot.controls) {
    // A control with no DOM node behind it is described as little as a landmark with
    // none, so no render can mark it and counting it would report an omission the
    // agent has no ref to reach.
    if (control.backendId === undefined) continue;
    const ref = `e${control.backendId}`;
    if (rendered.has(ref) || hidden.has(ref)) continue;
    if (inScope && inScope.has(control.nodeId)) {
      countIn(droppedInside, control);
      continue;
    }
    countIn(snapshot.enclosingLandmark(control.nodeId, listed) || elsewhere, control);
  }
  // A landmark outside the rendered subtree is listed even when it holds nothing, so
  // the agent can expand it by ref. Under BODY there is no subtree to be outside of,
  // so a landmark gets a line only when something under it was left out: a control
  // Readability dropped, or one the clone walk skipped.
  const landmarks = [...listed.values()].filter((l) => inScope || l.links + l.buttons + l.other > 0);
  return {
    landmarks: landmarks.slice(0, MAX_LANDMARKS),
    more: Math.max(0, landmarks.length - MAX_LANDMARKS),
    elsewhere,
    droppedInside,
    framesNotRead: [...unreadFrames],
  };
}

// The node ids inside what rendered: the root's subtree, none under NOTHING, and no set
// at all under BODY, where there is no containment left to decide.
function subtreeOf(snapshot, root) {
  if (root === BODY) return null;
  return root === NOTHING ? new Set() : snapshot.subtree(root);
}

function roleOf(node) {
  return node.role ? node.role.value : null;
}

function nameOf(node) {
  return node.name ? node.name.value : '';
}

function propertiesOf(node) {
  const properties = {};
  for (const { name, value } of node.properties || []) properties[name] = value ? value.value : undefined;
  return properties;
}

// A contenteditable region is a control Chrome reports as a generic node with an
// editable property; every other control has a role of its own.
function isControl(role, properties) {
  return CONTROL_ROLES.has(role) || properties.editable !== undefined;
}

// The state words a marker carries, in the order it prints them.
function stateOf(properties) {
  const words = [];
  if (properties.checked === 'true') words.push('checked');
  if (properties.checked === 'mixed' || properties.pressed === 'mixed') words.push('mixed');
  if (properties.selected === true) words.push('selected');
  if (properties.pressed === 'true') words.push('pressed');
  if (properties.expanded === true) words.push('expanded');
  if (properties.expanded === false) words.push('collapsed');
  if (properties.required === true) words.push('required');
  if (properties.readonly === true) words.push('readonly');
  if (properties.disabled === true) words.push('disabled');
  return words;
}

// Chrome reports 0 for both bounds of a spinbutton the page left unbounded, which a
// marker would print as the range (0–0); a range says something only when its bounds
// differ.
function rangeOf(properties) {
  const { valuemin: min, valuemax: max } = properties;
  return typeof min === 'number' && typeof max === 'number' && min < max ? { min, max } : null;
}

// Adds an option to a combobox or listbox, which renders its options as its value
// list: `kept` holds up to MAX_KEPT_OPTIONS of them with the DOM node behind each, for
// the markers and for the ref set, and `total` counts them all.
function addOption(control, name, backendId) {
  if (!control.options) control.options = { total: 0, kept: [] };
  control.options.total += 1;
  if (control.options.kept.length < MAX_KEPT_OPTIONS) control.options.kept.push({ name, backendId });
}

function counts() {
  return { links: 0, buttons: 0, other: 0 };
}

function countIn(bucket, control) {
  if (control.role === 'link') bucket.links += 1;
  else if (control.role === 'button') bucket.buttons += 1;
  else bucket.other += 1;
}

module.exports = { Snapshot, resolveScope, omissions, blockOverlays, BODY, NOTHING, DIALOG_ROLES, OPTION_OWNERS };
