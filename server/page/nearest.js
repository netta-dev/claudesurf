// This script runs in the browser. action-support.js inserts it at the page scripts'
// include markers. Do not require() this file.
// The frame-target widget check and the page scan share this definition of nearby
// response fields for a widget's <iframe> or <frame>.
//
// Returns the response-field state within the closest ancestor of `el` containing
// matches for `selector`. The search covers five ancestor levels; a shadow root and
// its host each count as a level. The state is 'filled' when the matching values are
// nonblank, 'empty' when a matching value is blank, and 'absent' without a match.
// The search tests node types rather than classes because nodes from a same-origin
// frame belong to that frame's realm.
function claudesurfNearestField(el, selector) {
  const LEVELS = 5;
  const shadowRoot = (node) => node.nodeType === Node.DOCUMENT_FRAGMENT_NODE && Boolean(node.host);
  let node = el;
  for (let level = 0; level < LEVELS; level++) {
    node = shadowRoot(node) ? node.host : node.parentNode;
    if (!node || !(node.nodeType === Node.ELEMENT_NODE || shadowRoot(node))) break;
    const matches = [...node.querySelectorAll(selector)];
    if (matches.length) return matches.every((match) => String(match.value || '').trim() !== '') ? 'filled' : 'empty';
  }
  return 'absent';
}
