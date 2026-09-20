// CLAUDESURF_FAKE_SCRIPT: Target.setAutoAttach fails, so the launch's setup step rejects.
module.exports = (fake) => {
  fake.handle('Target.setAutoAttach', () => { throw { code: -32000, message: 'auto-attach refused' }; });
};
