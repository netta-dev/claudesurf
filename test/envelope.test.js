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
  assert.strictEqual(acted.message, 'The action ran, and a navigation it led to was stopped at the domain gate. Ask the human about the host on the Blocked: line; once she approves, call claudesurf_act with action: policy, op: allow_once (this session) or allow_always (saved), and host set to the host on the Blocked: line. Check the result lines before repeating the action: a form it submitted may already have been processed.');
  const before = envelope.needsConfirmation(payload, { acted: false });
  assert.deepStrictEqual(before, {
    outcome: 'needs_confirmation',
    message: "The call didn't start: its host needs the human's approval. Ask her about the host on the Blocked: line; once she approves, call claudesurf_act with action: policy, op: allow_once (this session) or allow_always (saved), and host set to the host on the Blocked: line, then retry.",
    payload,
  });
  for (const env of [acted, before]) assert.ok(!env.message.includes('evil.example'), 'the host stays in the payload');
});

test('needs_human carries the full payload and a message naming the type and the window, and keeps the page out of the message', () => {
  const payload = 'URL: https://app.example/login?next=%2Fsettings\nTitle: Sign in · App\nChallenge: sign-in — a password field\nNavigated: yes';
  const labelled = envelope.needsHuman(payload, { notes: ['n'], type: 'sign-in', label: 'reviewing PR #42' });
  assert.deepStrictEqual(Object.keys(labelled), ['outcome', 'message', 'payload', 'notes']);
  assert.strictEqual(labelled.outcome, 'needs_human');
  assert.strictEqual(labelled.payload, payload);
  assert.strictEqual(labelled.message, 'A person has to clear this page: a sign-in. Tell the human that the window "reviewing PR #42" needs her, then end your turn; read the page again once she says it is done.'
    + " The page stays readable and actable, so if this isn't a challenge, carry on."
    + ' If clearing it takes her through a host the allowlist lacks, she can sign in from a tab she opens herself (Ctrl+T), which shares the cookies.');
  assert.ok(!labelled.message.includes('app.example') && !labelled.message.includes('Sign in · App'), 'the page stays in the payload');
  const unnamed = envelope.needsHuman(payload, { type: 'two-factor', label: null });
  assert.match(unnamed.message, /^A person has to clear this page: a two-factor code\. Tell the human that the session's window needs her,/);
  assert.strictEqual(unnamed.notes, undefined);
  assert.match(envelope.needsHuman(payload, { type: 'bot check', label: 'a\nb  "c"' }).message, /: a bot check\. Tell the human that the window "a b \\"c\\"" needs her/);
  assert.match(envelope.needsHuman(payload, { type: 'bot check', label: ' Ops\n' }).message, /Tell the human that the window "Ops" needs her/, 'the ends are trimmed');
  assert.match(envelope.needsHuman(payload, { type: 'bot check', label: ' \n\u0000\u202E ' }).message, /Tell the human that the session's window needs her/, 'a label of whitespace and controls alone names no window');
  assert.match(envelope.needsHuman(payload, { type: 'bot check', label: 'a\u202Eb\u0085c\u0000d\u2066e\u200Df' }).message, /the window "a b c d e\u200Df" needs her/, 'control characters and the bidi overrides and isolates collapse as the notification collapses them; a zero-width joiner stays');
  assert.ok(!envelope.ERROR_OUTCOMES.includes('needs_human'), 'so the bridge does not mark it isError');
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
