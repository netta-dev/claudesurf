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
const { daemonSocketPath, profileDir, policyFile, actionLogPath } = require('./paths');
const { createLogger } = require('./diagnostics');
const { validate, withDefaults } = require('./dispatch');
const browser = require('./browser');
const { Sessions } = require('./sessions');
const { Policy, normalizeHost } = require('./policy');
const { Gate } = require('./gate');
const { ActionLog } = require('./action-log');
const { respond, failureEnvelope, workingUrl } = require('./respond');
const envelope = require('./envelope');
const { fail } = require('./action-support');
const read = require('./read');
const input = require('./input');
const navigation = require('./navigation');
const consoleCapture = require('./console-capture');
const network = require('./network');
const fetchAction = require('./fetch');
const { tabs } = require('./tabs');
const { Notifier, toolEnv } = require('./notify');
const { Handoff } = require('./handoff');

const log = createLogger('claudesurf daemon');
const SOCK = daemonSocketPath();
const PROFILE = profileDir();
// The bridge's request timeout is 35 s; everything here runs under a deadline inside it.
const REQUEST_BUDGET_MS = 33_000;
const RESTARTED = {
  summary: 'ClaudeSurf restarted',
  body: 'Its browser closed, with any session windows it had open. Each Claude session reopens its window on its next call.',
  urgency: 'normal',
};

let live = null;
let launching = null;
let lastRequestEnv = {};
const sessions = new Sessions(log);
const policy = new Policy({ file: policyFile(), log });
const gate = new Gate({ sessions, policy, log });
const actionLog = new ActionLog({ file: actionLogPath(), log });
const notifier = new Notifier({ log, env: () => toolEnv(process.env, lastRequestEnv) });
const handoff = new Handoff({ notifier, browserPid: () => (live && !live.conn.closed ? live.child.pid : null), log });
gate.onRefusal = (session, entry) => handoff.refused(session, entry);

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
      gate.attach(launched.conn);
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

const context = { sessions, gate, policy, log };

const HANDLERS = {
  page: (ctx, session, a, deadline) => read.readPage(ctx.sessions, session, { scope: a.scope, find: a.find, article: a.article, links: a.links, hidden: a.hidden, since: a.since, maxChars: a.max_chars, offset: a.offset, deadline }),
  info: (ctx, session, a, deadline) => read.pageInfo(ctx.sessions, session, { deadline }),
  screenshot: (ctx, session, a, deadline) => read.screenshot(ctx.sessions, session, { fullPage: a.full_page, deadline }),
  navigate: navigation.navigate,
  history: navigation.history,
  click: input.click,
  scroll: input.scroll,
  type: input.type,
  press: input.press,
  select: input.select,
  tabs,
  console: consoleCapture.read,
  network: network.read,
  fetch: fetchAction.fetch,
};

// Answers a call and writes its action-log record before the answer is sent.
async function runAction(call) {
  const { envelope: built, carried, url, inSlot } = await answer(call);
  actionLog.record({
    sessionId: call.sessionId, tool: call.tool, action: call.action, args: call.args,
    url: inSlot ? url : workingUrl(sessions, sessions.peek(call.sessionId)), outcome: built.outcome, blocked: carried,
  });
  return built;
}

// Resolves { envelope, carried, url, inSlot }: what respond.js or failureEnvelope built,
// and whether the call reached the session's queue slot, where `url` was read before a
// later call could switch tabs.
async function answer({ sessionId, tool, action, args, env }) {
  const invalid = validate(tool, action, args);
  if (invalid) return { envelope: invalid, carried: [], inSlot: false };
  const a = withDefaults(action, args);
  const deadline = Date.now() + REQUEST_BUDGET_MS;
  try {
    // The daemon handles policy without launching the browser or recreating a window
    // that the human closed, and includes pending refusals in the response.
    // The handoff remains open because the human may approve a host during sign-in.
    if (action === 'policy') return await slot(sessions.get(sessionId), [], () => answerPolicy(sessionId, a), { closes: false });
    await ensureBrowser(env);
    const { session, notes } = await sessions.ensureWithNotes(sessionId, { deadline });
    return await slot(session, notes, () => HANDLERS[action](context, session, a, deadline), { ref: a.ref });
  } catch (e) {
    return { ...failureEnvelope(e, sessions, null, { log }), inSlot: false };
  }
}

function slot(session, notes, handler, { ref, closes = true } = {}) {
  return session.run(async () => {
    if (closes) handoff.closed(session.id);
    let result;
    try {
      result = await handler();
    } catch (e) {
      return { ...failureEnvelope(e, sessions, session, { notes, ref, log }), inSlot: true };
    } finally {
      // An acting handler's marks say which refusals its call led to; they belong to
      // that call alone.
      session.marks = null;
    }
    const built = respond(sessions, session, result, { notes });
    if (built.envelope.outcome === 'needs_human') handoff.opened(session, result.challenge, built.url);
    return { ...built, inSlot: true };
  });
}

// Allows `host` as `op` says and returns the Allowed: head. An allow_once grant lasts
// the daemon's lifetime; allow_always appends to the file unless an entry already
// covers the host. The host is the agent's own text, which the payload prints as the
// URL parser normalized it.
function answerPolicy(sessionId, { op, host }) {
  const normalized = normalizeHost(host);
  if (op === 'allow_once') {
    policy.allowOnce(sessionId, host);
    return { head: `Allowed: ${normalized} for this session` };
  }
  let saved;
  try {
    saved = policy.allowAlways(host);
  } catch (e) {
    log.warn(`allowlist ${policyFile()}: ${e.message}`);
    fail(envelope.error(`the allowlist could not be written: ${e.code || 'unknown error'}; nothing was saved`));
  }
  return { head: saved === 'added' ? `Allowed: ${normalized}, saved to the allowlist` : `Allowed: ${normalized} was already allowed` };
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

// The daemon announces a restart after finding a previous browser record, including
// a stale one. The previous browser's windows are lost when it exits or is reaped.
// The daemon sends the notice without awaiting it, using its own environment.
browser.reapOrphan(log).then(({ found }) => {
  if (found) notifier.notify(RESTARTED);
}, (e) => log.warn(`reaping the previous browser: ${e.message}`)).then(listen);
