// Runs in the browser, spliced into the page scripts at their include marker
// (action-support.js does the splice). Never require() this file.
//
// The one definition of an element's disabled and hidden state, so a read and a
// click agree on it. Hidden is a failed checkVisibility, an empty rect (either
// dimension zero), or an aria-hidden ancestor, shadow hosts included; offscreen
// elements count as visible. `boxless` names an element that paints nothing of its own
// — a slot, a display:contents wrapper, a float-only container — and paints through
// its children, which a read walks rather than the element.
function claudesurfState(el) {
  function hiddenByAria(node) {
    // The test reads the node type rather than the class, since the nodes of a
    // same-origin frame's document belong to that frame's realm.
    const host = (n) => {
      const root = n.getRootNode();
      return root.nodeType === Node.DOCUMENT_FRAGMENT_NODE && root.host ? root.host : null;
    };
    for (let n = node; n; n = n.parentElement || host(n)) {
      if (n.getAttribute && n.getAttribute('aria-hidden') === 'true') return true;
    }
    return false;
  }
  const disabled = el.disabled === true || el.getAttribute('aria-disabled') === 'true' || Boolean(el.closest('fieldset:disabled'));
  const rect = el.getBoundingClientRect();
  const aria = hiddenByAria(el);
  const painted = !aria && el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true });
  const empty = rect.width === 0 || rect.height === 0;
  // Two shapes have no box of their own to judge and paint through their children, and
  // the computed style tells each from an element the page hides: a
  // display:contents element, which checkVisibility rejects for want of a layout box as
  // it rejects a display:none one, and an element that paints while measuring empty,
  // which is a float-only container under overflow:visible and a wrapper collapsed to
  // height:0 under an overflow that clips, its children going with it. The style is
  // read for those two alone.
  const style = !aria && (!painted || empty) ? getComputedStyle(el) : null;
  const boxless = Boolean(style) && (painted
    ? style.overflowX === 'visible' && style.overflowY === 'visible'
    : style.display === 'contents');
  return { disabled, hidden: !painted || empty, boxless };
}

// Whether a read leaves an element out: hidden and not boxless, since a boxless one
// paints through its children, which the walk descends and judges instead. The clone
// walk and the hidden walk both ask this, so the render and the hidden list agree
// element for element.
function claudesurfSkipped(state) {
  return state.hidden && !state.boxless;
}

// What a read prints in place of a secret value.
const CLAUDESURF_MASK = '•••';

// The one definition of a field whose value is a secret, so a read prints a mask
// wherever the value would otherwise print: in a marker, and in the label a walk
// falls back to.
function claudesurfMasked(el) {
  if (!el || !el.getAttribute) return false;
  const type = (el.getAttribute('type') || '').toLowerCase();
  const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase();
  return type === 'password' || autocomplete === 'one-time-code';
}
