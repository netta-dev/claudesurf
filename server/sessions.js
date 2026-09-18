// Per-session state and the target registry. A Session owns one Chrome window with an
// identity tab and a working tab; every handler reaches its targets through this
// registry, which also tracks each target's window, document generation, isolated
// world, load events, and dismissed dialogs.
//
// Lifecycle: `attach(conn)` after every launch; `ensure(sessionId)` before every
// action, which creates or repairs the window; target destruction marks the session
// so the next `ensure` repairs it; pipe EOF drops every window and target while
// labels survive.

const path = require('path');
const { pathToFileURL } = require('url');
const { ProtocolError, TimeoutError } = require('./cdp');

const SESSION_PAGE = pathToFileURL(path.join(__dirname, 'static', 'session.html')).href;
const WINDOW_TIMEOUT_MS = 5_000;
const CTRL_MODIFIER = 2;
const CROSS_DOCUMENT = new Set(['differentDocument', 'historyDifferentDocument', 'reload', 'reloadBypassingCache', 'restore', 'restoreWithPost']);

class TargetGoneError extends Error {
  constructor(targetId) { super(`target ${targetId} is gone`); this.name = 'TargetGoneError'; }
}

class Session {
  constructor(id) {
    this.id = id;
    this.windowId = null;
    this.identityTargetId = null;
    this.workingTargetId = null;
    this.label = null;
    this.startedAt = null;
    this.notes = [];
    // targetId → { generation, ids: Set<backendNodeId> }
    this.refs = new Map();
    // page-opened targets attributed to this session by opener
    this.opened = new Set();
    this.chain = Promise.resolve();
  }

  // Serializes work on this session; the returned promise settles with fn's result.
  run(fn) {
    const next = this.chain.then(fn, fn);
    this.chain = next.then(() => undefined, () => undefined);
    return next;
  }

  takeNotes() {
    const notes = this.notes;
    this.notes = [];
    return notes;
  }

  get name() { return this.label ? this.label.name : null; }
}

function parseSessionPage(url) {
  if (!url || !url.startsWith(SESSION_PAGE)) return null;
  const [base, fragment = ''] = url.split('#');
  if (base !== SESSION_PAGE) return null;
  const params = new URLSearchParams(fragment);
  const role = params.get('role');
  const session = params.get('session');
  if (!session || (role !== 'identity' && role !== 'working')) return null;
  return { role, session };
}

class Sessions {
  constructor(log) {
    this.log = log;
    this.conn = null;
    this.sessions = new Map();
    this.targets = new Map();
    this.roleWaiters = new Map();
  }

  get count() { return this.sessions.size; }

  attach(conn) {
    this.conn = conn;
    conn.on('Target.attachedToTarget', (p) => this.onAttached(p));
    conn.on('Target.detachedFromTarget', (p) => this.onDestroyed(p.targetId));
    conn.on('Target.targetDestroyed', (p) => this.onDestroyed(p.targetId));
    conn.on('Page.frameNavigated', (p, sid) => this.onFrameNavigated(p, sid));
    conn.on('Page.frameStartedNavigating', (p, sid) => this.onNavigationStarted(p, sid));
    conn.on('Page.loadEventFired', (p, sid) => this.onLoad(sid));
    conn.on('Page.downloadWillBegin', (p, sid) => this.onDownload(sid));
    conn.on('Page.javascriptDialogOpening', (p, sid) => this.onDialog(p, sid));
    conn.onClose(() => this.dropAll());
  }

  get(sessionId) {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = new Session(sessionId);
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  // The session with a usable working tab, creating or repairing the window under the
  // session's queue so overlapping first calls create one window. Anything recreated
  // leaves a note on the session.
  ensure(sessionId, { deadline } = {}) {
    const session = this.get(sessionId);
    return session.run(async () => {
      if (session.workingTargetId && this.targets.has(session.workingTargetId)) return session;
      const identity = session.identityTargetId && this.targets.get(session.identityTargetId);
      const page = identity && parseSessionPage(identity.url);
      if (identity && page && page.role === 'identity' && page.session === session.id) {
        await this.openWorkingTab(session, identity, deadline);
        session.notes.push('working tab was recreated');
      } else {
        const had = session.startedAt !== null;
        await this.createWindow(session, deadline);
        if (had) session.notes.push(session.label ? 'session window was recreated under its retained name' : 'session window was recreated');
      }
      return session;
    });
  }

  // Stores the label and re-renders the identity page if present.
  async setLabel(session, name, description) {
    const previous = session.label || { name: '', description: '' };
    session.label = {
      name: name.trim(),
      description: description === undefined ? previous.description : description,
    };
    const identity = session.identityTargetId && this.targets.get(session.identityTargetId);
    if (identity && parseSessionPage(identity.url)) await this.render(identity.targetId, session.label);
  }

  target(targetId) {
    return this.targets.get(targetId) || null;
  }

  // Sends a command on the target's protocol session.
  send(targetId, method, params = {}, opts = {}) {
    const t = this.targets.get(targetId);
    if (!t) return Promise.reject(new TargetGoneError(targetId));
    return this.conn.send(method, params, { ...opts, sessionId: t.cdpSessionId });
  }

  // The isolated world for the target's current document, created on first use.
  async world(targetId, opts = {}) {
    const t = this.targets.get(targetId);
    if (!t) throw new TargetGoneError(targetId);
    if (t.world && t.world.generation === t.generation) return t.world.contextId;
    const generation = t.generation;
    const { executionContextId } = await this.send(targetId, 'Page.createIsolatedWorld', {
      frameId: t.mainFrameId || targetId, worldName: 'claudesurf',
    }, opts);
    t.world = { generation, contextId: executionContextId };
    return executionContextId;
  }

  invalidateWorld(targetId) {
    const t = this.targets.get(targetId);
    if (t) t.world = null;
  }

  // Runs a page-side function (sent as source) in the target's isolated world and
  // returns its value. A world the document has discarded is recreated once.
  async callInWorld(targetId, functionDeclaration, args = [], opts = {}) {
    for (let attempt = 0; ; attempt++) {
      const executionContextId = await this.world(targetId, opts);
      try {
        return await this.callFunction(targetId, { executionContextId, functionDeclaration, args }, opts);
      } catch (e) {
        if (attempt === 0 && isMissingContext(e)) { this.invalidateWorld(targetId); continue; }
        throw e;
      }
    }
  }

  // Runtime.callFunctionOn with arguments passed as values, returning the result by
  // value; a thrown page exception becomes an Error.
  async callFunction(targetId, { executionContextId, objectId, functionDeclaration, args = [], userGesture = false }, opts = {}) {
    const params = {
      functionDeclaration, returnByValue: true, awaitPromise: true, userGesture,
      arguments: args.map((value) => (value && value.objectId ? { objectId: value.objectId } : { value })),
    };
    if (objectId) params.objectId = objectId; else params.executionContextId = executionContextId;
    const r = await this.send(targetId, 'Runtime.callFunctionOn', params, opts);
    if (r.exceptionDetails) {
      const text = r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text;
      throw new Error(`page script failed: ${text}`);
    }
    return r.result ? r.result.value : undefined;
  }

  // Resolves once the target has fired more load events than `since`.
  waitForLoad(targetId, since, { timeout = 10_000, deadline } = {}) {
    const t = this.targets.get(targetId);
    if (!t) return Promise.reject(new TargetGoneError(targetId));
    if (t.loads > since) return Promise.resolve();
    let ms = timeout;
    if (deadline !== undefined) ms = Math.max(1, Math.min(ms, deadline - Date.now()));
    return new Promise((resolve, reject) => {
      const waiter = { since, resolve, reject, timer: setTimeout(() => {
        t.loadWaiters.delete(waiter);
        reject(new TimeoutError('waiting for the page to load', ms));
      }, ms) };
      t.loadWaiters.add(waiter);
    });
  }

  takeDialogs(targetId) {
    const t = this.targets.get(targetId);
    if (!t) return [];
    const dialogs = t.dialogs;
    t.dialogs = [];
    return dialogs;
  }

  // Pipe EOF: every window and target is gone; labels survive.
  dropAll() {
    for (const t of this.targets.values()) this.failWaiters(t);
    this.targets.clear();
    for (const session of this.sessions.values()) {
      session.windowId = null;
      session.identityTargetId = null;
      session.workingTargetId = null;
      session.refs.clear();
      session.opened.clear();
    }
    for (const [key, waiters] of this.roleWaiters) {
      for (const w of waiters) w.reject(new Error('browser connection closed'));
      this.roleWaiters.delete(key);
    }
  }

  sessionPageUrl(session, role) {
    const params = new URLSearchParams({ role, session: session.id, started: session.startedAt });
    return `${SESSION_PAGE}#${params}`;
  }

  async createWindow(session, deadline) {
    const limit = deadline === undefined ? Date.now() + WINDOW_TIMEOUT_MS : Math.min(deadline, Date.now() + WINDOW_TIMEOUT_MS);
    const opts = { deadline: limit };
    this.disown(session);
    if (!session.startedAt) session.startedAt = new Date().toISOString();
    const working = this.waitForRole(session, 'working', opts);
    await this.conn.send('Target.createTarget', {
      url: this.sessionPageUrl(session, 'working'), newWindow: true, background: true,
    }, opts);
    const workingId = await working;
    await this.waitForLoad(workingId, 0, opts);
    session.windowId = this.targets.get(workingId).windowId;
    // Only a real pointer event carries the Ctrl modifier that makes the new tab a
    // background one, so the working tab stays the window's active tab.
    const identity = this.waitForRole(session, 'identity', opts);
    await this.ctrlClick(workingId, 'identity-link', opts);
    const identityId = await identity;
    await this.waitForLoad(identityId, 0, opts);
    if (session.label) {
      await this.render(identityId, session.label, opts);
      await this.render(workingId, session.label, opts);
    }
    this.log.info(`session ${session.id.slice(0, 8)}: window ${session.windowId} created`);
  }

  // The human closed the working tab: a scripted click with a user gesture on the
  // identity page's working link opens a foreground tab in that window.
  async openWorkingTab(session, identity, deadline) {
    const limit = deadline === undefined ? Date.now() + WINDOW_TIMEOUT_MS : Math.min(deadline, Date.now() + WINDOW_TIMEOUT_MS);
    const opts = { deadline: limit };
    // The human can drag a tab into another window.
    const { windowId } = await this.conn.send('Browser.getWindowForTarget', { targetId: identity.targetId }, opts);
    identity.windowId = windowId;
    session.windowId = windowId;
    const working = this.waitForRole(session, 'working', opts);
    const link = await this.pageElement(identity.targetId, 'working-link', opts);
    await this.callFunction(identity.targetId, { objectId: link, functionDeclaration: 'function () { this.click(); }', userGesture: true }, opts);
    const workingId = await working;
    await this.waitForLoad(workingId, 0, opts);
    if (session.label) await this.render(workingId, session.label, opts);
    this.log.info(`session ${session.id.slice(0, 8)}: working tab recreated in window ${windowId}`);
  }

  // Drops every target the session owned before a window is recreated: an identity tab
  // that was navigated away stays open but unowned; page-opened targets likewise.
  disown(session) {
    for (const id of [session.identityTargetId, session.workingTargetId, ...session.opened]) {
      const t = id && this.targets.get(id);
      if (t) { t.role = null; t.sessionId = null; }
    }
    session.identityTargetId = null;
    session.workingTargetId = null;
    session.opened.clear();
    session.refs.clear();
  }

  waitForRole(session, role, { deadline }) {
    const key = `${session.id}:${role}`;
    const ms = Math.max(1, deadline - Date.now());
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: setTimeout(() => {
        this.roleWaiters.get(key).delete(waiter);
        reject(new TimeoutError(`waiting for the ${role} tab`, ms));
      }, ms) };
      if (!this.roleWaiters.has(key)) this.roleWaiters.set(key, new Set());
      this.roleWaiters.get(key).add(waiter);
    });
  }

  // Claims a target for a session role when its URL is that session's page, else
  // attributes it to the session owning its opener.
  claim(t) {
    const page = parseSessionPage(t.url);
    if (page) {
      const session = this.get(page.session);
      if (t.role === 'opened' && t.sessionId) this.get(t.sessionId).opened.delete(t.targetId);
      const field = `${page.role}TargetId`;
      if (session[field] && session[field] !== t.targetId && this.targets.has(session[field])) {
        // A second tab of the same role (the human duplicated one): leave it unowned.
        return;
      }
      t.role = page.role;
      t.sessionId = session.id;
      session[field] = t.targetId;
      if (session.windowId === null) session.windowId = t.windowId;
      const key = `${session.id}:${page.role}`;
      const waiters = this.roleWaiters.get(key);
      if (waiters) {
        this.roleWaiters.delete(key);
        for (const w of waiters) { clearTimeout(w.timer); w.resolve(t.targetId); }
      }
      return;
    }
    if (t.role !== null) return;
    const opener = t.openerId && this.targets.get(t.openerId);
    if (opener && opener.sessionId) {
      t.role = 'opened';
      t.sessionId = opener.sessionId;
      this.get(opener.sessionId).opened.add(t.targetId);
    }
  }

  async onAttached({ sessionId: cdpSessionId, targetInfo, waitingForDebugger }) {
    const { targetId } = targetInfo;
    if (targetInfo.type !== 'page') {
      if (waitingForDebugger) this.conn.send('Runtime.runIfWaitingForDebugger', {}, { sessionId: cdpSessionId }).catch(() => {});
      return;
    }
    const t = {
      targetId, cdpSessionId, url: targetInfo.url || '', openerId: targetInfo.openerId || null,
      windowId: null, generation: 0, role: null, sessionId: null, world: null, mainFrameId: null,
      loads: 0, navigations: 0, downloads: 0, loadWaiters: new Set(), dialogs: [],
    };
    this.targets.set(targetId, t);
    const opts = { sessionId: cdpSessionId };
    let released = false;
    const release = () => {
      if (released || !waitingForDebugger) return;
      released = true;
      this.conn.send('Runtime.runIfWaitingForDebugger', {}, opts).catch(() => {});
    };
    try {
      // The preparation commands are queued ahead of the release on the target's
      // session; awaiting them first would deadlock on a tab whose first document has
      // not committed (a noopener link target), where Page.enable answers only after
      // the commit the pause holds back.
      const window = this.conn.send('Browser.getWindowForTarget', { targetId });
      const enabled = this.conn.send('Page.enable', {}, opts);
      const focused = this.conn.send('Emulation.setFocusEmulationEnabled', { enabled: true }, opts);
      release();
      t.windowId = (await window).windowId;
      await enabled;
      await focused;
      if (!t.url) {
        // Attached before its first navigation; the frameNavigated may have preceded Page.enable.
        const { frameTree } = await this.conn.send('Page.getFrameTree', {}, opts);
        t.mainFrameId = frameTree.frame.id;
        t.url = frameTree.frame.url + (frameTree.frame.urlFragment || '');
      }
      if (this.targets.get(targetId) === t) this.claim(t);
    } catch (e) {
      this.log.warn(`preparing target ${targetId}: ${e.message}`);
    } finally {
      // A target left paused wedges its page load.
      release();
    }
  }

  onDestroyed(targetId) {
    const t = this.targets.get(targetId);
    if (!t) return;
    this.targets.delete(targetId);
    this.failWaiters(t);
    if (!t.sessionId) return;
    const session = this.get(t.sessionId);
    if (t.role === 'working') session.workingTargetId = null;
    if (t.role === 'identity') session.identityTargetId = null;
    if (t.role === 'opened') session.opened.delete(targetId);
    session.refs.delete(targetId);
    if (session.workingTargetId === null && session.identityTargetId === null) {
      // The window is gone; its state goes with it and the label stays.
      this.disown(session);
      session.windowId = null;
      this.log.info(`session ${session.id.slice(0, 8)}: window closed`);
    }
  }

  onFrameNavigated({ frame }, cdpSessionId) {
    const t = this.byCdpSession(cdpSessionId);
    if (!t || frame.parentId) return;
    t.mainFrameId = frame.id;
    t.url = frame.url + (frame.urlFragment || '');
    t.generation += 1;
    t.world = null;
    if (t.role === null || t.role === 'opened') this.claim(t);
  }

  onNavigationStarted({ frameId, navigationType }, cdpSessionId) {
    const t = this.byCdpSession(cdpSessionId);
    if (!t) return;
    const main = frameId === t.mainFrameId || frameId === t.targetId;
    if (main && CROSS_DOCUMENT.has(navigationType)) t.navigations += 1;
  }

  onLoad(cdpSessionId) {
    const t = this.byCdpSession(cdpSessionId);
    if (!t) return;
    t.loads += 1;
    for (const w of [...t.loadWaiters]) {
      if (t.loads > w.since) { t.loadWaiters.delete(w); clearTimeout(w.timer); w.resolve(); }
    }
  }

  onDownload(cdpSessionId) {
    const t = this.byCdpSession(cdpSessionId);
    if (t) t.downloads += 1;
  }

  onDialog({ type, message }, cdpSessionId) {
    const t = this.byCdpSession(cdpSessionId);
    if (!t) return;
    t.dialogs.push({ type, message });
    // beforeunload is accepted so a close the human started goes through.
    this.conn.send('Page.handleJavaScriptDialog', { accept: type === 'beforeunload' }, { sessionId: cdpSessionId })
      .catch((e) => this.log.warn(`dismissing ${type} dialog: ${e.message}`));
  }

  byCdpSession(cdpSessionId) {
    for (const t of this.targets.values()) if (t.cdpSessionId === cdpSessionId) return t;
    return null;
  }

  failWaiters(t) {
    for (const w of t.loadWaiters) { clearTimeout(w.timer); w.reject(new TargetGoneError(t.targetId)); }
    t.loadWaiters.clear();
  }

  async pageElement(targetId, elementId, opts) {
    const { result } = await this.send(targetId, 'Runtime.evaluate', { expression: `document.getElementById(${JSON.stringify(elementId)})` }, opts);
    if (!result.objectId) throw new Error(`session page has no element ${elementId}`);
    return result.objectId;
  }

  async ctrlClick(targetId, elementId, opts) {
    const objectId = await this.pageElement(targetId, elementId, opts);
    const { quads } = await this.send(targetId, 'DOM.getContentQuads', { objectId }, opts);
    if (!quads || !quads.length) throw new Error(`session page element ${elementId} has no layout`);
    const [x1, y1, , , x2, y2] = quads[0];
    const x = (x1 + x2) / 2;
    const y = (y1 + y2) / 2;
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await this.send(targetId, 'Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, modifiers: CTRL_MODIFIER }, opts);
    }
  }

  // The one main-world call: the session page's own render function, with the label
  // passed as arguments rather than interpolated.
  async render(targetId, label, opts = {}) {
    try {
      const { result } = await this.send(targetId, 'Runtime.evaluate', { expression: 'window' }, opts);
      await this.callFunction(targetId, {
        objectId: result.objectId,
        functionDeclaration: 'function (name, description) { render(name, description); }',
        args: [label.name, label.description || ''],
      }, opts);
    } catch (e) {
      this.log.warn(`rendering label on ${targetId}: ${e.message}`);
    }
  }
}

function isMissingContext(e) {
  return e instanceof ProtocolError && /context/i.test(e.protocolMessage || '');
}

module.exports = { Sessions, Session, TargetGoneError, SESSION_PAGE, parseSessionPage };
