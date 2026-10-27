// A session's tab records: the number that each of its tabs carries as `t<n>`, the tabs
// that its pages opened, the stack of earlier working tabs, and each tab's kind.
// sessions.js numbers a tab when it claims it for a role or attributes it by opener,
// from a per-session counter that never reuses a number, so a recreated window's tabs take
// new numbers. A tab keeps its number when it moves between roles.
//
// The stack holds the targets that were the working tab before a switch, most recent
// last. An entry is live while its target is registered and still the session's.
//
// A tab's kind, the tab that `tabs new` opens from, and Opened:'s wording share one
// test of whether a tab is in the session's window, inSessionWindow. The window-state
// drop runs synchronously, so it reads the registry's record alone (sessions.js
// holdsWindow), and can count as in the window a tab that inSessionWindow finds in
// another.

// Returns the tab's number, assigning the next one to a tab that doesn't have one yet.
function number(session, t) {
  if (!session.tabIds.has(t.targetId)) session.tabIds.set(t.targetId, session.nextTab++);
  return session.tabIds.get(t.targetId);
}

// Returns the `t<n>` name of one of the session's numbered tabs.
function tabId(session, targetId) {
  return `t${session.tabIds.get(targetId)}`;
}

// Records a tab that one of the session's pages opened, and numbers it.
function addOpened(session, t) {
  session.opened.add(t.targetId);
  number(session, t);
}

// Records a tab claimed for a role, which takes it out of the opened tabs, and numbers
// it.
function addClaimed(session, t) {
  session.opened.delete(t.targetId);
  number(session, t);
}

// Removes the records of a tab that left the session: its number and its place among
// the opened tabs. Its entries on the stack stay, no longer live.
function release(session, targetId) {
  session.opened.delete(targetId);
  session.tabIds.delete(targetId);
}

// Removes every record of a tab that is gone, its entries on the stack included.
function remove(session, targetId) {
  release(session, targetId);
  session.earlierWorking = session.earlierWorking.filter((id) => id !== targetId);
}

// Removes every tab record, as the window's state is dropped; the counter stays, so a
// number isn't reused.
function clear(session) {
  session.opened.clear();
  session.tabIds.clear();
  session.earlierWorking = [];
}

// Makes `targetId`, one of the session's tabs, the working tab. The old working tab,
// when there is one, joins the opened tabs and goes on the stack.
function switchWorking(sessions, session, targetId) {
  if (session.workingTargetId === targetId) return;
  const old = sessions.target(session.workingTargetId);
  if (old) {
    old.role = 'opened';
    session.opened.add(old.targetId);
    session.earlierWorking.push(old.targetId);
  }
  const t = sessions.target(targetId);
  session.opened.delete(targetId);
  session.earlierWorking = session.earlierWorking.filter((id) => id !== targetId);
  t.role = 'working';
  t.everWorking = true;
  session.workingTargetId = targetId;
}

// Returns the most recent live earlier working tab's target id, taking it and every
// dead entry above it off the stack, or null when none is live.
function earlier(sessions, session) {
  while (session.earlierWorking.length) {
    const id = session.earlierWorking.pop();
    if (isLive(sessions, session, id)) return id;
  }
  return null;
}

// Resolves with the most recent live earlier working tab's target id that is in the
// session's window, leaving the stack as it is, or null. `opts.deadline` bounds each
// window lookup.
async function latestIn(sessions, session, opts) {
  for (const id of [...session.earlierWorking].reverse()) {
    if (isLive(sessions, session, id) && await inSessionWindow(sessions, session, id, opts)) return id;
  }
  return null;
}

// Resolves with the session's tabs as [{ id, targetId, kind }], the working tab first
// and the rest by number. `id` is `t<n>`; `kind` is working, identity, tab (in the
// session's window), or popup (in another). `opts.deadline` bounds each window lookup.
async function tabs(sessions, session, opts) {
  const ids = [session.workingTargetId, session.identityTargetId, ...session.opened].filter((id) => id && sessions.target(id));
  const listed = [];
  for (const targetId of new Set(ids)) {
    const t = sessions.target(targetId);
    let kind = t.role === 'working' || t.role === 'identity' ? t.role : 'tab';
    if (kind === 'tab' && !(await inSessionWindow(sessions, session, targetId, opts))) kind = 'popup';
    listed.push({ n: session.tabIds.get(targetId), id: tabId(session, targetId), targetId, kind });
  }
  listed.sort((a, b) => (a.kind === 'working' ? -1 : b.kind === 'working' ? 1 : a.n - b.n));
  return listed.map(({ id, targetId, kind }) => ({ id, targetId, kind }));
}

// Returns whether a tab whose recorded window is `windowId`, null while it is unknown,
// is in the session's window. Every tab counts as in it while the session's own window
// is unknown.
function inWindow(session, windowId) {
  return windowId === null || session.windowId === null || windowId === session.windowId;
}

// Resolves whether the tab is in the session's window, looking its window up when the
// registry hasn't recorded it, by `opts.deadline`. Never rejects.
async function inSessionWindow(sessions, session, targetId, opts) {
  const windowId = await sessions.windowOf(targetId, opts).catch(() => null);
  return inWindow(session, windowId);
}

// Returns whether the tab is registered, still the session's, and not its identity tab,
// as a stack entry has to be to take the working role again.
function isLive(sessions, session, targetId) {
  const t = sessions.target(targetId);
  return Boolean(t) && t.sessionId === session.id && t.role !== 'identity';
}

module.exports = { tabId, addOpened, addClaimed, release, remove, clear, switchWorking, earlier, latestIn, tabs, inWindow, inSessionWindow, isLive };
