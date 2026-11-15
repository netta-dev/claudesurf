// This script supplies sign-in pages for the handoff's daemon tests.
// /login exposes a password field to detection.
// /login-slow also exposes a password field and starts an 800 ms request during load.
// /login-then-away exposes a password field and schedules a navigation to an unlisted
// host 300 ms after its first scan, simulating an identity-provider redirect.
// /login-on-click exposes its password field after a link click. That click also
// navigates to evil.test, which the allowlist lacks.
// The SIGUSR2 handler navigates tabs on /login to the unlisted elsewhere.test host,
// allowing tests to trigger refusals without a tool call.
// CLAUDESURF_TEST_PAGE_LOG names a file for recording Page.navigate URLs as commands
// arrive, allowing tests to observe a navigation occupying its queue slot.
// The fake refuses auto-attach at startup if the file named by
// CLAUDESURF_TEST_REFUSE_LAUNCH exists, so the daemon's launch fails its setup.
const fs = require('fs');

module.exports = (fake) => {
  const page = (detect, extra = {}) => ({ title: 'Sign in', text: 'Sign in to continue.', elements: [], scrollY: 0, pageHeight: 1200, viewportHeight: 600, detect, ...extra });
  fake.site['http://fake.test/login'] = page({ password: true });
  fake.site['http://fake.test/login-slow'] = page({ password: true }, { network: [{ type: 'Fetch', at: 0, ms: 800 }] });
  let bounced = false;
  fake.site['http://fake.test/login-then-away'] = page((target) => {
    if (!bounced) {
      bounced = true;
      setTimeout(() => fake.navigateByPage(target, 'http://idp.test/authorize'), 300);
    }
    return { password: true };
  });
  let shown = false;
  fake.site['http://fake.test/login-on-click'] = page(() => ({ password: shown }), {
    elements: [{ kind: 'link', label: 'Sign in elsewhere', visible: true, onClick: (f, t) => { shown = true; f.navigateByPage(t, 'http://evil.test/collect'); } }],
  });
  process.on('SIGUSR2', () => {
    for (const target of fake.targets.values()) if (target.url === 'http://fake.test/login') fake.navigateByPage(target, 'http://elsewhere.test/');
  });
  const pageLog = process.env.CLAUDESURF_TEST_PAGE_LOG;
  if (pageLog) {
    const navigate = fake.handlers.get('Page.navigate');
    fake.handle('Page.navigate', (params, sid, f) => {
      fs.appendFileSync(pageLog, `${params.url}\n`);
      return navigate(params, sid, f);
    });
  }
  const refuse = process.env.CLAUDESURF_TEST_REFUSE_LAUNCH;
  if (refuse && fs.existsSync(refuse)) fake.handle('Target.setAutoAttach', () => { throw { code: -32000, message: 'auto-attach refused' }; });
};
