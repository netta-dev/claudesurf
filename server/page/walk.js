// Runs in the browser, in the page's isolated world; sent as source by region.js.
// Never require() this file.
//
// Collects the interactive elements of the document, descending open shadow roots,
// and returns a summary by value. The element objects are stashed on the
// world's global so the daemon can read their handles with one Runtime.getProperties.
//
// Under `hiddenOnly` it collects the hidden elements alone, what the accessibility tree
// keeps but a read leaves out and what Chrome prunes from the tree altogether, and
// leaves the page text empty. `labelMax` is the daemon's cap on a label.
function claudesurfWalk(hiddenOnly, labelMax) {
  const SELECTOR = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [contenteditable=true], [role]';
  const ROLES = new Set([
    'button', 'link', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'checkbox',
    'radio', 'switch', 'option', 'combobox', 'listbox', 'textbox', 'searchbox', 'slider',
    'spinbutton', 'treeitem',
  ]);

  function collect(root, out) {
    for (const el of root.querySelectorAll(SELECTOR)) {
      const role = el.getAttribute('role');
      if (role !== null && !ROLES.has(role) && !el.matches('a[href], button, input, select, textarea, summary, [contenteditable=true]')) continue;
      out.push(el);
    }
    const all = root.querySelectorAll('*');
    for (const el of all) if (el.shadowRoot) collect(el.shadowRoot, out);
  }

  function kindOf(el) {
    const role = el.getAttribute('role');
    if (role && ROLES.has(role)) return role;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return 'button';
      if (type === 'checkbox' || type === 'radio') return type;
      return 'textbox';
    }
    if (tag === 'textarea' || el.isContentEditable) return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'summary' || tag === 'button') return 'button';
    // What is left of collect()'s [contenteditable=true] arm: an SVG element carrying
    // that attribute has no isContentEditable at all, so the chain above runs off its
    // end. The word is fixed rather than the tag name, which the page sets, so this
    // branch and any added later cannot print page text as a kind.
    return 'element';
  }

  // A label and a URL are the page's to write, and the two characters the read's
  // renderer reserves — the NUL that delimits its frame placeholder and the filler it
  // pads a blank control with — are the two the daemon strips from every payload.
  const plain = (value) => (value || '').replace(/[\0\uE000]/g, '');

  function text(s) { return plain(s).replace(/\s+/g, ' ').trim(); }

  const escapeField = (value) => value.replace(/[\\[\]]/g, '\\$&');

  function labelOf(el) {
    const candidates = [];
    candidates.push(el.getAttribute('aria-label'));
    const by = el.getAttribute('aria-labelledby');
    if (by) candidates.push(by.split(/\s+/).map((id) => { const n = el.getRootNode().getElementById ? el.getRootNode().getElementById(id) : document.getElementById(id); return n ? n.innerText : ''; }).join(' '));
    if (el.labels && el.labels.length) candidates.push(Array.from(el.labels).map((l) => l.innerText).join(' '));
    candidates.push(el.innerText);
    const img = el.querySelector && el.querySelector('img[alt]');
    if (img) candidates.push(img.getAttribute('alt'));
    candidates.push(el.getAttribute('title'));
    candidates.push(el.getAttribute('placeholder'));
    if (el.tagName === 'INPUT' || el.tagName === 'SELECT') candidates.push(claudesurfMasked(el) ? CLAUDESURF_MASK : el.value);
    for (const c of candidates) {
      const t = text(c);
      // Cut with an ellipsis, as every other capped field is, then escaped the way the
      // daemon escapes a name at its cap: the hidden list brackets a ref onto each
      // line, and a `]` in a label would close it and leave a marker for a ref the page
      // does not own. The escape follows the cut, so the cap still counts the
      // characters the page wrote.
      if (t) return escapeField(cap(t));
    }
    return '';
  }

  function cap(t) {
    if (t.length <= labelMax) return t;
    // The cut never lands between the halves of a surrogate pair, whose lone half
    // renders as a replacement character; action-support.js holds the daemon's copy.
    const end = labelMax - 1;
    const code = t.charCodeAt(end);
    return `${t.slice(0, code >= 0xdc00 && code <= 0xdfff ? end - 1 : end)}…`;
  }

  // @include state.js

  function checkedOf(el) {
    if (typeof el.checked === 'boolean') return el.checked;
    const aria = el.getAttribute('aria-checked') || el.getAttribute('aria-selected') || el.getAttribute('aria-pressed');
    return aria === 'true';
  }

  const found = [];
  collect(document, found);
  // One state per element: reading it costs a layout call, and the filter below and the
  // summary read the same answer.
  const states = new Map(found.map((el) => [el, claudesurfState(el)]));
  const elements = hiddenOnly ? found.filter((el) => claudesurfSkipped(states.get(el))) : found;
  globalThis.__claudesurfElements = elements;
  const summary = elements.map((el) => {
    const state = states.get(el);
    return {
      kind: kindOf(el),
      label: labelOf(el),
      href: el.tagName === 'A' ? plain(el.href) : undefined,
      disabled: state.disabled,
      checked: checkedOf(el),
      visible: !claudesurfSkipped(state),
    };
  });
  return {
    url: location.href,
    title: document.title,
    text: hiddenOnly ? '' : (document.body ? document.body.innerText : ''),
    elements: summary,
  };
}
