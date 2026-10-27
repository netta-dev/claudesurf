// diff.js: the line diff that the change summary and `since` print, and its cut.

const { test } = require('node:test');
const assert = require('node:assert');
const { diffLines, formatDiff } = require('../server/diff');

const format = (before, after, options) => formatDiff(diffLines(before, after), options).text;

test('identical input diffs as unchanged and prints nothing', () => {
  const result = diffLines(['a', 'b'], ['a', 'b']);
  assert.deepStrictEqual({ added: result.added, removed: result.removed }, { added: 0, removed: 0 });
  assert.deepStrictEqual(formatDiff(result), { text: '', cut: false });
});

test('an insertion, a deletion, and a replacement each print with one line of context', () => {
  const page = ['# Title', 'one', 'two', 'three', 'four', 'five', 'six', 'seven'];
  assert.strictEqual(format(page, [...page.slice(0, 4), 'inserted', ...page.slice(4)]), '@@\n  three\n+ inserted\n  four');
  assert.strictEqual(format(page, [...page.slice(0, 3), ...page.slice(4)]), '@@\n  two\n- three\n  four');
  const replaced = diffLines(page, [...page.slice(0, 3), 'THREE', 'extra', ...page.slice(4)]);
  assert.deepStrictEqual({ added: replaced.added, removed: replaced.removed }, { added: 2, removed: 1 });
  assert.strictEqual(formatDiff(replaced).text, '@@\n  two\n- three\n+ THREE\n+ extra\n  four', 'the removal ahead of what replaced it');
});

test('changes whose context touches share a hunk; farther ones open their own', () => {
  const page = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  assert.strictEqual(format(page, ['a', 'B', 'c', 'D', 'e', 'f', 'g', 'h']), '@@\n  a\n- b\n+ B\n  c\n- d\n+ D\n  e');
  assert.strictEqual(format(page, ['a', 'B', 'c', 'd', 'E', 'f', 'g', 'h']), '@@\n  a\n- b\n+ B\n  c\n  d\n- e\n+ E\n  f', 'contexts that meet without overlapping');
  assert.strictEqual(format(page, ['a', 'B', 'c', 'd', 'e', 'F', 'g', 'h']), '@@\n  a\n- b\n+ B\n  c\n@@\n  e\n- f\n+ F\n  g', 'contexts one line apart');
  assert.strictEqual(format(page, ['a', 'B', 'c', 'd', 'e', 'f', 'G', 'h']), '@@\n  a\n- b\n+ B\n  c\n@@\n  f\n- g\n+ G\n  h');
});

test('a change at the first line and one at the last have context on one side only', () => {
  assert.strictEqual(format(['a', 'b', 'c'], ['A', 'b', 'c']), '@@\n- a\n+ A\n  b');
  assert.strictEqual(format(['a', 'b', 'c'], ['a', 'b', 'C']), '@@\n  b\n- c\n+ C');
  assert.strictEqual(format([], ['only']), '@@\n+ only');
});

// Returns the length of the longest common subsequence of two arrays.
function lcsLength(a, b) {
  let row = new Array(b.length + 1).fill(0);
  for (const line of a) {
    const next = [0];
    b.forEach((other, j) => next.push(line === other ? row[j] + 1 : Math.max(row[j + 1], next[j])));
    row = next;
  }
  return row[b.length];
}

test('the script is a minimal edit that reproduces both sides', () => {
  const lines = (n, seed) => Array.from({ length: n }, (_, i) => `line ${(i * seed) % 5}`);
  for (let n = 0; n < 12; n++) {
    for (let m = 0; m < 12; m++) {
      const before = lines(n, 3);
      const after = lines(m, 7);
      const { script, added, removed } = diffLines(before, after);
      assert.deepStrictEqual(script.filter((l) => l.op !== '+').map((l) => l.text), before);
      assert.deepStrictEqual(script.filter((l) => l.op !== '-').map((l) => l.text), after);
      assert.strictEqual(added + removed, script.filter((l) => l.op !== ' ').length);
      assert.strictEqual(added + removed, n + m - 2 * lcsLength(before, after), `${n} lines against ${m} take the fewest edits`);
    }
  }
  const swapped = diffLines(['x', 'y'], ['y', 'x']);
  assert.strictEqual(swapped.added + swapped.removed, 2, 'one line moved costs two edits, not four');
});

test('past the edit cap the diff gives up and says how many lines differ', () => {
  const before = Array.from({ length: 30 }, (_, i) => `old ${i}`);
  const after = Array.from({ length: 40 }, (_, i) => `new ${i}`);
  assert.deepStrictEqual(diffLines(['same', ...before, 'end'], ['same', ...after, 'end'], { maxEdits: 69 }), { tooLarge: true, differing: 40 });
  const within = diffLines(['same', ...before, 'end'], ['same', ...after, 'end'], { maxEdits: 70 });
  assert.deepStrictEqual({ added: within.added, removed: within.removed }, { added: 40, removed: 30 }, 'seventy edits fit a cap of seventy');
  const lines = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
  const atCap = diffLines(lines('a', 500), lines('b', 500));
  assert.deepStrictEqual({ added: atCap.added, removed: atCap.removed }, { added: 500, removed: 500 }, 'the default cap is 1,000 edits');
  assert.deepStrictEqual(diffLines(lines('a', 500), lines('b', 501)), { tooLarge: true, differing: 501 }, 'and 1,001 are past it');
});

test('every line carries its two-character prefix, so page lines reading @@ or + x stay page text', () => {
  const text = format(['@@', '+ x', 'kept'], ['@@', '- y', 'kept']);
  assert.strictEqual(text, '@@\n  @@\n- + x\n+ - y\n  kept');
  const lines = text.split('\n');
  assert.deepStrictEqual(lines.filter((line) => line === '@@'), ['@@'], 'only the hunk opener is a bare @@');
});

test('past maxChars the hunks are cut on a line, and a closing line counts the changed lines left out', () => {
  const added = Array.from({ length: 50 }, (_, i) => `${String(i).padStart(2, '0')} ${'x'.repeat(97)}`);
  const { text, cut } = formatDiff(diffLines(['top'], ['top', ...added]), { maxChars: 3000 });
  const lines = text.split('\n');
  const closing = lines.pop();
  const kept = lines.join('\n');
  assert.ok(kept.length <= 3000, `the hunks fit the cap: ${kept.length}`);
  assert.ok(kept.length > 3000 - 103, 'and stop only when the next line would not fit');
  assert.ok(lines.slice(2).every((line, i) => line === `+ ${added[i]}`), 'every line is whole');
  const printed = lines.filter((line) => line.startsWith('+ ')).length;
  assert.strictEqual(closing, `… ${50 - printed} more changed lines; read the page for the rest`);
  assert.strictEqual(cut, true);
  assert.deepStrictEqual(formatDiff(diffLines(['top'], ['top', 'one']), { maxChars: 3000 }).cut, false);
});

test('the cut keeps a prefix of the hunks: no line prints after the first one that did not fit, though a later one would', () => {
  const long = 'x'.repeat(50);
  // '@@\n+ short' is 10 characters; '+ tiny' would fit the 20 after it, and the long
  // line wouldn't.
  const inHunk = formatDiff(diffLines([], ['short', long, 'tiny']), { maxChars: 20 });
  assert.strictEqual(inHunk.text, '@@\n+ short\n… 2 more changed lines; read the page for the rest');
  // The first hunk's '@@\n  a\n- b\n+ B' is 14 characters, and the second whole would
  // fit the 33 after it.
  const page = ['a', 'b', 'c', 'd', 'e', 'f'];
  const acrossHunks = formatDiff(diffLines(page, ['a', 'B', long, 'c', 'd', 'e', 'F']), { maxChars: 33 });
  assert.strictEqual(acrossHunks.text, '@@\n  a\n- b\n+ B\n… 3 more changed lines; read the page for the rest', 'nor does a later hunk');
});

test('a hunk that the cut would leave without a change is dropped whole, and a count of one changed line left out reads singular', () => {
  const page = ['a', 'b', 'c', 'd', 'e', 'f'];
  const result = diffLines(page, ['a', 'B', 'c', 'd', 'e', 'F']);
  // The first hunk is 18 characters; 21 leaves room for the second's @@ alone.
  const { text } = formatDiff(result, { maxChars: 21 });
  assert.strictEqual(text, '@@\n  a\n- b\n+ B\n  c\n… 2 more changed lines; read the page for the rest');
  const one = formatDiff(diffLines(['a', 'b'], ['a', 'c']), { maxChars: 10 });
  assert.strictEqual(one.text, '@@\n  a\n- b\n… 1 more changed line; read the page for the rest');
});
