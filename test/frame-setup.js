// Scaffolding for tests of a page that holds an out-of-process frame, served by the
// in-process fake and attached as its own target.

const { waitFor } = require('./helpers');

const FRAME_URL = 'http://frame.test/child';

// Returns the tree and childFrames of a fake-site page that holds only an
// out-of-process frame, at backend id 90, which loads FRAME_URL; a fixture spreads
// them in.
function oneFrame() {
  return {
    tree: [
      { nodeId: 'n0', role: { value: 'RootWebArea' }, name: { value: 'A' }, childIds: ['n1'] },
      { nodeId: 'n1', role: { value: 'Iframe' }, name: { value: '' }, backendDOMNodeId: 90 },
    ],
    childFrames: [{ backendId: 90, url: FRAME_URL }],
  };
}

// Attaches the frame at `backendId` in the fake tab `parent` as its own target and
// resolves with that fake target once the frame's first document has committed. A read
// made before then returns refs that the frameNavigated after it makes stale.
async function attachFrame({ fake, sessions }, parent, backendId) {
  const frame = fake.attachFrame(parent, backendId);
  await waitFor(() => sessions.target(frame.targetId) && sessions.target(frame.targetId).generation > 0);
  return frame;
}

// Makes the settle probe of the fake target `frame`'s own world never answer, so
// settling runs out on it.
function silenceFrame(fake, frame) {
  const original = fake.handlers.get('Runtime.callFunctionOn');
  fake.handle('Runtime.callFunctionOn', (params, sid) => (
    sid === frame.sessionId && /function claudesurfSettle/.test(params.functionDeclaration) ? new Promise(() => {}) : original(params, sid)
  ));
}

module.exports = { FRAME_URL, oneFrame, attachFrame, silenceFrame };
