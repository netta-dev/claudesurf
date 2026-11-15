// Per-session state and the target registry. A Session owns one Chrome window with an
// identity tab and a working tab, and holds the tabs that its pages opened; every handler
// reaches its targets through this registry, which also tracks each target's window,
// document generation, isolated worlds, navigation, load, and download counts,
// dismissed dialogs, and domain-gate arming.
//
// An out-of-process child frame attaches as its own target and is recorded like a
// page, with `type: 'iframe'`, the parent target whose protocol session delivered its
// attach, and a frame number taken from its root page's counter, which never
// reassigns one.
//
// A page target whose opener is a session's tab, or a frame under one, is that
// session's from its attach: attributed with the role `opened`, numbered, and armed
// under the domain gate before Chrome lets its first request go. Any other tab stays
// the human's until a claim by its session-page URL. A tab that leaves its session is
// disarmed.
//
// Lifecycle: `attach(conn)` after every launch; `ensureWithNotes(sessionId)` creates or
// repairs the window and arms the working tab before every action but `policy`; the
// window's state is dropped once the working tab is gone and none of the session's tabs
// remains in its window, and the next repair recreates it; pipe EOF drops every window
// and target while labels survive.

const path = require('path');
const { pathToFileURL } = require('url');
const { ProtocolError, TimeoutError } = require('./cdp');
const envelope = require('./envelope');
const { fail, within, TIMED_OUT } = require('./action-support');
const arming = require('./arming');
const tabRecords = require('./tab-records');
const requests = require('./requests');
const network = require('./network');
const consoleCapture = require('./console-capture');
const retained = require('./retained');
const refusals = require('./refusals');
const { isWeb } = require('./policy');
const { mainFrame, isMainFrame } = require('./frames');
const { WORKERS, WORKER_FILTER } = require('./browser');

const SESSION_PAGE = pathToFileURL(path.join(__dirname, 'static', 'session.html')).href;
const WINDOW_TIMEOUT_MS = 5_000;
const CTRL_MODIFIER = 2;
const MAX_DIALOGS = 20;
const MAX_DOWNLOADS = 10;
const CROSS_DOCUMENT = new Set(['differentDocument', 'historyDifferentDocument', 'reload', 'reloadBypassingCache', 'restore', 'restoreWithPost']);
const UNGATED = 'the working tab could not be put under the domain gate; call again';
// The per-target auto-attach: out-of-process child frames, paused so that their
// commands go ahead of their first commit, and the workers that the pause holds.
const ATTACH = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'iframe' }, ...WORKER_FILTER] };

class TargetGoneError extends Error {
  constructor(targetId) {
    super(`target ${targetId} is gone`);
    this.name = 'TargetGoneError';
    this.targetId = targetId;
  }
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
    // The session's tabs other than its working and identity tabs: those that its pages
    // opened, attributed by opener, and the earlier working tabs that a switch left.
    this.opened = new Set();
    // tab-records.js's: each tab's number, the next one to assign, which a window
    // recreation leaves alone, and the stack of earlier working tabs, most recent last.
    this.tabIds = new Map();
    this.nextTab = 1;
    this.earlierWorking = [];
    // The target that the session's last page read covered.
    this.refsTarget = null;
    // retained.js's store: each tab's retained render, by target id.
    this.retained = new Map();
    // The domain gate's refusals not yet reported, kept by refusals.js: the list, the
    // counter that stamps each entry's seq, the entries dropped from a full list, and
    // the running call's marks ({ seq, nextTab, workingTargetId, newTab }), null
    // between calls. The list is dropped with the window's state unless a call is
    // running, since that call's response may still report a refusal that it led to.
    this.refusals = [];
    this.refusalCount = 0;
    this.droppedRefusals = 0;
    this.marks = null;
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
    // The domain gate once it has attached; arming sends Fetch.enable only while set.
    this.interceptor = null;
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
    conn.on('Page.domContentEventFired', (p, sid) => this.onContentLoaded(sid));
    conn.on('Page.navigatedWithinDocument', (p, sid) => this.onSameDocument(p, sid));
    conn.on('Page.downloadWillBegin', (p, sid) => this.onDownload(p, sid));
    conn.on('Network.loadingFailed', (p, sid) => this.onRequestFailed(p, sid));
    conn.on('Page.javascriptDialogOpening', (p, sid) => this.onDialog(p, sid));
    conn.onClose(() => this.dropAll());
    requests.attachRequests(conn, this, network.sink);
    consoleCapture.attachConsole(conn, this);
  }

  // Returns the session, or undefined for an id that a call hasn't used yet; unlike
  // get, it doesn't create one.
  peek(sessionId) {
    return this.sessions.get(sessionId);
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

  // Gives the session a working tab under the domain gate: the window, the working tab,
  // or the identity tab put back as needed, or an earlier working tab given the role
  // back, and the working tab armed when it isn't.
  async repair(session, deadline) {
    await this.repairWindow(session, deadline);
    await this.armWorking(session, deadline);
  }

  // Closes a tab that the daemon gave up on, marking it `closing` until its destruction
  // arrives. Resolves with whether Chrome took the command by `opts.deadline`; never
  // rejects. A rejected close clears the mark on a tab still registered.
  closeTab(t, opts = {}) {
    t.closing = true;
    return this.conn.send('Target.closeTarget', { targetId: t.targetId }, opts).then(() => true, (e) => {
      if (this.targets.get(t.targetId) === t) {
        t.closing = false;
        this.log.warn(`closing ${t.targetId}: ${e.message}`);
      }
      return false;
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

  // Returns the frame id that a world is kept under: `frameId`, or the main frame's for
  // null.
  frameKey(t, frameId) {
    return frameId || mainFrame(t);
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

  // Resolves true once `predicate(target)` holds, checked now and on every notify of
  // the target: each navigation, load, download, and counted request event, a refusal
  // of its navigation, and each tab that it opened as it is attributed or checked. Resolves
  // false after `timeout` ms or at `deadline`; rejects with TargetGoneError when the
  // target is destroyed or the pipe closes, and with the throw of a predicate that
  // throws on a notify.
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

  // Runs every waiter's predicate on the target and resolves the waiters whose predicate
  // holds. A predicate that throws can't say whether it holds, so its waiter rejects
  // with the throw, which is logged, and the waiters after it still run.
  notify(t) {
    for (const w of [...t.waiters]) {
      let holds;
      try {
        holds = w.predicate(t);
      } catch (e) {
        this.log.warn(`a wait on ${t.targetId} failed: ${e.stack || e.message}`);
        t.waiters.delete(w);
        clearTimeout(w.timer);
        w.reject(e);
        continue;
      }
      if (holds) { t.waiters.delete(w); clearTimeout(w.timer); w.resolve(true); }
    }
  }

  // Returns the target whose protocol session is `cdpSessionId`, or null.
  byCdpSession(cdpSessionId) {
    for (const t of this.targets.values()) if (t.cdpSessionId === cdpSessionId) return t;
    return null;
  }

  // Returns { deadline } for a window step: WINDOW_TIMEOUT_MS from now, cut to
  // `deadline` when one is given.
  windowBudget(deadline) {
    const limit = deadline === undefined ? Date.now() + WINDOW_TIMEOUT_MS : Math.min(deadline, Date.now() + WINDOW_TIMEOUT_MS);
    return { deadline: limit };
  }

  // Pipe EOF: every window and target is gone; labels survive.
  dropAll() {
    for (const t of this.targets.values()) this.forget(t);
    this.targets.clear();
    for (const session of this.sessions.values()) this.dropWindowState(session);
    for (const [key, waiters] of this.roleWaiters) {
      for (const w of waiters) { clearTimeout(w.timer); w.reject(new Error('browser connection closed')); }
      this.roleWaiters.delete(key);
    }
  }

  sessionPageUrl(session, role, startedAt) {
    const params = new URLSearchParams({ role, session: session.id, started: startedAt });
    return `${SESSION_PAGE}#${params}`;
  }

  async repairWindow(session, deadline) {
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
    const earlier = tabRecords.earlier(this, session);
    if (earlier) {
      tabRecords.switchWorking(this, session, earlier);
      session.notes.push(`the working tab closed; ${tabRecords.tabId(session, earlier)} is the working tab again`);
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

  // Arms the working tab when it isn't armed: an arming queued at its attach is waited
  // for first, until the deadline, since it runs under its commands' own timeouts.
  // Fails the call when the arming fails or that wait runs out, leaving the flag down
  // so the next call tries again.
  async armWorking(session, deadline) {
    const t = this.targets.get(session.workingTargetId);
    if (!t || t.armed) return;
    if (t.arming) {
      const settled = deadline === undefined ? await t.arming : await within(t.arming, deadline);
      if (settled === TIMED_OUT) fail(envelope.error(UNGATED));
    }
    if (t.armed) return;
    const failed = arming.failure(await arming.arm(this, t, { deadline }));
    if (failed && this.targets.get(t.targetId) !== t) throw new TargetGoneError(t.targetId);
    if (failed) {
      this.log.warn(`session ${session.id.slice(0, 8)}: arming the working tab: ${failed.error.message}`);
      fail(envelope.error(UNGATED));
    }
  }

  async createWindow(session, deadline) {
    const opts = this.windowBudget(deadline);
    this.dropWindowState(session);
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

  // Drops the session's window state: every tab that it still holds is disowned, and its
  // tab records, last-read target, retained renders, and refusals go with them. The
  // refusals stay while a call runs, since its response may still report one that it led
  // to. The label, the counters, and the queue survive, so a number or a seq is never
  // reused.
  dropWindowState(session) {
    this.disown(session);
    session.windowId = null;
    tabRecords.clear(session);
    session.refsTarget = null;
    retained.dropAll(session);
    if (!session.marks) refusals.takeRest(session);
  }

  // Drops every target that the session owned: an identity tab that was navigated away
  // stays open but unowned and disarmed, and so do page-opened targets.
  disown(session) {
    for (const id of [session.identityTargetId, session.workingTargetId, ...session.opened]) {
      const t = id && this.targets.get(id);
      if (t) this.letGo(t);
    }
    session.identityTargetId = null;
    session.workingTargetId = null;
    session.refs.clear();
  }

  // Takes a tab out of its session, which leaves it a tab of the human's own: without a
  // role or a number, and disarmed.
  letGo(t) {
    const session = t.sessionId && this.sessions.get(t.sessionId);
    if (session) tabRecords.release(session, t.targetId);
    t.role = null;
    t.sessionId = null;
    arming.disarm(this, t);
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

  // Claims a target for a session role when its URL is that session's page. A tab that
  // a page opened keeps its number as it takes the role.
  claim(t) {
    const page = parseSessionPage(t.url);
    if (!page) return;
    const session = this.get(page.session);
    const field = `${page.role}TargetId`;
    if (session[field] && session[field] !== t.targetId && this.targets.has(session[field])) {
      // Leave a second tab of the same role unowned (the human duplicated one).
      if (t.sessionId) this.letGo(t);
      return;
    }
    if (t.sessionId && t.sessionId !== session.id) this.letGo(t);
    t.role = page.role;
    t.sessionId = session.id;
    if (page.role === 'working') t.everWorking = true;
    session[field] = t.targetId;
    tabRecords.addClaimed(session, t);
    if (session.windowId === null) session.windowId = t.windowId;
    const key = `${session.id}:${page.role}`;
    const waiters = this.roleWaiters.get(key);
    if (waiters) {
      this.roleWaiters.delete(key);
      for (const w of waiters) { clearTimeout(w.timer); w.resolve(t.targetId); }
    }
  }

  // Attributes a page target to the session of `opener`, the root page of the tab or
  // frame that opened it.
  attribute(t, opener) {
    const session = this.get(opener.sessionId);
    t.role = 'opened';
    t.sessionId = session.id;
    t.openerPage = opener.targetId;
    tabRecords.addOpened(session, t);
  }

  // Returns the page target, in a session, that opened this one: its opener's root
  // page, which a frame that opened it reaches through its parent chain; or null when
  // there is none.
  sessionOpener(t) {
    const opener = t.openerId && this.targets.get(t.openerId);
    const page = opener && this.rootPage(opener);
    return page && page.sessionId ? page : null;
  }

  // `deliveredOn` is the protocol session the event arrived on: the parent target's
  // for an out-of-process child frame under flatten, and none for a page target.
  async onAttached({ sessionId: cdpSessionId, targetInfo, waitingForDebugger }, deliveredOn) {
    const { targetId } = targetInfo;
    const opts = { sessionId: cdpSessionId };
    let queued;
    // The release goes out whatever the steps before it throw: a tab left paused
    // wedges its navigation.
    try {
      queued = this.queueAttach(targetInfo, cdpSessionId, deliveredOn, opts);
    } finally {
      if (waitingForDebugger) this.conn.send('Runtime.runIfWaitingForDebugger', {}, opts).catch(() => {});
    }
    if (WORKERS.has(targetInfo.type)) this.conn.send('Target.detachFromTarget', { sessionId: cdpSessionId }).catch(() => {});
    if (!queued) return;
    const { t, page, opener, armed, window, enabled, attaching, focused } = queued;
    // Every command is settled from here on, before anything is awaited: a wedged
    // renderer makes several of them time out, and a rejection left without a handler
    // would take the daemon down as an unhandled rejection. Only Page.enable's answer
    // gates the frame-tree read and the claim.
    const prepared = Promise.allSettled([window, attaching, focused]);
    const settled = Promise.allSettled([enabled, armed]).then(([, outcomes]) => outcomes.value || null);
    // This resolves ahead of the rule below, which may close the tab.
    settled.then((outcomes) => t.resolveReady(outcomes));
    const succeeded = (step, what) => step.then(() => true, (e) => {
      this.log.warn(`${what} ${targetId}: ${e.message}`);
      return false;
    });
    let claimable = await succeeded(enabled, 'preparing target');
    // A tab attached before its first navigation needs its URL for the role claim, and
    // a paused tab's first commit may come before Page.enable answers, without a
    // frameNavigated. A frame's own URL is in its parent's frame tree, and an ad frame
    // that never commits would hold this command for its whole timeout.
    if (claimable && page && (!t.url || opener)) {
      claimable = await succeeded(this.readFrameTree(t, opts), 'reading the frame tree of');
    }
    const [windowed, ...others] = await prepared;
    if (windowed.status === 'fulfilled' && windowed.value) t.windowId = windowed.value.windowId;
    for (const outcome of [windowed, ...others]) {
      if (outcome.status === 'rejected') this.log.warn(`preparing target ${targetId}: ${outcome.reason.message}`);
    }
    if (claimable && page && this.targets.get(targetId) === t) this.claim(t);
    if (armed) arming.onRejections(this, t, await settled);
  }

  // Records an attached target and queues its commands, which go ahead of its release
  // on its protocol session. Returns null for a target left unrecorded: one that is
  // neither a page nor a frame whose parent chain reaches a page, and so belongs to
  // neither a session nor a read. Otherwise returns the target, whether it is a page,
  // the session tab that opened it or null, and the commands' promises.
  queueAttach(targetInfo, cdpSessionId, deliveredOn, opts) {
    const { targetId, type } = targetInfo;
    const t = targetRecord(targetInfo, cdpSessionId);
    if (type === 'page') {
      t.nextFrameNumber = 1;
    } else if (type === 'iframe') {
      const parent = this.byCdpSession(deliveredOn);
      const root = parent && this.rootPage(parent);
      if (!root) return null;
      t.parentTargetId = parent.targetId;
      t.frameNumber = root.nextFrameNumber++;
      // Chrome numbers an out-of-process frame's own frame with its target id.
      t.mainFrameId = targetId;
      if (requests.endFrame(parent, targetId)) this.notify(parent);
    } else {
      return null;
    }
    this.targets.set(targetId, t);
    const page = type === 'page';
    // The tab belongs to its opener's session before its commands are queued: its first
    // request can be refused, and the tab closed, before any of them answers.
    const opener = page ? this.sessionOpener(t) : null;
    if (opener) this.attribute(t, opener);
    // Chrome runs a protocol session's commands in order, so a queued Fetch.enable
    // already gates the first request. Awaiting them before the release would deadlock
    // on a tab whose first document has not committed (a noopener link target), where
    // Page.enable answers only after the commit that the pause holds back.
    const armed = opener ? arming.arm(this, t) : null;
    const window = page ? this.conn.send('Browser.getWindowForTarget', { targetId }) : null;
    const enabled = this.conn.send('Page.enable', {}, opts);
    // Out-of-process child frames surface through this per-target call only; the
    // browser-level one reaches page targets alone.
    const attaching = this.conn.send('Target.setAutoAttach', ATTACH, opts);
    // Focus emulation lifts an input stall on a tab that is not its window's active
    // one, and on a frame inside it, which takes keys and scripted input.
    const focused = this.conn.send('Emulation.setFocusEmulationEnabled', { enabled: true }, opts);
    if (opener) this.notify(opener);
    return { t, page, opener, armed, window, enabled, attaching, focused };
  }

  async readFrameTree(t, opts) {
    const { frameTree: { frame } } = await this.conn.send('Page.getFrameTree', {}, opts);
    if (!t.mainFrameId) t.mainFrameId = frame.id;
    if (!t.url) t.url = frame.url + (frame.urlFragment || '');
    if (!t.loaderId) t.loaderId = frame.loaderId || null;
    if (isWeb(frame.url)) t.committedWeb = true;
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
    this.forget(t);
    if (!owner || !owner.sessionId) return;
    const session = this.get(owner.sessionId);
    session.refs.delete(targetId);
    if (t.type === 'iframe') return;
    retained.drop(session, t);
    if (t.role === 'working') session.workingTargetId = null;
    if (t.role === 'identity') session.identityTargetId = null;
    tabRecords.remove(session, targetId);
    if (session.workingTargetId === null && !this.holdsWindow(session)) {
      // The window is gone, or the human closed the working tab and none of the
      // session's tabs is left in it to return through; the state is dropped and the
      // label stays.
      this.dropWindowState(session);
      this.log.info(`session ${session.id.slice(0, 8)}: window closed`);
    }
  }

  // Returns whether one of the session's tabs is still in its window, by the window that
  // the registry last recorded for each tab, since this runs synchronously.
  holdsWindow(session) {
    return [session.identityTargetId, ...session.opened].some((id) => {
      const t = id && this.targets.get(id);
      return Boolean(t) && tabRecords.inWindow(session, t.windowId);
    });
  }

  onFrameNavigated({ frame, type }, cdpSessionId) {
    const t = this.byCdpSession(cdpSessionId);
    if (!t) return;
    // An out-of-process frame's own frame carries the parentId of the frame it sits
    // in and the id of its target, which is how it is told from a child of its own.
    const own = t.type === 'iframe' ? frame.id === t.targetId : !frame.parentId;
    if (!own) return;
    t.mainFrameId = frame.id;
    t.url = frame.url + (frame.urlFragment || '');
    t.loaderId = frame.loaderId || null;
    t.generation += 1;
    t.navigationsAtCommit = t.navigations;
    t.pendingLoader = null;
    t.worlds.clear();
    if (t.type !== 'page') return;
    requests.commit(t, frame.loaderId);
    // A back-forward cache restore fires neither DOMContentLoaded nor load, so its
    // commit counts as both.
    if (type === 'BackForwardCacheRestore') {
      t.loads += 1;
      t.loadedGeneration = t.generation;
    }
    this.notify(t);
    // The backstop judges the commit while a tab that a page opened still counts as
    // new, so a refused first web page closes it.
    if (this.interceptor) {
      try {
        this.interceptor.onCommitted(t);
      } catch (e) {
        this.log.warn(`judging the commit of ${t.targetId}: ${e.stack || e.message}`);
      }
    }
    if (isWeb(frame.url)) t.committedWeb = true;
    // A tab opened from the session page attaches with an empty URL, so its role
    // claim lands here, on its first document.
    if (t.role === null || t.role === 'opened') this.claim(t);
  }

  onNavigationStarted({ frameId, navigationType, loaderId }, cdpSessionId) {
    const t = this.byCdpSession(cdpSessionId);
    if (!t) return;
    if (isMainFrame(t, frameId) && CROSS_DOCUMENT.has(navigationType)) {
      t.navigations += 1;
      t.pendingLoader = loaderId || null;
      this.notify(t);
    }
  }

  // Counts the target's latest navigation as stopped when Chrome ends it without a
  // commit: for a 204 or 205 answer, a window.stop(), a URL handed to another
  // application, a download, or a request that the gate failed, its document request fails
  // with ERR_ABORTED, under the navigation's loader id. A network error fails that
  // request too, before Chrome commits its error page under the same id, so only
  // ERR_ABORTED counts.
  onRequestFailed({ requestId, errorText }, cdpSessionId) {
    const t = this.byCdpSession(cdpSessionId);
    if (!t || requestId !== t.pendingLoader || errorText !== 'net::ERR_ABORTED') return;
    t.pendingLoader = null;
    t.navigationsStopped = t.navigations;
    this.notify(t);
  }

  onLoad(cdpSessionId) {
    const t = this.byCdpSession(cdpSessionId);
    if (!t) return;
    t.loads += 1;
    this.notify(t);
  }

  onContentLoaded(cdpSessionId) {
    const t = this.byCdpSession(cdpSessionId);
    if (!t) return;
    t.loadedGeneration = t.generation;
    this.notify(t);
  }

  // Records a fragment change or pushState of the target's own main frame: the URL
  // changes, the document and its refs stay. A page target follows its URL; a frame
  // target keeps the URL that its commit recorded. A child frame's event arrives on its
  // page's session too, where a navigation wait would take it for the page landing, so
  // it is skipped.
  onSameDocument({ frameId, url }, cdpSessionId) {
    const t = this.byCdpSession(cdpSessionId);
    if (!t || !isMainFrame(t, frameId)) return;
    if (t.type === 'page') t.url = url;
    t.sameDocument += 1;
    this.notify(t);
  }

  // Counts main-frame downloads for navigate's download wait and keeps their details
  // for an acting call's Download: lines.
  // Chrome emits this event despite download denial. A navigation to a file emits it
  // after Chrome fails the document request (onRequestFailed).
  // An <a download> link or blob URL can emit it without starting a navigation,
  // including while another navigation is underway. A download therefore doesn't
  // stop an ongoing navigation.
  // Downloads from child frames in the page's process arrive on the page's session
  // with the child's frame id and are excluded here.
  onDownload({ frameId, url, suggestedFilename }, cdpSessionId) {
    const t = this.byCdpSession(cdpSessionId);
    if (!t || !isMainFrame(t, frameId)) return;
    t.downloads += 1;
    t.downloadLog.push({ n: t.downloads, url: url || '', file: suggestedFilename || '' });
    if (t.downloadLog.length > MAX_DOWNLOADS) t.downloadLog.shift();
    this.notify(t);
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

  forget(t) {
    for (const w of t.waiters) { clearTimeout(w.timer); w.reject(new TargetGoneError(t.targetId)); }
    t.waiters.clear();
    t.resolveReady(null);
    requests.drop(t);
    network.drop(t);
    consoleCapture.drop(t);
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

  // Calls the session page's own render function, with the label passed as arguments
  // rather than interpolated. The daemon's main-world calls are this, pageElement, and
  // the scripted click on the link that pageElement finds, all on the session page.
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

// Returns a new target's record, including counters and worlds used by handlers.
// Navigation verdicts use these fields:
// `loadedGeneration` identifies the generation whose DOMContentLoaded event fired.
// It is null before the first event; equality with `generation` means that the current
// document has loaded.
// `navigationsAtCommit` records `navigations` at the current document's commit.
// `pendingLoader` holds the main frame's latest cross-document loader id until commit.
// `navigationsStopped` records `navigations` when Chrome last dropped the latest
// navigation without committing (onRequestFailed). The drop ends the navigations
// started by that point.
// `downloadLog` retains recent main-frame downloads as { n, url, file } for acting
// calls. Each `n` is the download count after that event.
// `loaderId` identifies the current document's loader. It comes from the main-frame
// commit or the attach handler's frame-tree read when the first commit wasn't reported.
// `clearWaited` records the generation when the wait for a challenge to clear last ran.
// `widgetWaited` records the generation when the widget wait last ran.
// `widgetReported` records the generation when a widget without a response field
// was last reported. These generation markers limit waits and reports per document.
// The domain gate also uses these fields:
// `closing` indicates that the daemon has sent Target.closeTarget (closeTab).
// `armingSent` indicates whether arming commands have been sent.
// `armed` indicates whether Network.enable, the bypass, and any Fetch.enable succeeded.
// `arming` is the promise for the latest arming outcomes.
// `armingEpoch` identifies the latest arming or disarm (arming.js).
// `openerPage` identifies the session page target that opened the tab; a frame's
// root page is used when a frame opened it.
// `committedWeb` indicates an http(s) commit reported by frameNavigated or read from
// the frame tree during attach.
// `everWorking` indicates whether the target has been a working tab.
// `ready` resolves without rejecting after Page.enable and any arming commands sent
// at attach have settled. Its value is the arming outcomes or null.
// It resolves with null if the target disappears first.
function targetRecord(targetInfo, cdpSessionId) {
  const { targetId, type } = targetInfo;
  const t = {
    targetId, cdpSessionId, type, url: targetInfo.url || '', openerId: targetInfo.openerId || null,
    windowId: null, generation: 0, role: null, sessionId: null, worlds: new Map(), mainFrameId: null,
    loads: 0, loadedGeneration: null, navigations: 0, navigationsAtCommit: 0, pendingLoader: null, navigationsStopped: 0, downloads: 0, downloadLog: [], sameDocument: 0, waiters: new Set(), dialogs: [],
    loaderId: null, clearWaited: null, widgetWaited: null, widgetReported: null,
    closing: false, armingSent: false, armed: false, arming: null, armingEpoch: 0,
    openerPage: null, committedWeb: false, everWorking: false,
  };
  t.ready = new Promise((resolve) => { t.resolveReady = resolve; });
  return t;
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
