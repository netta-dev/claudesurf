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

// The two needs_confirmation messages: the call acted and a navigation it led to was
// stopped, or the gate refused the call's own URL before the call acted.
const ACTED = 'The action ran, and a navigation it led to was stopped at the domain gate. Ask the human about the host on the Blocked: line, then call policy with allow_once or allow_always. Check the result lines before repeating the action: a form it submitted may already have been processed.';
const NOT_STARTED = "The navigation was not started: its host needs the human's approval. Ask her about the host on the Blocked: line, then call policy with allow_once or allow_always and retry.";

// Returns the envelope of a domain-gate refusal. The host stays in the payload's
// Blocked: line, out of the message.
function needsConfirmation(payload, { notes = [], acted }) {
  const envelope = { outcome: 'needs_confirmation', message: acted ? ACTED : NOT_STARTED, payload };
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

module.exports = { OUTCOMES, ERROR_OUTCOMES, success, needsConfirmation, unsettled, error, schemaError, setupError, staleRef, isEnvelope };
