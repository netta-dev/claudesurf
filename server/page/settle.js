// Runs in the browser, in the isolated world of one document: the page's main frame,
// or a child frame that an input action touched. Sent as source by settle.js and read.js.
// Never require() this file.
//
// Reports whether the document's structure and text are still changing. The first
// call installs a MutationObserver over the document and every open shadow root in
// it, since the renderer flattens open shadow roots into the markdown; later calls in
// the same world answer from it at once, and the world lasts as long as the document.
// Attribute changes are left out, so an animation that restyles every frame doesn't
// count. Times are Date.now() milliseconds; `lastMutationAt` is null until a mutation.
function claudesurfSettle() {
  const KEY = '__claudesurfSettle';
  if (!globalThis[KEY]) {
    const state = { installedAt: Date.now(), lastMutationAt: null };
    const options = { childList: true, characterData: true, subtree: true };
    const watched = new WeakSet();
    // The callback runs only after a mutation, by which time watchShadows below is defined.
    const observer = new MutationObserver((records) => {
      state.lastMutationAt = Date.now();
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) watchShadows(node);
        }
      }
    });
    // A shadow root is a tree of its own, which an observer on the document doesn't
    // see into, so each one gets an observe call of its own.
    const watch = (root) => {
      if (watched.has(root)) return;
      watched.add(root);
      observer.observe(root, options);
      watchShadows(root);
    };
    const watchShadows = (root) => {
      if (root.nodeType === Node.ELEMENT_NODE && root.shadowRoot) watch(root.shadowRoot);
      if (!root.querySelectorAll) return;
      for (const element of root.querySelectorAll('*')) {
        if (element.shadowRoot) watch(element.shadowRoot);
      }
    };
    watch(document);
    globalThis[KEY] = state;
  }
  const { installedAt, lastMutationAt } = globalThis[KEY];
  return { installedAt, lastMutationAt, readyState: document.readyState };
}
