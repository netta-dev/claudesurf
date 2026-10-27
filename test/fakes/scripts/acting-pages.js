// CLAUDESURF_FAKE_SCRIPT: pages for the acting actions through the daemon. fake.test
// is on the daemon's allowlist and evil.test is not.
//   - /form holds a text field (focused), a native select, and a custom combobox;
//   - /leave holds links and buttons that leave for evil.test at once, behind a
//     request, or after the call has returned; that close the session's window or the
//     working tab after a while; that change the URL by pushState; or that close the
//     working tab;
//   - /busy never stops changing.
module.exports = (fake) => {
  const page = (title, elements, extra = {}) => ({ title, text: `${title}.`, elements, scrollY: 0, pageHeight: 1200, viewportHeight: 600, ...extra });
  const closeWindow = (f, t) => {
    for (const target of [...f.targets.values()]) if (target.windowId === t.windowId) f.destroyTarget(target.targetId);
  };
  const name = { kind: 'textbox', label: 'Name', visible: true, value: '', tag: 'input', attributes: { name: 'name' } };
  fake.site['http://fake.test/form'] = page('Form', [
    name,
    { kind: 'combobox', label: 'Sort', visible: true, select: true, options: [{ label: 'Newest', value: 'new' }, { label: 'Oldest', value: 'old' }] },
    { kind: 'combobox', label: 'Fancy', visible: true },
  ], { focused: name });
  fake.site['http://fake.test/leave'] = page('Leave', [
    { kind: 'link', label: 'Away', visible: true, onClick: (f, t) => f.navigateByPage(t, 'http://evil.test/collect?d=1') },
    { kind: 'link', label: 'Slow away', visible: true, onClick: (f, t) => { f.networkRequest(t, { type: 'Fetch', ms: 1500 }); f.navigateByPage(t, 'http://evil.test/slow'); } },
    { kind: 'button', label: 'Later', visible: true, onClick: (f, t) => setTimeout(() => f.navigateByPage(t, 'http://evil.test/later'), 300) },
    { kind: 'button', label: 'Vanish', visible: true, onClick: (f, t) => setTimeout(() => closeWindow(f, t), 300) },
    {
      kind: 'button', label: 'Later then vanish', visible: true,
      onClick: (f, t) => {
        setTimeout(() => f.navigateByPage(t, 'http://evil.test/later'), 800);
        setTimeout(() => closeWindow(f, t), 1600);
      },
    },
    {
      kind: 'button', label: 'Push', visible: true,
      onClick: (f, t) => {
        const url = 'http://fake.test/leave?pushed=1';
        t.url = url;
        f.emit('Page.navigatedWithinDocument', { frameId: t.targetId, url }, t.sessionId);
      },
    },
    { kind: 'button', label: 'Close tab', visible: true, onClick: (f, t) => f.destroyTarget(t.targetId) },
  ]);
  // pushState moves the URL and keeps the document.
  fake.site['http://fake.test/leave?pushed=1'] = fake.site['http://fake.test/leave'];
  fake.site['http://fake.test/busy'] = page('Busy', [], { busy: { mutating: true } });
};
