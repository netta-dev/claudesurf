// Runs in the browser, in the page's isolated world; sent as source by read.js.
// Never require() this file.
//
// Collects the interactive elements of the document, descending open shadow roots,
// and returns a summary by value. The element objects are stashed on the
// world's global so the daemon can read their handles with one Runtime.getProperties.
function claudesurfWalk() {
  const SELECTOR = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [contenteditable=true], [role]';
  const ROLES = new Set(['button', 'link', 'tab', 'menuitem', 'checkbox', 'radio', 'switch', 'option', 'combobox', 'textbox']);
  const LABEL_MAX = 100;

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
    if (tag === 'summary') return 'button';
    return tag;
  }

  function text(s) { return (s || '').replace(/\s+/g, ' ').trim(); }

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
    if (el.tagName === 'INPUT' || el.tagName === 'SELECT') candidates.push(el.value);
    for (const c of candidates) {
      const t = text(c);
      if (t) return t.length > LABEL_MAX ? t.slice(0, LABEL_MAX) : t;
    }
    return '';
  }

  // @include state.js

  function checkedOf(el) {
    if (typeof el.checked === 'boolean') return el.checked;
    const aria = el.getAttribute('aria-checked') || el.getAttribute('aria-selected') || el.getAttribute('aria-pressed');
    return aria === 'true';
  }

  const elements = [];
  collect(document, elements);
  globalThis.__claudesurfElements = elements;
  const summary = elements.map((el) => {
    const state = claudesurfState(el);
    return {
      kind: kindOf(el),
      label: labelOf(el),
      href: el.tagName === 'A' ? el.href : undefined,
      disabled: state.disabled,
      checked: checkedOf(el),
      visible: !state.hidden,
    };
  });
  return {
    url: location.href,
    title: document.title,
    text: document.body ? document.body.innerText : '',
    elements: summary,
  };
}
