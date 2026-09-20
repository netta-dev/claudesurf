const { test } = require('node:test');
const assert = require('node:assert');
const { assemblePage } = require('../server/read');
const { OutcomeError } = require('../server/action-support');

// A walk summary as the page script returns it, with one ref per element.
function fixture() {
  const summary = {
    url: 'https://example.com/long',
    title: 'Long page',
    text: 'First paragraph.\nSecond paragraph with emoji \u{1F600} inside.',
    elements: [
      { kind: 'link', label: 'Sign in', href: 'https://example.com/login', disabled: false, checked: false, visible: true },
      { kind: 'button', label: 'Search', disabled: true, checked: false, visible: true },
      { kind: 'checkbox', label: 'Remember me', disabled: false, checked: true, visible: true },
      { kind: 'link', label: 'Skip', href: 'https://example.com/#main', disabled: false, checked: false, visible: false },
    ],
  };
  return { summary, refs: [12, 13, 14, 15] };
}

const HEADER = 'URL: https://example.com/long\nTitle: Long page';

test('a page that fits: header, blank line, body, blank line, elements with markers', () => {
  const { summary, refs } = fixture();
  const { payload } = assemblePage(summary, refs, { maxChars: 40000, offset: 0, hidden: false });
  assert.strictEqual(payload, [
    HEADER,
    '',
    summary.text,
    '',
    '## Interactive elements (3 visible, 1 hidden)',
    '[e12] link "Sign in" → https://example.com/login',
    '[e13] button "Search" (disabled)',
    '[e14] checkbox "Remember me" (checked)',
  ].join('\n'));
});

test('hidden=true lists hidden elements marked (hidden)', () => {
  const { summary, refs } = fixture();
  const { payload } = assemblePage(summary, refs, { maxChars: 40000, offset: 0, hidden: true });
  assert.match(payload, /\[e15\] link "Skip" → https:\/\/example\.com\/#main \(hidden\)$/);
  assert.match(payload, /## Interactive elements \(3 visible, 1 hidden\)/);
});

test('a cut inside the body drops the elements section and says where they start', () => {
  const { summary, refs } = fixture();
  const { payload } = assemblePage(summary, refs, { maxChars: 20, offset: 0, hidden: false });
  const region = `\n${summary.text}\n\n`;
  assert.strictEqual(payload, [
    HEADER,
    `[Showing characters 0–20 of ${region.length + 45 + 1 + 48 + 1 + 32 + 1 + 38}; 0 of 3 visible elements (1 hidden) shown; they start at offset ${region.length}. Pass offset=20 for the next part.]`,
    region.slice(0, 20),
  ].join('\n'));
  assert.ok(!payload.includes('## Interactive'), 'elements section absent');
});

test('a cut inside the body snaps back to a code-point boundary', () => {
  const { summary, refs } = fixture();
  const region = `\n${summary.text}`;
  const emojiAt = region.indexOf('\u{1F600}');
  const { payload, end } = assemblePage(summary, refs, { maxChars: emojiAt + 1, offset: 0, hidden: false });
  assert.strictEqual(end, emojiAt, 'cut moved before the surrogate pair');
  assert.ok(!/[\uD800-\uDBFF]$/.test(payload), 'payload does not end on a lone high surrogate');
  const next = assemblePage(summary, refs, { maxChars: 4, offset: end, hidden: false });
  assert.ok(next.payload.endsWith('\u{1F600} i'), 'continuation starts with the whole emoji');
});

test('a cut inside the elements section ends on a whole element line', () => {
  const { summary, refs } = fixture();
  const elementsStart = `\n${summary.text}\n\n`.length;
  const headingEnd = elementsStart + '## Interactive elements (3 visible, 1 hidden)'.length;
  // Room for the heading and the first line plus half of the second.
  const { payload, shown } = assemblePage(summary, refs, { maxChars: headingEnd + 1 + 48 + 20, offset: 0, hidden: false });
  assert.strictEqual(shown, 1);
  const lines = payload.split('\n');
  assert.strictEqual(lines.at(-1), '[e12] link "Sign in" → https://example.com/login');
  assert.match(lines[2], /^\[Showing characters 0–\d+ of \d+; 1 of 3 visible elements \(1 hidden\) shown\. Pass offset=\d+ for the next part\.\]$/);
  assert.ok(!lines[2].includes('they start at'), 'no start offset when the elements are showing');
});

test('an offset into the elements section shows the remaining lines and reports no further cut', () => {
  const { summary, refs } = fixture();
  const region = `\n${summary.text}\n\n## Interactive elements (3 visible, 1 hidden)\n[e12] link "Sign in" → https://example.com/login\n`;
  const { payload, shown } = assemblePage(summary, refs, { maxChars: 40000, offset: region.length, hidden: false });
  assert.strictEqual(shown, 2);
  const lines = payload.split('\n');
  assert.match(lines[2], /^\[Showing characters \d+–\d+ of \d+; 2 of 3 visible elements \(1 hidden\) shown\.\]$/);
  assert.deepStrictEqual(lines.slice(3), ['[e13] button "Search" (disabled)', '[e14] checkbox "Remember me" (checked)']);
});

test('a max_chars too small for one element line still delivers a whole line', () => {
  const { summary, refs } = fixture();
  const elementsStart = `\n${summary.text}\n\n`.length;
  const { payload } = assemblePage(summary, refs, { maxChars: 5, offset: elementsStart, hidden: false });
  assert.ok(payload.endsWith('## Interactive elements (3 visible, 1 hidden)'));
});

test('an offset past the end is an error', () => {
  const { summary, refs } = fixture();
  assert.throws(() => assemblePage(summary, refs, { maxChars: 10, offset: 10000, hidden: false }), (e) => e instanceof OutcomeError && e.envelope.outcome === 'error' && /past the end/.test(e.envelope.message));
});
