// CLAUDESURF_FAKE_SCRIPT: the page holds one control it paints and one it hides, so a
// read's hidden count and its hidden=true list have something to report.
module.exports = (fake) => {
  const control = (kind, label, backendNodeId, visible) => ({ kind, label, backendNodeId, disabled: false, checked: false, visible });
  fake.site['http://fake.test/'] = {
    title: 'Fake page',
    text: 'Hello from the fake browser.',
    elements: [control('button', 'Go', 102, true), control('button', 'Shade', 103, false)],
    scrollY: 0, pageHeight: 2000, viewportHeight: 600,
  };
};
