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

test('needs_confirmation carries the payload and a message that says whether the call acted and leaves out the host', () => {
  const payload = 'URL: https://docs.example/\nTitle: Docs\nBlocked: [t1] evil.example — navigation to https://evil.example/x';
  const acted = envelope.needsConfirmation(payload, { notes: ['n'], acted: true });
  assert.deepStrictEqual(Object.keys(acted), ['outcome', 'message', 'payload', 'notes']);
  assert.strictEqual(acted.outcome, 'needs_confirmation');
  assert.strictEqual(acted.message, 'The action ran, and a navigation it led to was stopped at the domain gate. Ask the human about the host on the Blocked: line, then call policy with allow_once or allow_always. Check the result lines before repeating the action: a form it submitted may already have been processed.');
  const before = envelope.needsConfirmation(payload, { acted: false });
  assert.deepStrictEqual(before, {
    outcome: 'needs_confirmation',
    message: "The navigation was not started: its host needs the human's approval. Ask her about the host on the Blocked: line, then call policy with allow_once or allow_always and retry.",
    payload,
  });
  for (const env of [acted, before]) assert.ok(!env.message.includes('evil.example'), 'the host stays in the payload');
});

test('unsettled carries the payload and its optional fields, and is not an error outcome', () => {
  assert.deepStrictEqual(envelope.unsettled('p'), { outcome: 'unsettled', payload: 'p' });
  assert.deepStrictEqual(
    envelope.unsettled('p', { notes: ['n'], images: [{ data: 'd', mimeType: 'image/png' }] }),
    { outcome: 'unsettled', payload: 'p', notes: ['n'], images: [{ data: 'd', mimeType: 'image/png' }] },
  );
  assert.ok(!envelope.ERROR_OUTCOMES.includes('unsettled'), 'so the bridge does not mark it isError');
  assert.ok(!envelope.ERROR_OUTCOMES.includes('needs_confirmation'));
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
