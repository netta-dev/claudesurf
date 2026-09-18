// Runs in the browser, in the page's isolated world with `this` bound to the element;
// sent as source by input.js. Never require() this file.
//
// mode 'scripted' clicks the element; mode 'prepare' only scrolls it into view for the
// trusted path. Either way the element's state is reported first, so a disabled
// element is refused and a hidden one is named.
function claudesurfClick(mode) {
  const el = this;
  if (!(el instanceof Element)) return { state: 'detached' };
  if (!el.isConnected) return { state: 'detached' };
  const disabled = el.disabled === true || el.getAttribute('aria-disabled') === 'true' || Boolean(el.closest('fieldset:disabled'));
  if (disabled) return { state: 'disabled' };
  const rect = el.getBoundingClientRect();
  const hidden = !el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true }) || (rect.width === 0 && rect.height === 0);
  el.scrollIntoView({ block: 'center', inline: 'nearest' });
  if (mode === 'scripted') el.click();
  return { state: hidden ? 'hidden' : 'ok' };
}
