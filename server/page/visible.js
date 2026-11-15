// This script runs in an isolated world and is sent as source by challenge.js.
// `this` must be a widget's <iframe> or an ancestor frame's <iframe>.
// Ancestor frames are checked without a selector. Do not require() this file.
//
// Returns { visible, field }. `visible` indicates whether the <iframe> is visible
// and measures at least `min` CSS pixels on each side.
// `field` reports nearby response-field states under `selector` (nearest.js),
// or 'absent' when a selector isn't supplied.
function claudesurfVisible(selector, min) {
  // @include state.js
  // @include nearest.js
  const rect = this.getBoundingClientRect();
  const visible = !claudesurfState(this).hidden && rect.width >= min && rect.height >= min;
  return { visible, field: selector ? claudesurfNearestField(this, selector) : 'absent' };
}
