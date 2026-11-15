// This script runs in the main frame's isolated world and is sent as source by
// challenge.js. Do not require() this file.
//
// Returns { title, password, px, twoFactor, frames } after scanning the document, its
// open shadow roots, and the documents of its same-origin child frames. A child frame
// is scanned when its <iframe> or <frame> meets the field rule below.
// `password` reports a matching password field, and `px` reports a matching HUMAN
// press-and-hold element (#px-captcha). `twoFactor` identifies 'one-time-code',
// 'verification-code', or 'code-boxes', or is null.
// A field counts when it is visible, measures at least `fieldMin` CSS pixels on each
// side, and extends right of and below its document's origin. Pages can place autofill
// honeypots outside that area. #px-captcha must be visible and measure at least
// `widgetMin` on each side.
// `frames` lists visible http(s) <iframe> and <frame> elements that measure at least
// `widgetMin` on each side, regardless of origin. Each entry is { src, fields };
// `fields` maps `selectors` to nearby response-field states (nearest.js).
function claudesurfDetect({ fieldMin, widgetMin, selectors }) {
  // @include state.js
  // @include nearest.js
  const CODE_PREFIXES = ['otp', '2fa', 'mfa', 'totp'];
  const CODE_RUNS = ['one time', 'two factor', 'two step', 'verification code', 'authentication code', 'sign in code'];
  const EXCLUDED = new Set(['postal', 'zip', 'card', 'cvc', 'cvv', 'csc', 'promo', 'coupon', 'gift']);
  const NUMERIC_TYPES = new Set(['text', 'tel', 'number']);
  const CODE_LENGTH_MIN = 4;
  const CODE_LENGTH_MAX = 8;
  const BOXES_MIN = 4;
  const BOXES_MAX = 8;

  const inputs = [];
  const frames = [];
  let px = false;
  const walk = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (el.tagName === 'INPUT') inputs.push(el);
      if (el.id === 'px-captcha' && !px) px = measures(el, widgetMin);
      if (el.shadowRoot) walk(el.shadowRoot);
      if (el.tagName !== 'IFRAME' && el.tagName !== 'FRAME') continue;
      if (/^https?:/i.test(el.src) && measures(el, widgetMin)) {
        frames.push({ src: el.src, fields: Object.fromEntries(selectors.map((selector) => [selector, claudesurfNearestField(el, selector)])) });
      }
      if (counts(el)) {
        let inner = null;
        try { inner = el.contentDocument; } catch { inner = null; }
        if (inner) walk(inner);
      }
    }
  };

  function measures(el, min) {
    const rect = el.getBoundingClientRect();
    return !claudesurfState(el).hidden && rect.width >= min && rect.height >= min;
  }

  function counts(el) {
    if (!measures(el, fieldMin)) return false;
    const rect = el.getBoundingClientRect();
    const view = el.ownerDocument.defaultView;
    return rect.right + (view ? view.scrollX : 0) > 0 && rect.bottom + (view ? view.scrollY : 0) > 0;
  }

  function words(...texts) {
    return texts.join(' ').replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  }

  function namesCode(list) {
    if (list.some((word) => word === 'passcode' || CODE_PREFIXES.some((prefix) => word.startsWith(prefix)))) return true;
    const joined = ` ${list.join(' ')} `;
    return CODE_RUNS.some((run) => joined.includes(` ${run} `));
  }

  function excludedAutocomplete(el) {
    return (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/).some((token) => token === 'postal-code' || token.startsWith('cc-'));
  }

  function fieldText(el) {
    const labels = [...(el.labels || [])].map((label) => label.textContent || '');
    return words(el.name || '', el.id || '', el.getAttribute('placeholder') || '', el.getAttribute('aria-label') || '', ...labels);
  }

  function oneTimeCode(el) {
    return (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/).includes('one-time-code');
  }

  function verificationCode(el) {
    const type = (el.type || '').toLowerCase();
    if (!NUMERIC_TYPES.has(type) && (el.getAttribute('inputmode') || '').toLowerCase() !== 'numeric') return false;
    if (type !== 'number' && el.hasAttribute('maxlength') && !(el.maxLength >= CODE_LENGTH_MIN && el.maxLength <= CODE_LENGTH_MAX)) return false;
    const list = fieldText(el);
    return namesCode(list) && !excludedAutocomplete(el) && !list.some((word) => EXCLUDED.has(word));
  }

  function rowText(boxes) {
    let holder = boxes[0].parentElement;
    while (holder && !boxes.every((box) => holder.contains(box))) holder = holder.parentElement;
    const legend = holder && holder.tagName === 'FIELDSET' ? holder.querySelector(':scope > legend') : null;
    const first = boxes[0];
    return words(first.name || '', first.id || '', first.getAttribute('aria-label') || '',
      (holder && holder.getAttribute('aria-label')) || '', legend ? legend.textContent || '' : '');
  }

  // A row's boxes share one document or shadow root, since the walk lists a frame's or a
  // shadow root's inputs between its neighbours in the enclosing tree.
  function codeBoxes(counted) {
    let run = [];
    const closes = () => {
      const ok = run.length >= BOXES_MIN && run.length <= BOXES_MAX
        && !run.some(excludedAutocomplete) && !rowText(run).some((word) => EXCLUDED.has(word));
      run = [];
      return ok;
    };
    for (const el of inputs) {
      const box = el.getAttribute('maxlength') === '1' && counted.has(el);
      if (run.length && (!box || el.getRootNode() !== run[0].getRootNode()) && closes()) return true;
      if (box) run.push(el);
    }
    return closes();
  }

  walk(document);
  const visible = inputs.filter(counts);
  const counted = new Set(visible);
  let twoFactor = null;
  if (visible.some(oneTimeCode)) twoFactor = 'one-time-code';
  else if (visible.some(verificationCode)) twoFactor = 'verification-code';
  else if (codeBoxes(counted)) twoFactor = 'code-boxes';
  const password = visible.some((el) => (el.type || '').toLowerCase() === 'password');
  return { title: document.title, password, px, twoFactor, frames };
}
