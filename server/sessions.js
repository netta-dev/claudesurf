// Per-session state and the target registry. A Session owns one Chrome window with an
// identity tab and a working tab; every handler reaches its targets through this
// registry, which also tracks each target's window, document generation, isolated
// worlds, navigation, load, and download counts, and dismissed dialogs.
//
// An out-of-process child frame attaches as its own target and is recorded like a
// page, with `type: 'iframe'`, the parent target whose protocol session delivered its
// attach, and a frame number taken from its root page's counter, which never
// reassigns one.
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
const MAX_DIALOGS = 20;
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
    // Set when window creation got the working tab up but not the identity tab;
    // ensure retries the identity tab. An identity tab the human closes stays closed.
    this.identityFailed = false;
    this.notes = [];
    // targetId → { generation, ids: Map<backendNodeId, frameId | null> }
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
    conn.on('Target.attachedToTarget', (p, sid) => this.onAttached(p, sid));
    conn.on('Target.detachedFromTarget', (p) => this.onDestroyed(p.targetId));
    conn.on('Target.targetDestroyed', (p) => this.onDestroyed(p.targetId));
    conn.on('Page.frameNavigated', (p, sid) => this.onFrameNavigated(p, sid));
    conn.on('Page.frameStartedNavigating', (p, sid) => this.onNavigationStarted(p, sid));
    conn.on('Page.loadEventFired', (p, sid) => this.onLoad(sid));
    conn.on('Page.navigatedWithinDocument', (p, sid) => this.onSameDocument(sid));
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
      await this.repair(session, deadline);
      return session;
    });
  }

  // ensure, plus the notes taken in the same queue slot, so a repair note reaches
  // only the request whose ensure made it.
  ensureWithNotes(sessionId, { deadline } = {}) {
    const session = this.get(sessionId);
    return session.run(async () => {
      await this.repair(session, deadline);
      return { session, notes: session.takeNotes() };
    });
  }

  async repair(session, deadline) {
    const working = session.workingTargetId && this.targets.get(session.workingTargetId);
    if (working) {
      if (!session.identityFailed || session.identityTargetId !== null) {
        session.identityFailed = false;
        return;
      }
      // The identity tab gets one retry. The working tab is usable either way, so a
      // second failure, or a working tab that has left the session page and taken the
      // link with it, leaves the identity tab absent, as when the human closes it.
      let reopened = false;
      if (parseSessionPage(working.url)) {
        try {
          await this.openIdentityTab(session, working.targetId, deadline);
          reopened = true;
        } catch (e) {
          this.log.warn(`session ${session.id.slice(0, 8)}: reopening the identity tab: ${e.message}`);
        }
      }
      session.identityFailed = false;
      session.notes.push(reopened ? 'identity tab was recreated' : 'identity tab could not be recreated; it returns with the next window');
      return;
    }
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

  // Every live iframe target whose parent chain reaches this page, in attach order.
  frameTargets(pageTargetId) {
    const page = this.targets.get(pageTargetId);
    if (!page) return [];
    return [...this.targets.values()].filter((t) => t.type === 'iframe' && this.rootPage(t) === page);
  }

  // The iframe target carrying frame number `n` under this page, or null once it is
  // gone; a number is never reassigned, so a ref keeps naming the frame it was read in.
  frameTarget(pageTargetId, n) {
    return this.frameTargets(pageTargetId).find((t) => t.frameNumber === n) || null;
  }

  // Sends a command on the target's protocol session.
  send(targetId, method, params = {}, opts = {}) {
    const t = this.targets.get(targetId);
    if (!t) return Promise.reject(new TargetGoneError(targetId));
    return this.conn.send(method, params, { ...opts, sessionId: t.cdpSessionId });
  }

  // The isolated world of one document of this target: its main frame when `frameId`
  // is null, else the child frame that id names, which a same-process frame answers on
  // its parent's protocol session. Created on first use and kept per frame and
  // generation.
  async world(targetId, frameId = null, opts = {}) {
    return (await this.worldRecord(targetId, frameId, opts)).contextId;
  }

  // Runs `fn(contextId, world)` in that world, once more with a recreated world when
  // the document discarded the old one; `world` carries the injected-libraries flag,
  // which a recreated world clears. A same-process frame that navigated on its own
  // leaves no generation behind, so the retry notices the stale world.
  async withWorld(targetId, frameId, fn, opts = {}) {
    for (let attempt = 0; ; attempt++) {
      const world = await this.worldRecord(targetId, frameId, opts);
      try {
        return await fn(world.contextId, world);
      } catch (e) {
        if (attempt === 0 && isMissingContext(e)) { this.invalidateWorld(targetId, frameId); continue; }
        throw e;
      }
    }
  }

  // The target's window id, read from the browser when the attach handler has not
  // recorded it yet (a target claimed on its first navigation can get there first).
  async windowOf(targetId, opts = {}) {
    const t = this.targets.get(targetId);
    if (!t) throw new TargetGoneError(targetId);
    if (t.windowId === null) {
      const { windowId } = await this.conn.send('Browser.getWindowForTarget', { targetId }, opts);
      t.windowId = windowId;
    }
    return t.windowId;
  }

  invalidateWorld(targetId, frameId = null) {
    const t = this.targets.get(targetId);
    if (t) t.worlds.delete(this.frameKey(t, frameId));
  }

  // Runs a page-side function (sent as source) in the main frame's isolated world and
  // returns its value.
  callInWorld(targetId, functionDeclaration, args = [], opts = {}) {
    return this.withWorld(targetId, null, (executionContextId) => (
      this.callFunction(targetId, { executionContextId, functionDeclaration, args }, opts)
    ), opts);
  }

  async worldRecord(targetId, frameId, opts) {
    const t = this.targets.get(targetId);
    if (!t) throw new TargetGoneError(targetId);
    const frame = this.frameKey(t, frameId);
    const cached = t.worlds.get(frame);
    if (cached && cached.generation === t.generation) return cached;
    const generation = t.generation;
    const { executionContextId } = await this.send(targetId, 'Page.createIsolatedWorld', { frameId: frame, worldName: 'claudesurf' }, opts);
    const world = { generation, contextId: executionContextId, injected: false };
    t.worlds.set(frame, world);
    return world;
  }

  // A target's main frame id equals its target id until its first frameNavigated
  // records the frame.
  frameKey(t, frameId) {
    return frameId || t.mainFrameId || t.targetId;
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

  // Resolves true once `predicate(target)` holds, checked now and after every event
  // the registry counts on the target (navigation start, load, download, a target
  // attributed to its session), false after `timeout` ms or at `deadline`; rejects
  // with TargetGoneError when the target is destroyed or the pipe closes.
  waitUntil(targetId, predicate, { timeout = 10_000, deadline } = {}) {
    const t = this.targets.get(targetId);
    if (!t) return Promise.reject(new TargetGoneError(targetId));
    if (predicate(t)) return Promise.resolve(true);
    const ms = budget(timeout, deadline);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: setTimeout(() => {
        t.waiters.delete(waiter);
        resolve(false);
      }, ms) };
      t.waiters.add(waiter);
    });
  }

  // Resolves once the target has fired more load events than `since`; TimeoutError
  // otherwise.
  async waitForLoad(targetId, since, { timeout = 10_000, deadline } = {}) {
    const ms = budget(timeout, deadline);
    const loaded = await this.waitUntil(targetId, (t) => t.loads > since, { timeout: ms });
    if (!loaded) throw new TimeoutError('waiting for the page to load', ms);
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
      for (const w of waiters) { clearTimeout(w.timer); w.reject(new Error('browser connection closed')); }
      this.roleWaiters.delete(key);
    }
  }

  sessionPageUrl(session, role, startedAt) {
    const params = new URLSearchParams({ role, session: session.id, started: startedAt });
    return `${SESSION_PAGE}#${params}`;
  }

  windowBudget(deadline) {
    const limit = deadline === undefined ? Date.now() + WINDOW_TIMEOUT_MS : Math.min(deadline, Date.now() + WINDOW_TIMEOUT_MS);
    return { deadline: limit };
  }

  async createWindow(session, deadline) {
    const opts = this.windowBudget(deadline);
    this.disown(session);
    session.identityFailed = false;
    const startedAt = session.startedAt || new Date().toISOString();
    const working = this.waitForRole(session, 'working', opts);
    await this.conn.send('Target.createTarget', {
      url: this.sessionPageUrl(session, 'working', startedAt), newWindow: true, background: true,
    }, opts);
    const workingId = await working;
    await this.waitForLoad(workingId, 0, opts);
    session.windowId = await this.windowOf(workingId, opts);
    // The window exists from here; a failure before this point leaves startedAt
    // unset so the retry does not report a recreation.
    session.startedAt = startedAt;
    await this.openIdentityTab(session, workingId, opts.deadline);
    if (session.label) await this.render(workingId, session.label, opts);
    this.log.info(`session ${session.id.slice(0, 8)}: window ${session.windowId} created`);
  }

  // Opens the identity tab from the working tab's identity link. Only a real pointer
  // event carries the Ctrl modifier that makes the new tab a background one, so the
  // working tab stays the window's active tab.
  async openIdentityTab(session, workingId, deadline) {
    const opts = this.windowBudget(deadline);
    session.identityFailed = true;
    // The human can drag a tab into another window.
    const { windowId } = await this.conn.send('Browser.getWindowForTarget', { targetId: workingId }, opts);
    this.targets.get(workingId).windowId = windowId;
    session.windowId = windowId;
    const identity = this.waitForRole(session, 'identity', opts);
    await this.ctrlClick(workingId, 'identity-link', opts);
    const identityId = await identity;
    await this.waitForLoad(identityId, 0, opts);
    session.identityFailed = false;
    if (session.label) await this.render(identityId, session.label, opts);
  }

  // The human closed the working tab: a scripted click with a user gesture on the
  // identity page's working link opens a foreground tab in that window.
  async openWorkingTab(session, identity, deadline) {
    const opts = this.windowBudget(deadline);
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

  // Resolves with the target id claimed for the role; TimeoutError at the deadline.
  // A caller that gave up before the timer fired has nothing to catch, so the
  // rejection is marked handled here.
  waitForRole(session, role, { deadline }) {
    const key = `${session.id}:${role}`;
    const ms = Math.max(1, deadline - Date.now());
    const promise = new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: setTimeout(() => {
        const waiters = this.roleWaiters.get(key);
        waiters.delete(waiter);
        if (waiters.size === 0) this.roleWaiters.delete(key);
        reject(new TimeoutError(`waiting for the ${role} tab`, ms));
      }, ms) };
      if (!this.roleWaiters.has(key)) this.roleWaiters.set(key, new Set());
      this.roleWaiters.get(key).add(waiter);
    });
    promise.catch(() => {});
    return promise;
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
      this.notify(opener);
    }
  }

  // `deliveredOn` is the protocol session the event arrived on: the parent target's
  // for an out-of-process child frame under flatten, and none for a page target.
  async onAttached({ sessionId: cdpSessionId, targetInfo, waitingForDebugger }, deliveredOn) {
    const { targetId, type } = targetInfo;
    const opts = { sessionId: cdpSessionId };
    let released = false;
    const release = () => {
      if (released || !waitingForDebugger) return;
      released = true;
      this.conn.send('Runtime.runIfWaitingForDebugger', {}, opts).catch(() => {});
    };
    const t = {
      targetId, cdpSessionId, type, url: targetInfo.url || '', openerId: targetInfo.openerId || null,
      windowId: null, generation: 0, role: null, sessionId: null, worlds: new Map(), mainFrameId: null,
      loads: 0, navigations: 0, downloads: 0, sameDocument: 0, waiters: new Set(), dialogs: [],
    };
    if (type === 'page') {
      t.nextFrameNumber = 1;
    } else if (type === 'iframe') {
      const parent = this.byCdpSession(deliveredOn);
      const root = parent && this.rootPage(parent);
      // A frame whose parent chain reaches no page target belongs to no session and
      // no read; it is released and left unrecorded.
      if (!root) { release(); return; }
      t.parentTargetId = parent.targetId;
      t.frameNumber = root.nextFrameNumber++;
      // Chrome numbers an out-of-process frame's own frame with its target id.
      t.mainFrameId = targetId;
    } else {
      release();
      return;
    }
    this.targets.set(targetId, t);
    try {
      // The preparation commands are queued ahead of the release on the target's
      // session; awaiting them first would deadlock on a tab whose first document has
      // not committed (a noopener link target), where Page.enable answers only after
      // the commit the pause holds back.
      const page = type === 'page';
      const window = page ? this.conn.send('Browser.getWindowForTarget', { targetId }) : null;
      const enabled = this.conn.send('Page.enable', {}, opts);
      // Out-of-process child frames surface through this per-target call only; the
      // browser-level one reaches page targets alone.
      const attaching = this.conn.send('Target.setAutoAttach', {
        autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'iframe' }],
      }, opts);
      // Focus emulation lifts an input stall on a tab that is not its window's active
      // one. Frames take scripted clicks, which never stall, so they go without.
      const focused = page ? this.conn.send('Emulation.setFocusEmulationEnabled', { enabled: true }, opts) : null;
      release();
      // Every queued command is settled together: a wedged renderer makes several of
      // them time out, and a rejection left unawaited while another is reported would
      // take the daemon down as an unhandled rejection.
      const queued = await Promise.allSettled([window, enabled, attaching, focused]);
      if (queued[0].status === 'fulfilled' && queued[0].value) t.windowId = queued[0].value.windowId;
      const failed = queued.find((outcome) => outcome.status === 'rejected');
      if (failed) throw failed.reason;
      if (!t.url && page) {
        // Attached before its first navigation; the frameNavigated may have preceded
        // Page.enable, and a page target's role claim needs the URL. A frame's own
        // URL is in its parent's frame tree, and an ad frame that never commits would
        // hold this command for its whole timeout.
        const { frameTree } = await this.conn.send('Page.getFrameTree', {}, opts);
        t.mainFrameId = frameTree.frame.id;
        t.url = frameTree.frame.url + (frameTree.frame.urlFragment || '');
      }
      if (page && this.targets.get(targetId) === t) this.claim(t);
    } catch (e) {
      this.log.warn(`preparing target ${targetId}: ${e.message}`);
    } finally {
      // A target left paused stalls its page load.
      release();
    }
  }

  onDestroyed(targetId) {
    const t = this.targets.get(targetId);
    if (!t) return;
    // Chrome destroys the frame targets inside a target with it; their own events may
    // arrive first, later, or not at all. They go before their parent, so each still
    // finds the session its ref set belongs to along a parent chain that reaches a page.
    const frames = [...this.targets.values()].filter((frame) => frame.parentTargetId === targetId);
    for (const frame of frames) this.onDestroyed(frame.targetId);
    // A frame target claims no role, so the session that read it is its root page's.
    const owner = t.type === 'iframe' ? this.rootPage(t) : t;
    this.targets.delete(targetId);
    this.failWaiters(t);
    if (!owner || !owner.sessionId) return;
    const session = this.get(owner.sessionId);
    session.refs.delete(targetId);
    if (t.type === 'iframe') return;
    if (t.role === 'working') session.workingTargetId = null;
    if (t.role === 'identity') session.identityTargetId = null;
    if (t.role === 'opened') session.opened.delete(targetId);
    if (session.workingTargetId === null && session.identityTargetId === null) {
      // The window is gone; its state goes with it and the label stays.
      this.disown(session);
      session.windowId = null;
      this.log.info(`session ${session.id.slice(0, 8)}: window closed`);
    }
  }

  onFrameNavigated({ frame }, cdpSessionId) {
    const t = this.byCdpSession(cdpSessionId);
    if (!t) return;
    // An out-of-process frame's own frame carries the parentId of the frame it sits
    // in and the id of its target, which is how it is told from a child of its own.
    const own = t.type === 'iframe' ? frame.id === t.targetId : !frame.parentId;
    if (!own) return;
    t.mainFrameId = frame.id;
    t.url = frame.url + (frame.urlFragment || '');
    t.generation += 1;
    t.worlds.clear();
    // A tab opened from the session page attaches with an empty URL, so its role
    // claim lands here, on its first document.
    if (t.type === 'page' && (t.role === null || t.role === 'opened')) this.claim(t);
  }

  onNavigationStarted({ frameId, navigationType }, cdpSessionId) {
    const t = this.byCdpSession(cdpSessionId);
    if (!t) return;
    const main = frameId === t.mainFrameId || frameId === t.targetId;
    if (main && CROSS_DOCUMENT.has(navigationType)) {
      t.navigations += 1;
      this.notify(t);
    }
  }

  onLoad(cdpSessionId) {
    const t = this.byCdpSession(cdpSessionId);
    if (!t) return;
    t.loads += 1;
    this.notify(t);
  }

  // A fragment change or pushState: the URL changes, the document and its refs stay.
  onSameDocument(cdpSessionId) {
    const t = this.byCdpSession(cdpSessionId);
    if (!t) return;
    t.sameDocument += 1;
    this.notify(t);
  }

  // Under download denial Chrome still fires this for a click on a file link, after
  // the navigation start that the click wait counts and instead of a load event.
  onDownload(cdpSessionId) {
    const t = this.byCdpSession(cdpSessionId);
    if (!t) return;
    t.downloads += 1;
    this.notify(t);
  }

  notify(t) {
    for (const w of [...t.waiters]) {
      if (w.predicate(t)) { t.waiters.delete(w); clearTimeout(w.timer); w.resolve(true); }
    }
  }

  onDialog({ type, message }, cdpSessionId) {
    const t = this.byCdpSession(cdpSessionId);
    if (!t) return;
    // The daemon drains the working target's queue and its frame targets' after every
    // action; any other target keeps its dialogs until it becomes the working one.
    t.dialogs.push({ type, message });
    if (t.dialogs.length > MAX_DIALOGS) t.dialogs.shift();
    // beforeunload is accepted so a close the human started goes through.
    this.conn.send('Page.handleJavaScriptDialog', { accept: type === 'beforeunload' }, { sessionId: cdpSessionId })
      .catch((e) => this.log.warn(`dismissing ${type} dialog: ${e.message}`));
  }

  // The page target at the top of a target's parent chain, or null when a frame in
  // the chain has been destroyed.
  rootPage(t) {
    let current = t;
    for (let hops = this.targets.size; current && current.type === 'iframe' && hops > 0; hops--) {
      current = this.targets.get(current.parentTargetId) || null;
    }
    return current && current.type === 'page' ? current : null;
  }

  byCdpSession(cdpSessionId) {
    for (const t of this.targets.values()) if (t.cdpSessionId === cdpSessionId) return t;
    return null;
  }

  failWaiters(t) {
    for (const w of t.waiters) { clearTimeout(w.timer); w.reject(new TargetGoneError(t.targetId)); }
    t.waiters.clear();
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

// Milliseconds to wait: `timeout`, cut to what remains before `deadline` (ms epoch).
function budget(timeout, deadline) {
  if (deadline === undefined) return timeout;
  return Math.max(1, Math.min(timeout, deadline - Date.now()));
}

function isMissingContext(e) {
  return e instanceof ProtocolError && /context/i.test(e.protocolMessage || '');
}

module.exports = { Sessions, TargetGoneError, isMissingContext, SESSION_PAGE, parseSessionPage };
