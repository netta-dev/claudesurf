// CLAUDESURF_FAKE_SCRIPT: the working tab is destroyed while a page read runs.
module.exports = (fake) => {
  const original = fake.handlers.get('Runtime.callFunctionOn');
  fake.handle('Runtime.callFunctionOn', (params, sid) => {
    if (/function claudesurfWalk/.test(params.functionDeclaration)) {
      const target = fake.bySession(sid);
      setImmediate(() => fake.destroyTarget(target.targetId));
    }
    return original(params, sid);
  });
};
