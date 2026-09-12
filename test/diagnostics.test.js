const { test } = require('node:test');
const assert = require('node:assert');
const { createLogger } = require('../server/diagnostics');

function capture(env) {
  const lines = [];
  const log = createLogger('t', { env, write: (s) => lines.push(s) });
  return { log, lines };
}

test('default level is info: debug is dropped, info and above pass', () => {
  const { log, lines } = capture({});
  log.debug('d'); log.info('i'); log.warn('w'); log.error('e');
  assert.deepStrictEqual(lines, ['[t] i\n', '[t] w\n', '[t] e\n']);
});

test('CLAUDESURF_LOG_LEVEL filters: debug shows everything, error only errors', () => {
  const debug = capture({ CLAUDESURF_LOG_LEVEL: 'debug' });
  debug.log.debug('d'); debug.log.error('e');
  assert.deepStrictEqual(debug.lines, ['[t] d\n', '[t] e\n']);
  const error = capture({ CLAUDESURF_LOG_LEVEL: 'error' });
  error.log.warn('w'); error.log.error('e');
  assert.deepStrictEqual(error.lines, ['[t] e\n']);
  const unknown = capture({ CLAUDESURF_LOG_LEVEL: 'loud' });
  unknown.log.debug('d'); unknown.log.info('i');
  assert.deepStrictEqual(unknown.lines, ['[t] i\n'], 'an unknown level falls back to info');
});

test('the <N> priority prefix is present under JOURNAL_STREAM and absent otherwise', () => {
  const journal = capture({ JOURNAL_STREAM: '9:12345', CLAUDESURF_LOG_LEVEL: 'debug' });
  journal.log.debug('d'); journal.log.info('i'); journal.log.warn('w'); journal.log.error('e');
  assert.deepStrictEqual(journal.lines, ['<7>[t] d\n', '<6>[t] i\n', '<4>[t] w\n', '<3>[t] e\n']);
  const plain = capture({});
  plain.log.info('i');
  assert.strictEqual(plain.lines[0], '[t] i\n');
});

test('errors log their stack', () => {
  const { log, lines } = capture({});
  log.error('failed:', new Error('boom'));
  assert.match(lines[0], /^\[t\] failed: Error: boom\n\s+at /);
});
