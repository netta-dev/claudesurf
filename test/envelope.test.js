const { test } = require('node:test');
const assert = require('node:assert');
const envelope = require('../server/envelope');

test('the outcome vocabulary is the fixed set, and the error outcomes are a subset', () => {
  assert.deepStrictEqual(envelope.OUTCOMES, ['success', 'needs_confirmation', 'needs_human', 'stale_ref', 'unsettled', 'schema_error', 'setup_error', 'error']);
  assert.deepStrictEqual(envelope.ERROR_OUTCOMES, ['error', 'schema_error', 'setup_error']);
  for (const o of envelope.ERROR_OUTCOMES) assert.ok(envelope.OUTCOMES.includes(o));
});

test('success carries the payload and only the optional fields that were given', () => {
  assert.deepStrictEqual(envelope.success('URL: x'), { outcome: 'success', payload: 'URL: x' });
  assert.deepStrictEqual(
    envelope.success('p', { notes: ['n'], images: [{ data: 'd', mimeType: 'image/png' }] }),
    { outcome: 'success', payload: 'p', notes: ['n'], images: [{ data: 'd', mimeType: 'image/png' }] },
  );
});

test('failure constructors set outcome and message', () => {
  assert.deepStrictEqual(envelope.error('bad'), { outcome: 'error', message: 'bad' });
  assert.deepStrictEqual(envelope.setupError('no display'), { outcome: 'setup_error', message: 'no display' });
  assert.deepStrictEqual(envelope.staleRef('e4', 'document changed'), { outcome: 'stale_ref', message: 'e4: document changed' });
  assert.deepStrictEqual(
    envelope.schemaError('click', 'ref is required', { action: 'click', properties: {}, required: ['ref'] }),
    { outcome: 'schema_error', message: 'click: ref is required', schema: { action: 'click', properties: {}, required: ['ref'] } },
  );
});

test('isEnvelope recognises an envelope by its outcome', () => {
  assert.ok(envelope.isEnvelope(envelope.error('x')));
  assert.ok(!envelope.isEnvelope({ error: 'old shape' }));
  assert.ok(!envelope.isEnvelope(null));
  assert.ok(!envelope.isEnvelope({ outcome: 'partial' }));
});
