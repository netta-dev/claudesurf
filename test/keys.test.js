// keys.js: the press grammar that both processes validate with, and the key events that
// a press becomes.

const { test } = require('node:test');
const assert = require('node:assert');
const { parseKeys, keyEvents } = require('../server/keys');

test('each named key parses case-insensitively to its key, code, and virtual key code', () => {
  const named = {
    Enter: ['Enter', 13], Tab: ['Tab', 9], Escape: ['Escape', 27], Backspace: ['Backspace', 8], Delete: ['Delete', 46],
    ArrowUp: ['ArrowUp', 38], ArrowDown: ['ArrowDown', 40], ArrowLeft: ['ArrowLeft', 37], ArrowRight: ['ArrowRight', 39],
    Home: ['Home', 36], End: ['End', 35], PageUp: ['PageUp', 33], PageDown: ['PageDown', 34], Insert: ['Insert', 45],
  };
  for (let n = 1; n <= 12; n++) named[`F${n}`] = [`F${n}`, 111 + n];
  for (const [name, [code, keyCode]] of Object.entries(named)) {
    for (const written of [name, name.toLowerCase(), name.toUpperCase()]) {
      const [press] = parseKeys(written);
      assert.deepStrictEqual({ key: press.key, code: press.code, keyCode: press.keyCode }, { key: name, code, keyCode }, written);
      assert.strictEqual(press.printable, false, `${written} types no character`);
    }
  }
});

test('a character is its own key, case-sensitive, with the US-layout code, and types itself', () => {
  const [lower, upper, digit, bang, accented] = parseKeys('a A 1 ! é');
  assert.deepStrictEqual(lower, { key: 'a', code: 'KeyA', keyCode: 65, text: 'a', modifiers: [], printable: true });
  assert.deepStrictEqual(upper, { key: 'A', code: 'KeyA', keyCode: 65, text: 'A', modifiers: [], printable: true });
  assert.deepStrictEqual(digit, { key: '1', code: 'Digit1', keyCode: 49, text: '1', modifiers: [], printable: true });
  assert.deepStrictEqual(bang, { key: '!', code: 'Digit1', keyCode: 49, text: '!', modifiers: [], printable: true });
  assert.deepStrictEqual(accented, { key: 'é', code: '', keyCode: 0, text: 'é', modifiers: [], printable: true }, 'a character off the US layout still types');
});

test('modifiers parse in any case and order, keep the order written, and make a chord that doesn\'t type text', () => {
  const [first, second, third] = parseKeys('ctrl+SHIFT+z Shift+Control+z ALT+Tab');
  assert.deepStrictEqual(first.modifiers, ['Control', 'Shift']);
  assert.deepStrictEqual(second.modifiers, ['Shift', 'Control']);
  assert.deepStrictEqual(third.modifiers, ['Alt']);
  assert.strictEqual(first.key, 'Z', 'Shift held makes the letter uppercase, in a chord too');
  assert.strictEqual(first.text, undefined, 'a Control chord carries no text');
  assert.strictEqual(first.printable, false);
  const [meta, alt] = parseKeys('Meta+a Alt+a');
  assert.strictEqual(meta.printable, false, 'nor does a Meta chord');
  assert.deepStrictEqual([alt.text, alt.printable], [undefined, false], 'nor an Alt chord');
  const [shifted] = parseKeys('Shift+a');
  assert.strictEqual(shifted.printable, true, 'Shift alone still types');
});

test('Shift with a letter types the uppercase letter, as a keyboard does, and with any other character types it as written', () => {
  const [letter, digit] = parseKeys('Shift+a Shift+1');
  assert.deepStrictEqual(letter, { key: 'A', code: 'KeyA', keyCode: 65, text: 'A', modifiers: ['Shift'], printable: true });
  assert.deepStrictEqual(digit, { key: '1', code: 'Digit1', keyCode: 49, text: '1', modifiers: ['Shift'], printable: true });
  assert.deepStrictEqual(keyEvents(letter)[1], { type: 'keyDown', key: 'A', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 8, text: 'A', unmodifiedText: 'A' });
});

test('Shift with a letter outside ASCII types its uppercase too, and a letter whose uppercase is two letters types as written', () => {
  const [accented, cyrillic, sharp] = parseKeys('Shift+é Shift+ж Shift+ß');
  assert.deepStrictEqual(accented, { key: 'É', code: '', keyCode: 0, text: 'É', modifiers: ['Shift'], printable: true });
  assert.strictEqual(cyrillic.text, 'Ж');
  assert.strictEqual(sharp.text, 'ß', 'one press types one character, so ß does not become SS');
});

test('the plus key is written last, and a space as Space', () => {
  assert.deepStrictEqual(parseKeys('Control++')[0], { key: '+', code: 'Equal', keyCode: 187, text: undefined, modifiers: ['Control'], printable: false });
  assert.deepStrictEqual(parseKeys('+')[0], { key: '+', code: 'Equal', keyCode: 187, text: '+', modifiers: [], printable: true });
  assert.deepStrictEqual(parseKeys('Space')[0], { key: ' ', code: 'Space', keyCode: 32, text: ' ', modifiers: [], printable: true }, 'Space types a character');
  assert.throws(() => parseKeys('Control+'), /^Error: has a press "Control\+" with no key after its last "\+" \(the plus key is written Control\+\+\)/);
});

test('sixteen presses are accepted and seventeen refused', () => {
  assert.strictEqual(parseKeys(Array(16).fill('Tab').join(' ')).length, 16);
  assert.throws(() => parseKeys(Array(17).fill('Tab').join(' ')), /^Error: holds 17 presses; the limit is 16$/);
  assert.throws(() => parseKeys('  '), /^Error: must name at least one key/);
});

test('an unknown key or modifier is named in the message', () => {
  assert.throws(() => parseKeys('Enter Foo'), /^Error: has an unknown key "Foo"; a key is one character or one of Enter, Tab/);
  assert.throws(() => parseKeys('Hyper+a'), /^Error: has an unknown modifier "Hyper" in "Hyper\+a"; modifiers are Control, Shift, Alt, and Meta$/);
});

test('Shift+Tab: the modifier down, the key down without text, the key up, the modifier up', () => {
  assert.deepStrictEqual(keyEvents(parseKeys('Shift+Tab')[0]), [
    { type: 'rawKeyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 8 },
    { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 },
    { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 },
    { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 0 },
  ]);
});

test('Control+a doesn\'t send text, and the modifier bits follow what is held', () => {
  assert.deepStrictEqual(keyEvents(parseKeys('Control+Shift+a')[0]), [
    { type: 'rawKeyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 2 },
    { type: 'rawKeyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 10 },
    { type: 'rawKeyDown', key: 'A', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 10 },
    { type: 'keyUp', key: 'A', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 10 },
    { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 2 },
    { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 0 },
  ]);
  const [down] = keyEvents(parseKeys('Control+a')[0]).filter((e) => e.key === 'a');
  assert.deepStrictEqual(down, { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
});

test('Alt and Meta carry their own bits, codes, and virtual key codes', () => {
  assert.deepStrictEqual(keyEvents(parseKeys('Alt+Meta+x')[0]), [
    { type: 'rawKeyDown', key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18, modifiers: 1 },
    { type: 'rawKeyDown', key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91, modifiers: 5 },
    { type: 'rawKeyDown', key: 'x', code: 'KeyX', windowsVirtualKeyCode: 88, modifiers: 5 },
    { type: 'keyUp', key: 'x', code: 'KeyX', windowsVirtualKeyCode: 88, modifiers: 5 },
    { type: 'keyUp', key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91, modifiers: 1 },
    { type: 'keyUp', key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18, modifiers: 0 },
  ]);
});

test('a modifier written twice, under either spelling, is held once', () => {
  const [press] = parseKeys('Control+ctrl+CONTROL+a');
  assert.deepStrictEqual(press.modifiers, ['Control']);
  assert.deepStrictEqual(keyEvents(press).map((e) => `${e.type} ${e.key}`), ['rawKeyDown Control', 'rawKeyDown a', 'keyUp a', 'keyUp Control']);
});

test('Enter and a printable key go down as keyDown carrying their text, Enter\'s as \\r', () => {
  assert.deepStrictEqual(keyEvents(parseKeys('Enter')[0]), [
    { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 0, text: '\r', unmodifiedText: '\r' },
    { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 0 },
  ]);
  assert.deepStrictEqual(keyEvents(parseKeys('x')[0])[0], { type: 'keyDown', key: 'x', code: 'KeyX', windowsVirtualKeyCode: 88, modifiers: 0, text: 'x', unmodifiedText: 'x' });
});
