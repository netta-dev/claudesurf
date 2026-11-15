// This module sends a GET from the working tab's isolated world using the page's
// cookies, CORS rules, and content security policy. Redirects aren't followed, so the
// request stays on the host checked by the domain gate before sending.
// The handler returns the response without settling, diffing, or detecting challenges.
// The handler doesn't retry after navigation because a retry could send the request
// from another document.

const envelope = require('./envelope');
const { TimeoutError } = require('./cdp');
const { TEXTUAL } = require('./mime');
const { precheck } = require('./navigation');
const { isMissingContext } = require('./sessions');
const { fail, workingTarget, requireHttp, currentStateLines, cappedText, cappedUrl, FETCH_SOURCE, RESERVED } = require('./action-support');

const BODY_CHARS = 40_000;
const FETCH_MS = 20_000;
// What the fetch leaves of the request deadline, and how much longer than the page
// script's own timeout the protocol waits for its answer.
const FETCH_MARGIN_MS = 2_000;
const PROTOCOL_SLACK_MS = 2_000;
// The minimum timeout for the page script. The handler fails before sending the
// request if less time remains after resolving the world and reserving the margin.
const FETCH_MIN_MS = 500;

// Resolves { head, body } with the response to a GET of `url`, { head } for a redirect,
// which isn't followed, or { head, blocked } when the gate refuses its host before
// anything is sent.
async function fetch({ sessions, gate }, session, { url: given }, deadline) {
  // The page's fetch resolves its URL against the document's base URL, which the page
  // sets, so a form such as http:host/path, whose host the gate reads without a base,
  // would reach another host. The absolute form resolves the same against any base.
  const url = new URL(given).href;
  const t = workingTarget(sessions, session);
  requireHttp(t);
  const refused = await precheck(gate, sessions, session, t, url, 'fetch', { deadline });
  if (refused) return refused;
  const generation = t.generation;
  // A commit while the world resolves can leave the resolved world in the new document.
  const executionContextId = await sessions.world(t.targetId, null, { deadline });
  if (t.generation !== generation) fail(envelope.error(`the page navigated before the fetch of ${url}; nothing was sent, so read the page before fetching again`));
  const timeoutMs = deadline === undefined ? FETCH_MS : Math.min(FETCH_MS, deadline - FETCH_MARGIN_MS - Date.now());
  if (timeoutMs < FETCH_MIN_MS) fail(envelope.error(`the call ran out of time before the fetch of ${url}; nothing was sent`));
  const navigated = () => fail(envelope.error(`the page navigated during the fetch of ${url}; the request may have been sent, so read the page before fetching again`));
  let answer;
  try {
    answer = await sessions.callFunction(t.targetId, {
      executionContextId, functionDeclaration: FETCH_SOURCE, args: [url, BODY_CHARS, timeoutMs, TEXTUAL],
    }, { timeout: timeoutMs + PROTOCOL_SLACK_MS, deadline });
  } catch (e) {
    if (t.generation !== generation || isMissingContext(e)) navigated();
    if (e instanceof TimeoutError) fail(envelope.error(`the fetch of ${url} did not answer; the request may have been sent`));
    throw e;
  }
  if (t.generation !== generation) navigated();
  if (answer.failed === 'timeout') fail(envelope.error(`the request to ${url} timed out after ${Number((timeoutMs / 1000).toFixed(1))} s`));
  if (answer.failed) fail(envelope.error(failure(url, t.url)));
  const head = [await currentStateLines(sessions, t, { deadline }), `Fetched: ${cappedUrl(url)}`];
  if (answer.redirected) {
    head.push('Redirected: not followed; navigate to the URL to follow it through the domain gate');
    return { head: head.join('\n') };
  }
  head.push(statusLine(answer));
  if (answer.body !== null && answer.cut) head.push(`Body: the first ${answer.body.length} characters; the response is longer`);
  return { head: head.join('\n'), body: answer.body === null ? '' : answer.body.replace(RESERVED, '') };
}

function statusLine({ status, statusText, contentType, bytes, body, cut }) {
  const text = statusText ? ` ${cappedText(statusText, 100)}` : '';
  const type = contentType ? cappedText(contentType, 100) : 'no type';
  let size;
  if (body === null) size = `${cut ? 'over 10 MiB' : `${bytes} bytes`}; binary, not shown`;
  else size = cut ? `at least ${bytes} bytes` : `${bytes} bytes`;
  return `Status: ${Number.isInteger(status) ? status : '—'}${text} (${type}, ${size})`;
}

// Returns the message of a request that failed on the network, or that CORS or the
// page's content security policy refused. For a URL of another origin than the page's,
// the message names the way to read it with that origin's cookies.
function failure(url, pageUrl) {
  if (origin(url) !== origin(pageUrl)) {
    return `the request to ${url} failed: its server didn't allow this page's origin to read it (CORS), the page's content security policy refused it, or the network failed; to read it with that origin's cookies, navigate to its origin and fetch there`;
  }
  return `the request to ${url} failed: the page's content security policy refused it, or the network failed`;
}

function origin(url) {
  try { return new URL(url).origin; } catch { return null; }
}

module.exports = { fetch };
