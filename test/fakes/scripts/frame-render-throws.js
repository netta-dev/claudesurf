// CLAUDESURF_FAKE_SCRIPT: the page holds one out-of-process frame whose renderer
// throws, so the page is delivered and the frame says it is not readable.
const PAGE = 'http://fake.test/';
const FRAME = 'http://frame.test/child';

module.exports = (fake) => {
  const node = (nodeId, role, name, backendDOMNodeId, extra = {}) => ({
    nodeId, role: { value: role }, name: { value: name }, backendDOMNodeId, ...extra,
  });
  fake.site[PAGE] = {
    title: 'Framed page',
    text: 'The page around the frame.',
    elements: [{ kind: 'button', label: 'Go', backendNodeId: 102, disabled: false, checked: false, visible: true }],
    tree: [
      node('n0', 'RootWebArea', 'Framed page', undefined, { childIds: ['n1', 'n2'] }),
      node('n1', 'button', 'Go', 102),
      node('n2', 'Iframe', '', 103),
    ],
    childFrames: [{ backendId: 103, url: FRAME }],
    scrollY: 0, pageHeight: 2000, viewportHeight: 600,
  };
  fake.site[FRAME] = {
    title: 'Child', text: 'frame text', elements: [], scrollY: 0, pageHeight: 100, viewportHeight: 100,
    // The target the render ran on is in the message, since the frame marker reads the
    // same whether the frame rendered as a unit of its own or on the page's session.
    render: (options, descriptors, target) => { throw new Error(`the frame renderer fell over in ${target.type} target ${target.targetId}`); },
  };
  // The frame attaches as the read creates the page's isolated world — before the
  // read asks which frame the iframe node holds — and that answer is held back long
  // enough for the daemon to have recorded the new target.
  const original = fake.handlers.get('Page.createIsolatedWorld');
  let attached = false;
  fake.handle('Page.createIsolatedWorld', (params, sid) => {
    const target = fake.bySession(sid);
    if (attached || target.url !== PAGE) return original(params, sid);
    attached = true;
    fake.attachFrame(target, 103);
    const answer = original(params, sid);
    return new Promise((resolve) => setTimeout(() => resolve(answer), 30));
  });
};
