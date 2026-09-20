// The bridge's behaviour when the daemon is unreachable. The daemon runs under
// systemd with Restart=always, so the daemon is back ~3 s after a crash; the bridge retries a
// not-reached daemon over that window (ENOENT while the socket file is gone,
// ECONNREFUSED while nothing accepts) and, if it stays down, returns setup_error
// pointing at the service.

const { test } = require('node:test');
const assert = require('node:assert');
const { tmpSocket, mockDaemon, callBridge } = require('./helpers');

test('a daemon that comes up within the retry window makes the restart invisible', async () => {
  const socketPath = tmpSocket();
  const daemon = mockDaemon(socketPath, () => ({ outcome: 'success', payload: 'URL: http://retry-rode-it-out\nTitle: t' }));
  setTimeout(() => daemon.listen(), 1500);
  try {
    const { response, stderr } = await callBridge({ socketPath, name: 'claudesurf_read', args: { action: 'info' } });
    const text = response.result.content[0].text;
    assert(!response.result.isError, 'should succeed once the daemon comes up; got: ' + text);
    assert(text.includes('retry-rode-it-out'), 'should return the mock daemon payload; got: ' + text);
    assert(/retrying \(/.test(stderr), 'should have logged at least one retry; stderr:\n' + stderr);
    assert.deepStrictEqual(daemon.seen.map((b) => [b.tool, b.action]), [['claudesurf_read', 'info']]);
  } finally {
    daemon.close();
  }
});

test('a daemon that stays down returns setup_error with the systemctl message', async () => {
  const socketPath = tmpSocket();
  const { response } = await callBridge({ socketPath, name: 'claudesurf_read', args: { action: 'info' } });
  const text = response.result.content[0].text;
  assert(response.result.isError, 'should be an error when the daemon stays down; got: ' + text);
  assert.match(text, /^outcome: setup_error\n/);
  assert(text.includes('systemctl --user restart claudesurf'), 'message should point at the service; got: ' + text);
  assert(!/\bnode\b/.test(text), 'message must not tell the agent to run node directly; got: ' + text);
});
