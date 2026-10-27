// The action log: one JSON line per call that reaches the daemon, in a 0600 file in a
// 0700 directory, renamed to `<file>.1` when the next line would take it past its
// size cap. Text that a call types — `type`'s text, and `press`'s keys when a press types a
// character — is reduced to its length and a keyed hash. The key is drawn when the log
// is constructed and kept in memory, so two records of one daemon run that typed the
// same thing match, and a leaked log, which lacks the key, can't confirm a guess at
// the text.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseKeys } = require('./keys');

// The number of hex characters that a record keeps from the HMAC.
const HASH_CHARS = 16;

class ActionLog {
  // Takes `file`, the log's path, `log`, the daemon's logger, which a failed write warns
  // on, and `maxBytes`, the file's size cap in bytes, 10 MiB by default.
  constructor({ file, log, maxBytes = 10 * 1024 * 1024 }) {
    this.file = file;
    this.log = log;
    this.maxBytes = maxBytes;
    this.key = crypto.randomBytes(32);
  }

  // Appends one record, synchronously. `blocked` is respond.js's `carried`; an
  // undefined `url` and an empty `blocked` are left out. Doesn't throw: a write that
  // fails warns.
  record({ sessionId, tool, action, args, url, outcome, blocked }) {
    try {
      const entry = { ts: new Date().toISOString(), session: sessionId, tool, action, args: this.reduce(action, args || {}) };
      if (url !== undefined) entry.url = url;
      entry.outcome = outcome;
      if (blocked && blocked.length) entry.blocked = blocked.map(blockedEntry);
      this.append(`${JSON.stringify(entry)}\n`);
    } catch (e) {
      this.log.warn(`action log ${this.file}: ${e.message}`);
    }
  }

  reduce(action, args) {
    if (action === 'type' && args.text !== undefined) return { ...args, text: this.secret(args.text) };
    if (action === 'press' && args.keys !== undefined && types(args.keys)) return { ...args, keys: this.secret(args.keys) };
    return args;
  }

  secret(value) {
    const text = String(value);
    return { length: [...text].length, hmac: crypto.createHmac('sha256', this.key).update(text).digest('hex').slice(0, HASH_CHARS) };
  }

  append(line) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    let size = 0;
    try {
      size = fs.statSync(this.file).size;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    if (size > 0 && size + Buffer.byteLength(line) > this.maxBytes) fs.renameSync(this.file, `${this.file}.1`);
    fs.appendFileSync(this.file, line, { mode: 0o600 });
  }
}

// Returns whether a press list types a character, so its keys are the typed text; a
// list that the grammar refuses is treated as one that does.
function types(keys) {
  try {
    return parseKeys(keys).some((press) => press.printable);
  } catch {
    return true;
  }
}

function blockedEntry({ own, tab, kind, how, host, url, count }) {
  return { own, tab: tab === undefined || tab === null ? null : `t${tab}`, kind, how, host, url, count };
}

module.exports = { ActionLog };
