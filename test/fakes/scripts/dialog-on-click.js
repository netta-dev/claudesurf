// CLAUDESURF_FAKE_SCRIPT: every scripted click opens a confirm dialog on its page.
module.exports = (fake) => {
  const original = fake.handlers.get('Runtime.callFunctionOn');
  fake.handle('Runtime.callFunctionOn', (params, sid) => {
    if (/function claudesurfClick/.test(params.functionDeclaration)) {
      fake.emit('Page.javascriptDialogOpening', { type: 'confirm', message: 'Leave the page?' }, sid);
    }
    return original(params, sid);
  });
};
