const fs = require('fs');
const path = require('path');
const envelope = require('./envelope');
const { ConnectionClosedError } = require('./cdp');
const { SetupError } = require('./browser');
const { isWeb } = require('./policy');

const PAGE_DIR = path.join(__dirname, 'page');
// The one copy of the cap on a name, a label, or a value: cappedText cuts to it, and
// the render and walk page scripts take it as an argument, so a marker field is one
// bounded line.
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
// A run of whitespace or line terminators, which a one-line field collapses to one
// space; \s leaves out U+0085, which network.js's body lines break at too.
// server/page/collapse.js holds the page scripts' copy of the rule.
const SPACES = /[\s\u0085]+/g;
// The margin that a load wait leaves before the request deadline, so the page state that
// follows it still has time to be read.
const LOAD_MARGIN_MS = 2_000;
const NAVIGATE_FIRST = 'The working tab is not on an http(s) page; navigate first.';
const WORKING_TAB_GONE = 'The working tab is gone; retry the action.';
const TIMED_OUT = Symbol('timed out');

// Handlers throw this to return a specific envelope.
class OutcomeError extends Error {
  constructor(env) { super(env.message || env.outcome); this.name = 'OutcomeError'; this.envelope = env; }
}
function fail(env) { throw new OutcomeError(env); }

// Returns the URL: and Title: lines that every action's payload carries. Both values are the
// page's to set (history.pushState, document.title), so each is made safe the way a
// marker field is.
function stateLines(url, title) {
  return `URL: ${safeUrl(url)}\nTitle: ${safeText(title)}`;
}

// The characters safeUrl percent-encodes by hand, since encodeURIComponent leaves them be.
const URL_ESCAPES = { '(': '%28', ')': '%29' };

// Returns a URL made safe to sit inside a marker or a list line: the brackets and
// parentheses that the marker forms are built out of are percent-encoded, since a URL
// that the page crafted would otherwise close its own marker and open one for a ref that
// the page does not own; whitespace goes with them, since a newline would break the line it
// sits on.
// encodeURIComponent leaves the parentheses alone and encodes the rest, multi-byte
// whitespace included. server/page/render.js holds the page script's copy of the rule.
function safeUrl(url) {
  return url.replace(RESERVED, '').replace(/[()[\]\s\u0085]/g, (c) => URL_ESCAPES[c] || encodeURIComponent(c));
}

// Returns page text made safe for a header line: the characters that the renderer
// reserves are stripped, whitespace is collapsed to one space, and brackets and
// backslashes are escaped as cappedText escapes a marker field, so the text cannot close
// or open a marker. The text isn't capped, since a page may legitimately set a long
// title.
function safeText(text) {
  return (text || '').replace(RESERVED, '').replace(SPACES, ' ').trim().replace(/[\\[\]]/g, '\\$&');
}

// Returns page text as one bounded field, such as a marker's name, a tab's title, or a
// focused element's label: the characters that the renderer reserves are stripped,
// whitespace is collapsed, the text is cut to at most `max` characters with an ellipsis,
// and then brackets and backslashes are escaped, so the field can't close the marker it
// sits in or open one. The cap counts the page's characters, not the escapes.
function cappedText(text, max = LABEL_MAX) {
  return collapsedText(text, max).replace(/[\\[\]]/g, '\\$&');
}

// Returns page text stripped, collapsed, and cut as cappedText does, without the
// escapes, for a store that prints it later: cappedText(collapsedText(text, max), max)
// equals cappedText(text, max).
function collapsedText(text, max = LABEL_MAX) {
  return cutText((text || '').replace(RESERVED, '').replace(SPACES, ' ').trim(), max);
}

function letters(word) {
  return String(word || '').toLowerCase().replace(/[^a-z]/g, '');
}

// Returns a URL made safe by safeUrl and cut at URL_MAX with an ellipsis, for a line
// that names a page rather than links to it.
function cappedUrl(url) {
  return cutText(safeUrl(url || ''), URL_MAX);
}

// Returns `text` whole when it has at most `max` characters; otherwise returns its first
// `max - 1` characters and an ellipsis. Cuts one character sooner if the cut would split
// a surrogate pair.
function cutText(text, max) {
  return text.length > max ? `${text.slice(0, codePointBoundary(text, max - 1))}…` : text;
}

// Returns a cut index that doesn't split a surrogate pair. An unpaired surrogate
// renders as a replacement character. The page scripts carry copies of this function
// because they run in the browser.
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
  if (!isWeb(t.url)) fail(envelope.error(NAVIGATE_FIRST));
}

function pipeClosed(sessions, e) {
  return e instanceof ConnectionClosedError || Boolean(sessions.conn && sessions.conn.closed);
}

function pipeClosedOrTabGone(sessions, t, e) {
  return pipeClosed(sessions, e) || sessions.target(t.targetId) !== t;
}

// Returns the milliseconds that a load wait of `limit` gets: cut to the deadline less the
// margin, and at least 1, so a spent deadline still runs one check.
function loadBudget(limit, deadline) {
  if (deadline === undefined) return limit;
  return Math.max(1, Math.min(limit, deadline - LOAD_MARGIN_MS - Date.now()));
}

// Resolves with the promise's value, or TIMED_OUT at `deadline`.
function within(promise, deadline) {
  let timer;
  const expired = new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), Math.max(1, deadline - Date.now())); });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

// Returns the page script `name` as source: one function declaration, with each
// `// @include <file>` line inside it replaced by that file's content, so the scripts
// that judge an element's state share one copy of state.js, those that find the
// focused element one copy of focused.js, and those that collapse whitespace one copy
// of collapse.js.
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

// Returns the renderer as one script: the libraries, then render.js. A caller evaluates
// it once per isolated world and then calls claudesurfRender there. A library that
// cannot be resolved or read is a SetupError naming the install command, which
// respond.js's failureEnvelope answers as setup_error.
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
const SETTLE_SOURCE = pageScript('settle.js');
const EDIT_SOURCE = pageScript('edit.js');
const SELECT_SOURCE = pageScript('select.js');
const FOCUSED_SOURCE = pageScript('focused.js');
const DETECT_SOURCE = pageScript('detect.js');
const VISIBLE_SOURCE = pageScript('visible.js');
const FETCH_SOURCE = pageScript('fetch.js');

// Resolves with the target's url, title, and scroll position: the scroll script, when
// called with no arguments, reports them without scrolling.
function pageState(sessions, t, opts) {
  return sessions.callInWorld(t.targetId, SCROLL_SOURCE, [], opts);
}

// Resolves with the state lines of the target's document as it is now.
async function currentStateLines(sessions, t, opts) {
  const info = await pageState(sessions, t, opts);
  return stateLines(info.url, info.title);
}

// Releases an object group, waiting for Chrome's answer until `deadline`, the
// request's, at most. The command goes out however little of the deadline is left,
// since a group left unreleased pins its document's nodes for as long as the document
// lives. Never rejects: the caller is already returning.
function releaseObjects(sessions, targetId, objectGroup, deadline) {
  return sessions.send(targetId, 'Runtime.releaseObjectGroup', { objectGroup }, { deadline })
    .catch((e) => sessions.log.debug(`releasing ${objectGroup}: ${e.message}`));
}

module.exports = { OutcomeError, fail, stateLines, codePointBoundary, cutText, workingTarget, requireHttp, pipeClosed, pipeClosedOrTabGone, loadBudget, within, TIMED_OUT, pageState, currentStateLines, releaseObjects, renderSource, LABEL_MAX, URL_MAX, RESERVED, SPACES, WORKING_TAB_GONE, WALK_SOURCE, CLICK_SOURCE, SCROLL_SOURCE, SETTLE_SOURCE, EDIT_SOURCE, SELECT_SOURCE, FOCUSED_SOURCE, DETECT_SOURCE, VISIBLE_SOURCE, FETCH_SOURCE, safeUrl, cappedText, collapsedText, cappedUrl, letters };
