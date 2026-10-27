// Runs in the browser, spliced into the page scripts at their include marker
// (action-support.js does the splice). Never require() this file.
//
// Returns `text` with each run of whitespace collapsed to one space and the ends
// trimmed; missing text is the empty string.
function claudesurfCollapse(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}
