// CLAUDESURF_FAKE_SCRIPT: the working tab is destroyed while a page read runs, as its
// first command reaches the browser.
module.exports = (fake) => {
  const original = fake.handlers.get('Accessibility.getFullAXTree');
  fake.handle('Accessibility.getFullAXTree', (params, sid) => {
    const target = fake.bySession(sid);
    setImmediate(() => fake.destroyTarget(target.targetId));
    return original(params, sid);
  });
};
