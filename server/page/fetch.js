// This script runs in the working tab's main-frame isolated world and is sent as
// source by fetch.js. Do not require() this file.
//
// Resolves with a GET response as { status, statusText, contentType, bytes, body, cut },
// or with { redirected: true } or { failed: 'network' | 'timeout' }.
// The request uses the page's cookies, CORS rules, and content security policy.
// It bypasses the HTTP cache and doesn't follow redirects. `timeoutMs` bounds the
// wait for headers and the body.
// A body matching `textual`, mime.js's { source, flags }, is decoded as text and capped
// at `cap` characters. An untyped body is decoded as UTF-8 until an invalid sequence
// is found, then counted as binary. Other bodies are counted as binary from the start.
// Binary counts stop after exceeding 10 MiB. `body` is null for binary responses.
// `cut` indicates that the text or byte count stopped before the body's end.
// `bytes` counts the body's bytes after any Content-Encoding is undone.
async function claudesurfFetch(url, cap, timeoutMs, textual) {
  const BINARY_MAX = 10 * 1024 * 1024;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const failed = () => ({ failed: controller.signal.aborted ? 'timeout' : 'network' });
  try {
    let response;
    try {
      response = await fetch(url, { credentials: 'include', redirect: 'manual', cache: 'no-store', signal: controller.signal });
    } catch {
      return failed();
    }
    if (response.type === 'opaqueredirect') return { redirected: true };
    const contentType = response.headers.get('content-type') || '';
    const answer = { status: response.status, statusText: response.statusText, contentType, bytes: 0, body: null, cut: false };
    if (!response.body) return { ...answer, body: '' };
    let decoder = null;
    if (new RegExp(textual.source, textual.flags).test(contentType)) decoder = textDecoder(contentType);
    else if (!contentType) decoder = new TextDecoder('utf-8', { fatal: true });
    const reader = response.body.getReader();
    let text = '';
    const decode = (chunk) => {
      try {
        text += chunk ? decoder.decode(chunk, { stream: true }) : decoder.decode();
      } catch {
        decoder = null;
      }
    };
    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch {
        return failed();
      }
      if (!chunk.done) answer.bytes += chunk.value.byteLength;
      // The flush at the end turns an unfinished sequence into a character, which can
      // pass the cap too.
      if (decoder) decode(chunk.done ? null : chunk.value);
      if (decoder ? text.length > cap : answer.bytes > BINARY_MAX) {
        answer.cut = true;
        if (!decoder) answer.bytes = BINARY_MAX;
        reader.cancel().catch(() => {});
        break;
      }
      if (chunk.done) break;
    }
    return decoder ? { ...answer, body: capped(text) } : answer;
  } finally {
    clearTimeout(timer);
  }

  // Returns `whole` capped at `cap` characters without splitting a surrogate pair.
  // An unpaired surrogate renders as a replacement character.
  // action-support.js holds the daemon's copy.
  function capped(whole) {
    const code = whole.charCodeAt(cap);
    return whole.slice(0, code >= 0xdc00 && code <= 0xdfff ? cap - 1 : cap);
  }

  function textDecoder(type) {
    const charset = /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(type);
    try {
      return new TextDecoder(charset ? charset[1] : 'utf-8');
    } catch {
      return new TextDecoder('utf-8');
    }
  }
}
