// Runs in the browser, spliced into page-side code: at its include marker by
// action-support.js, and into the focus read's expression by focus.js. Never require()
// this file.
//
// Returns the innermost focused element of the document, through open shadow roots;
// the body, or null, when nothing else holds focus.
function claudesurfFocused() {
  let active = document.activeElement;
  while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
  return active;
}
