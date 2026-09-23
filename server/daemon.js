#!/usr/bin/env node

// Persistent daemon, one per OS user: owns a dedicated Chrome as its child over
// --remote-debugging-pipe and serves the action API to the per-session bridges.
//
// The command channel (/api + /health) is a Unix domain socket, 0600, in this user's
// runtime directory, so only the same OS user's server.js can send commands; the
// browser is reached over the pipe, so no TCP port is open. Paths and overrides live
// in paths.js.

const http = require('http');
const net = require('net');
const fs = require('fs');
const { daemonSocketPath, profileDir } = require('./paths');
const { createLogger } = require('./diagnostics');
const envelope = require('./envelope');
const { validate, withDefaults } = require('./dispatch');
const browser = require('./browser');
const { Sessions, TargetGoneError } = require('./sessions');
const { OutcomeError, WORKING_TAB_GONE, safeText, LABEL_MAX, codePointBoundary } = require('./action-support');
const read = require('./read');
const input = require('./input');

const log = createLogger('claudesurf daemon');
const SOCK = daemonSocketPath();
const PROFILE = profileDir();
// The bridge's request timeout is 35 s; everything here runs under a deadline inside it.
const REQUEST_BUDGET_MS = 33_000;

const sessions = new Sessions(log);
let live = null; // { conn, child } while the browser is up
let launching = null;
let lastRequestEnv = {};

// A burst of first calls launches one browser. Retains the request's
// graphical environment for child processes spawned later.
function ensureBrowser(requestEnv) {
  if (requestEnv && Object.keys(requestEnv).length) lastRequestEnv = requestEnv;
  if (live && !live.conn.closed) return Promise.resolve(live);
  if (!launching) {
    launching = (async () => {
      const env = browser.graphicalEnv(process.env, lastRequestEnv);
      const binary = browser.locateBinary();
      const launched = await browser.launch({ binary, profileDir: PROFILE, env, log });
      launched.conn.onClose(() => {
        if (live === launched) live = null;
        log.info('browser connection closed');
      });
      sessions.attach(launched.conn);
      try {
        await browser.enableTargets(launched.conn);
      } catch (e) {
        // Window creation needs auto-attach; closing the pipe exits Chrome.
        launched.conn.close();
        throw new browser.BrowserError(`Browser setup failed: ${e.message}`);
      }
      live = launched;
      return launched;
    })().finally(() => { launching = null; });
  }
  return launching;
}

const HANDLERS = {
  page: (session, a, deadline) => read.readPage(sessions, session, { scope: a.scope, find: a.find, article: a.article, links: a.links, hidden: a.hidden, maxChars: a.max_chars, offset: a.offset, deadline }),
  info: (session, a, deadline) => read.pageInfo(sessions, session, { deadline }),
  screenshot: (session, a, deadline) => read.screenshot(sessions, session, { fullPage: a.full_page, deadline }),
  navigate: (session, a, deadline) => input.navigate(sessions, session, { url: a.url, name: a.name, description: a.description, deadline }),
  click: (session, a, deadline) => input.click(sessions, session, a.ref, { trusted: a.trusted, deadline }),
  scroll: (session, a, deadline) => input.scroll(sessions, session, a.direction, a.amount, { deadline }),
};

// A dialog's message is the page's to set, and it lands in the payload outside the
// nonce delimiter's own escaping, so it is made safe the way a marker field is: NUL
// stripped, whitespace collapsed to one line, brackets and backslashes escaped, and
// capped, so a message built to open its own `## Hidden elements` section or a live ref
// marker cannot.
function safeDialogMessage(message) {
  const text = safeText(message);
  if (text.length <= LABEL_MAX) return text;
  return `${text.slice(0, codePointBoundary(text, LABEL_MAX - 1))}…`;
}

function failureEnvelope(e) {
  if (e instanceof OutcomeError) return e.envelope;
  if (e instanceof TargetGoneError) return envelope.error(WORKING_TAB_GONE);
  if (e instanceof browser.SetupError) return envelope.setupError(e.message);
  log.warn(`action failed: ${e.stack || e.message}`);
  return envelope.error(e.message);
}

async function runAction({ sessionId, tool, action, args, env }) {
  const invalid = validate(tool, action, args);
  if (invalid) return invalid;
  const a = withDefaults(action, args);
  const deadline = Date.now() + REQUEST_BUDGET_MS;
  try {
    await ensureBrowser(env);
    const { session, notes } = await sessions.ensureWithNotes(sessionId, { deadline });
    return await session.run(async () => {
      let result;
      try {
        result = await HANDLERS[action](session, a, deadline);
      } catch (e) {
        const failed = failureEnvelope(e);
        if (notes.length) failed.notes = [...notes, ...(failed.notes || [])];
        return failed;
      }
      let payload = result.payload;
      // Chrome delivers a frame's dialog on the page target's session, so the working
      // target's queue holds it; the frame targets are drained with it because each is
      // Page.enabled and a future Chrome may route it there.
      const dialogTargets = [session.workingTargetId, ...sessions.frameTargets(session.workingTargetId).map((f) => f.targetId)];
      for (const targetId of dialogTargets) {
        for (const { type, message } of sessions.takeDialogs(targetId)) {
          notes.push(`a ${type} dialog was dismissed`);
          payload += `\nDialog (${type}): ${safeDialogMessage(message)}`;
        }
      }
      return envelope.success(payload, { notes, images: result.images || [] });
    });
  } catch (e) {
    return failureEnvelope(e);
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body));
  });
}

const server = http.createServer(async (req, res) => {
  const json = (status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  if (req.method === 'POST' && req.url === '/api') {
    let parsed;
    try {
      parsed = JSON.parse(await readBody(req));
      if (typeof parsed.sessionId !== 'string' || parsed.sessionId.length === 0 || parsed.sessionId.length > 100) {
        throw new Error('Invalid or missing sessionId');
      }
    } catch (e) {
      json(400, { error: e.message });
      return;
    }
    json(200, await runAction(parsed));
  } else if (req.method === 'GET' && req.url === '/health') {
    json(200, { status: 'ok', browser: live && !live.conn.closed ? 'running' : 'none', sessions: sessions.count });
  } else {
    res.writeHead(404);
    res.end();
  }
});

function listen() {
  server.once('error', (e) => {
    if (e.code !== 'EADDRINUSE') {
      log.error(`command socket error: ${e.message}`);
      process.exit(1);
    }
    // The socket file exists: a live daemon owns it, or it is left from an unclean
    // exit. Bail if something answers; otherwise unlink and retry once.
    const probe = net.connect(SOCK);
    probe.once('connect', () => {
      probe.destroy();
      log.error(`another daemon is listening on ${SOCK}; exiting`);
      process.exit(1);
    });
    probe.once('error', () => {
      try { fs.unlinkSync(SOCK); } catch { /* gone already */ }
      server.listen(SOCK, onListening);
    });
  });
  server.listen(SOCK, onListening);
}

function onListening() {
  fs.chmodSync(SOCK, 0o600);
  log.info(`listening at ${SOCK} (profile ${PROFILE})`);
}

// Exits without closing the browser; the record stays for the next daemon to reap.
function shutdown() {
  try { fs.unlinkSync(SOCK); } catch { /* gone already */ }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

browser.reapOrphan(log).catch((e) => log.warn(`reaping the previous browser: ${e.message}`)).then(listen);
