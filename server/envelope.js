// The result envelope every action returns. `payload` is page-derived text, which the
// bridge wraps in the nonce delimiter; `message` and `notes` are daemon-derived and
// rendered unwrapped, so they must never carry page text.

const OUTCOMES = [
  'success', 'needs_confirmation', 'needs_human', 'stale_ref', 'unsettled',
  'schema_error', 'setup_error', 'error',
];

// Outcomes the bridge marks isError.
const ERROR_OUTCOMES = ['error', 'schema_error', 'setup_error'];

function success(payload, { notes = [], images = [] } = {}) {
  const envelope = { outcome: 'success', payload };
  if (notes.length) envelope.notes = notes;
  if (images.length) envelope.images = images;
  return envelope;
}

// These messages include policy-call instructions for sessions whose tool schema
// predates the policy action.
const ACTED = 'The action ran, and a navigation it led to was stopped at the domain gate. Ask the human about the host on the Blocked: line; once she approves, call claudesurf_act with action: policy, op: allow_once (this session) or allow_always (saved), and host set to the host on the Blocked: line. Check the result lines before repeating the action: a form it submitted may already have been processed.';
const NOT_STARTED = "The call didn't start: its host needs the human's approval. Ask her about the host on the Blocked: line; once she approves, call claudesurf_act with action: policy, op: allow_once (this session) or allow_always (saved), and host set to the host on the Blocked: line, then retry.";

// Returns the envelope of a domain-gate refusal. The host stays in the payload's
// Blocked: line, out of the message.
function needsConfirmation(payload, { notes = [], acted }) {
  const envelope = { outcome: 'needs_confirmation', message: acted ? ACTED : NOT_STARTED, payload };
  if (notes.length) envelope.notes = notes;
  return envelope;
}

const CHALLENGE_NAMES = { 'bot check': 'a bot check', 'sign-in': 'a sign-in', 'two-factor': 'a two-factor code' };

function challengeName(type) {
  return CHALLENGE_NAMES[type] || 'a challenge';
}

// Returns a session's label, the agent's text, as one line: each run of
// whitespace, control characters, and the bidi embeddings, overrides, and isolates
// becomes one space. The other format characters stay, since a zero-width joiner holds
// an emoji sequence together.
function oneLineLabel(label) {
  return String(label || '').replace(/[\s\p{Cc}\u202A-\u202E\u2066-\u2069]+/gu, ' ').trim();
}

function needsHuman(payload, { notes = [], type, label }) {
  const name = oneLineLabel(label);
  const where = name ? `the window ${JSON.stringify(name)}` : "the session's window";
  const message = `A person has to clear this page: ${challengeName(type)}. Tell the human that ${where} needs her, then end your turn; read the page again once she says it is done. `
    + "The page stays readable and actable, so if this isn't a challenge, carry on. "
    + 'If clearing it takes her through a host the allowlist lacks, she can sign in from a tab she opens herself (Ctrl+T), which shares the cookies.';
  const envelope = { outcome: 'needs_human', message, payload };
  if (notes.length) envelope.notes = notes;
  return envelope;
}

// Returns the envelope of a result whose page had not settled; its Settled: line says
// what was still busy.
function unsettled(payload, { notes = [], images = [] } = {}) {
  const envelope = { outcome: 'unsettled', payload };
  if (notes.length) envelope.notes = notes;
  if (images.length) envelope.images = images;
  return envelope;
}

function error(message) {
  return { outcome: 'error', message };
}

function schemaError(action, message, schema) {
  return { outcome: 'schema_error', message: `${action}: ${message}`, schema };
}

function setupError(message) {
  return { outcome: 'setup_error', message };
}

function staleRef(ref, message) {
  return { outcome: 'stale_ref', message: `${ref}: ${message}` };
}

function isEnvelope(value) {
  return Boolean(value) && typeof value === 'object' && OUTCOMES.includes(value.outcome);
}

module.exports = { OUTCOMES, ERROR_OUTCOMES, success, needsConfirmation, needsHuman, challengeName, oneLineLabel, unsettled, error, schemaError, setupError, staleRef, isEnvelope };
