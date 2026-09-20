// Chrome DevTools Protocol client over --remote-debugging-pipe: NUL-delimited JSON
// messages, id correlation, sessionId routing, and event fan-out. The browser writes
// to the stream we read and reads the stream we write; both are unframed byte streams,
// so messages may straddle chunks and several may share one.

class ProtocolError extends Error {
  constructor(method, code, message) {
    super(`${method}: ${message}`);
    this.name = 'ProtocolError';
    this.method = method;
    this.code = code;
    this.protocolMessage = message;
  }
}

class TimeoutError extends Error {
  constructor(method, ms) {
    super(`${method} timed out after ${ms} ms`);
    this.name = 'TimeoutError';
    this.method = method;
  }
}

class ConnectionClosedError extends Error {
  constructor(method) {
    super(`${method}: browser connection closed`);
    this.name = 'ConnectionClosedError';
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;

class Connection {
  // readable: the stream the browser writes to; writable: the one it reads from.
  constructor(readable, writable, log) {
    this.log = log;
    this.closed = false;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.closeHandlers = [];
    this.buffer = '';
    this.readable = readable;
    this.writable = writable;
    readable.setEncoding('utf8');
    readable.on('data', (chunk) => this.onData(chunk));
    // Browser.close ends with ECONNRESET rather than a clean EOF; both mean closed.
    readable.on('end', () => this.onClosed());
    readable.on('error', (e) => this.onClosed(e));
    readable.on('close', () => this.onClosed());
    writable.on('error', (e) => this.onClosed(e));
  }

  // Resolves with the command's result, rejects with ProtocolError for an error reply,
  // TimeoutError past `timeout` ms or the absolute `deadline` (ms epoch), whichever is
  // sooner, and ConnectionClosedError once the pipe is gone.
  send(method, params = {}, { sessionId, timeout = DEFAULT_TIMEOUT_MS, deadline } = {}) {
    if (this.closed) return Promise.reject(new ConnectionClosedError(method));
    const id = this.nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    let ms = timeout;
    if (deadline !== undefined) ms = Math.max(1, Math.min(ms, deadline - Date.now()));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new TimeoutError(method, ms));
      }, ms);
      this.pending.set(id, { method, resolve, reject, timer });
      this.log.debug(`-> ${method}${sessionId ? ` [${sessionId.slice(0, 6)}]` : ''}`);
      this.writable.write(JSON.stringify(message) + '\0');
    });
  }

  // handler(params, sessionId); returns an unsubscribe function.
  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set());
    this.handlers.get(method).add(handler);
    return () => this.handlers.get(method).delete(handler);
  }

  onClose(handler) {
    this.closeHandlers.push(handler);
  }

  close() {
    this.writable.end();
    this.readable.destroy();
    this.onClosed();
  }

  onData(chunk) {
    this.buffer += chunk;
    let start = 0;
    for (;;) {
      const nul = this.buffer.indexOf('\0', start);
      if (nul === -1) break;
      const raw = this.buffer.slice(start, nul);
      start = nul + 1;
      let message;
      try { message = JSON.parse(raw); } catch (e) {
        this.log.warn(`unparseable protocol message: ${raw.slice(0, 200)}`);
        continue;
      }
      this.dispatch(message);
    }
    this.buffer = this.buffer.slice(start);
  }

  dispatch(message) {
    if (message.id !== undefined) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        entry.reject(new ProtocolError(entry.method, message.error.code, message.error.message));
      } else {
        entry.resolve(message.result || {});
      }
      return;
    }
    const handlers = this.handlers.get(message.method);
    if (!handlers) return;
    for (const handler of [...handlers]) {
      try {
        const r = handler(message.params || {}, message.sessionId);
        if (r && typeof r.catch === 'function') r.catch((e) => this.log.error(`handler for ${message.method} failed:`, e));
      } catch (e) {
        this.log.error(`handler for ${message.method} failed:`, e);
      }
    }
  }

  onClosed(err) {
    if (this.closed) return;
    this.closed = true;
    if (err && err.code !== 'ECONNRESET' && err.code !== 'EPIPE') this.log.warn(`pipe error: ${err.message}`);
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new ConnectionClosedError(entry.method));
    }
    this.pending.clear();
    const handlers = this.closeHandlers;
    this.closeHandlers = [];
    for (const handler of handlers) {
      try { handler(err); } catch (e) { this.log.error('close handler failed:', e); }
    }
  }
}

module.exports = { Connection, ProtocolError, TimeoutError, ConnectionClosedError };
