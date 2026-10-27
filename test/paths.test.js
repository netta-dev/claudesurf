const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const { daemonSocketPath, profileDir, browserRecordPath, policyFile, actionLogPath } = require('../server/paths');
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

test('the allowlist defaults under XDG_CONFIG_HOME, then ~/.config, and follows CLAUDESURF_POLICY_FILE', async () => {
  await withEnv({ CLAUDESURF_POLICY_FILE: null, XDG_CONFIG_HOME: '/config' }, () => {
    assert.strictEqual(policyFile(), '/config/claudesurf/allowed-hosts');
  });
  await withEnv({ CLAUDESURF_POLICY_FILE: null, XDG_CONFIG_HOME: null }, () => {
    assert.strictEqual(policyFile(), path.join(os.homedir(), '.config', 'claudesurf', 'allowed-hosts'));
  });
  await withEnv({ CLAUDESURF_POLICY_FILE: '/tmp/cs-allowed-hosts' }, () => {
    assert.strictEqual(policyFile(), '/tmp/cs-allowed-hosts');
  });
});

test('the action log defaults under XDG_STATE_HOME, then ~/.local/state, and follows CLAUDESURF_ACTION_LOG', async () => {
  await withEnv({ CLAUDESURF_ACTION_LOG: null, XDG_STATE_HOME: '/state' }, () => {
    assert.strictEqual(actionLogPath(), '/state/claudesurf/actions.jsonl');
  });
  await withEnv({ CLAUDESURF_ACTION_LOG: null, XDG_STATE_HOME: null }, () => {
    assert.strictEqual(actionLogPath(), path.join(os.homedir(), '.local', 'state', 'claudesurf', 'actions.jsonl'));
  });
  await withEnv({ CLAUDESURF_ACTION_LOG: '/tmp/cs-actions.jsonl' }, () => {
    assert.strictEqual(actionLogPath(), '/tmp/cs-actions.jsonl');
  });
});
