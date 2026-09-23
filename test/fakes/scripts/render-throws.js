// CLAUDESURF_FAKE_SCRIPT: the renderer throws on the page itself, as it would on a DOM
// shape Turndown or Readability cannot handle.
module.exports = (fake) => {
  fake.site['http://fake.test/'] = {
    title: 'Fake page',
    text: 'Hello from the fake browser.',
    elements: [],
    scrollY: 0,
    pageHeight: 2000,
    viewportHeight: 600,
    render: () => { throw new Error('TypeError: cannot read properties of null'); },
  };
};
