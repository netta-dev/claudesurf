// A capped list of numbered entries, read after a cursor: each tab's console entries
// and ended requests. One counter numbers every list in the daemon, so within a run a
// number names one entry across tabs and kinds, and a cursor only moves forward.

// The characters of entry lines that one answer of a cursor read carries at most.
const READ_CHARS = 40_000;

let counter = 0;

class Ring {
  constructor(cap) {
    this.cap = cap;
    this.entries = [];
    this.droppedThrough = 0;
  }

  push(entry) {
    entry.n = ++counter;
    this.entries.push(entry);
    if (this.entries.length > this.cap) this.droppedThrough = this.entries.shift().n;
    return entry;
  }

  after(n) {
    return {
      entries: this.entries.filter((entry) => entry.n > n),
      missedThrough: this.droppedThrough > n ? this.droppedThrough : null,
    };
  }
}

function issued() {
  return counter;
}

// Returns { entries, missed, next } for a read of `ring` after `after`: the entries
// listed, the Missed: line or null, and the Next: cursor of an uncut answer. A cursor
// above every number issued comes from before a restart, so the read lists every entry
// kept. `ring` may be null, for a tab that never captured anything.
function readAfter(ring, after) {
  const next = issued();
  const list = ring || new Ring(0);
  if (after > next) return { entries: list.after(0).entries, missed: `Missed: the daemon restarted since after=${after}`, next };
  const { entries, missedThrough } = list.after(after);
  return { entries, missed: missedThrough === null ? null : `Missed: the tab dropped entries up to [${missedThrough}]`, next };
}

// Resolves { lines, printed, used, next } for `entries`, those that a cursor read
// lists, oldest first. Each entry's text is what `textOf(entry, used)` resolves, where
// `used` counts the characters of the lines so far. Text that would exceed READ_CHARS,
// or null text, cuts the answer at that entry. The cut line names the `after` value to
// resume from, and the cut answer uses that value as `next`. An uncut answer uses the
// `next` argument.
async function printEntries(entries, next, textOf) {
  const lines = [];
  let used = 0;
  for (let i = 0; i < entries.length; i++) {
    const text = await textOf(entries[i], used);
    if (text === null || used + text.length > READ_CHARS) {
      const after = entries[i].n - 1;
      lines.push(`… ${entries.length - i} more; call again with after=${after}`);
      return { lines, printed: i, used, next: after };
    }
    lines.push(text);
    used += text.length + 1;
  }
  return { lines, printed: entries.length, used, next };
}

function cursorHead({ state, label, printed, after, filter = '', kept, missed, next }) {
  const count = `${label}: ${printed} ${printed === 1 ? 'entry' : 'entries'} after ${after}${filter}; the tab keeps its last ${kept}`;
  return [state, count, ...(missed ? [missed] : []), `Next: after=${next}`].join('\n');
}

module.exports = { Ring, issued, readAfter, printEntries, cursorHead, READ_CHARS };
