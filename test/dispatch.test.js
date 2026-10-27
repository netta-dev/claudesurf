// The action table that both processes validate against: each action's arguments and
// checks, the conflicts between arguments, an action's own check over several of them,
// and the two tool definitions generated from it, with a property that several actions
// share merged.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { validate, withDefaults, toolDefinitions, ACTIONS } = require('../server/dispatch');
const { tmpSocket, mockDaemon, callBridge } = require('./helpers');

test('a well-formed call validates to null', () => {
  assert.strictEqual(validate('claudesurf_read', 'page', { max_chars: 100, offset: 0, hidden: true }), null);
  assert.strictEqual(validate('claudesurf_read', 'page', { scope: 'all', find: 'market share', links: 'index' }), null);
  assert.strictEqual(validate('claudesurf_read', 'page', { scope: 'f1e12', article: false }), null);
  assert.strictEqual(validate('claudesurf_read', 'info', {}), null);
  assert.strictEqual(validate('claudesurf_read', 'info'), null);
  assert.strictEqual(validate('claudesurf_act', 'navigate', { url: 'https://example.com/', name: 'n' }), null);
  assert.strictEqual(validate('claudesurf_act', 'click', { ref: 'e42' }), null);
  assert.strictEqual(validate('claudesurf_act', 'scroll', { direction: 'down' }), null);
  assert.strictEqual(validate('claudesurf_act', 'type', { ref: 'f1e42', text: 'hello' }), null);
  assert.strictEqual(validate('claudesurf_act', 'type', { ref: 'e42', text: '' }), null, 'empty text clears the field');
  assert.strictEqual(validate('claudesurf_act', 'press', { keys: 'Control+a Backspace' }), null);
  assert.strictEqual(validate('claudesurf_act', 'select', { ref: 'e42', option: 'Oldest' }), null);
  assert.strictEqual(validate('claudesurf_act', 'history', { op: 'back' }), null);
  assert.strictEqual(validate('claudesurf_act', 'tabs', { op: 'list' }), null);
  assert.strictEqual(validate('claudesurf_act', 'policy', { op: 'allow_once', host: 'docs.example.com' }), null);
  assert.strictEqual(validate('claudesurf_read', 'page', { since: true, max_chars: 2000 }), null);
});

test('the six acting actions require their arguments and refuse a value their checks reject', () => {
  for (const [action, args, missing] of [
    ['type', { text: 'x' }, 'ref'],
    ['type', { ref: 'e1' }, 'text'],
    ['press', {}, 'keys'],
    ['select', { ref: 'e1' }, 'option'],
    ['history', {}, 'op'],
    ['tabs', {}, 'op'],
    ['policy', { op: 'allow_once' }, 'host'],
    ['policy', { host: 'a.test' }, 'op'],
  ]) {
    const r = validate('claudesurf_act', action, args);
    assert.strictEqual(r.outcome, 'schema_error', `${action} without ${missing}`);
    assert.match(r.message, new RegExp(`^${action}: ${missing} is required`));
  }
  assert.match(validate('claudesurf_act', 'type', { ref: 'x1', text: 'a' }).message, /^type: ref must look like e42/);
  assert.match(validate('claudesurf_act', 'type', { ref: 'e1', text: 5 }).message, /^type: text must be a string/);
  assert.strictEqual(validate('claudesurf_act', 'select', { ref: 'e1', option: '' }), null, 'an option whose value is empty resets many selects');
  assert.strictEqual(validate('claudesurf_act', 'select', { ref: 'e1', option: '  ' }), null, 'a value may be spaces alone');
  assert.match(validate('claudesurf_act', 'history', { op: 'up' }).message, /^history: op must be one of back, forward, reload/);
  assert.match(validate('claudesurf_act', 'tabs', { op: 'open' }).message, /^tabs: op must be one of list, new, switch, close/);
  assert.match(validate('claudesurf_act', 'policy', { op: 'allow', host: 'a.test' }).message, /^policy: op must be one of allow_once, allow_always/);
  assert.match(validate('claudesurf_act', 'press', { keys: 'Enter', ref: 'e1' }).message, /^press: unknown argument ref/, 'press takes no ref: keys go to whatever holds focus');
});

test('press refuses a key list that the grammar refuses, naming what is wrong', () => {
  assert.match(validate('claudesurf_act', 'press', { keys: 'Ctrl+Hyper+a' }).message, /^press: keys has an unknown modifier "Hyper"/);
  assert.match(validate('claudesurf_act', 'press', { keys: 'Return' }).message, /^press: keys has an unknown key "Return"/);
  assert.match(validate('claudesurf_act', 'press', { keys: '   ' }).message, /^press: keys must name at least one key/);
  assert.match(validate('claudesurf_act', 'press', { keys: Array(17).fill('a').join(' ') }).message, /^press: keys holds 17 presses; the limit is 16/);
  assert.strictEqual(validate('claudesurf_act', 'press', { keys: Array(16).fill('Tab').join(' ') }), null);
});

test('since refuses every argument that a read renders with unless it holds its default', () => {
  for (const [name, value] of [['scope', 'all'], ['scope', 'e42'], ['article', true], ['links', 'index'], ['hidden', true], ['find', 'x'], ['offset', 10]]) {
    const r = validate('claudesurf_read', 'page', { since: true, [name]: value });
    assert.strictEqual(r.outcome, 'schema_error', `since with ${name}=${value}`);
    assert.strictEqual(r.message, `page: since cannot be combined with ${name}; a since read renders with the parameters of your last read, so read without since to choose them`);
  }
  for (const [name, value] of [['scope', 'main'], ['article', false], ['links', 'inline'], ['hidden', false], ['offset', 0]]) {
    assert.strictEqual(validate('claudesurf_read', 'page', { since: true, [name]: value }), null, `since with ${name} at its default`);
  }
  assert.strictEqual(validate('claudesurf_read', 'page', { since: true, max_chars: 500 }), null, 'since takes max_chars at any value, as the cut of its diff');
  assert.strictEqual(validate('claudesurf_read', 'page', { since: false, scope: 'e42', find: 'x', links: 'index' }), null, 'since=false conflicts with nothing');
  assert.match(validate('claudesurf_read', 'page', { since: 'yes' }).message, /^page: since must be a boolean/);
});

test('tabs takes a URL for new, a tab id for switch and close, and nothing for list', () => {
  assert.strictEqual(validate('claudesurf_act', 'tabs', { op: 'new', target: 'https://a.test/x' }), null);
  assert.strictEqual(validate('claudesurf_act', 'tabs', { op: 'switch', target: 't2' }), null);
  assert.strictEqual(validate('claudesurf_act', 'tabs', { op: 'close', target: 't12' }), null);
  const cases = [
    [{ op: 'list', target: 't2' }, 'tabs: target is not taken by list'],
    [{ op: 'new' }, 'tabs: target is required for new: the http or https URL to open'],
    [{ op: 'new', target: 't2' }, 'tabs: target is not a valid URL'],
    [{ op: 'new', target: 'file:///etc/passwd' }, 'tabs: target must be http or https'],
    [{ op: 'switch' }, 'tabs: target is required for switch: a tab id like t2'],
    [{ op: 'switch', target: 'https://a.test/' }, 'tabs: target must be a tab id like t2 for switch'],
    [{ op: 'close', target: '2' }, 'tabs: target must be a tab id like t2 for close'],
  ];
  for (const [args, message] of cases) {
    const r = validate('claudesurf_act', 'tabs', args);
    assert.strictEqual(r.outcome, 'schema_error', JSON.stringify(args));
    assert.strictEqual(r.message, message);
    assert.strictEqual(r.schema.action, 'tabs', 'the schema rides along');
  }
  assert.match(validate('claudesurf_act', 'tabs', { op: 'list', extra: 1 }).message, /^tabs: unknown argument extra/, 'an unknown argument is reported ahead of the action\'s own check');
});

test('policy takes a bare host and refuses a URL, a wildcard, a port, and a top-level domain alone', () => {
  for (const host of ['https://evil.example/', '*.example.com', 'example.com:8443', 'com', 'example.com/path', 'user@example.com', 'two words.com']) {
    const r = validate('claudesurf_act', 'policy', { op: 'allow_always', host });
    assert.strictEqual(r.outcome, 'schema_error', host);
    assert.match(r.message, /^policy: host must be a bare host such as example\.com/);
  }
  for (const host of ['example.com', 'Docs.Example.COM', 'localhost', '127.0.0.1', '[::1]', 'bücher.example']) {
    assert.strictEqual(validate('claudesurf_act', 'policy', { op: 'allow_once', host }), null, host);
  }
});

test('a malformed key list is answered by the bridge as schema_error, without a request to the daemon', async () => {
  const socketPath = tmpSocket();
  const daemon = mockDaemon(socketPath, () => ({ outcome: 'success', payload: 'x' }));
  await daemon.listen();
  try {
    const { response } = await callBridge({ socketPath, name: 'claudesurf_act', args: { action: 'press', keys: 'Control+Hyper' } });
    const text = response.result.content[0].text;
    assert.strictEqual(response.result.isError, true);
    assert.match(text, /^outcome: schema_error\n/);
    assert.match(text, /press: keys has an unknown key "Hyper"/);
    assert.deepStrictEqual(daemon.seen, [], 'the daemon never saw the call');
  } finally {
    daemon.close();
    fs.rmSync(path.dirname(socketPath), { recursive: true, force: true });
  }
});

test('unknown tool or action, and an action on the wrong tool, return schema_error naming the actions', () => {
  const unknownTool = validate('claudesurf_x', 'page', {});
  assert.strictEqual(unknownTool.outcome, 'schema_error');
  const unknown = validate('claudesurf_read', 'fly', {});
  assert.strictEqual(unknown.outcome, 'schema_error');
  assert.match(unknown.message, /^fly: unknown action/);
  assert.deepStrictEqual(unknown.schema.actions, ['page', 'info', 'screenshot']);
  const wrongTool = validate('claudesurf_read', 'click', { ref: 'e1' });
  assert.strictEqual(wrongTool.outcome, 'schema_error');
});

test('missing required arguments: name, ref, direction, url', () => {
  for (const [action, args, missing] of [
    ['navigate', { url: 'https://a.test/' }, 'name'],
    ['navigate', { name: 'x' }, 'url'],
    ['click', {}, 'ref'],
    ['scroll', { amount: 3 }, 'direction'],
  ]) {
    const r = validate('claudesurf_act', action, args);
    assert.strictEqual(r.outcome, 'schema_error', `${action} without ${missing}`);
    assert.match(r.message, new RegExp(`^${action}: ${missing} is required`));
    assert.strictEqual(r.schema.action, action);
    assert.ok(r.schema.required.includes(missing));
    assert.ok(r.schema.properties[missing], 'schema carries the argument list');
  }
});

test('wrong types, bad enums, non-http URLs, bad refs, and unknown arguments are refused', () => {
  const type = validate('claudesurf_read', 'page', { max_chars: '100' });
  assert.match(type.message, /max_chars must be a integer/);
  assert.match(validate('claudesurf_read', 'page', { max_chars: 1.5 }).message, /max_chars must be a integer/);
  assert.match(validate('claudesurf_read', 'page', { max_chars: 0 }).message, /max_chars must be positive/);
  assert.match(validate('claudesurf_act', 'scroll', { direction: 'sideways' }).message, /direction must be one of up, down, top, bottom/);
  assert.match(validate('claudesurf_act', 'navigate', { url: 'ftp://x/', name: 'n' }).message, /url must be http or https/);
  assert.match(validate('claudesurf_act', 'navigate', { url: 'not a url', name: 'n' }).message, /url is not a valid URL/);
  assert.match(validate('claudesurf_act', 'navigate', { url: 'https://x/', name: '  ' }).message, /name must not be empty/);
  assert.match(validate('claudesurf_act', 'click', { ref: '42' }).message, /ref must look like e42, or f1e42 inside a frame/);
  assert.strictEqual(validate('claudesurf_act', 'click', { ref: 'f2e42' }), null, 'a frame ref is a ref');
  assert.match(validate('claudesurf_read', 'page', { scope: 'the sidebar' }).message, /scope must be main, all, or a ref like e42, or f1e12 inside a frame/);
  assert.match(validate('claudesurf_read', 'page', { find: '  ' }).message, /find must not be empty/);
  assert.match(validate('claudesurf_read', 'page', { links: 'trailing' }).message, /links must be one of inline, index/);
  assert.match(validate('claudesurf_act', 'click', { ref: 'e1', trusted: 'yes' }).message, /trusted must be a boolean/);
  assert.match(validate('claudesurf_act', 'click', { ref: 'e1', selector: 'a' }).message, /unknown argument selector/);
  assert.match(validate('claudesurf_read', 'info', []).message, /arguments must be an object/);
});

test('find rejects offset, and article rejects a ref scope, since the two ask for different things', () => {
  const paging = validate('claudesurf_read', 'page', { find: 'market share', offset: 4000 });
  assert.strictEqual(paging.outcome, 'schema_error');
  assert.match(paging.message, /^page: find cannot be combined with offset; a find read pages by the \[offset N\]/);
  const article = validate('claudesurf_read', 'page', { article: true, scope: 'e42' });
  assert.strictEqual(article.outcome, 'schema_error');
  assert.match(article.message, /^page: article extracts the whole document, so it cannot be combined with a ref scope/);
  assert.strictEqual(validate('claudesurf_read', 'page', { article: true, scope: 'all' }), null);
  assert.strictEqual(validate('claudesurf_read', 'page', { article: true, scope: 'main' }), null, 'the default scope is one an article reads under');
  assert.strictEqual(validate('claudesurf_read', 'page', { article: false, scope: 'e42' }), null, 'only the extraction conflicts');
  assert.strictEqual(validate('claudesurf_read', 'page', { find: 'x' }), null);
  assert.strictEqual(validate('claudesurf_read', 'page', { find: 'x', offset: 0 }), null, 'only a paging offset conflicts; 0 is the advertised default');
});

test('an argument that is wrong in itself is reported as that rather than as a conflict', () => {
  // find is checked before offset, so a conflict decided ahead of offset's own checks
  // would answer for a value that is no offset at all.
  assert.match(validate('claudesurf_read', 'page', { find: 'x', offset: '5' }).message, /^page: offset must be a integer/);
  assert.match(validate('claudesurf_read', 'page', { find: 'x', offset: -1 }).message, /^page: offset must not be negative/);
});

test('withDefaults fills the documented defaults without touching given values', () => {
  const pageDefaults = { scope: 'main', article: false, links: 'inline', hidden: false, max_chars: 40000, offset: 0, since: false };
  assert.deepStrictEqual(withDefaults('page', {}), pageDefaults);
  assert.deepStrictEqual(withDefaults('page', { offset: 5 }), { ...pageDefaults, offset: 5 });
  assert.deepStrictEqual(withDefaults('page', { find: 'x' }), { ...pageDefaults, find: 'x' });
  assert.deepStrictEqual(withDefaults('scroll', { direction: 'up' }), { direction: 'up', amount: 500 });
  assert.deepStrictEqual(withDefaults('click', { ref: 'e1' }), { ref: 'e1', trusted: false });
  assert.deepStrictEqual(withDefaults('tabs', { op: 'list' }), { op: 'list' });
});

test('tool definitions list exactly the shipped actions with a flat schema and the verb index', () => {
  const tools = toolDefinitions();
  assert.deepStrictEqual(tools.map((t) => t.name), ['claudesurf_read', 'claudesurf_act']);
  const [read, act] = tools;
  assert.deepStrictEqual(read.inputSchema.properties.action.enum, ['page', 'info', 'screenshot']);
  assert.deepStrictEqual(act.inputSchema.properties.action.enum, ['navigate', 'click', 'scroll', 'type', 'press', 'select', 'history', 'tabs', 'policy']);
  assert.deepStrictEqual(read.inputSchema.required, ['action']);
  assert.deepStrictEqual(act.inputSchema.required, ['action']);
  assert.deepStrictEqual(Object.keys(read.inputSchema.properties), ['action', 'scope', 'find', 'article', 'links', 'hidden', 'max_chars', 'offset', 'since', 'full_page']);
  assert.deepStrictEqual(read.inputSchema.properties.links.enum, ['inline', 'index']);
  assert.deepStrictEqual(Object.keys(act.inputSchema.properties), ['action', 'url', 'name', 'description', 'ref', 'trusted', 'direction', 'amount', 'text', 'keys', 'option', 'op', 'target', 'host']);
  assert.deepStrictEqual(act.inputSchema.properties.direction.enum, ['up', 'down', 'top', 'bottom']);
  for (const action of Object.keys(ACTIONS)) {
    const tool = ACTIONS[action].tool === 'claudesurf_read' ? read : act;
    assert.ok(tool.description.includes(`\`${action}\``), `${action} is in the verb index`);
  }
  assert.match(read.description, /<<<claudesurf-untrusted:NONCE>>>/);
  assert.match(read.description, /`page`\(scope, find, article, links, hidden, max_chars, offset, since\) — /);
  assert.match(read.description, /scope=all for the whole page, scope=e42 for one element's or frame's subtree/);
  assert.match(read.description, /links=index moves URLs to a trailing list/);
  assert.match(act.description, /`click`\(ref, trusted\) — /);
  assert.match(act.description, /brings the window to the front/);
  assert.match(act.description, /`click`\(ref, trusted\) — click an element by a ref from a `page` read of the current document; if the Changed: line says nothing changed and the control/);
  assert.match(read.description, /since=true returns what changed since your last read or action/);
  assert.match(act.description, /`type`\(ref, text\) — replace a text field's content with text \(empty clears it\); does not press Enter; /);
  assert.match(act.description, /`press`\(keys\) — send key presses to the focused element, e\.g\. "Enter", "Control\+a Backspace", "ArrowDown ArrowDown Enter"; /);
  assert.match(act.description, /`select`\(ref, option\) — choose an option of a native select by its label or value; /);
  assert.match(act.description, /`history`\(op\) — back, forward, or reload the working tab; /);
  assert.match(act.description, /`tabs`\(op, target\) — use `list` to list the session's tabs; `new` opens target=URL and makes it the working tab; use `switch` or `close` with target=t2; /);
  assert.match(act.description, /`policy`\(op, host\) — call `policy` only after the human approves a host that a Blocked: line named\. Use allow_once for this session or allow_always to save the host\./);
  assert.ok(act.description.endsWith(' Results end with a Changed: diff of the page since your last read or action. needs_confirmation means the domain gate stopped a navigation; ask the human before calling policy.'));
});

test('a property several actions declare is merged: its enums joined, its descriptions joined under each action', () => {
  const act = toolDefinitions()[1];
  const { op, ref } = act.inputSchema.properties;
  assert.strictEqual(op.type, 'string');
  assert.deepStrictEqual(op.enum, ['back', 'forward', 'reload', 'list', 'new', 'switch', 'close', 'allow_once', 'allow_always']);
  assert.strictEqual(op.description, 'history: back, forward, or reload. tabs: list, new, switch, or close. policy: allow_once or allow_always.');
  assert.strictEqual(ref.enum, undefined, 'no action declares an enum for ref');
  assert.match(ref.description, /^click: Element ref from a `page` read, e\.g\. e42; [^]* type: The text field's ref from a `page` read\. select: The select's ref from a `page` read\.$/);
  // Each action still validates against its own spec, not the merged enum.
  assert.match(validate('claudesurf_act', 'history', { op: 'list' }).message, /^history: op must be one of back, forward, reload/);
});

test('tool definitions refuse a table in which two actions of one tool declare a property with different types, and build one whose differing actions belong to different tools', () => {
  const action = (tool, arg) => ({ tool, summary: 'an action', args: { op: { description: 'The op.', ...arg } } });
  const conflicting = { one: action('claudesurf_act', { type: 'string', enum: ['a'] }), two: action('claudesurf_act', { type: 'integer' }) };
  assert.throws(() => toolDefinitions(conflicting), /two declares op as integer where one declares it as string/);
  const apart = toolDefinitions({ one: action('claudesurf_read', { type: 'string', enum: ['a'] }), two: action('claudesurf_act', { type: 'integer' }) });
  assert.deepStrictEqual(apart.map((tool) => tool.inputSchema.properties.op.type), ['string', 'integer']);
});

test('a merged property carries no enum when one of its actions declares it without one, so that action\'s free values stay valid', () => {
  const action = (arg) => ({ tool: 'claudesurf_act', summary: 'an action', args: { op: { type: 'string', description: 'The op.', ...arg } } });
  const [, act] = toolDefinitions({ one: action({ enum: ['a', 'b'] }), two: action({}) });
  assert.strictEqual(act.inputSchema.properties.op.enum, undefined);
});
