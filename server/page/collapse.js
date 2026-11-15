// This script runs in the browser. action-support.js inserts it at the page scripts'
// include markers. Do not require() this file.
//
// Returns `text` with runs of whitespace and line breaks, including U+0085, collapsed
// to one space and the ends trimmed. Missing text becomes an empty string.
// action-support.js's SPACES holds the daemon's copy of the rule.
function claudesurfCollapse(text) {
  return (text || '').replace(/[\s\u0085]+/g, ' ').trim();
}
