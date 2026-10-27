// The domain gate's allowlist: the hosts in the allowlist file, which the human may
// edit by hand and `allow_always` appends to, and the `allow_once` grants, held in
// memory per session for the daemon's lifetime. An entry covers its host and every
// subdomain of it; an IP address covers itself alone. Both processes load
// normalizeHost to validate policy's argument; the store is the daemon's.

const fs = require('fs');
const path = require('path');

// A bracketed IPv6 address, the one place a colon belongs in a bare host.
const BRACKETED = /\[[0-9A-Fa-f:.]+\]/.source;
// A bare host as written: without a scheme, userinfo, port, path, query, wildcard, or
// whitespace.
const BARE = new RegExp(`^(?:${BRACKETED}|${/[^\s/\\:@?#*[\]]+/.source})$`);
// The parsed hostname that normalizeHost accepts as a domain or an IPv4 address; the
// URL parser keeps characters such as `!` and `$`, which this pattern refuses.
const DOMAIN = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/;
const IPV4 = /^\d+\.\d+\.\d+\.\d+$/;
const IPV6 = new RegExp(`^${BRACKETED}$`);

// Returns the normalized host — lowercased, punycoded, without a trailing dot — or
// null when `text` is not a bare host, or is a single label other than localhost,
// which would allow a whole top-level domain.
function normalizeHost(text) {
  if (typeof text !== 'string' || !BARE.test(text)) return null;
  const host = parsedHost(`http://${text}`);
  if (!host) return null;
  if (IPV6.test(host)) return host;
  if (!DOMAIN.test(host) || (!host.includes('.') && host !== 'localhost')) return null;
  return host;
}

// Returns whether `url`, which may be empty or missing, is an http or https URL.
function isWeb(url) {
  return /^https?:/i.test(url || '');
}

// Returns the normalized host of an http or https URL, or null for any other URL.
function hostOf(url) {
  return isWeb(url) ? parsedHost(url) : null;
}

class Policy {
  // Takes `file`, the allowlist's path, and `log`, the daemon's logger.
  constructor({ file, log }) {
    this.file = file;
    this.log = log;
    this.entries = [];
    this.stat = null;
    // The error of the last read that failed, cleared by the next one that succeeds.
    this.failure = null;
    // Whether the file, as last read, ends without a newline.
    this.unterminated = false;
    this.grants = new Map();
  }

  // Returns whether the allowlist file or the session's allow_once grants cover `host`,
  // a normalized host such as hostOf returns.
  allows(host, sessionId) {
    if (!host) return false;
    const grants = this.grants.get(sessionId) || [];
    return [...this.read(), ...grants].some((entry) => covers(entry, host));
  }

  // Grants `host` to the session until the daemon exits. Throws for a host that
  // normalizeHost refuses.
  allowOnce(sessionId, host) {
    const normalized = requireHost(host);
    if (!this.grants.has(sessionId)) this.grants.set(sessionId, new Set());
    this.grants.get(sessionId).add(normalized);
  }

  // Appends `host` to the allowlist file, creating its directory 0700 and the file
  // 0600; returns 'present' when an entry already covers it and 'added' otherwise.
  // A failed read or write throws the file system's error, its `code` set, and leaves
  // the host off the allowlist.
  allowAlways(host) {
    const normalized = requireHost(host);
    if (this.read().some((entry) => covers(entry, normalized))) return 'present';
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    if (this.failure && this.failure.code !== 'ENOENT') throw this.failure;
    fs.appendFileSync(this.file, `${this.unterminated ? '\n' : ''}${normalized}\n`, { mode: 0o600 });
    return 'added';
  }

  // Returns the file's entries, read again when its modification time or size has
  // changed since the last read. A missing file is an empty list; so is one that can't
  // be read, with a warning each time the reason changes.
  read() {
    let stat;
    try {
      stat = fs.statSync(this.file);
    } catch (e) {
      return this.unreadable(e);
    }
    if (this.stat && stat.mtimeMs === this.stat.mtimeMs && stat.size === this.stat.size) return this.entries;
    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      return this.unreadable(e);
    }
    this.stat = stat;
    this.failure = null;
    this.unterminated = text !== '' && !text.endsWith('\n');
    this.entries = this.parse(text);
    return this.entries;
  }

  parse(text) {
    const entries = [];
    const skipped = [];
    text.split('\n').forEach((line, i) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const host = normalizeHost(trimmed);
      if (host) entries.push(host); else skipped.push(i + 1);
    });
    if (skipped.length) this.log.warn(`allowlist ${this.file}: skipped ${skipped.length === 1 ? 'line' : 'lines'} ${skipped.join(', ')}, which ${skipped.length === 1 ? 'is not a bare host' : 'are not bare hosts'}`);
    return entries;
  }

  unreadable(e) {
    this.stat = null;
    this.entries = [];
    this.unterminated = false;
    if (e.code !== 'ENOENT' && e.code !== (this.failure && this.failure.code)) this.log.warn(`allowlist ${this.file} cannot be read, so it allows nothing: ${e.message}`);
    this.failure = e;
    return this.entries;
  }
}

function parsedHost(url) {
  let hostname;
  try { ({ hostname } = new URL(url)); } catch { return null; }
  return hostname.replace(/\.$/, '') || null;
}

function isAddress(host) {
  return IPV4.test(host) || IPV6.test(host);
}

function covers(entry, host) {
  return host === entry || (!isAddress(entry) && host.endsWith(`.${entry}`));
}

function requireHost(host) {
  const normalized = normalizeHost(host);
  if (!normalized) throw new Error(`${host} is not a bare host`);
  return normalized;
}

module.exports = { normalizeHost, hostOf, isWeb, Policy };
