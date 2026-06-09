#!/usr/bin/env node

// Regression test for: "when claude compacts, it opens a new browser window
// instead of reusing the old one."
//
// Root cause (the one fixed here): server.js used a per-PROCESS `crypto.randomUUID()`
// as the session identity. The extension keys each dedicated window by that id
// (`chrome.storage.session['session:<id>']`). So whenever the MCP process was
// respawned, the new process minted a new id, the extension had never seen it, and
// opened a fresh window — orphaning the old one.
//
// The fix: derive a STABLE identity from Claude Code's own session id
// (CLAUDE_CODE_SESSION_ID), falling back to a hash of CLAUDE_PROJECT_DIR, then random.
//
// Red/green: test A asserts two respawns with the same CLAUDE_CODE_SESSION_ID produce
// the SAME SESSION_ID. Against the old `crypto.randomUUID()` code this FAILS (two random
// ids); against the fix it PASSES. (Verified red by running test A's spawn against
// `git show HEAD:server/server.js` — ids differed.)
//
// No test framework in this repo; run with:  node test/session-identity.test.js
//
// NOTE: this covers identity stability only (the fixed cause). The separate daemon
// profile-rebind gap (a stable id can still get routed to a different Chrome profile
// after the bound socket dies on a compaction's idle gap → new window in that profile)
// is deliberately NOT fixed yet — it's tracked via the [debug] logging in daemon.js /
// extension/background.js, to be confirmed against a real compaction before fixing.

const { spawnSync } = require('child_process');
const path = require('path');
const assert = require('assert');

const SERVER = path.join(__dirname, '..', 'server', 'server.js');

// Spawn a fresh server.js with env overrides (value null => unset that var) and return
// the {id, source} it logs to stderr at startup. server.js prints the line before it
// needs the daemon, then blocks on stdin; an empty stdin (EOF) lets it exit cleanly.
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

let passed = 0;
function check(label, fn) { fn(); passed++; console.log(`  ok - ${label}`); }

console.log('A. CLAUDE_CODE_SESSION_ID makes identity stable across respawns (the fix):');
const FIXED = '00000000-1111-2222-3333-444444444444';
check('two respawns with the same CLAUDE_CODE_SESSION_ID share one SESSION_ID', () => {
  const a1 = sessionIdOf({ CLAUDE_CODE_SESSION_ID: FIXED });
  const a2 = sessionIdOf({ CLAUDE_CODE_SESSION_ID: FIXED });
  assert.strictEqual(a1.source, 'CLAUDE_CODE_SESSION_ID');
  assert.strictEqual(a1.id, FIXED, 'id should be the env var verbatim');
  assert.strictEqual(a1.id, a2.id, 'respawn must reuse the id => extension reuses the window');
});

console.log('B. With no stable source, it falls back to random (the old always-on behavior):');
check('two respawns with neither env var get different ids', () => {
  const b1 = sessionIdOf({ CLAUDE_CODE_SESSION_ID: null, CLAUDE_PROJECT_DIR: null });
  const b2 = sessionIdOf({ CLAUDE_CODE_SESSION_ID: null, CLAUDE_PROJECT_DIR: null });
  assert.strictEqual(b1.source, 'randomUUID');
  assert.notStrictEqual(b1.id, b2.id, 'random fallback is per-process — this WAS the bug');
});

console.log('C. CLAUDE_PROJECT_DIR fallback is stable per dir, distinct across dirs:');
check('same project dir => same id; different dir => different id', () => {
  const base = { CLAUDE_CODE_SESSION_ID: null };
  const c1 = sessionIdOf({ ...base, CLAUDE_PROJECT_DIR: '/home/z/workspaces/claudesurf' });
  const c2 = sessionIdOf({ ...base, CLAUDE_PROJECT_DIR: '/home/z/workspaces/claudesurf' });
  const c3 = sessionIdOf({ ...base, CLAUDE_PROJECT_DIR: '/home/z/other' });
  assert.strictEqual(c1.source, 'CLAUDE_PROJECT_DIR(hash)');
  assert.strictEqual(c1.id, c2.id, 'same dir => same id');
  assert.notStrictEqual(c1.id, c3.id, 'different dir => different id');
});

console.log(`\n${passed} checks passed.`);
