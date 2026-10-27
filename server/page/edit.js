// Runs in the browser, in the isolated world of the element's frame with `this` bound
// to the element; sent as source by input.js for `type`. Never require() this file.
//
// Two steps around the key event that selects the field's content:
//   - 'focus' checks that the element is a text field that can take text and focuses it,
//     answering { state: 'ok' | 'detached' | 'disabled' | 'readonly' | 'not-editable'
//     | 'no-focus', type? }; `type` is an input's or a select's `type`, a value from
//     the browser's fixed set;
//   - 'select', after the key event, checks that the field still holds focus and selects
//     its whole value by script when the selection falls short of it, and every time
//     for an email or number input, answering { state: 'selected' | 'by-script' |
//     'focus-lost' }.
function claudesurfEdit(step) {
  // @include state.js
  // @include focused.js
  // @include collapse.js
  const TEXT_TYPES = ['text', 'search', 'email', 'url', 'tel', 'password', 'number'];
  const el = this;

  // Returns whether the element holds focus. An editable region's focus sits on its
  // editing host, which may be an ancestor of the element that the ref names. The body is
  // the active element when nothing holds focus, and it contains everything, so the
  // host has to be editable itself.
  function holdsFocus() {
    const active = claudesurfFocused();
    const inside = active === el || (el.isContentEditable && Boolean(active) && active.isContentEditable && active.contains(el));
    return inside && document.hasFocus();
  }
  function isInput() { return el instanceof HTMLInputElement; }

  if (step === 'focus') {
    if (!(el instanceof Element) || !el.isConnected) return { state: 'detached' };
    const field = isInput() ? TEXT_TYPES.includes(el.type) : (el instanceof HTMLTextAreaElement || el.isContentEditable);
    if (!field) return { state: 'not-editable', type: isInput() || el instanceof HTMLSelectElement ? el.type : undefined };
    if (claudesurfState(el).disabled) return { state: 'disabled' };
    if ((isInput() || el instanceof HTMLTextAreaElement) && el.readOnly) return { state: 'readonly' };
    el.focus();
    return { state: holdsFocus() ? 'ok' : 'no-focus' };
  }

  if (!holdsFocus()) return { state: 'focus-lost' };
  if (el.isContentEditable && !(isInput() || el instanceof HTMLTextAreaElement)) {
    const selection = getSelection();
    if (claudesurfCollapse(selection.toString()) === claudesurfCollapse(el.innerText)) return { state: 'selected' };
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
    return { state: 'by-script' };
  }
  // An email or number input lacks the selection API, so its selectionStart reads null
  // and its value is selected by script every time.
  if (el.selectionStart === 0 && el.selectionEnd === el.value.length) return { state: 'selected' };
  el.select();
  return { state: 'by-script' };
}
