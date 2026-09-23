// A scripted browser speaking the pipe protocol over a stream pair: NUL-delimited JSON
// in, replies and events out. It models just enough of Chrome for the daemon's window
// and action paths — targets, windows, pages, the pause on attach — and records every
// command so tests can assert what was sent. Usable in-process (`inProcess()`) and as
// a child (fake-chrome.js).
//
// Tests customise it through `handle(method, fn)` to override a command (a promise
// returned from fn answers late), `site[url]` to describe the page a URL serves, and
// `emit()` to raise events.

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
  // attach handler's commands observable.
  createTarget({ url = '', windowId, openerId, lateUrl, windowDelayMs = 0, type = 'page', parent, holdUntilRelease = false } = {}) {
    const targetId = `T${this.nextTarget++}`;
    const target = {
      targetId, sessionId: `S${targetId}`, type, url, openerId,
      windowId: windowId || (parent ? parent.windowId : this.nextWindow++),
      parentFrameId: parent ? parent.targetId : undefined,
      pendingUrl: lateUrl, windowDelayMs, released: false, committed: false, loads: 0, enabled: false,
      contexts: new Map(), holdUntilRelease, releaseWaiters: [],
    };
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
    if (target.parentFrameId) frame.parentId = target.parentFrameId;
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
    this.handle('Page.enable', (p, sid) => {
      const t = this.bySession(sid);
      return this.afterRelease(t, () => { if (t) t.enabled = true; return {}; });
    });
    this.handle('Emulation.setFocusEmulationEnabled', ok);
    this.handle('Runtime.runIfWaitingForDebugger', (p, sid) => {
      const t = this.bySession(sid);
      if (t && !t.released) {
        t.released = true;
        if (t.pendingUrl) { t.url = t.pendingUrl; delete t.pendingUrl; }
        for (const waiter of t.releaseWaiters.splice(0)) waiter();
        setImmediate(() => this.commit(t));
      }
      return {};
    });
    this.handle('Page.getFrameTree', (p, sid) => {
      const t = this.bySession(sid);
      const [plain, fragment] = (t.url || '').split('#');
      const frame = { id: t.targetId, url: plain };
      if (fragment) frame.urlFragment = '#' + fragment;
      const children = t.url ? (this.page(t).childFrames || []) : [];
      return { frameTree: { frame, childFrames: children.map((f) => ({ frame: { id: f.id, url: f.url, parentId: t.targetId } })) } };
    });
    this.handle('Page.createIsolatedWorld', ({ frameId }, sid) => {
      const t = this.bySession(sid);
      t.worlds = (t.worlds || 0) + 1;
      t.contexts.set(t.worlds, frameId);
      return { executionContextId: t.worlds };
    });
    this.handle('Runtime.evaluate', ({ expression, contextId }, sid) => {
      const t = this.bySession(sid);
      if (expression === 'window') return { result: { type: 'object', objectId: this.object('window', t) } };
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
      if (objectId) return { node: { backendNodeId: this.objects.get(objectId).element.backendNodeId } };
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
      if (page && page.download) {
        // Under download denial: the navigation starts, the download event follows, no load.
        setImmediate(() => {
          this.emit('Page.frameStartedNavigating', { frameId: t.targetId, url, navigationType: 'differentDocument' }, t.sessionId);
          this.emit('Page.downloadWillBegin', { frameId: t.targetId, url }, t.sessionId);
        });
      } else if (url.split('#')[0] === t.url.split('#')[0] && url.includes('#')) {
        setImmediate(() => { t.url = url; this.emit('Page.navigatedWithinDocument', { frameId: t.targetId, url }, t.sessionId); });
      } else {
        setImmediate(() => this.navigateTarget(t, url));
      }
      return { frameId: t.targetId, loaderId: 'L1' };
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

  // What the page script would return, built from the descriptors the daemon sent: one
  // marker per control, a placeholder per frame, and the hidden ones reported instead.
  renderAnswer(page, options, descriptors) {
    const parts = [];
    const links = [];
    const refs = [];
    const hiddenRefs = [];
    for (const d of descriptors) {
      if (d.kind === 'root') continue;
      if (this.pageHides(page, d)) { hiddenRefs.push(d.ref); continue; }
      refs.push(d.ref);
      const state = d.state && d.state.length ? ` (${d.state.join(', ')})` : '';
      const href = d.kind === 'control' && d.role === 'link' ? this.urlOf(page, d.ref) : null;
      if (d.kind === 'iframe') parts.push(`\u0000frame:${d.ref}\u0000`);
      else if (href) {
        links.push({ ref: d.ref, url: href });
        parts.push(options.links === 'index' ? `[${d.name}][${d.ref}]` : `[${d.name}](${href})[${d.ref}]`);
      } else if (d.kind === 'control') parts.push(`[${d.ref} ${d.role} ${JSON.stringify(d.name)}${state}]`);
      else parts.push(`[${d.ref} ${d.role}${d.name ? ` ${JSON.stringify(d.name)}` : ''}]`);
    }
    const readability = options.chain === 'auto' || options.chain === 'forced-article';
    const found = Boolean(readability && page.article);
    return {
      markdown: [page.text, ...parts].filter(Boolean).join('\n\n'),
      links,
      chain: readability ? (found ? 'readability' : options.fallback) : options.chain,
      refs,
      hiddenRefs,
      article: readability ? { found, title: found ? page.article.title : '', byline: found ? page.article.byline || '' : '' } : null,
    };
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
      if (typeof page.render === 'function') return value(page.render(options, descriptors, t));
      return value(page.render || this.renderAnswer(page, options, descriptors));
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
    if (/hit\.contains\(this\)/.test(functionDeclaration)) {
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
