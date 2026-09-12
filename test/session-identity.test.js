// The bridge's session identity must be stable across MCP respawns: the daemon keys
// each dedicated window by it, so a respawned bridge with a new id would open a new
// window. The identity comes from Claude Code's own session id, falling back to a hash
// of the project directory, then a random id.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'server', 'server.js');

// Spawns a fresh server.js with env overrides (null unsets) and returns the {id, source}
// its startup line logs to stderr. Empty stdin lets it exit at once.
function sessionIdOf(overrides) {
  const env = { ...process.env };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === null) delete env[k]; else env[k] = v;
  }
  const out = spawnSync('node', [SERVER], { input: '', encoding: 'utf8', timeout: 5000, env });
  const m = (out.stderr || '').match(/session \S+ \[([^\]]+)\] via ([^,]+)/);
  assert(m, `could not find session id in server.js stderr:\n${out.stderr}`);
  return { id: m[1], source: m[2] };
}

test('two respawns with the same CLAUDE_CODE_SESSION_ID share one SESSION_ID', () => {
  const FIXED = '00000000-1111-2222-3333-444444444444';
  const a1 = sessionIdOf({ CLAUDE_CODE_SESSION_ID: FIXED });
  const a2 = sessionIdOf({ CLAUDE_CODE_SESSION_ID: FIXED });
  assert.strictEqual(a1.source, 'CLAUDE_CODE_SESSION_ID');
  assert.strictEqual(a1.id, FIXED, 'id should be the env var verbatim');
  assert.strictEqual(a1.id, a2.id, 'respawn must reuse the id => extension reuses the window');
});

test('two respawns with neither env var get different ids', () => {
  const b1 = sessionIdOf({ CLAUDE_CODE_SESSION_ID: null, CLAUDE_PROJECT_DIR: null });
  const b2 = sessionIdOf({ CLAUDE_CODE_SESSION_ID: null, CLAUDE_PROJECT_DIR: null });
  assert.strictEqual(b1.source, 'randomUUID');
  assert.notStrictEqual(b1.id, b2.id, 'random fallback is per-process — this WAS the bug');
});

test('same project dir => same id; different dir => different id', () => {
  const base = { CLAUDE_CODE_SESSION_ID: null };
  const c1 = sessionIdOf({ ...base, CLAUDE_PROJECT_DIR: '/home/z/workspaces/claudesurf' });
  const c2 = sessionIdOf({ ...base, CLAUDE_PROJECT_DIR: '/home/z/workspaces/claudesurf' });
  const c3 = sessionIdOf({ ...base, CLAUDE_PROJECT_DIR: '/home/z/other' });
  assert.strictEqual(c1.source, 'CLAUDE_PROJECT_DIR(hash)');
  assert.strictEqual(c1.id, c2.id, 'same dir => same id');
  assert.notStrictEqual(c1.id, c3.id, 'different dir => different id');
});
