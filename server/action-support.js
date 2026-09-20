// Shared by read.js and input.js: the error that carries an envelope, the state
// lines every payload starts with, the working-target lookup, the http check, the
// page-state read, and the page-side scripts as source.

const fs = require('fs');
const path = require('path');
const envelope = require('./envelope');

const PAGE_DIR = path.join(__dirname, 'page');
const NAVIGATE_FIRST = 'The working tab is not on an http(s) page; navigate first.';
const WORKING_TAB_GONE = 'The working tab is gone; retry the action.';

// Handlers throw this to return a specific envelope.
class OutcomeError extends Error {
  constructor(env) { super(env.message || env.outcome); this.name = 'OutcomeError'; this.envelope = env; }
}
function fail(env) { throw new OutcomeError(env); }

function stateLines(url, title) {
  return `URL: ${url}\nTitle: ${title}`;
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

const WALK_SOURCE = pageScript('walk.js');
const CLICK_SOURCE = pageScript('click.js');
const SCROLL_SOURCE = pageScript('scroll.js');

// The target's url, title, and scroll position: the scroll script called with no
// arguments reports them without scrolling.
function pageState(sessions, t, opts) {
  return sessions.callInWorld(t.targetId, SCROLL_SOURCE, [], opts);
}

module.exports = { OutcomeError, fail, stateLines, workingTarget, requireHttp, pageState, WORKING_TAB_GONE, WALK_SOURCE, CLICK_SOURCE, SCROLL_SOURCE };
