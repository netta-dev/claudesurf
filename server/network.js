// This module captures request metadata from requests.js for armed tabs and serves
// network reads. It doesn't capture request headers or POST bodies because they may
// contain passwords. It keeps two challenge response headers per main-frame document
// for detection.
//
// The module caps stored URLs because Chrome can report arbitrarily long data: URLs.
// Records receive numbers when their requests end. Chrome retains response bodies
// until a filtered read requests them. Disarming or removing a tab drops its captured
// data.
//
// Callers supply the registry to avoid circular imports. sessions.js loads this
// module through arming.js before setting its exports. Imports of read.js,
// respond.js, and refs.js would create the same cycle.

const { ProtocolError, TimeoutError } = require('./cdp');
const requests = require('./requests');
const { Ring, readAfter, printEntries, cursorHead, READ_CHARS } = require('./ring');
const { TEXTUAL } = require('./mime');
const { isMainFrame } = require('./frames');
const { workingTarget, currentStateLines, safeUrl, cappedText, cutText, letters, RESERVED } = require('./action-support');

// The ended records kept per tab; a new one pushes out the oldest.
const KEPT = 500;
// The main-frame document responses kept per tab for their challenge headers; a new
// one pushes out the oldest.
const DOCUMENTS = 10;
const BODY_CHARS = 4_000;
const URL_CHARS = 1_000;
// The characters of a URL that a record keeps, for a filter to match within.
const URL_KEPT = 2_000;
const IN_FLIGHT_LINES = 20;
const BODY_MARGIN_MS = 1_000;
const BODY_TYPES = new Set(['XHR', 'Fetch', 'Document']);
const TEXTUAL_TYPE = new RegExp(TEXTUAL.source, TEXTUAL.flags);
const METHOD = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,20}$/;
const LINE_BREAK = /\r\n|[\r\n\v\f\u0085\u2028\u2029]/;

const stores = new WeakMap();

const sink = {
  started(t, { requestId, request = {}, type }) {
    return {
      requestId, method: request.method, url: String(request.url || '').slice(0, URL_KEPT), type, startedAt: Date.now(),
      status: null, mimeType: '', size: null, failure: null, how: null, endedAt: null,
    };
  },
  response(t, record, { type, frameId, loaderId, response = {} }) {
    record.status = response.status;
    record.mimeType = response.mimeType || '';
    if (type === 'Document' && loaderId && isMainFrame(t, frameId)) {
      const { documents } = storeOf(t);
      documents.set(loaderId, { cf: header(response.headers, 'cf-mitigated'), aws: header(response.headers, 'x-amzn-waf-action') });
      if (documents.size > DOCUMENTS) documents.delete(documents.keys().next().value);
    }
  },
  ended(t, record, how, params) {
    record.how = how;
    record.endedAt = Date.now();
    if (how === 'redirect' && params.redirectResponse) {
      record.status = params.redirectResponse.status;
      record.mimeType = params.redirectResponse.mimeType || '';
    } else if (how === 'finished') {
      record.size = params.encodedDataLength;
    } else if (how === 'failed') {
      record.failure = { errorText: params.errorText, canceled: Boolean(params.canceled), blockedReason: params.blockedReason || null };
    }
    storeOf(t).ring.push(record);
  },
};

function documentSignal(t) {
  const store = stores.get(t);
  const document = store && t.loaderId && store.documents.get(t.loaderId);
  if (!document) return null;
  if (document.cf === 'challenge') return 'cloudflare';
  if (document.aws === 'challenge') return 'aws-challenge';
  if (document.aws === 'captcha') return 'aws-captcha';
  return null;
}

function drop(t) {
  stores.delete(t);
}

// Resolves { head, body } for the network read: the working tab's ended records
// numbered above `after`, then its requests in flight, each kept when `filter` occurs,
// case-insensitively, in its URL or in the URL's percent-encoded form. Under a filter,
// each eligible record's body prints under its line, read as the record prints. The
// list is cut at the first record whose line or body doesn't fit the character budget,
// or whose body the deadline leaves unread.
async function read({ sessions }, session, { filter, after = 0 }, deadline) {
  const t = workingTarget(sessions, session);
  const state = await currentStateLines(sessions, t, { deadline });
  const store = stores.get(t);
  const needle = filter ? filter.toLowerCase() : null;
  const kept = (record) => !needle || record.url.toLowerCase().includes(needle) || safeUrl(record.url).toLowerCase().includes(needle);
  const listing = readAfter(store && store.ring, after);
  const bodyBy = deadline === undefined ? undefined : deadline - BODY_MARGIN_MS;
  const textOf = async (record, used) => {
    const line = entryLine(record);
    if (!needle || !eligible(record)) return line;
    // Chrome is asked for the body only when the record's line leaves room in the
    // budget; otherwise the answer is cut at this record.
    const body = used + line.length < READ_CHARS ? await bodyOf(sessions, t, record, bodyBy) : null;
    return body === null ? null : `${line}\n${body}`;
  };
  const listed = listing.entries.filter(kept);
  const { lines, printed, used, next } = await printEntries(listed, listing.next, textOf);
  if (printed === listed.length) lines.push(...flightLines(requests.inFlight(t).filter(kept), used));
  const echo = filter ? `, filter "${cappedText(filter, 100)}"` : '';
  const head = cursorHead({ state, label: 'Requests', printed, after, filter: echo, kept: `${KEPT} ended`, missed: listing.missed, next });
  return { head, body: lines.join('\n') };
}

// Returns up to IN_FLIGHT_LINES lines of the requests in flight, within what is left
// of the budget, then one line counting the rest. A request in flight has no number to
// resume from, so these lines don't cut the answer.
function flightLines(flying, used) {
  const now = Date.now();
  const lines = [];
  for (const record of flying.slice(0, IN_FLIGHT_LINES)) {
    const text = `[in flight] ${requestText(record)} (${((now - record.startedAt) / 1000).toFixed(1)} s so far)`;
    if (used + text.length > READ_CHARS) break;
    lines.push(text);
    used += text.length + 1;
  }
  if (flying.length > lines.length) lines.push(`… and ${flying.length - lines.length} more in flight`);
  return lines;
}

// Returns an ended record's line, starting at column 0 with its number.
// Fields supplied by the page or server are sanitized to prevent embedded text
// from starting another entry.
function entryLine(record) {
  return `[${record.n}] ${requestText(record)}${ending(record)}`;
}

function requestText({ method, status, type, url }) {
  const shownMethod = METHOD.test(method || '') ? method : '?';
  const shownStatus = Number.isInteger(status) ? status : '—';
  const shownType = letters(type) || 'other';
  return `${shownMethod} ${shownStatus} ${shownType} ${requestUrl(url)}`;
}

function ending(record) {
  if (record.how === 'finished') {
    const details = [];
    if (record.mimeType) details.push(cappedText(record.mimeType, 100));
    if (Number.isFinite(record.size)) details.push(`${Math.round(record.size)} B transferred`);
    details.push(`${record.endedAt - record.startedAt} ms`);
    return ` (${details.join(', ')})`;
  }
  if (record.how === 'failed') {
    const { errorText, canceled, blockedReason } = record.failure;
    const flags = [];
    if (canceled) flags.push('canceled');
    if (blockedReason) flags.push(`blocked: ${cappedText(blockedReason)}`);
    return ` failed: ${cappedText(errorText)}${flags.length ? ` (${flags.join(', ')})` : ''}`;
  }
  return ` (${record.how})`;
}

function requestUrl(url) {
  return cutText(safeUrl(String(url || '')), URL_CHARS);
}

// Returns whether a filtered read prints the record's body: an XHR, fetch, or document
// response that finished with a textual MIME type, or without one, since Chrome's
// base64Encoded flag identifies a binary body.
function eligible(record) {
  return BODY_TYPES.has(record.type) && record.how === 'finished' && (!record.mimeType || TEXTUAL_TYPE.test(record.mimeType));
}

async function bodyOf(sessions, t, record, by) {
  if (by !== undefined && Date.now() >= by) return null;
  let answer;
  try {
    answer = await sessions.send(t.targetId, 'Network.getResponseBody', { requestId: record.requestId }, by === undefined ? {} : { deadline: by });
  } catch (e) {
    if (e instanceof ProtocolError) return '    (body not kept)';
    if (e instanceof TimeoutError) return null;
    throw e;
  }
  if (answer.base64Encoded) return `    (binary body, ${Buffer.from(answer.body || '', 'base64').length} bytes)`;
  const text = String(answer.body || '').replace(RESERVED, '');
  if (!text) return '    (empty body)';
  return cutText(text, BODY_CHARS).split(LINE_BREAK).map((line) => `    ${line}`).join('\n');
}

function header(headers, name) {
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() === name) return String(value).trim().toLowerCase();
  }
  return null;
}

function storeOf(t) {
  let store = stores.get(t);
  if (!store) {
    store = { ring: new Ring(KEPT), documents: new Map() };
    stores.set(t, store);
  }
  return store;
}

module.exports = { sink, documentSignal, drop, read };
