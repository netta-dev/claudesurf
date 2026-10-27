// A line diff of two renders, free of side effects. It trims the common prefix and
// suffix, then runs Myers's O(ND) diff over the middle. The algorithm keeps one array
// of 2d+1 entries per edit step, so its memory grows with the square of the edit count
// rather than with the page. It runs on the daemon's event loop, where a long synchronous
// job holds up the gate's answer to each paused request, so the edit cap bounds it.

// Returns { added, removed, script } for two arrays of lines, `script` the edit script
// as { op, text } in order, `op` one of ' ', '-', and '+'; or { tooLarge: true,
// differing } when the middle needs more than `maxEdits` edits, `differing` the longer
// of the two middles' line counts.
function diffLines(before, after, { maxEdits = 1000 } = {}) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore -= 1;
    endAfter -= 1;
  }
  const a = before.slice(start, endBefore);
  const b = after.slice(start, endAfter);
  const middle = myers(a, b, maxEdits);
  if (!middle) return { tooLarge: true, differing: Math.max(a.length, b.length) };
  const same = (text) => ({ op: ' ', text });
  const script = [...before.slice(0, start).map(same), ...middle, ...before.slice(endBefore).map(same)];
  return {
    added: middle.filter((line) => line.op === '+').length,
    removed: middle.filter((line) => line.op === '-').length,
    script,
  };
}

// Returns { text, cut } for a diffLines result: hunks, each opened by `@@`, holding
// every change with `context` unchanged lines on either side, every line prefixed by
// `+ `, `- `, or two spaces, so a page line reading `@@` or `+ x` can't pass for
// structure. Past `maxChars` the hunks are cut on a line; when the cut leaves changed
// lines out, a closing line counts them and `cut` is true. The closing line is past
// the cap.
function formatDiff(result, { maxChars = Infinity, context = 1 } = {}) {
  if (result.tooLarge) return { text: '', cut: false };
  const lines = [];
  let printedChanges = 0;
  let total = 0;
  let length = -1;
  let full = false;
  for (const hunk of hunks(result.script, context)) {
    const start = lines.length;
    let hunkChanges = 0;
    for (const line of ['@@', ...hunk.map(prefixed)]) {
      if (!full && length + 1 + line.length > maxChars) full = true;
      if (!full) {
        lines.push(line);
        length += 1 + line.length;
        if (line[0] === '+' || line[0] === '-') hunkChanges += 1;
      }
    }
    total += hunk.filter((line) => line.op !== ' ').length;
    // A hunk that the cut left without a change of its own would show only context, so
    // it is dropped whole.
    if (full && hunkChanges === 0) lines.splice(start);
    printedChanges += hunkChanges;
  }
  const left = total - printedChanges;
  if (left > 0) lines.push(`… ${left} more changed ${left === 1 ? 'line' : 'lines'}; read the page for the rest`);
  return { text: lines.join('\n'), cut: left > 0 };
}

function prefixed({ op, text }) {
  return `${op === ' ' ? ' ' : op} ${text}`;
}

// Returns the script's changes grouped with `context` unchanged lines around each;
// changes whose context touches share a hunk.
function hunks(script, context) {
  const groups = [];
  let current = null;
  script.forEach((line, i) => {
    if (line.op === ' ') return;
    const from = Math.max(0, i - context);
    if (current && from <= current.to + 1) {
      current.to = Math.min(script.length - 1, i + context);
    } else {
      current = { from, to: Math.min(script.length - 1, i + context) };
      groups.push(current);
    }
  });
  return groups.map(({ from, to }) => script.slice(from, to + 1));
}

// Returns the middle's edit script, deletions ahead of insertions within a change, or
// null past `maxEdits` edits.
function myers(a, b, maxEdits) {
  const trace = [];
  let previous = null;
  const limit = Math.min(a.length + b.length, maxEdits);
  for (let d = 0; d <= limit; d++) {
    // v[k + d] holds the furthest x reached on diagonal k after d edits.
    const v = new Array(2 * d + 1);
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (d === 0) x = 0;
      else if (down(previous, k, d)) x = previous[k + 1 + d - 1];
      else x = previous[k - 1 + d - 1] + 1;
      let y = x - k;
      while (x < a.length && y < b.length && a[x] === b[y]) { x += 1; y += 1; }
      v[k + d] = x;
      if (x >= a.length && y >= b.length) {
        trace.push(v);
        return backtrack(trace, a, b);
      }
    }
    trace.push(v);
    previous = v;
  }
  return null;
}

// Returns whether the path onto diagonal k at step d comes down from k + 1, an
// insertion, rather than across from k - 1, a deletion.
function down(previous, k, d) {
  return k === -d || (k !== d && previous[k - 1 + d - 1] < previous[k + 1 + d - 1]);
}

function backtrack(trace, a, b) {
  const script = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d > 0; d--) {
    const previous = trace[d - 1];
    const k = x - y;
    const fromAbove = down(previous, k, d);
    const startK = fromAbove ? k + 1 : k - 1;
    const startX = previous[startK + d - 1];
    const startY = startX - startK;
    while (x > startX && y > startY) { script.push({ op: ' ', text: a[x - 1] }); x -= 1; y -= 1; }
    if (fromAbove) { script.push({ op: '+', text: b[y - 1] }); y -= 1; } else { script.push({ op: '-', text: a[x - 1] }); x -= 1; }
  }
  while (x > 0 && y > 0) { script.push({ op: ' ', text: a[x - 1] }); x -= 1; y -= 1; }
  return script.reverse();
}

module.exports = { diffLines, formatDiff };
