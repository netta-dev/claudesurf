const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const { daemonSocketPath, profileDir, browserRecordPath } = require('../server/paths');
const { withEnv } = require('./helpers');

test('socket defaults to the runtime directory and follows CLAUDESURF_SOCKET', async () => {
  await withEnv({ CLAUDESURF_SOCKET: null, XDG_RUNTIME_DIR: '/run/user/1001' }, () => {
    assert.strictEqual(daemonSocketPath(), '/run/user/1001/claudesurf.sock');
  });
  await withEnv({ CLAUDESURF_SOCKET: null, XDG_RUNTIME_DIR: null }, () => {
    assert.strictEqual(daemonSocketPath(), `/run/user/${process.getuid()}/claudesurf.sock`);
  });
  await withEnv({ CLAUDESURF_SOCKET: '/tmp/cs.sock' }, () => {
    assert.strictEqual(daemonSocketPath(), '/tmp/cs.sock');
  });
});

test('profile defaults under XDG_DATA_HOME, then ~/.local/share, and follows CLAUDESURF_PROFILE_DIR', async () => {
  await withEnv({ CLAUDESURF_PROFILE_DIR: null, XDG_DATA_HOME: '/data' }, () => {
    assert.strictEqual(profileDir(), '/data/claudesurf/profile');
  });
  await withEnv({ CLAUDESURF_PROFILE_DIR: null, XDG_DATA_HOME: null }, () => {
    assert.strictEqual(profileDir(), path.join(os.homedir(), '.local', 'share', 'claudesurf', 'profile'));
  });
  await withEnv({ CLAUDESURF_PROFILE_DIR: '/tmp/cs-profile' }, () => {
    assert.strictEqual(profileDir(), '/tmp/cs-profile');
  });
});

test('record sits beside the socket, named after it, with or without an extension', async () => {
  await withEnv({ CLAUDESURF_SOCKET: null, XDG_RUNTIME_DIR: '/run/user/1001' }, () => {
    assert.strictEqual(browserRecordPath(), '/run/user/1001/claudesurf.browser.json');
  });
  await withEnv({ CLAUDESURF_SOCKET: '/tmp/x/worktree.sock' }, () => {
    assert.strictEqual(browserRecordPath(), '/tmp/x/worktree.browser.json');
  });
  await withEnv({ CLAUDESURF_SOCKET: '/tmp/x/worktree' }, () => {
    assert.strictEqual(browserRecordPath(), '/tmp/x/worktree.browser.json');
  });
});
