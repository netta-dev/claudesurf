const DEFAULT_WS_PORT = 7865;
// Port is overridable per-profile so a second OS user can run their own daemon on a
// different port (e.g. 7866) and their Chrome connects to *their* daemon. Two sources,
// highest wins: chrome.storage.local['claudesurf_ws_port'], then an optional untracked
// port.json ({"port": 7866}) next to this file — settable without service-worker console
// access. The daemon also peer-uid-rejects foreign Chromes, so a wrong port just fails
// to connect rather than crossing into another user's daemon.
let storagePort = null;
let filePort = null;
let wsPort = DEFAULT_WS_PORT;
const asPort = (v) => {
  const p = parseInt(v, 10);
  return Number.isInteger(p) && p > 0 ? p : null;
};
const updateWsPort = () => {
  wsPort = storagePort ?? filePort ?? DEFAULT_WS_PORT;
};
chrome.storage.local.get('claudesurf_ws_port').then((s) => {
  storagePort = asPort(s.claudesurf_ws_port);
  updateWsPort();
});
fetch(chrome.runtime.getURL('port.json'))
  .then((r) => r.json())
  .then((j) => {
    filePort = asPort(j.port);
    updateWsPort();
  })
  .catch(() => {}); // no port.json — fine, it's optional
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.claudesurf_ws_port) {
    storagePort = asPort(changes.claudesurf_ws_port.newValue);
    updateWsPort();
  }
});
const NAVIGATE_TIMEOUT_MS = 30_000;
// Namespace storage keys so per-profile state and per-session state can coexist.
const SESSION_KEY_PREFIX = 'session:';
const SESSION_NAME_KEY_PREFIX = 'sessionName:';
const LAST_FOCUSED_KEY = 'lastFocusedAt';
let ws = null;
let reconnectTimer = null;

// Map<sessionId, Promise<windowId>> — dedupes concurrent first-use creates for the same session.
const creatingWindow = new Map();

function connect() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    return;
  }
  ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);

  ws.onopen = () => {
    console.log('[ClaudeSurf] Connected to server');
    if (reconnectTimer) {
      clearInterval(reconnectTimer);
      reconnectTimer = null;
    }
  };

  ws.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    const { id, action, params, sessionId } = msg;
    let result;

    try {
      switch (action) {
        case '__claudesurf_get_focus': {
          const stored = await chrome.storage.session.get(LAST_FOCUSED_KEY);
          result = { lastFocusedAt: stored[LAST_FOCUSED_KEY] || null };
          break;
        }
        case 'read_page':
          result = await executeInActiveTab(sessionId, { action: 'getPageContent' });
          break;
        case 'click_element':
          if (params.selector) {
            result = await executeInActiveTab(sessionId, { action: 'clickBySelector', selector: params.selector });
          } else if (params.text) {
            result = await executeInActiveTab(sessionId, { action: 'clickByText', text: params.text });
          } else {
            result = { success: false, error: 'Provide selector or text' };
          }
          break;
        case 'navigate':
          if (params.name !== undefined) {
            await setSessionName(sessionId, params.name, params.description);
          }
          result = await navigateActiveTab(sessionId, params.url);
          break;
        case 'scroll':
          result = await executeInActiveTab(sessionId, { action: 'scroll', direction: params.direction, amount: params.amount });
          break;
        case 'get_page_info':
          result = await getPageInfo(sessionId);
          break;
        case 'screenshot':
          result = await captureScreenshot(sessionId);
          break;
        default:
          result = { success: false, error: 'Unknown action: ' + action };
      }
    } catch (e) {
      result = { success: false, error: e.message };
    }

    ws.send(JSON.stringify({ id, result }));
  };

  ws.onclose = () => {
    console.log('[ClaudeSurf] Disconnected, will retry...');
    scheduleReconnect();
  };

  ws.onerror = () => {
    // onclose will fire after this
  };
}

function scheduleReconnect() {
  if (!reconnectTimer) {
    reconnectTimer = setInterval(connect, 3000);
  }
}

// Keep the service worker alive using chrome.alarms.
// MV3 service workers die after ~30s of inactivity, killing the WebSocket.
// A periodic alarm wakes the worker, which triggers reconnect if needed.
chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connect();
    }
  }
});

// Track when this profile last gained OS focus so the daemon can pick the right
// profile when binding a new session. Stored in chrome.storage.session so it
// survives service worker death within a Chrome run. Debounced to 1s since rapid
// focus changes (e.g. alt-tabbing within this profile) don't add information.
const FOCUS_WRITE_DEBOUNCE_MS = 1000;
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return; // focus left all our windows
  const now = Date.now();
  const stored = await chrome.storage.session.get(LAST_FOCUSED_KEY);
  const prev = stored[LAST_FOCUSED_KEY] || 0;
  if (now - prev < FOCUS_WRITE_DEBOUNCE_MS) return;
  await chrome.storage.session.set({ [LAST_FOCUSED_KEY]: now });
});

async function initFocusTracking() {
  try {
    const win = await chrome.windows.getLastFocused({ populate: false });
    if (win && win.focused) {
      await chrome.storage.session.set({ [LAST_FOCUSED_KEY]: Date.now() });
    }
  } catch {
    // No windows yet, or transient — onFocusChanged will catch the next event.
  }
}
initFocusTracking();

async function getOrCreateSessionWindow(sessionId) {
  if (!sessionId) {
    throw new Error('Missing sessionId on request');
  }

  if (creatingWindow.has(sessionId)) {
    return creatingWindow.get(sessionId);
  }

  const storageKey = SESSION_KEY_PREFIX + sessionId;
  const stored = await chrome.storage.session.get(storageKey);
  const existingId = stored[storageKey];
  const shortDbg = sessionId.slice(0, 8);
  if (typeof existingId === 'number') {
    try {
      await chrome.windows.get(existingId);
      console.log(`[ClaudeSurf][debug] session ${shortDbg}: REUSE window ${existingId}`);
      return existingId;
    } catch {
      // Stored window is gone (user closed it, or this is a different profile that
      // happens to have a stale entry). Falls through to create a fresh one.
      console.log(`[ClaudeSurf][debug] session ${shortDbg}: stored window ${existingId} gone -> recreating`);
      await chrome.storage.session.remove(storageKey);
    }
  } else {
    // [debug] No window mapping for this sessionId in THIS profile. Either a brand-new
    // session, or the same session re-routed here from another profile (Mechanism 2).
    console.log(`[ClaudeSurf][debug] session ${shortDbg}: NO window mapping in this profile -> creating NEW window`);
  }

  const shortId = sessionId.slice(0, 8);
  const startedAt = new Date().toISOString();
  const url = chrome.runtime.getURL(
    `session.html#sessionId=${encodeURIComponent(sessionId)}&startedAt=${encodeURIComponent(startedAt)}`
  );

  // If the service worker dies between create resolving and the storage write, the
  // window is orphaned and the next call will spawn a fresh one. Bounded and rare.
  const createPromise = (async () => {
    try {
      const win = await chrome.windows.create({ url, focused: false });
      // Record the window in storage immediately so a partial-init failure below still
      // leaves a reusable handle — otherwise the window orphans and the next call spawns
      // another.
      await chrome.storage.session.set({ [storageKey]: win.id });
      const sessionTabId = win.tabs && win.tabs[0] && win.tabs[0].id;
      if (sessionTabId !== undefined) {
        await waitForTabReady(sessionTabId);
        // Pin the session marker tab so it stays visible as the window's identity,
        // resists accidental close, and stays out of the way for navigation.
        await chrome.tabs.update(sessionTabId, { pinned: true });
      }
      // Open a working tab so the window title doesn't follow Claude's navigation —
      // the pinned session.html stays as the visual marker on the left.
      await chrome.tabs.create({ windowId: win.id, url: 'about:blank', active: true });
      return win.id;
    } catch (e) {
      throw new Error(`Failed to open dedicated ClaudeSurf window for session ${shortId}: ${e.message}`);
    } finally {
      creatingWindow.delete(sessionId);
    }
  })();

  creatingWindow.set(sessionId, createPromise);
  return createPromise;
}

function waitForTabReady(tabId, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const done = () => {
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        done();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(done, timeoutMs);
    // Race with the tab already being ready by the time we listen.
    chrome.tabs.get(tabId).then((tab) => {
      if (tab && tab.status === 'complete' && tab.url) done();
    }).catch(() => done());
  });
}

async function getActiveTabInSessionWindow(sessionId, _retried = false) {
  const windowId = await getOrCreateSessionWindow(sessionId);
  try {
    const tabs = await chrome.tabs.query({ windowId });
    const working = tabs.filter((t) => !t.pinned);

    if (working.length === 0) {
      // User closed every working tab; recreate one so Claude has somewhere to navigate.
      const fresh = await chrome.tabs.create({ windowId, url: 'about:blank', active: true });
      return { tabId: fresh.id, url: fresh.url || '', title: fresh.title || '', windowId };
    }

    // Prefer active non-pinned. If user clicked the pinned session.html, the active tab is
    // pinned and excluded; fall back to most-recently-accessed non-pinned.
    const target = working.find((t) => t.active)
      || working.reduce((best, t) => ((t.lastAccessed || 0) > (best.lastAccessed || 0) ? t : best));
    return { tabId: target.id, url: target.url || '', title: target.title || '', windowId };
  } catch (e) {
    // The window can vanish between getOrCreateSessionWindow returning and the calls
    // above (user closes it). Clear the stale storage entry and retry exactly once.
    if (_retried) throw e;
    await chrome.storage.session.remove(SESSION_KEY_PREFIX + sessionId);
    return getActiveTabInSessionWindow(sessionId, true);
  }
}

function isSessionLandingPage(url) {
  // All URLs here block content-script injection. Treat as "navigate first" rather than
  // letting executeScript fail with a cryptic permission error.
  if (url === '' || url === 'about:blank') return true;
  return /^(chrome|chrome-extension|chrome-untrusted|devtools|view-source|file):/.test(url);
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { action: 'ping' });
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    });
  }
}

function sendToContentScript(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

async function executeInActiveTab(sessionId, message) {
  const { tabId, url } = await getActiveTabInSessionWindow(sessionId);
  if (isSessionLandingPage(url)) {
    return { success: false, error: 'Session window just opened — navigate to a URL first.' };
  }
  await ensureContentScript(tabId);
  return sendToContentScript(tabId, message);
}

async function getPageInfo(sessionId) {
  const { tabId, url, title } = await getActiveTabInSessionWindow(sessionId);
  if (isSessionLandingPage(url)) {
    return { success: true, url, title, note: 'Session window just opened — navigate to a URL first.' };
  }
  await ensureContentScript(tabId);
  return sendToContentScript(tabId, { action: 'getPageInfo' });
}

async function navigateActiveTab(sessionId, url) {
  const { tabId } = await getActiveTabInSessionWindow(sessionId);
  await chrome.tabs.update(tabId, { url });
  return new Promise((resolve) => {
    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve({ success: true, url });
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve({ success: true, url, note: 'navigation started but load timeout' });
    }, NAVIGATE_TIMEOUT_MS);
  });
}

async function setSessionName(sessionId, name, description) {
  if (typeof name !== 'string' || name.trim().length === 0) {
    return { success: false, error: 'name is required' };
  }
  if (description !== undefined && typeof description !== 'string') {
    return { success: false, error: 'description must be a string' };
  }
  // Eagerly ensure the session has a window so the pinned tab exists to receive the update.
  await getOrCreateSessionWindow(sessionId);
  const key = SESSION_NAME_KEY_PREFIX + sessionId;
  const stored = await chrome.storage.session.get(key);
  const current = stored[key];
  const newName = name.trim();
  // Omitted description preserves the previous one; empty string clears.
  const newDescription = description !== undefined ? description : (current ? current.description : '');
  if (current && current.name === newName && current.description === newDescription) {
    return { success: true, name: newName, description: newDescription, unchanged: true };
  }
  await chrome.storage.session.set({ [key]: { name: newName, description: newDescription } });
  return { success: true, name: newName, description: newDescription };
}

async function captureScreenshot(sessionId) {
  const { windowId, url } = await getActiveTabInSessionWindow(sessionId);
  if (isSessionLandingPage(url)) {
    return { success: false, error: 'Session window just opened — navigate to a URL first.' };
  }
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  return { success: true, image: base64 };
}

// Connect on startup
connect();

// Also reconnect when service worker wakes up
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
