// A scripted browser speaking the pipe protocol over a stream pair: NUL-delimited JSON
// in, replies and events out. It models just enough of Chrome for the daemon's window
// and action paths — targets, windows, pages, the pause on attach — and records every
// command so tests can assert what was sent. Usable in-process (`inProcess()`) and as
// a child (fake-chrome.js).
//
// Tests customise it through `handle(method, fn)` to override a command (a promise
// returned from fn answers late), `site[url]` to describe the page a URL serves, and
// `emit()` to raise events.
//
// A target with Fetch enabled pauses each main-frame document request as Chrome does —
// of Page.navigate, a page's own navigation, and a target's first document other than
// about:blank — and goes on only once the daemon continues it; a failed request
// doesn't commit. `site[url].redirect` names the URL that a request is redirected to,
// which pauses again. Each Page.frameStartedNavigating that `announce` fires carries a
// loader id of its own, as do Page.navigate's answer, the commit's Page.frameNavigated,
// and the committed document's requests; `failNavigation` fails the navigation's
// document request under it, as Chrome reports a navigation that it drops or that
// fails on the network.
// A navigation that reaches `site[url].download`, a denied download, or
// `site[url].noContent`, a 204 answer, doesn't commit, and its document request fails
// with net::ERR_ABORTED under its loader id, as does one whose request the daemon
// failed; a download then fires Page.downloadWillBegin.
//
// Settling reads three things that a page describes: `site[url].network`, the requests
// that its load makes ([{ type, at, ms }], `ms` null for one that never ends), which
// reach a target with Network enabled; `site[url].busy`, what claudesurfSettle answers
// ({ mutating, lastMutationAt, readyState, throws }, or a function of the target), quiet
// and complete by default; and `networkRequest`, a request that a test starts itself.
// `site[url].overlays[ref]` answers the render of an overlay block ({ text, hidden,
// lost, tiny, throws }, or a function like `render`), and `site[url].lostRoot` makes a
// region render report its scope root lost.
//
// Input acts on page elements. claudesurfEdit and claudesurfSelect answer from the
// element: a text field has `type` (one of the text input types, `text` for a
// `textbox` kind) or `editable`, and `disabled`, `readonly`, `noFocus`,
// `cancelsSelectAll`, and `stealsFocus` flags; a native select has `options`
// ([{ label, value, disabled }]). The element that claudesurfEdit focused takes
// Input.insertText and the text of each key event, into its `value`; `page.focused`
// is the element that document.activeElement names (an element with `tag`, `attributes`,
// `ownText`, and, for an <iframe>, `frameId`), and `page.onKey(event, fake, target)`
// sees every key event. Each target keeps a history of the documents that it committed,
// which Page.getNavigationHistory, Page.navigateToHistoryEntry, and Page.reload use;
// `site[url].restored` makes a step onto that entry a back-forward cache restore,
// which commits without a request or a load event, under the loader id that the
// entry's document committed with.

const { PassThrough } = require('stream');
const path = require('path');
const { pathToFileURL } = require('url');

const SESSION_PAGE = pathToFileURL(path.join(__dirname, '..', '..', 'server', 'static', 'session.html')).href;
// A 1x1 PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// The page a URL serves unless a test describes one: `elements` is what the walk
// returns, `tree` the accessibility tree behind the same two controls, their DOM nodes
// named by the ids both sides share.
function defaultPage(url) {
  const node = (nodeId, role, name, extra = {}) => ({
    nodeId: String(nodeId), role: { type: 'role', value: role },
    name: { type: 'computedString', value: name }, backendDOMNodeId: nodeId, ...extra,
  });
  return {
    title: 'Fake page',
    text: 'Hello from the fake browser.',
    elements: [
      { kind: 'link', label: 'Next', href: 'http://fake.test/next', backendNodeId: 101, disabled: false, checked: false, visible: true },
      { kind: 'button', label: 'Go', backendNodeId: 102, disabled: false, checked: false, visible: true },
    ],
    tree: [
      node(100, 'RootWebArea', 'Fake page', { childIds: ['101', '102'] }),
      node(101, 'link', 'Next', { properties: [{ name: 'url', value: { type: 'string', value: 'http://fake.test/next' } }] }),
      node(102, 'button', 'Go'),
    ],
    scrollY: 0, pageHeight: 2000, viewportHeight: 600,
  };
}

class FakeBrowser {
  constructor({ log = () => {} } = {}) {
    this.log = log;
    this.calls = [];
    this.callWaiters = [];
    this.handlers = new Map();
    this.targets = new Map();
    this.site = {};
    this.nextTarget = 1;
    this.nextWindow = 100;
    this.nextObject = 1;
    this.objects = new Map();
    this.nextBackendNode = 10;
    this.nextRequest = 1;
    this.nextLoader = 1;
    this.nextEntry = 1;
    // { target, element } that the last claudesurfEdit focused, which input reaches.
    this.editing = null;
    // requestId → { target, resume(continued) } for each request paused at Fetch
    this.paused = new Map();
    this.buffer = '';
    this.closed = false;
    this.installDefaults();
  }

  // Wires the fake to a stream pair: the daemon writes `input`, reads `output`.
  static inProcess(options) {
    const fake = new FakeBrowser(options);
    const toFake = new PassThrough();
    const fromFake = new PassThrough();
    fake.attach(toFake, fromFake);
    return { fake, readable: fromFake, writable: toFake };
  }

  attach(input, output) {
    this.output = output;
    input.setEncoding('utf8');
    input.on('data', (chunk) => this.onData(chunk));
    input.on('end', () => this.close());
  }

  handle(method, fn) { this.handlers.set(method, fn); }

  emit(method, params = {}, sessionId) {
    const message = { method, params };
    if (sessionId) message.sessionId = sessionId;
    this.write(message);
  }

  // Resolves with the next call of `method` satisfying `predicate` (past calls count).
  waitForCall(method, predicate = () => true, timeout = 2000) {
    const found = this.calls.find((c) => c.method === method && predicate(c));
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ${method} call within ${timeout} ms`)), timeout);
      this.callWaiters.push({ method, predicate, resolve: (c) => { clearTimeout(timer); resolve(c); } });
    });
  }

  callsTo(method) { return this.calls.filter((c) => c.method === method); }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.output) this.output.end();
  }

  // Creates a target, attached paused; its first document commits on release.
  // `lateUrl` models a tab whose URL arrives with its first navigation (the attach
  // carries an empty one), and `windowDelayMs` a Browser.getWindowForTarget reply
  // that lands after that navigation. `type: 'iframe'` with `parent` (a target of
  // this fake) models an out-of-process child frame: the attach arrives on the
  // parent's protocol session, and the frame's own frameNavigated carries its
  // parent's frame id, as Chrome's does. `holdUntilRelease` models a renderer that
  // answers nothing while it waits for the debugger, which makes the order of the
  // attach handler's commands observable. `silentFirstCommit` commits `lateUrl`
  // without a Page event, as openWindow describes.
  createTarget({ url = '', windowId, openerId, lateUrl, windowDelayMs = 0, type = 'page', parent, holdUntilRelease = false, silentFirstCommit = false } = {}) {
    const targetId = `T${this.nextTarget++}`;
    const target = {
      targetId, sessionId: `S${targetId}`, type, url, openerId,
      windowId: windowId || (parent ? parent.windowId : this.nextWindow++),
      parentFrameId: parent ? parent.targetId : undefined,
      pendingUrl: lateUrl, windowDelayMs, released: false, committed: false, loads: 0, enabled: false,
      contexts: new Map(), holdUntilRelease, releaseWaiters: [], silentFirstCommit,
      history: [], historyIndex: -1,
    };
    // The attach below can reach the daemon, and its commands come back, before this
    // returns, so the target is complete before it is announced.
    if (silentFirstCommit) target.firstCommit = new Promise((resolve) => { target.firstCommitted = resolve; });
    this.targets.set(targetId, target);
    const targetInfo = { targetId, type, title: '', url: target.url, attached: true };
    if (openerId) targetInfo.openerId = openerId;
    this.emit('Target.attachedToTarget', { sessionId: target.sessionId, targetInfo, waitingForDebugger: true }, parent && parent.sessionId);
    return target;
  }

  // A paused renderer answers nothing until Runtime.runIfWaitingForDebugger reaches
  // it, so a target created with `holdUntilRelease` holds the commands the attach
  // handler queues on it and answers them in order once it is released. A handler that
  // awaited one of them before releasing deadlocks here as it would against Chrome.
  afterRelease(target, answer) {
    if (!target || !target.holdUntilRelease || target.released) return answer();
    return new Promise((resolve, reject) => {
      target.releaseWaiters.push(() => { try { resolve(answer()); } catch (e) { reject(e); } });
    });
  }

  // The page a target serves, or — for the frame id of one of its same-process
  // children, which a command carries as a `frameId` or through its execution context
  // — the page that frame serves, since such a frame shares its parent's target.
  page(target, frameId) {
    return this.pageAt(frameId ? this.frameUrl(target, frameId) : target.url);
  }

  frameUrl(target, frameId) {
    const child = (this.pageAt(target.url).childFrames || []).find((f) => f.id === frameId);
    return child ? child.url : target.url;
  }

  pageAt(url) {
    const plain = url.split('#')[0];
    if (!this.site[url] && !this.site[plain]) this.site[plain] = defaultPage(plain);
    const page = this.site[url] || this.site[plain];
    for (const element of page.elements || []) {
      if (element.backendNodeId === undefined) element.backendNodeId = this.nextBackendNode++;
    }
    // A test that describes its page as a list of elements gets the tree those
    // elements imply, so a read of it finds the controls the walk finds.
    if (!page.tree) page.tree = treeOf(page);
    return page;
  }

  // The frame an isolated world belongs to: one is created per frame, so the context
  // id a command carries says which of a target's documents it means.
  frameOf(target, executionContextId) {
    return target.contexts.get(executionContextId);
  }

  // Attaches an out-of-process child frame for the iframe node `backendId` of the
  // parent's page: the target attaches on the parent's protocol session, and the
  // parent's frame-tree entry for that node gains its id, as Chrome's does.
  attachFrame(parent, backendId) {
    const entry = (this.page(parent).childFrames || []).find((f) => f.backendId === backendId);
    const frame = this.createTarget({ type: 'iframe', parent, url: entry.url });
    entry.id = frame.targetId;
    return frame;
  }

  // The element behind a ref, or null when the ref names a tree node that is no
  // element of the walk (a landmark, a frame, the scope root).
  elementOf(page, ref) {
    return (page.elements || []).find((e) => e.backendNodeId === backendOf(ref)) || null;
  }

  // The URL behind a link: the page script reads it off the element, so the descriptor
  // the daemon sends carries none and the fake finds it on the tree node.
  urlOf(page, ref) {
    const node = (page.tree || []).find((n) => n.backendDOMNodeId === backendOf(ref));
    const url = node && (node.properties || []).find((p) => p.name === 'url');
    return url ? url.value.value : null;
  }

  // Commits a target's first document, after its release. One that a page opened by
  // window.open commits silently, as Chrome commits a paused tab's first document
  // before Page.enable answers, and `site[url].firstCommitDelay` holds that commit.
  commit(target) {
    if (target.committed) return;
    target.committed = true;
    if (target.silentFirstCommit) {
      const url = target.pendingUrl;
      const delay = (this.siteOf(url) || {}).firstCommitDelay || 0;
      setTimeout(() => this.request(target, url, (committed) => {
        if (committed !== null) {
          target.url = committed;
          this.record(target, committed);
        }
        delete target.pendingUrl;
        target.firstCommitted();
      }), delay);
      return;
    }
    if (!target.fetchEnabled || !requestable(target.url)) {
      this.navigateTarget(target, target.url);
      return;
    }
    this.startNavigation(target, target.url);
  }

  // Fires the events that Chrome fires, in order, for a cross-document navigation without a
  // request stage.
  navigateTarget(target, url) {
    this.announce(target, url);
    this.commitDocument(target, url);
  }

  // Runs a navigation that the page starts itself — a link, a script setting location, a
  // timer redirect, a frame setting top.location — on the target's main frame. Calls
  // `done` with the URL that it commits, or null when nothing commits.
  navigateByPage(target, url, done = () => {}) {
    if (!target.fetchEnabled && !this.drops(url)) {
      this.navigateTarget(target, url);
      done(url);
      return;
    }
    this.startNavigation(target, url, done);
  }

  // Opens a tab from `opener`'s page, as window.open or a target=_blank link does: it
  // attaches paused with an empty URL in the opener's window and commits `url`
  // silently after its release; Page.enable answers once that commit is made.
  openWindow(opener, url = 'about:blank') {
    return this.createTarget({ url: '', windowId: opener.windowId, openerId: opener.targetId, lateUrl: url, silentFirstCommit: true });
  }

  // Starts a navigation of `target` to `url`, and calls `done` with the URL that it commits,
  // or null when nothing commits, and the navigation's loader id. `navigationType` is the one
  // that Page.frameStartedNavigating carries; `entry`, the index of the history entry
  // that a history step or a reload commits into.
  startNavigation(target, url, done = () => {}, { navigationType, entry } = {}) {
    this.announce(target, url, navigationType);
    const { loaderId } = target;
    this.request(target, url, (reached) => {
      if (reached !== null && this.drops(reached)) {
        this.drop(target, reached, loaderId);
        done(null);
        return;
      }
      if (reached !== null) setImmediate(() => this.commitDocument(target, reached, { entry }));
      done(reached, loaderId);
    });
  }

  // Returns whether a navigation that reaches `url` ends without a commit: `url` serves
  // a download, which Chrome denies, or a 204 answer.
  drops(url) {
    const page = this.siteOf(url) || {};
    return Boolean(page.download || page.noContent);
  }

  // Ends the navigation under `loaderId` at `url` without a commit, as Chrome does once
  // the response arrives: it fails the document request with net::ERR_ABORTED and,
  // for a download, fires Page.downloadWillBegin a few ms later.
  drop(target, url, loaderId) {
    this.failNavigation(target, 'net::ERR_ABORTED', loaderId);
    if (this.siteOf(url).download) setImmediate(() => this.emit('Page.downloadWillBegin', { frameId: target.targetId, url }, target.sessionId));
  }

  announce(target, url, navigationType = 'differentDocument') {
    target.loaderId = `loader-${this.nextLoader++}`;
    this.emit('Page.frameStartedNavigating', { frameId: target.targetId, url, navigationType, loaderId: target.loaderId }, target.sessionId);
  }

  // Fails the document request of the navigation under `loaderId`, the target's latest
  // by default, which Chrome reports under that loader id to a target with Network
  // enabled: with net::ERR_ABORTED when it drops the navigation without a commit, as
  // for a 204, a download, a window.stop(), or a request that the daemon failed, and with
  // the network's own error before it commits an error page.
  failNavigation(target, errorText = 'net::ERR_ABORTED', loaderId = target.loaderId) {
    if (!target.networkEnabled || !loaderId) return;
    this.emit('Network.loadingFailed', { requestId: loaderId, timestamp: 0, type: 'Document', errorText, canceled: errorText === 'net::ERR_ABORTED' }, target.sessionId);
  }

  // Adds a committed document to the target's history, past the current entry, or
  // moves to `entry` for a history step or a reload.
  record(target, url, entry) {
    if (entry !== undefined) {
      target.historyIndex = entry;
      Object.assign(target.history[entry], { url, loaderId: target.documentLoaderId });
      return;
    }
    target.history = target.history.slice(0, target.historyIndex + 1);
    target.history.push({ id: this.nextEntry++, url, loaderId: target.documentLoaderId });
    target.historyIndex = target.history.length - 1;
  }

  // Commits `url` in the target's main frame and fires its DOMContentLoaded and load;
  // with `loaded` false, it only commits, as for a document still parsing.
  commitDocument(target, url, { entry, loaded = true } = {}) {
    target.url = url;
    target.documentLoaderId = target.loaderId;
    this.record(target, url, entry);
    const frame = { ...mainFrameOf(target, url), loaderId: target.loaderId };
    if (target.parentFrameId) frame.parentId = target.parentFrameId;
    this.emit('Page.frameNavigated', { frame, type: 'Navigation' }, target.sessionId);
    if (loaded) {
      target.loads += 1;
      this.emit('Page.domContentEventFired', { timestamp: target.loads }, target.sessionId);
      this.emit('Page.loadEventFired', { timestamp: target.loads }, target.sessionId);
    }
    for (const { type = 'XHR', at = 0, ms = null } of (this.siteOf(url) || {}).network || []) {
      setTimeout(() => this.networkRequest(target, { type, ms }), at);
    }
  }

  // Starts a request of `type` on the target, as its page's script would, which ends
  // after `ms` (never when null) or when the returned `finish` is called; the returned
  // `redirect(to)` sends a redirect hop, which Chrome reports as another
  // requestWillBeSent under the same id. Network events reach the daemon only once it
  // has enabled the domain on the target.
  networkRequest(target, { type = 'XHR', ms = null, url = 'http://fake.test/request' } = {}) {
    const requestId = `N${this.nextRequest++}`;
    let done = false;
    const finish = (failed = false) => {
      if (done || !target.networkEnabled) return;
      done = true;
      const params = { requestId, timestamp: 0, type };
      if (failed) this.emit('Network.loadingFailed', { ...params, errorText: 'net::ERR_FAILED' }, target.sessionId);
      else this.emit('Network.loadingFinished', { requestId, timestamp: 0, encodedDataLength: 0 }, target.sessionId);
    };
    const send = (to, extra = {}) => this.emit('Network.requestWillBeSent', {
      requestId, loaderId: target.documentLoaderId, documentURL: target.url, request: { url: to, method: 'GET', headers: {} }, timestamp: 0, wallTime: Date.now() / 1000, type, ...extra,
    }, target.sessionId);
    const redirect = (to = `${url}/hop`) => {
      if (!done && target.networkEnabled) send(to, { redirectResponse: { url, status: 302, statusText: 'Found', headers: { Location: to } } });
    };
    if (target.networkEnabled) {
      send(url);
      if (ms !== null) setTimeout(() => finish(), ms);
    }
    return { requestId, finish, redirect };
  }

  // Requests `url` as the main-frame document of the target's latest navigation,
  // following redirect hops, and calls `done` with the URL to commit, or null once a
  // hop is failed. With Fetch enabled each hop pauses until Fetch.continueRequest or
  // Fetch.failRequest; the pause carries the navigation's loader id as its network id,
  // and a failed hop fails the document request under that id, as Chrome does.
  request(target, url, done) {
    const { loaderId } = target;
    const hop = (at, redirectedRequestId) => {
      const onward = (requestId) => {
        const redirect = (this.siteOf(at) || {}).redirect;
        if (redirect) hop(redirect, requestId); else done(at);
      };
      if (!target.fetchEnabled || !requestable(at)) { onward(undefined); return; }
      const requestId = `R${this.nextRequest++}`;
      this.paused.set(requestId, {
        target,
        resume: (continued) => {
          if (continued) { onward(requestId); return; }
          this.failNavigation(target, 'net::ERR_ABORTED', loaderId);
          done(null);
        },
      });
      const params = { requestId, request: { url: at, method: 'GET', headers: {} }, frameId: target.targetId, resourceType: 'Document', networkId: loaderId };
      if (redirectedRequestId) params.redirectedRequestId = redirectedRequestId;
      this.emit('Fetch.requestPaused', params, target.sessionId);
    };
    hop(url);
  }

  resume(requestId, continued) {
    const paused = this.paused.get(requestId);
    if (!paused) throw { code: -32602, message: 'Invalid InterceptionId.' };
    this.paused.delete(requestId);
    setImmediate(() => paused.resume(continued));
    return {};
  }

  // Returns the page that a test described for `url`, without making a default one.
  siteOf(url) {
    if (!url) return null;
    return this.site[url] || this.site[url.split('#')[0]] || null;
  }

  destroyTarget(targetId) {
    const target = this.targets.get(targetId);
    if (!target) return;
    this.targets.delete(targetId);
    for (const [requestId, paused] of this.paused) if (paused.target === target) this.paused.delete(requestId);
    this.emit('Target.detachedFromTarget', { sessionId: target.sessionId, targetId }, undefined);
    this.emit('Target.targetDestroyed', { targetId });
  }

  bySession(sessionId) {
    for (const t of this.targets.values()) if (t.sessionId === sessionId) return t;
    return null;
  }

  object(kind, target, extra = {}) {
    const objectId = `O${this.nextObject++}`;
    this.objects.set(objectId, { kind, target, ...extra });
    return objectId;
  }

  // The session page's link of the other role opens a tab in the same window; a
  // Ctrl-click yields a background tab (the identity tab), a plain click a foreground
  // one, which is what the working-tab repair relies on.
  openLink(target, role) {
    const [plain, fragment] = target.url.split('#');
    const params = new URLSearchParams(fragment);
    params.set('role', role);
    const url = `${plain}#${params}`;
    // Chrome attaches such a tab with an empty URL; the URL arrives with its first navigation.
    const opened = this.createTarget({ url: '', windowId: target.windowId, openerId: target.targetId });
    opened.pendingUrl = url;
    return opened;
  }

  // Steps to history entry `index`: within the document when only the fragment
  // differs, a back-forward cache restore when the entry's page says `restored`, and a
  // navigation with a request otherwise.
  historyStep(t, index) {
    const { url } = t.history[index];
    const [plain] = url.split('#');
    if (plain === t.url.split('#')[0] && url !== t.url && (url.includes('#') || t.url.includes('#'))) {
      t.historyIndex = index;
      t.url = url;
      this.emit('Page.navigatedWithinDocument', { frameId: t.targetId, url }, t.sessionId);
      return;
    }
    if ((this.siteOf(url) || {}).restored) {
      t.historyIndex = index;
      t.url = url;
      t.documentLoaderId = t.history[index].loaderId;
      const frame = { ...mainFrameOf(t, url), loaderId: t.documentLoaderId };
      this.emit('Page.frameNavigated', { frame, type: 'BackForwardCacheRestore' }, t.sessionId);
      return;
    }
    this.startNavigation(t, url, undefined, { navigationType: 'historyDifferentDocument', entry: index });
  }

  // Delivers a key event to the element that claudesurfEdit last focused: a keyDown's text
  // goes into its value, a select-all command selects it unless the element cancels
  // it, and Backspace deletes. `page.onKey` sees every event.
  keyEvent(params, t) {
    const page = this.page(t);
    const element = this.editing && this.editing.element;
    if (element && params.type !== 'keyUp') {
      if ((params.commands || []).includes('selectAll')) {
        if (!element.cancelsSelectAll) element.selectedAll = true;
      } else if (params.type === 'keyDown' && params.text && params.text !== '\r') {
        // Enter's keyDown carries `\r` as its text; the fake's fields are single-line,
        // where Enter doesn't type.
        insert(element, params.text);
      } else if (params.key === 'Backspace') {
        element.value = element.selectedAll ? '' : (element.value || '').slice(0, -1);
        element.selectedAll = false;
      }
    }
    if (page.onKey) page.onKey(params, this, t);
    return {};
  }

  installDefaults() {
    const ok = () => ({});
    this.handle('Browser.getVersion', () => ({ product: 'FakeChrome/1.0', protocolVersion: '1.3' }));
    this.handle('Target.setAutoAttach', (p, sid) => this.afterRelease(this.bySession(sid), ok));
    this.handle('Browser.setDownloadBehavior', ok);
    this.handle('Target.createTarget', ({ url, newWindow }) => {
      const target = this.createTarget({ url, windowId: newWindow ? undefined : this.nextWindow - 1 });
      return { targetId: target.targetId };
    });
    this.handle('Target.closeTarget', ({ targetId }) => { this.destroyTarget(targetId); return { success: true }; });
    this.handle('Browser.getWindowForTarget', ({ targetId }) => {
      const t = this.targets.get(targetId);
      if (!t) throw { code: -32000, message: 'No target with given id found' };
      return this.afterRelease(t, () => {
        const reply = { windowId: t.windowId, bounds: { left: 0, top: 0, width: 800, height: 600, windowState: 'normal' } };
        if (t.windowDelayMs) return new Promise((r) => setTimeout(() => r(reply), t.windowDelayMs));
        return reply;
      });
    });
    // Returns a handler that answers once the tab's first commit is made, for a tab
    // whose first commit is silent, as a page-opened tab's is, or once the tab is
    // released otherwise.
    const afterFirstCommit = (answer) => (p, sid) => {
      const t = this.bySession(sid);
      if (t && t.firstCommit) return t.firstCommit.then(answer(t));
      return this.afterRelease(t, answer(t));
    };
    this.handle('Page.enable', afterFirstCommit((t) => () => { if (t) t.enabled = true; return {}; }));
    this.handle('Network.enable', afterFirstCommit((t) => () => { if (t) t.networkEnabled = true; return {}; }));
    this.handle('Network.disable', (p, sid) => {
      const t = this.bySession(sid);
      if (t) t.networkEnabled = false;
      return {};
    });
    this.handle('Network.setBypassServiceWorker', afterFirstCommit(() => ok));
    // Fetch.enable answers while the tab is held, before its first request.
    this.handle('Fetch.enable', (p, sid) => {
      const t = this.bySession(sid);
      if (t) t.fetchEnabled = true;
      return {};
    });
    this.handle('Fetch.disable', (p, sid) => {
      const t = this.bySession(sid);
      if (t) t.fetchEnabled = false;
      return {};
    });
    this.handle('Fetch.continueRequest', ({ requestId }) => this.resume(requestId, true));
    this.handle('Fetch.failRequest', ({ requestId }) => this.resume(requestId, false));
    this.handle('Target.getTargetInfo', ({ targetId }, sid) => {
      const t = targetId ? this.targets.get(targetId) : this.bySession(sid);
      if (!t) throw { code: -32602, message: 'No target with given id found' };
      const page = this.siteOf(t.url);
      const targetInfo = { targetId: t.targetId, type: t.type, title: (page && page.title) || '', url: t.url, attached: true, canAccessOpener: false };
      if (t.openerId) targetInfo.openerId = t.openerId;
      return { targetInfo };
    });
    this.handle('Emulation.setFocusEmulationEnabled', ok);
    this.handle('Runtime.runIfWaitingForDebugger', (p, sid) => {
      const t = this.bySession(sid);
      if (t && !t.released) {
        t.released = true;
        if (t.pendingUrl && !t.silentFirstCommit) { t.url = t.pendingUrl; delete t.pendingUrl; }
        for (const waiter of t.releaseWaiters.splice(0)) waiter();
        setImmediate(() => this.commit(t));
      }
      return {};
    });
    this.handle('Page.getFrameTree', (p, sid) => {
      const t = this.bySession(sid);
      const frame = mainFrameOf(t, t.url);
      const children = t.url ? (this.page(t).childFrames || []) : [];
      return { frameTree: { frame, childFrames: children.map((f) => ({ frame: { id: f.id, url: f.url, parentId: t.targetId } })) } };
    });
    this.handle('Page.createIsolatedWorld', ({ frameId }, sid) => {
      const t = this.bySession(sid);
      t.worlds = (t.worlds || 0) + 1;
      t.contexts.set(t.worlds, frameId);
      return { executionContextId: t.worlds };
    });
    this.handle('Runtime.evaluate', ({ expression, contextId, userGesture }, sid) => {
      const t = this.bySession(sid);
      if (expression === 'window') return { result: { type: 'object', objectId: this.object('window', t) } };
      const open = expression.match(/window\.open\((['"])(.*?)\1/);
      if (open) {
        // Under noopener window.open returns null; without a user gesture the popup
        // blocker keeps the window from opening.
        if (userGesture) this.openWindow(t, open[2]);
        return { result: { type: 'object', subtype: 'null', value: null } };
      }
      if (/document\.activeElement/.test(expression)) {
        const { focused } = this.page(t, this.frameOf(t, contextId));
        if (!focused) return { result: { type: 'object', subtype: 'null', value: null } };
        return { result: { type: 'object', objectId: this.object('element', t, { element: focused }) } };
      }
      if (expression === 'globalThis.__claudesurfElements') {
        // The walk stashes its elements on the world it ran in, and a document that
        // changed since has a world of its own, which holds no stash.
        if (t.walkedContext !== contextId) return { result: { type: 'undefined' } };
        return { result: { type: 'object', objectId: this.object('elements', t) } };
      }
      const m = expression.match(/getElementById\("([^"]+)"\)/);
      if (m) return { result: { type: 'object', objectId: this.object('link', t, { link: m[1] }) } };
      return { result: { type: 'undefined' } };
    });
    this.handle('DOM.getContentQuads', ({ objectId }) => {
      const o = this.objects.get(objectId);
      if (o && o.kind === 'element' && !o.element.visible) return { quads: [] };
      return { quads: [[10, 10, 50, 10, 50, 20, 10, 20]] };
    });
    this.handle('Input.dispatchMouseEvent', ({ type, modifiers }, sid) => {
      const t = this.bySession(sid);
      if (type === 'mouseReleased' && modifiers === 2 && t.url.startsWith(SESSION_PAGE)) this.openLink(t, 'identity');
      return {};
    });
    this.handle('Runtime.callFunctionOn', (params, sid) => this.callFunction(params, sid));
    this.handle('Runtime.getProperties', ({ objectId }) => {
      const o = this.objects.get(objectId);
      // The stashed array holds what the last walk collected, which under hiddenOnly
      // is the hidden elements alone.
      const walked = o.target.walked || this.page(o.target).elements;
      return {
        result: walked.map((element, i) => ({
          name: String(i), value: { type: 'object', objectId: this.object('element', o.target, { element }) },
        })),
      };
    });
    // By objectId for a walked element; by backendNodeId for an iframe node, whose
    // frameId is how a read joins it to the frame it holds.
    this.handle('DOM.describeNode', ({ objectId, backendNodeId }, sid) => {
      if (objectId) return { node: describe(this.objects.get(objectId).element) };
      const frame = (this.page(this.bySession(sid)).childFrames || []).find((f) => f.backendId === backendNodeId);
      return { node: { backendNodeId, frameId: frame ? frame.id : undefined } };
    });
    this.handle('Accessibility.getFullAXTree', ({ frameId }, sid) => {
      const t = this.bySession(sid);
      return { nodes: this.page(t, frameId).tree || [] };
    });
    this.handle('DOM.resolveNode', ({ backendNodeId, executionContextId }, sid) => {
      const t = this.bySession(sid);
      const page = this.page(t, this.frameOf(t, executionContextId));
      const element = (page.elements || []).find((e) => e.backendNodeId === backendNodeId);
      if (element) {
        if (element.detached) throw { code: -32000, message: 'No node with given id found' };
        return { object: { type: 'object', objectId: this.object('element', t, { element }) } };
      }
      // A node of the tree that is no element of the walk: a landmark, a frame, or the
      // scope root, which a read resolves to pass to the renderer.
      const node = (page.tree || []).find((n) => n.backendDOMNodeId === backendNodeId);
      if (!node) throw { code: -32000, message: 'No node with given id found' };
      return { object: { type: 'object', objectId: this.object('node', t, { node }) } };
    });
    this.handle('DOM.getNodeForLocation', (p, sid) => {
      const { elements } = this.page(this.bySession(sid));
      return { backendNodeId: (elements.find((e) => e.covering) || elements[0]).backendNodeId };
    });
    this.handle('Page.navigate', ({ url }, sid) => {
      const t = this.bySession(sid);
      const page = this.site[url];
      if (page && page.errorText) return { frameId: t.targetId, errorText: page.errorText };
      // A same-document navigation's answer doesn't carry a loader id, as Chrome's doesn't;
      // a cross-document one comes once the navigation has started, with its own.
      if (url.split('#')[0] === t.url.split('#')[0] && url.includes('#')) {
        setImmediate(() => {
          t.url = url;
          this.record(t, url);
          this.emit('Page.navigatedWithinDocument', { frameId: t.targetId, url }, t.sessionId);
        });
        return { frameId: t.targetId };
      }
      if (t.fetchEnabled || this.drops(url)) {
        // The answer waits for the request's outcome, as Chrome's does, and so follows the
        // failure of a dropped navigation's document request.
        return new Promise((resolve) => this.startNavigation(t, url, (committed, loaderId) => {
          resolve(committed === null ? { frameId: t.targetId, errorText: 'net::ERR_ABORTED' } : { frameId: t.targetId, loaderId });
        }));
      }
      this.announce(t, url);
      setImmediate(() => this.commitDocument(t, url));
      return { frameId: t.targetId, loaderId: t.loaderId };
    });
    this.handle('Page.captureScreenshot', () => ({ data: PNG }));
    this.handle('Page.getLayoutMetrics', (p, sid) => {
      const page = this.page(this.bySession(sid));
      return {
        cssContentSize: { x: 0, y: 0, width: 800, height: page.pageHeight },
        cssLayoutViewport: { pageX: 0, pageY: page.scrollY, clientWidth: 800, clientHeight: page.viewportHeight },
        cssVisualViewport: { pageX: 0, pageY: page.scrollY, clientWidth: 800, clientHeight: page.viewportHeight, scale: 1 },
      };
    });
    this.handle('Page.handleJavaScriptDialog', ok);
    this.handle('Page.getNavigationHistory', (p, sid) => {
      const t = this.bySession(sid);
      return {
        currentIndex: t.historyIndex,
        entries: t.history.map(({ id, url }) => ({ id, url, userTypedURL: url, title: (this.siteOf(url) || {}).title || '', transitionType: 'link' })),
      };
    });
    this.handle('Page.navigateToHistoryEntry', ({ entryId }, sid) => {
      const t = this.bySession(sid);
      const index = t.history.findIndex((e) => e.id === entryId);
      if (index < 0) throw { code: -32000, message: 'No entry with passed id' };
      setImmediate(() => this.historyStep(t, index));
      return {};
    });
    this.handle('Page.reload', (p, sid) => {
      const t = this.bySession(sid);
      setImmediate(() => this.startNavigation(t, t.url, undefined, { navigationType: 'reload', entry: t.historyIndex }));
      return {};
    });
    this.handle('Input.insertText', ({ text }) => {
      const element = this.editing && this.editing.element;
      if (element) insert(element, text);
      return {};
    });
    this.handle('Input.dispatchKeyEvent', (params, sid) => this.keyEvent(params, this.bySession(sid)));
    this.handle('Browser.close', () => { setImmediate(() => this.close()); return {}; });
  }

  // What the page script reports as hidden rather than rendering: a control the walk
  // calls invisible, and an <iframe> whose own entry marks it hidden.
  pageHides(page, descriptor) {
    if (descriptor.kind === 'control') {
      const element = this.elementOf(page, descriptor.ref);
      return Boolean(element) && !element.visible;
    }
    if (descriptor.kind !== 'iframe') return false;
    const frame = (page.childFrames || []).find((f) => f.backendId === backendOf(descriptor.ref));
    return Boolean(frame && frame.hidden);
  }

  // Builds the page script's answer from the descriptors that the daemon sent: one
  // marker per control, a placeholder per frame, and the hidden ones reported instead.
  // An overlay descriptor's node, and every descriptor under it in `page.tree`, stays
  // out, as the clone walk leaves it out; a combobox or listbox root renders as its
  // marker alone. `text` is the prose ahead of the markers, the page's own by default.
  renderAnswer(page, options, descriptors, { text = page.text } = {}) {
    const parts = [];
    const links = [];
    const refs = [];
    const hiddenRefs = [];
    const cut = new Set(descriptors.filter((d) => d.kind === 'overlay').flatMap((d) => [...subtreeOf(page.tree || [], d.backendId)]));
    const listed = descriptors.find((d) => d.root === true);
    const rootEntry = descriptors.find((d) => d.kind === 'root' || d.root === true);
    const lostRoot = Boolean(page.lostRoot && rootEntry);
    if (listed && !lostRoot) {
      return { markdown: this.marker(page, listed), links, chain: options.chain, refs: [listed.ref], hiddenRefs, article: null, lostRoot };
    }
    for (const d of descriptors) {
      if (d.kind === 'root' || d.kind === 'overlay' || cut.has(d.backendId)) continue;
      if (this.pageHides(page, d)) { hiddenRefs.push(d.ref); continue; }
      refs.push(d.ref);
      const href = d.kind === 'control' && d.role === 'link' ? this.urlOf(page, d.ref) : null;
      if (d.kind === 'iframe') parts.push(`\u0000frame:${d.ref}\u0000`);
      else if (href) {
        links.push({ ref: d.ref, url: href });
        parts.push(options.links === 'index' ? `[${d.name}][${d.ref}]` : `[${d.name}](${href})[${d.ref}]`);
      } else if (d.kind === 'control') parts.push(this.marker(page, d));
      else parts.push(`[${d.ref} ${d.role}${d.name ? ` ${JSON.stringify(d.name)}` : ''}]`);
    }
    const readability = options.chain === 'auto' || options.chain === 'forced-article';
    const found = Boolean(readability && page.article);
    let chain = readability ? (found ? 'readability' : options.fallback) : options.chain;
    if (lostRoot && !found) chain = 'body';
    return {
      markdown: [text, ...parts].filter(Boolean).join('\n\n'),
      links,
      chain,
      refs,
      hiddenRefs,
      article: readability ? { found, title: found ? page.article.title : '', byline: found ? page.article.byline || '' : '' } : null,
      lostRoot,
    };
  }

  // Returns a control's marker: its role, name, and state, and its options, by ref
  // unless the element behind it is a native <select> (`select: true` on its walk
  // element).
  marker(page, d) {
    const state = d.state && d.state.length ? ` (${d.state.join(', ')})` : '';
    let options = '';
    if (d.options) {
      const element = this.elementOf(page, d.ref);
      const native = Boolean(element && element.select);
      const names = d.options.names.map(({ name, ref }) => (native || !ref ? name : `${name} [${ref}]`));
      if (d.options.more) names.push(`… and ${d.options.more} more`);
      options = ` (options: ${names.join(', ')})`;
    }
    return `[${d.ref} ${d.role} ${JSON.stringify(d.name)}${state}${options}]`;
  }

  // Returns the render of an overlay block, rooted at the overlay:
  // `site[url].overlays[ref]` decides it, or the descriptors under the root alone when
  // it lacks a `text`.
  overlayAnswer(page, options, descriptors, t) {
    const root = descriptors.find((d) => d.kind === 'root');
    const entry = ((page.overlays || {})[root ? root.ref : '']) || {};
    if (typeof entry === 'function') return entry(options, descriptors, t);
    if (entry.throws) return { exceptionDetails: { text: 'Uncaught', exception: { description: `Error: ${entry.throws}` } } };
    const skipped = (entry.lost && 'lost') || (entry.hidden && 'hidden') || (entry.tiny && 'tiny') || null;
    if (skipped) return { markdown: '', links: [], chain: options.chain, refs: [], hiddenRefs: [], article: null, lostRoot: skipped === 'lost', skipped };
    return this.renderAnswer(page, options, descriptors, { text: entry.text || '' });
  }

  // Page-side scripts are recognised by the function name in their source.
  callFunction({ functionDeclaration, objectId, executionContextId, arguments: args = [] }, sid) {
    const t = this.bySession(sid);
    const page = this.page(t, this.frameOf(t, executionContextId));
    const values = args.map((a) => (a.objectId ? this.objects.get(a.objectId) : a.value));
    const value = (v) => ({ result: { type: typeof v, value: v } });
    if (/render\(/.test(functionDeclaration)) {
      t.label = { name: values[0], description: values[1] };
      return value(undefined);
    }
    if (/this\.click\(\)/.test(functionDeclaration)) {
      const o = this.objects.get(objectId);
      if (o && o.kind === 'link' && o.link === 'working-link') this.openLink(t, 'working');
      return value(undefined);
    }
    if (/function claudesurfWalk/.test(functionDeclaration)) {
      const hiddenOnly = values[0] === true;
      t.walked = hiddenOnly ? page.elements.filter((e) => !e.visible) : page.elements;
      t.walkedContext = executionContextId;
      return value({
        url: t.url, title: page.title, text: hiddenOnly ? '' : page.text,
        elements: t.walked.map(({ kind, label, href, disabled, checked, visible }) => ({ kind, label, href, disabled, checked, visible })),
      });
    }
    if (/claudesurfRender\(/.test(functionDeclaration)) {
      const [options, descriptors] = values;
      if (options.overlay) {
        const answer = this.overlayAnswer(page, options, descriptors, t);
        return answer.exceptionDetails ? answer : value(answer);
      }
      if (typeof page.render === 'function') return value(page.render(options, descriptors, t));
      return value(page.render || this.renderAnswer(page, options, descriptors));
    }
    if (/function claudesurfSettle/.test(functionDeclaration)) {
      // The observer installs on a world's first call, and a new document has a world
      // of its own.
      const worlds = t.settled || (t.settled = new Map());
      const world = executionContextId === undefined ? 'object' : executionContextId;
      if (!worlds.has(world)) worlds.set(world, Date.now());
      const busy = typeof page.busy === 'function' ? page.busy(t) : (page.busy || {});
      if (busy.throws) return { exceptionDetails: { text: 'Uncaught', exception: { description: `Error: ${busy.throws}` } } };
      return value({
        installedAt: worlds.get(world),
        lastMutationAt: busy.mutating ? Date.now() : (busy.lastMutationAt === undefined ? null : busy.lastMutationAt),
        readyState: busy.readyState || 'complete',
      });
    }
    if (/function claudesurfScroll/.test(functionDeclaration)) {
      const [direction, amount] = values;
      if (direction === 'down') page.scrollY = Math.min(page.pageHeight - page.viewportHeight, page.scrollY + (amount || 500));
      if (direction === 'up') page.scrollY = Math.max(0, page.scrollY - (amount || 500));
      if (direction === 'top') page.scrollY = 0;
      if (direction === 'bottom') page.scrollY = page.pageHeight - page.viewportHeight;
      return value({ url: t.url, title: page.title, scrollY: page.scrollY, pageHeight: page.pageHeight, viewportHeight: page.viewportHeight });
    }
    if (/function claudesurfClick/.test(functionDeclaration)) {
      const { element } = this.objects.get(objectId);
      if (element.detached) return value({ state: 'detached' });
      if (element.disabled) return value({ state: 'disabled' });
      if (values[0] === 'scripted' && element.onClick) setImmediate(() => element.onClick(this, t));
      return value({ state: element.visible ? 'ok' : 'hidden' });
    }
    if (/function claudesurfEdit/.test(functionDeclaration)) {
      const { element } = this.objects.get(objectId);
      return value(values[0] === 'focus' ? this.focusField(page, t, element) : selectField(element));
    }
    if (/function claudesurfSelect/.test(functionDeclaration)) {
      const { element } = this.objects.get(objectId);
      return value(chooseOption(element, values[0]));
    }
    if (/hit\.contains\(this\)/.test(functionDeclaration)) {
      const { element } = this.objects.get(objectId);
      const hit = values[0];
      return value(hit && hit.element === element);
    }
    return value(undefined);
  }

  // Runs claudesurfEdit's focus step: a field that can take text is focused, and input
  // reaches it from here on.
  focusField(page, t, element) {
    if (element.detached) return { state: 'detached' };
    const type = element.type || (element.kind === 'textbox' || element.kind === 'searchbox' ? 'text' : undefined);
    if (!element.editable && !TEXT_TYPES.includes(type)) return { state: 'not-editable', type: element.type };
    if (element.disabled) return { state: 'disabled' };
    if (element.readonly) return { state: 'readonly' };
    if (element.noFocus) return { state: 'no-focus' };
    page.focused = element;
    this.editing = { target: t, element };
    element.selectedAll = false;
    return { state: 'ok' };
  }

  onData(chunk) {
    this.buffer += chunk;
    let start = 0;
    for (;;) {
      const nul = this.buffer.indexOf('\0', start);
      if (nul === -1) break;
      const raw = this.buffer.slice(start, nul);
      start = nul + 1;
      this.onMessage(JSON.parse(raw));
    }
    this.buffer = this.buffer.slice(start);
  }

  onMessage({ id, method, params = {}, sessionId }) {
    const call = { id, method, params, sessionId };
    this.calls.push(call);
    this.log(`fake <- ${method}`);
    this.callWaiters = this.callWaiters.filter((w) => {
      if (w.method !== method || !w.predicate(call)) return true;
      w.resolve(call);
      return false;
    });
    const handler = this.handlers.get(method);
    let reply;
    try {
      const result = handler ? handler(params, sessionId, this) : {};
      // A handler may answer late by returning a promise.
      if (result && typeof result.then === 'function') {
        result.then((r) => this.write({ id, result: r }), (e) => this.write({ id, error: { code: -32000, message: e.message } }));
        return;
      }
      reply = { id, result };
    } catch (e) {
      reply = { id, error: e.code !== undefined ? { code: e.code, message: e.message } : { code: -32000, message: e.message || String(e) } };
    }
    this.write(reply);
  }

  write(message) {
    if (this.closed) return;
    this.output.write(JSON.stringify(message) + '\0');
  }
}

const TEXT_TYPES = ['text', 'search', 'email', 'url', 'tel', 'password', 'number'];

// Returns the protocol frame of the target's main frame at `url`, with the fragment
// apart in `urlFragment`, as Chrome reports one.
function mainFrameOf(target, url) {
  const [plain, fragment] = (url || '').split('#');
  const frame = { id: target.targetId, url: plain };
  if (fragment) frame.urlFragment = '#' + fragment;
  return frame;
}

// Types `text` into a text field: it replaces the value when the field's whole value is
// selected, and goes on the end otherwise.
function insert(element, text) {
  element.value = element.selectedAll ? text : `${element.value || ''}${text}`;
  element.selectedAll = false;
}

// Runs claudesurfEdit's select step, after the select-all key event.
function selectField(element) {
  if (element.stealsFocus) return { state: 'focus-lost' };
  if (element.selectedAll && element.type !== 'email' && element.type !== 'number') return { state: 'selected' };
  element.selectedAll = true;
  return { state: 'by-script' };
}

// Runs claudesurfSelect over a select element's `options`, by the page script's rule.
function chooseOption(element, option) {
  if (element.detached) return { state: 'detached' };
  if (!element.options) return { state: 'not-select' };
  if (element.disabled) return { state: 'disabled' };
  const collapse = (text) => (text || '').replace(/\s+/g, ' ').trim();
  const wanted = collapse(option);
  const folded = element.options.filter((o) => collapse(o.label).toLowerCase() === wanted.toLowerCase());
  const match = element.options.find((o) => collapse(o.label) === wanted)
    || element.options.find((o) => o.value === option)
    || (folded.length === 1 ? folded[0] : null);
  if (!match) return { state: 'no-match' };
  if (match.disabled) return { state: 'option-disabled' };
  for (const o of element.options) o.selected = o === match;
  element.value = match.value;
  return { state: 'ok' };
}

// Returns DOM.describeNode's answer for an element: its tag, attributes, own text, and
// the frame that an <iframe> holds.
function describe(element) {
  const tag = element.tag || 'input';
  const node = {
    backendNodeId: element.backendNodeId, nodeType: 1, nodeName: tag.toUpperCase(), localName: tag,
    attributes: Object.entries(element.attributes || {}).flat(),
    children: element.ownText ? [{ nodeType: 3, nodeName: '#text', nodeValue: element.ownText }] : [],
  };
  if (element.frameId) node.frameId = element.frameId;
  return node;
}

// Returns whether a navigation to `url` makes a document request: about: and data:
// URLs, and a target's empty first URL, don't.
function requestable(url) {
  return Boolean(url) && !/^(about|data):/i.test(url);
}

// Returns the backend ids of the node behind `backendId` and every node under it in
// `tree`.
function subtreeOf(tree, backendId) {
  const byId = new Map(tree.map((node) => [node.nodeId, node]));
  const start = tree.find((node) => node.backendDOMNodeId === backendId);
  const ids = new Set();
  const stack = start ? [start] : [];
  while (stack.length) {
    const node = stack.pop();
    if (node.backendDOMNodeId !== undefined) ids.add(node.backendDOMNodeId);
    for (const child of node.childIds || []) if (byId.has(child)) stack.push(byId.get(child));
  }
  return ids;
}

// The DOM node a ref names, which both sides of the fake key their pages on.
function backendOf(ref) {
  return Number(ref.slice(ref.lastIndexOf('e') + 1));
}

// The accessibility tree a page's elements imply: a root and one node per element,
// with the role, name, URL, and state the walk reports.
function treeOf(page) {
  const root = { nodeId: 'n0', role: { value: 'RootWebArea' }, name: { value: page.title || '' }, childIds: [] };
  const nodes = [root];
  (page.elements || []).forEach((element, i) => {
    const nodeId = `n${i + 1}`;
    root.childIds.push(nodeId);
    const properties = [];
    if (element.href) properties.push({ name: 'url', value: { value: element.href } });
    if (element.disabled) properties.push({ name: 'disabled', value: { value: true } });
    if (element.checked) properties.push({ name: 'checked', value: { value: 'true' } });
    nodes.push({
      nodeId, role: { value: element.kind }, name: { value: element.label || '' },
      backendDOMNodeId: element.backendNodeId, properties,
    });
  });
  return nodes;
}

module.exports = { FakeBrowser };
