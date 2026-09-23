const { test } = require('node:test');
const assert = require('node:assert');
const { validate, withDefaults, toolDefinitions, ACTIONS } = require('../server/dispatch');

test('a well-formed call validates to null', () => {
  assert.strictEqual(validate('claudesurf_read', 'page', { max_chars: 100, offset: 0, hidden: true }), null);
  assert.strictEqual(validate('claudesurf_read', 'page', { scope: 'all', find: 'market share', links: 'index' }), null);
  assert.strictEqual(validate('claudesurf_read', 'page', { scope: 'f1e12', article: false }), null);
  assert.strictEqual(validate('claudesurf_read', 'info', {}), null);
  assert.strictEqual(validate('claudesurf_read', 'info'), null);
  assert.strictEqual(validate('claudesurf_act', 'navigate', { url: 'https://example.com/', name: 'n' }), null);
  assert.strictEqual(validate('claudesurf_act', 'click', { ref: 'e42' }), null);
  assert.strictEqual(validate('claudesurf_act', 'scroll', { direction: 'down' }), null);
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
  const pageDefaults = { scope: 'main', article: false, links: 'inline', hidden: false, max_chars: 40000, offset: 0 };
  assert.deepStrictEqual(withDefaults('page', {}), pageDefaults);
  assert.deepStrictEqual(withDefaults('page', { offset: 5 }), { ...pageDefaults, offset: 5 });
  assert.deepStrictEqual(withDefaults('page', { find: 'x' }), { ...pageDefaults, find: 'x' });
  assert.deepStrictEqual(withDefaults('scroll', { direction: 'up' }), { direction: 'up', amount: 500 });
  assert.deepStrictEqual(withDefaults('click', { ref: 'e1' }), { ref: 'e1', trusted: false });
});

test('tool definitions list exactly the shipped actions with a flat schema and the verb index', () => {
  const tools = toolDefinitions();
  assert.deepStrictEqual(tools.map((t) => t.name), ['claudesurf_read', 'claudesurf_act']);
  const [read, act] = tools;
  assert.deepStrictEqual(read.inputSchema.properties.action.enum, ['page', 'info', 'screenshot']);
  assert.deepStrictEqual(act.inputSchema.properties.action.enum, ['navigate', 'click', 'scroll']);
  assert.deepStrictEqual(read.inputSchema.required, ['action']);
  assert.deepStrictEqual(act.inputSchema.required, ['action']);
  assert.deepStrictEqual(Object.keys(read.inputSchema.properties), ['action', 'scope', 'find', 'article', 'links', 'hidden', 'max_chars', 'offset', 'full_page']);
  assert.deepStrictEqual(read.inputSchema.properties.links.enum, ['inline', 'index']);
  assert.deepStrictEqual(Object.keys(act.inputSchema.properties), ['action', 'url', 'name', 'description', 'ref', 'trusted', 'direction', 'amount']);
  assert.deepStrictEqual(act.inputSchema.properties.direction.enum, ['up', 'down', 'top', 'bottom']);
  for (const action of Object.keys(ACTIONS)) {
    const tool = ACTIONS[action].tool === 'claudesurf_read' ? read : act;
    assert.ok(tool.description.includes(`\`${action}\``), `${action} is in the verb index`);
  }
  assert.match(read.description, /<<<claudesurf-untrusted:NONCE>>>/);
  assert.match(read.description, /`page`\(scope, find, article, links, hidden, max_chars, offset\) — /);
  assert.match(read.description, /scope=all for the whole page, scope=e42 for one element's or frame's subtree/);
  assert.match(read.description, /links=index moves URLs to a trailing list/);
  assert.match(act.description, /`click`\(ref, trusted\) — /);
  assert.match(act.description, /brings the window to the front/);
});
