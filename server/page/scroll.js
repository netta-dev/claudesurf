// Runs in the browser, in the page's isolated world; sent as source by input.js and
// read.js. Never require() this file.
//
// Some sites (LinkedIn, etc.) scroll a container instead of the window; the heuristic
// below finds it. Called with no arguments it only reports the position.
function claudesurfScroll(direction, amount) {
  function findScrollableElement() {
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
      url: location.href,
      title: document.title,
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
    url: location.href,
    title: document.title,
    scrollY: window.scrollY,
    pageHeight: document.body ? document.body.scrollHeight : 0,
    viewportHeight: window.innerHeight,
    usedContainer: false
  };
}
