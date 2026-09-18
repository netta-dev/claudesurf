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

module.exports = { OUTCOMES, ERROR_OUTCOMES, success, error, schemaError, setupError, staleRef, isEnvelope };
