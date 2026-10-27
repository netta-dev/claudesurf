// Runs in the browser, in the isolated world of the element's frame with `this` bound
// to the element; sent as source by input.js for `select`. Never require() this file.
//
// Chooses the option of a native <select> that `option` names: the first whose label
// equals it, else the first whose value does, else the one whose label equals it
// ignoring case. Labels are compared with their whitespace collapsed; values are compared exactly.
// Every other option is deselected, a `multiple` select's included, and `input` then
// `change` are dispatched, as a choice by hand does. Answers { state: 'ok' |
// 'detached' | 'not-select' | 'disabled' | 'option-disabled' | 'no-match' }; the
// answer leaves out what the page wrote.
function claudesurfSelect(option) {
  // @include state.js
  // @include collapse.js
  const el = this;
  if (!(el instanceof Element) || !el.isConnected) return { state: 'detached' };
  if (!(el instanceof HTMLSelectElement)) return { state: 'not-select' };
  if (claudesurfState(el).disabled) return { state: 'disabled' };

  const wanted = claudesurfCollapse(option);
  const options = [...el.options];
  const folded = options.filter((o) => claudesurfCollapse(o.label).toLowerCase() === wanted.toLowerCase());
  const match = options.find((o) => claudesurfCollapse(o.label) === wanted)
    || options.find((o) => o.value === option)
    || (folded.length === 1 ? folded[0] : null);
  if (!match) return { state: 'no-match' };
  const group = match.parentElement;
  if (match.disabled || (group instanceof HTMLOptGroupElement && group.disabled)) return { state: 'option-disabled' };

  for (const o of options) o.selected = o === match;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { state: 'ok' };
}
