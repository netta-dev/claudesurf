// policy.js: host normalization, the allowlist file and its re-reads, allow_always's
// append, and the allow_once grants.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { normalizeHost, hostOf, Policy } = require('../server/policy');
const { tmpDir, recordingLog, silentLog, modesIgnored } = require('./helpers');

// Returns a policy store over a fresh allowlist path, removed when the test ends.
function store(t, { content, log = silentLog } = {}) {
  const dir = tmpDir('claudesurf-policy');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'claudesurf', 'allowed-hosts');
  if (content !== undefined) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return { policy: new Policy({ file, log }), file, dir };
}

test('a missing file is an empty list', (t) => {
  const { policy } = store(t);
  assert.strictEqual(policy.allows('example.com', 's1'), false);
});

test('normalizeHost takes a bare host and refuses anything else', () => {
  const accepted = {
    'example.com': 'example.com',
    'WWW.Example.COM': 'www.example.com',
    'example.com.': 'example.com',
    'bücher.de': 'xn--bcher-kva.de',
    localhost: 'localhost',
    '127.0.0.1': '127.0.0.1',
    '[2001:DB8::1]': '[2001:db8::1]',
  };
  for (const [text, host] of Object.entries(accepted)) assert.strictEqual(normalizeHost(text), host, text);
  const refused = [
    'https://example.com', 'user@example.com', 'example.com:8080', 'example.com:80', 'example.com/path',
    '*.example.com', ' example.com', 'exa mple.com', 'example.com\n', 'com', 'intranet', '', '.example.com', 'a..b',
  ];
  for (const text of refused) assert.strictEqual(normalizeHost(text), null, JSON.stringify(text));
  assert.strictEqual(normalizeHost(undefined), null);
});

test('hostOf gives the normalized host of an http(s) URL and null for any other', () => {
  assert.strictEqual(hostOf('https://Docs.Example.COM./path?q=1'), 'docs.example.com');
  assert.strictEqual(hostOf('http://[::1]:8080/'), '[::1]');
  assert.strictEqual(hostOf('http://intranet/'), 'intranet', 'a single label is a host a URL can name, though no entry covers it');
  for (const url of ['file:///etc/passwd', 'data:text/html,x', 'about:blank', 'not a url', '']) assert.strictEqual(hostOf(url), null, url);
});

test('an entry covers its host and its subdomains, and not a host that merely ends in its name', (t) => {
  const { policy } = store(t, { content: 'example.com\n' });
  for (const host of ['example.com', 'www.example.com', 'a.b.example.com']) assert.strictEqual(policy.allows(host, 's1'), true, host);
  for (const host of ['badexample.com', 'example.com.evil.test', 'com']) assert.strictEqual(policy.allows(host, 's1'), false, host);
  assert.strictEqual(policy.allows(null, 's1'), false, 'a URL with no host is allowed nowhere');
});

test('an IP address matches itself alone', (t) => {
  const { policy } = store(t, { content: '127.0.0.1\n[::1]\n' });
  assert.strictEqual(policy.allows('127.0.0.1', 's1'), true);
  assert.strictEqual(policy.allows('[::1]', 's1'), true);
  assert.strictEqual(policy.allows('1.127.0.0.1', 's1'), false);
  assert.strictEqual(policy.allows('127.0.0.2', 's1'), false);
});

test('blank lines and comments are skipped, and bad lines with one warning per read', (t) => {
  const log = recordingLog();
  const { policy } = store(t, { log, content: '# the allowlist\n\nexample.com\nhttps://bad.test/\n  # indented comment\n*.wild.test\ngood.test\n' });
  assert.strictEqual(policy.allows('example.com', 's1'), true);
  assert.strictEqual(policy.allows('good.test', 's1'), true);
  assert.strictEqual(policy.allows('bad.test', 's1'), false);
  assert.strictEqual(policy.allows('wild.test', 's1'), false);
  assert.deepStrictEqual(log.lines.warn.length, 1);
  assert.match(log.lines.warn[0], /skipped lines 4, 6, which are not bare hosts$/);
  policy.allows('example.com', 's1');
  assert.strictEqual(log.lines.warn.length, 1, 'an unchanged file is not read, or warned about, again');
});

test('a file that can\'t be read allows nothing, with a warning each time the reason changes', { skip: modesIgnored }, (t) => {
  const log = recordingLog();
  const { policy, file } = store(t, { log, content: 'example.com\n' });
  fs.rmSync(file);
  fs.mkdirSync(file);
  assert.strictEqual(policy.allows('example.com', 's1'), false);
  assert.strictEqual(log.lines.warn.length, 1);
  assert.match(log.lines.warn[0], /^allowlist .*allowed-hosts cannot be read, so it allows nothing: EISDIR/);
  fs.rmSync(file, { recursive: true });
  fs.writeFileSync(file, 'example.com\n');
  fs.chmodSync(file, 0o000);
  assert.strictEqual(policy.allows('example.com', 's1'), false);
  assert.strictEqual(policy.allows('example.com', 's1'), false);
  assert.strictEqual(log.lines.warn.length, 2, 'another reason warns again, and the same reason once');
  assert.match(log.lines.warn[1], /EACCES/);
  fs.chmodSync(file, 0o600);
  assert.strictEqual(policy.allows('example.com', 's1'), true, 'a readable file is read again');
  fs.chmodSync(file, 0o000);
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(file, later, later);
  assert.strictEqual(policy.allows('example.com', 's1'), false);
  assert.strictEqual(log.lines.warn.length, 3, 'a read in between clears the reason, so the same one warns again');
});

test('a hand edit and a removal are picked up on the next check', (t) => {
  const { policy, file } = store(t, { content: 'one.test\ntwo.test\n' });
  assert.strictEqual(policy.allows('two.test', 's1'), true);
  fs.writeFileSync(file, 'one.test\n');
  assert.strictEqual(policy.allows('two.test', 's1'), false, 'the removal');
  assert.strictEqual(policy.allows('one.test', 's1'), true);
  // The file keeps the same size, so only its modification time identifies this edit.
  fs.writeFileSync(file, 'six.test\n');
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(file, later, later);
  assert.strictEqual(policy.allows('six.test', 's1'), true, 'the edit');
  assert.strictEqual(policy.allows('one.test', 's1'), false);
  fs.rmSync(file);
  assert.strictEqual(policy.allows('six.test', 's1'), false, 'and a deleted file allows nothing');
});

test('allowAlways creates the file 0600 in a 0700 directory and appends a host once', (t) => {
  const { policy, file } = store(t);
  assert.strictEqual(policy.allowAlways('Example.COM'), 'added');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'example.com\n');
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  assert.strictEqual(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.strictEqual(policy.allowAlways('example.com'), 'present');
  assert.strictEqual(policy.allowAlways('www.example.com'), 'present', 'an entry covering the host is enough');
  assert.strictEqual(policy.allowAlways('other.test'), 'added');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'example.com\nother.test\n');
  assert.strictEqual(policy.allows('other.test', 's2'), true, 'and every session sees it');
});

test('allowAlways puts the missing newline before its line in a file that lacks one', (t) => {
  const { policy, file } = store(t, { content: '# hand-written\nfirst.test' });
  assert.strictEqual(policy.allowAlways('second.test'), 'added');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '# hand-written\nfirst.test\nsecond.test\n');
});

test('allowAlways throws the system error code when its write fails, and doesn\'t grant the host', { skip: modesIgnored }, (t) => {
  const { policy, dir } = store(t);
  fs.chmodSync(dir, 0o500);
  try {
    assert.throws(() => policy.allowAlways('example.com'), (e) => e.code === 'EACCES');
  } finally {
    fs.chmodSync(dir, 0o700);
  }
  assert.strictEqual(policy.allows('example.com', 's1'), false);
  assert.throws(() => policy.allowAlways('*.example.com'), /is not a bare host/);
});

test('allow_once grants are visible to their own session alone and aren\'t written', (t) => {
  const { policy, file } = store(t);
  policy.allowOnce('s1', 'Docs.Example.com');
  assert.strictEqual(policy.allows('docs.example.com', 's1'), true);
  assert.strictEqual(policy.allows('api.docs.example.com', 's1'), true, 'a grant covers subdomains as an entry does');
  assert.strictEqual(policy.allows('docs.example.com', 's2'), false);
  assert.ok(!fs.existsSync(file));
  assert.throws(() => policy.allowOnce('s1', 'com'), /is not a bare host/);
});
