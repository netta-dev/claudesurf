// Runs in the browser, spliced into walk.js and click.js at their include marker
// (action-support.js does the splice). Never require() this file.
//
// The one definition of an element's disabled and hidden state, so a read and a
// click agree on it. Hidden is a failed checkVisibility, an empty rect (either
// dimension zero), or an aria-hidden ancestor, shadow hosts included; offscreen
// elements count as visible.
function claudesurfState(el) {
  function hiddenByAria(node) {
    for (let n = node; n; n = n.parentElement || (n.getRootNode() instanceof ShadowRoot ? n.getRootNode().host : null)) {
      if (n.getAttribute && n.getAttribute('aria-hidden') === 'true') return true;
    }
    return false;
  }
  const disabled = el.disabled === true || el.getAttribute('aria-disabled') === 'true' || Boolean(el.closest('fieldset:disabled'));
  const rect = el.getBoundingClientRect();
  const hidden = !el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })
    || rect.width === 0 || rect.height === 0
    || hiddenByAria(el);
  return { disabled, hidden };
}
