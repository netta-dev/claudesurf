// Shared by read.js and input.js: the error that carries an envelope, the state
// lines every payload starts with, the working-target lookup, the http check, the
// page-state read, and the page-side scripts as source.

const fs = require('fs');
const path = require('path');
const envelope = require('./envelope');
const { SetupError } = require('./browser');

const PAGE_DIR = path.join(__dirname, 'page');
// The one copy of the cap on a name, a label, or a value: snapshot.js imports it and
// both page scripts take it as an argument, so a marker field is one bounded line.
const LABEL_MAX = 100;
// The one copy of the cap on a URL; past it a marker prints the URL's length instead,
// since a cut URL is not navigable. render.js applies it to a frame's URL and passes it
// to the page script, which applies it to a link's.
const URL_MAX = 200;
// The two characters the renderer reserves: the NUL that delimits a frame placeholder,
// and the private-use filler that pads a blank control and that server/page/render.js
// strips from the finished markdown. Every page-controlled string is stripped of both,
// there and here.
const RESERVED = /[\0\uE000]/g;
// A release runs under a deadline of its own: the call that took the objects may have
// spent its own, and an object group left unreleased pins its document's nodes for as
// long as the document lives. It never throws — the caller is already returning.
const RELEASE_MS = 2_000;
const NAVIGATE_FIRST = 'The working tab is not on an http(s) page; navigate first.';
const WORKING_TAB_GONE = 'The working tab is gone; retry the action.';

// Handlers throw this to return a specific envelope.
class OutcomeError extends Error {
  constructor(env) { super(env.message || env.outcome); this.name = 'OutcomeError'; this.envelope = env; }
}
function fail(env) { throw new OutcomeError(env); }

// Both values are the page's to set (history.pushState, document.title), and every
// action's payload carries them, so each is made safe the way a marker field is.
function stateLines(url, title) {
  return `URL: ${safeUrl(url)}\nTitle: ${safeText(title)}`;
}

// The characters safeUrl percent-encodes by hand, since encodeURIComponent leaves them be.
const URL_ESCAPES = { '(': '%28', ')': '%29' };

// A URL made safe to sit inside a marker or a list line: the brackets and parentheses
// the marker forms are built out of are percent-encoded, since a URL the page crafted
// would otherwise close its own marker and open one for a ref the page does not own;
// whitespace goes with them, since a newline would break the line it sits on.
// encodeURIComponent leaves the parentheses alone and encodes the rest, multi-byte
// whitespace included. server/page/render.js holds the page script's copy of the rule.
function safeUrl(url) {
  return url.replace(RESERVED, '').replace(/[()[\]\s]/g, (c) => URL_ESCAPES[c] || encodeURIComponent(c));
}

// Page text made safe for a header line: the characters the renderer reserves stripped,
// whitespace collapsed to one space, and brackets and backslashes escaped as a marker
// field is at its cap (snapshot.js's `capped`), so the text cannot close or open a
// marker. Uncapped, since a page may legitimately set a long title.
function safeText(text) {
  return (text || '').replace(RESERVED, '').replace(/\s+/g, ' ').trim().replace(/[\\[\]]/g, '\\$&');
}

// Steps a cut back so it never splits a surrogate pair, whose lone half renders as a
// replacement character: snapshot.js cuts a name at LABEL_MAX, render.js a region at
// max_chars and a frame at its cap. The page scripts hold their own copies, since they
// run in the browser.
function codePointBoundary(text, index) {
  if (index > 0 && index < text.length) {
    const code = text.charCodeAt(index);
    if (code >= 0xdc00 && code <= 0xdfff) return index - 1;
  }
  return index;
}

function workingTarget(sessions, session) {
  const t = session.workingTargetId && sessions.target(session.workingTargetId);
  if (!t) fail(envelope.error(WORKING_TAB_GONE));
  return t;
}

function requireHttp(t) {
  if (!/^https?:/i.test(t.url || '')) fail(envelope.error(NAVIGATE_FIRST));
}

// A page script is one function declaration sent as source. A `// @include <file>`
// line inside it is replaced by that file's content, so walk.js and click.js share
// one copy of state.js.
function pageScript(name) {
  const source = fs.readFileSync(path.join(PAGE_DIR, name), 'utf8');
  return source.replace(/^[ \t]*\/\/ @include (\S+)\n/gm, (line, file) => fs.readFileSync(path.join(PAGE_DIR, file), 'utf8'));
}

// The libraries the renderer runs on, as they ship: each binds its global when it is
// evaluated as a script, which is how an isolated world evaluates it.
const RENDER_LIBRARIES = [
  '@mozilla/readability/Readability.js',
  '@mozilla/readability/Readability-readerable.js',
  'turndown/lib/turndown.browser.umd.js',
  'turndown-plugin-gfm/dist/turndown-plugin-gfm.js',
];
const INSTALL_COMMAND = 'npm --prefix server ci --ignore-scripts';

// The renderer as one script: the libraries, then render.js. A caller evaluates it
// once per isolated world and then calls claudesurfRender there. A library that
// cannot be resolved or read is a SetupError naming the install command, which
// daemon.js renders as setup_error.
//
// Kept once it succeeds, since a read asks for 140 KB of it per unit; a failure is not
// kept, so an install repairs it without a restart.
let renderCache = null;
function renderSource() {
  if (renderCache === null) renderCache = buildRenderSource();
  return renderCache;
}

function buildRenderSource() {
  const libraries = RENDER_LIBRARIES.map((file) => {
    let resolved;
    try {
      resolved = require.resolve(file);
    } catch {
      throw new SetupError(`The renderer needs ${file}, which is not installed; run ${INSTALL_COMMAND}`);
    }
    try {
      return fs.readFileSync(resolved, 'utf8');
    } catch (e) {
      throw new SetupError(`The renderer cannot read ${resolved}: ${e.message}; run ${INSTALL_COMMAND}`);
    }
  });
  return [...libraries, pageScript('render.js')].join('\n;\n');
}

const WALK_SOURCE = pageScript('walk.js');
const CLICK_SOURCE = pageScript('click.js');
const SCROLL_SOURCE = pageScript('scroll.js');

// The target's url, title, and scroll position: the scroll script called with no
// arguments reports them without scrolling.
function pageState(sessions, t, opts) {
  return sessions.callInWorld(t.targetId, SCROLL_SOURCE, [], opts);
}

function releaseObjects(sessions, targetId, objectGroup) {
  return sessions.send(targetId, 'Runtime.releaseObjectGroup', { objectGroup }, { deadline: Date.now() + RELEASE_MS })
    .catch((e) => sessions.log.debug(`releasing ${objectGroup}: ${e.message}`));
}

module.exports = { OutcomeError, fail, stateLines, codePointBoundary, workingTarget, requireHttp, pageState, releaseObjects, renderSource, LABEL_MAX, URL_MAX, RESERVED, WORKING_TAB_GONE, WALK_SOURCE, CLICK_SOURCE, SCROLL_SOURCE, safeUrl, safeText };
