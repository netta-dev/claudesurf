// The key grammar of `press`, loaded by both processes: the bridge refuses a malformed
// list before the daemon sees it, and the daemon turns each press into the protocol's
// key events, and the action log reads which presses type a character.
//
// A list is up to 16 presses separated by spaces. A press is an optional run of
// modifiers joined to one key by `+`: a named key, case-insensitive, or one character,
// case-sensitive. `+` is written as a press's last character (`Control++`), and a space
// as `Space`. Codes and virtual key codes follow the US layout.

const MAX_PRESSES = 16;

// The protocol's modifier bits, and the key that each modifier's own events carry.
const MODIFIERS = {
  Alt: { bit: 1, code: 'AltLeft', keyCode: 18 },
  Control: { bit: 2, code: 'ControlLeft', keyCode: 17 },
  Meta: { bit: 4, code: 'MetaLeft', keyCode: 91 },
  Shift: { bit: 8, code: 'ShiftLeft', keyCode: 16 },
};
const MODIFIER_NAMES = { alt: 'Alt', control: 'Control', ctrl: 'Control', meta: 'Meta', shift: 'Shift' };

// Each named key's DOM key, code, virtual key code, and the text that its keyDown carries.
const NAMED = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
};
for (let n = 1; n <= 12; n++) NAMED[`F${n}`] = { key: `F${n}`, code: `F${n}`, keyCode: 111 + n };
const NAMED_BY_LOWER = new Map(Object.keys(NAMED).map((name) => [name.toLowerCase(), name]));

// The US-layout key that each digit and punctuation character sits on, unshifted and
// shifted, with that key's code and virtual key code.
const PUNCTUATION = [
  ['`~', 'Backquote', 192], ['-_', 'Minus', 189], ['=+', 'Equal', 187], ['[{', 'BracketLeft', 219],
  [']}', 'BracketRight', 221], ['\\|', 'Backslash', 220], [';:', 'Semicolon', 186], ['\'"', 'Quote', 222],
  [',<', 'Comma', 188], ['.>', 'Period', 190], ['/?', 'Slash', 191],
  ['1!', 'Digit1', 49], ['2@', 'Digit2', 50], ['3#', 'Digit3', 51], ['4$', 'Digit4', 52], ['5%', 'Digit5', 53],
  ['6^', 'Digit6', 54], ['7&', 'Digit7', 55], ['8*', 'Digit8', 56], ['9(', 'Digit9', 57], ['0)', 'Digit0', 48],
];
const CHARACTER_KEYS = new Map();
for (const [chars, code, keyCode] of PUNCTUATION) for (const c of chars) CHARACTER_KEYS.set(c, { code, keyCode });
for (let c = 65; c <= 90; c++) {
  const key = { code: `Key${String.fromCharCode(c)}`, keyCode: c };
  CHARACTER_KEYS.set(String.fromCharCode(c), key);
  CHARACTER_KEYS.set(String.fromCharCode(c + 32), key);
}

// Parses a key list into its presses, each { key, code, keyCode, text, modifiers,
// printable }: `modifiers` the modifier names in the order written, `text` what the
// keyDown types (undefined for none), and `printable` whether the press types a
// character: one character or Space, outside a chord with Control, Alt, or Meta.
// Throws an Error whose message continues "keys …", naming what is wrong.
function parseKeys(text) {
  const presses = typeof text === 'string' ? text.trim().split(/\s+/).filter(Boolean) : [];
  if (!presses.length) throw new Error('must name at least one key, e.g. "Enter" or "Control+a"');
  if (presses.length > MAX_PRESSES) throw new Error(`holds ${presses.length} presses; the limit is ${MAX_PRESSES}`);
  return presses.map(parsePress);
}

function parsePress(press) {
  // `+` alone, or after the `+` that joins it to its modifiers, is the plus key.
  let keyName;
  let modifierPart;
  if (press === '+' || press.endsWith('++')) {
    keyName = '+';
    modifierPart = press.slice(0, -2);
  } else {
    const at = press.lastIndexOf('+');
    keyName = press.slice(at + 1);
    modifierPart = at < 0 ? '' : press.slice(0, at);
  }
  const modifiers = [];
  for (const name of modifierPart ? modifierPart.split('+') : []) {
    const modifier = MODIFIER_NAMES[name.toLowerCase()];
    if (!modifier) throw new Error(`has an unknown modifier ${JSON.stringify(name)} in ${JSON.stringify(press)}; modifiers are Control, Shift, Alt, and Meta`);
    if (!modifiers.includes(modifier)) modifiers.push(modifier);
  }
  // Shift with a letter of any script gives its uppercase, as a keyboard does, unless
  // that is more than one character (ß gives SS); any other character keeps what was
  // written, since its shifted form depends on the layout.
  const upper = keyName.toUpperCase();
  const shifted = modifiers.includes('Shift') && /^\p{L}$/u.test(keyName) && [...upper].length === 1;
  const key = keyOf(shifted ? upper : keyName, press);
  const chord = modifiers.some((m) => m !== 'Shift');
  // A chord doesn't type, so its key goes as a rawKeyDown without text; Enter's \r is
  // a key's text, though Enter doesn't type a character.
  const typed = chord ? undefined : key.text;
  const printable = typed !== undefined && typed !== '\r';
  return { key: key.key, code: key.code, keyCode: key.keyCode, text: typed, modifiers, printable };
}

function keyOf(name, press) {
  const named = NAMED_BY_LOWER.get(name.toLowerCase());
  if (named) return NAMED[named];
  if ([...name].length === 1) {
    const known = CHARACTER_KEYS.get(name) || { code: '', keyCode: 0 };
    return { key: name, code: known.code, keyCode: known.keyCode, text: name };
  }
  const what = name ? `an unknown key ${JSON.stringify(name)}` : `a press ${JSON.stringify(press)} with no key after its last "+" (the plus key is written Control++)`;
  throw new Error(`has ${what}; a key is one character or one of Enter, Tab, Escape, Backspace, Delete, Space, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home, End, PageUp, PageDown, Insert, and F1 to F12`);
}

// Returns the Input.dispatchKeyEvent parameters for one parsed press, in order: a
// rawKeyDown per modifier, the key's keyDown (with text) or rawKeyDown (without), its
// keyUp, and the modifiers' keyUps in reverse. Each event carries the modifier bits
// held at that point.
function keyEvents(press) {
  const events = [];
  let held = 0;
  for (const name of press.modifiers) {
    const modifier = MODIFIERS[name];
    held |= modifier.bit;
    events.push({ type: 'rawKeyDown', key: name, code: modifier.code, windowsVirtualKeyCode: modifier.keyCode, modifiers: held });
  }
  const own = { key: press.key, code: press.code, windowsVirtualKeyCode: press.keyCode, modifiers: held };
  events.push(press.text === undefined
    ? { type: 'rawKeyDown', ...own }
    : { type: 'keyDown', ...own, text: press.text, unmodifiedText: press.text });
  events.push({ type: 'keyUp', ...own });
  for (const name of [...press.modifiers].reverse()) {
    const modifier = MODIFIERS[name];
    held &= ~modifier.bit;
    events.push({ type: 'keyUp', key: name, code: modifier.code, windowsVirtualKeyCode: modifier.keyCode, modifiers: held });
  }
  return events;
}

module.exports = { parseKeys, keyEvents, MAX_PRESSES };
