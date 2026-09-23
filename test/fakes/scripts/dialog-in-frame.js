// CLAUDESURF_FAKE_SCRIPT: the first page read attaches an out-of-process child frame
// to the page being read, which raises an alert.
module.exports = (fake) => {
  const original = fake.handlers.get('Runtime.callFunctionOn');
  let attached = false;
  fake.handle('Runtime.callFunctionOn', (params, sid) => {
    if (/function claudesurfWalk/.test(params.functionDeclaration) && !attached) {
      attached = true;
      const frame = fake.createTarget({ type: 'iframe', parent: fake.bySession(sid), url: 'http://frame.test/child' });
      fake.emit('Page.javascriptDialogOpening', { type: 'alert', message: 'Alert from the frame' }, frame.sessionId);
    }
    return original(params, sid);
  });
};
