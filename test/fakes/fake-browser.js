// A scripted browser speaking the pipe protocol over a stream pair: NUL-delimited JSON
// in, replies and events out. It models just enough of Chrome for the daemon's window
// and action paths — targets, windows, pages, the pause on attach — and records every
// command so tests can assert what was sent. Usable in-process (`inProcess()`) and as
// a child (fake-chrome.js).
//
// Tests customise it through `handle(method, fn)` to override a command, `site[url]`
// to describe the page a URL serves, and `emit()` to raise events.

const { PassThrough } = require('stream');
const path = require('path');
const { pathToFileURL } = require('url');

const SESSION_PAGE = pathToFileURL(path.join(__dirname, '..', '..', 'server', 'static', 'session.html')).href;
// A 1x1 PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function defaultPage(url) {
  return {
    title: 'Fake page',
    text: 'Hello from the fake browser.',
    elements: [
      { kind: 'link', label: 'Next', href: 'http://fake.test/next', disabled: false, checked: false, visible: true },
      { kind: 'button', label: 'Go', disabled: false, checked: false, visible: true },
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

  // Creates a page target, attached paused; its first document commits on release.
  createTarget({ url = '', windowId, openerId, session } = {}) {
    const targetId = `T${this.nextTarget++}`;
    const target = {
      targetId, sessionId: `S${targetId}`, url, windowId: windowId || this.nextWindow++, openerId,
      released: false, committed: false, loads: 0, enabled: false,
    };
    this.targets.set(targetId, target);
    const targetInfo = { targetId, type: 'page', title: '', url: target.url, attached: true };
    if (openerId) targetInfo.openerId = openerId;
    this.emit('Target.attachedToTarget', { sessionId: target.sessionId, targetInfo, waitingForDebugger: true });
    return target;
  }

  page(target) {
    const url = target.url;
    const plain = url.split('#')[0];
    if (!this.site[url] && !this.site[plain]) this.site[plain] = defaultPage(plain);
    return this.site[url] || this.site[plain];
  }

  commit(target) {
    if (target.committed) return;
    target.committed = true;
    this.navigateTarget(target, target.url);
  }

  // A cross-document navigation: the events Chrome fires, in order.
  navigateTarget(target, url) {
    target.url = url;
    const [plain, fragment] = url.split('#');
    this.emit('Page.frameStartedNavigating', { frameId: target.targetId, url, navigationType: 'differentDocument' }, target.sessionId);
    const frame = { id: target.targetId, url: plain };
    if (fragment) frame.urlFragment = '#' + fragment;
    this.emit('Page.frameNavigated', { frame, type: 'Navigation' }, target.sessionId);
    target.loads += 1;
    this.emit('Page.loadEventFired', { timestamp: target.loads }, target.sessionId);
  }

  destroyTarget(targetId) {
    const target = this.targets.get(targetId);
    if (!target) return;
    this.targets.delete(targetId);
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
    const opened = this.createTarget({ url: '', windowId: target.windowId });
    opened.pendingUrl = url;
    return opened;
  }

  installDefaults() {
    const ok = () => ({});
    this.handle('Browser.getVersion', () => ({ product: 'FakeChrome/1.0', protocolVersion: '1.3' }));
    this.handle('Target.setAutoAttach', ok);
    this.handle('Browser.setDownloadBehavior', ok);
    this.handle('Target.createTarget', ({ url, newWindow }) => {
      const target = this.createTarget({ url, windowId: newWindow ? undefined : this.nextWindow - 1 });
      return { targetId: target.targetId };
    });
    this.handle('Target.closeTarget', ({ targetId }) => { this.destroyTarget(targetId); return { success: true }; });
    this.handle('Browser.getWindowForTarget', ({ targetId }) => {
      const t = this.targets.get(targetId);
      if (!t) throw { code: -32000, message: 'No target with given id found' };
      return { windowId: t.windowId, bounds: { left: 0, top: 0, width: 800, height: 600, windowState: 'normal' } };
    });
    this.handle('Page.enable', (p, sid) => { const t = this.bySession(sid); if (t) t.enabled = true; return {}; });
    this.handle('Emulation.setFocusEmulationEnabled', ok);
    this.handle('Runtime.runIfWaitingForDebugger', (p, sid) => {
      const t = this.bySession(sid);
      if (t && !t.released) {
        t.released = true;
        if (t.pendingUrl) { t.url = t.pendingUrl; delete t.pendingUrl; }
        setImmediate(() => this.commit(t));
      }
      return {};
    });
    this.handle('Page.getFrameTree', (p, sid) => {
      const t = this.bySession(sid);
      const [plain, fragment] = (t.url || '').split('#');
      const frame = { id: t.targetId, url: plain };
      if (fragment) frame.urlFragment = '#' + fragment;
      return { frameTree: { frame, childFrames: [] } };
    });
    this.handle('Page.createIsolatedWorld', (p, sid) => {
      const t = this.bySession(sid);
      t.worlds = (t.worlds || 0) + 1;
      return { executionContextId: t.worlds };
    });
    this.handle('Runtime.evaluate', ({ expression }, sid) => {
      const t = this.bySession(sid);
      if (expression === 'window') return { result: { type: 'object', objectId: this.object('window', t) } };
      if (expression === 'globalThis.__claudesurfElements') return { result: { type: 'object', objectId: this.object('elements', t) } };
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
      const page = this.page(o.target);
      return {
        result: page.elements.map((element, i) => ({
          name: String(i), value: { type: 'object', objectId: this.object('element', o.target, { element, index: i }) },
        })),
      };
    });
    this.handle('DOM.describeNode', ({ objectId }) => {
      const o = this.objects.get(objectId);
      return { node: { backendNodeId: this.backendNodeId(o.target, o.index) } };
    });
    this.handle('DOM.resolveNode', ({ backendNodeId }, sid) => {
      const t = this.bySession(sid);
      const page = this.page(t);
      const index = page.elements.findIndex((e, i) => this.backendNodeId(t, i) === backendNodeId);
      if (index === -1 || page.elements[index].detached) throw { code: -32000, message: 'No node with given id found' };
      return { object: { type: 'object', objectId: this.object('element', t, { element: page.elements[index], index }) } };
    });
    this.handle('DOM.getNodeForLocation', (p, sid) => {
      const t = this.bySession(sid);
      const page = this.page(t);
      const covered = page.elements.findIndex((e) => e.covering);
      return { backendNodeId: this.backendNodeId(t, covered === -1 ? 0 : covered) };
    });
    this.handle('Page.navigate', ({ url }, sid) => {
      const t = this.bySession(sid);
      const page = this.site[url];
      if (page && page.errorText) return { frameId: t.targetId, errorText: page.errorText };
      setImmediate(() => this.navigateTarget(t, url));
      return { frameId: t.targetId, loaderId: 'L1' };
    });
    this.handle('Page.captureScreenshot', () => ({ data: PNG }));
    this.handle('Page.getLayoutMetrics', (p, sid) => {
      const page = this.page(this.bySession(sid));
      return { cssContentSize: { x: 0, y: 0, width: 800, height: page.pageHeight }, cssVisualViewport: { clientWidth: 800, clientHeight: page.viewportHeight, scale: 1 } };
    });
    this.handle('Page.handleJavaScriptDialog', ok);
    this.handle('Browser.close', () => { setImmediate(() => this.close()); return {}; });
  }

  backendNodeId(target, index) {
    const page = this.page(target);
    const element = page.elements[index];
    if (element.backendNodeId === undefined) element.backendNodeId = this.nextBackendNode++;
    return element.backendNodeId;
  }

  // Page-side scripts are recognised by the function name in their source.
  callFunction({ functionDeclaration, objectId, arguments: args = [] }, sid) {
    const t = this.bySession(sid);
    const page = this.page(t);
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
      return value({ url: t.url, title: page.title, text: page.text, elements: page.elements.map(({ kind, label, href, disabled, checked, visible }) => ({ kind, label, href, disabled, checked, visible })) });
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
    if (/this\.contains\(hit\)/.test(functionDeclaration)) {
      const { element } = this.objects.get(objectId);
      const hit = values[0];
      return value(hit && hit.element === element);
    }
    return value(undefined);
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
      reply = { id, result };
    } catch (e) {
      reply = { id, error: e.code !== undefined ? { code: e.code, message: e.message } : { code: -32000, message: e.message || String(e) } };
    }
    if (reply.result && reply.result.__defer) {
      reply.result.__defer.then((result) => this.write({ id, result }), (e) => this.write({ id, error: { code: -32000, message: e.message } }));
      return;
    }
    this.write(reply);
  }

  write(message) {
    if (this.closed) return;
    this.output.write(JSON.stringify(message) + '\0');
  }
}

module.exports = { FakeBrowser, SESSION_PAGE, PNG, defaultPage };
