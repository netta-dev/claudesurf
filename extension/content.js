// Content script injected into pages to read/interact with DOM

function getPageText() {
  return document.body.innerText;
}

function getPageLinks() {
  const links = [];
  document.querySelectorAll('a[href]').forEach(a => {
    links.push({
      text: a.innerText.trim().substring(0, 200),
      href: a.href,
      selector: buildSelector(a)
    });
  });
  return links;
}

function buildSelector(el) {
  if (el.id) {
    return '#' + CSS.escape(el.id);
  }
  if (el.className && typeof el.className === 'string') {
    const classes = el.className.trim().split(/\s+/).slice(0, 3);
    if (classes.length && classes[0]) {
      const sel = el.tagName.toLowerCase() + '.' + classes.map(c => CSS.escape(c)).join('.');
      if (document.querySelectorAll(sel).length === 1) {
        return sel;
      }
    }
  }
  // Fall back to nth-child path
  const path = [];
  let current = el;
  while (current && current !== document.body) {
    const parent = current.parentElement;
    if (!parent) {
      break;
    }
    const index = Array.from(parent.children).indexOf(current) + 1;
    path.unshift(current.tagName.toLowerCase() + ':nth-child(' + index + ')');
    current = parent;
  }
  return 'body > ' + path.join(' > ');
}

function clickBySelector(selector) {
  const el = document.querySelector(selector);
  if (!el) {
    return { success: false, error: 'Element not found: ' + selector };
  }
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.click();
  return { success: true };
}

function clickByText(text) {
  // Try links first
  const links = document.querySelectorAll('a');
  for (const link of links) {
    if (link.innerText.trim().toLowerCase().includes(text.toLowerCase())) {
      link.scrollIntoView({ behavior: 'smooth', block: 'center' });
      link.click();
      return { success: true, clicked: link.innerText.trim().substring(0, 100) };
    }
  }
  // Try buttons
  const buttons = document.querySelectorAll('button, [role="button"], input[type="submit"]');
  for (const btn of buttons) {
    const btnText = btn.innerText || btn.value || '';
    if (btnText.trim().toLowerCase().includes(text.toLowerCase())) {
      btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
      btn.click();
      return { success: true, clicked: btnText.trim().substring(0, 100) };
    }
  }
  return { success: false, error: 'No clickable element found with text: ' + text };
}

function findScrollableElement() {
  // Some sites (LinkedIn, etc.) use a scrollable container instead of window/body scroll.
  // Walk the DOM to find it.
  const candidates = document.querySelectorAll('main, [role="main"], .scaffold-layout__main, .scaffold-finite-scroll');
  for (const el of candidates) {
    if (el.scrollHeight > el.clientHeight) {
      return el;
    }
  }
  // Generic: find the largest scrollable element
  const all = document.querySelectorAll('div');
  let best = null;
  let bestArea = 0;
  for (const el of all) {
    if (el.scrollHeight > el.clientHeight + 50) {
      const area = el.clientWidth * el.clientHeight;
      if (area > bestArea) {
        bestArea = area;
        best = el;
      }
    }
  }
  return best;
}

function getScrollTarget() {
  // If window is scrollable, use it
  if (document.documentElement.scrollHeight > window.innerHeight + 50) {
    return null; // null = use window
  }
  return findScrollableElement();
}

function scrollPage(direction, amount) {
  const pixels = amount || 500;
  const container = getScrollTarget();

  if (container) {
    if (direction === 'up') {
      container.scrollBy(0, -pixels);
    } else if (direction === 'down') {
      container.scrollBy(0, pixels);
    } else if (direction === 'top') {
      container.scrollTo(0, 0);
    } else if (direction === 'bottom') {
      container.scrollTo(0, container.scrollHeight);
    }
    return {
      success: true,
      scrollY: container.scrollTop,
      pageHeight: container.scrollHeight,
      viewportHeight: container.clientHeight,
      usedContainer: true
    };
  }

  if (direction === 'up') {
    window.scrollBy(0, -pixels);
  } else if (direction === 'down') {
    window.scrollBy(0, pixels);
  } else if (direction === 'top') {
    window.scrollTo(0, 0);
  } else if (direction === 'bottom') {
    window.scrollTo(0, document.body.scrollHeight);
  }
  return {
    success: true,
    scrollY: window.scrollY,
    pageHeight: document.body.scrollHeight,
    viewportHeight: window.innerHeight
  };
}

// Listen for messages from the background script
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  try {
    switch (msg.action) {
      case 'getPageContent': {
        const text = getPageText();
        const links = getPageLinks();
        sendResponse({
          success: true,
          title: document.title,
          url: window.location.href,
          text: text,
          links: links
        });
        break;
      }
      case 'clickBySelector':
        sendResponse(clickBySelector(msg.selector));
        break;
      case 'clickByText':
        sendResponse(clickByText(msg.text));
        break;
      case 'scroll':
        sendResponse(scrollPage(msg.direction, msg.amount));
        break;
      case 'getPageInfo':
        sendResponse({
          success: true,
          title: document.title,
          url: window.location.href,
          scrollY: window.scrollY,
          pageHeight: document.body.scrollHeight,
          viewportHeight: window.innerHeight
        });
        break;
      default:
        sendResponse({ success: false, error: 'Unknown action: ' + msg.action });
    }
  } catch (e) {
    sendResponse({ success: false, error: e.message });
  }
  return true; // keep channel open for async response
});
