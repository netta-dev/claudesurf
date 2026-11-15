// What changed since the tab's retained render, in a read's vocabulary. The tab
// renders again with the retained render's parameters, and the two renders are
// compared line by line, the overlay blocks apart from the region, so that an opened
// dialog's hunks print first. An acting call's change summary and a `since` read share
// it; the new render replaces the retained one either way.

const { renderRegion, RenderError, DocumentChangedError } = require('./region');
const { BLOCK_CHARS } = require('./overlays');
const retained = require('./retained');
const { diffLines, formatDiff } = require('./diff');
const { TimeoutError } = require('./cdp');
const { OutcomeError, pipeClosedOrTabGone } = require('./action-support');

// The edit count past which a diff gives up and says how much differs instead.
const MAX_EDITS = 1_000;
// The length past which a summary cuts the region's hunks, on a line. The overlays'
// hunks cut at BLOCK_CHARS, a block's own cut, which shows an opened dialog whole when
// its added lines fit with their prefixes; a block near that cut, or one whose frames
// were inlined after it, loses its last lines, often the buttons.
const REGION_CHARS = 3_000;
const OVERLAYS_TOO_MUCH = '… the overlays changed too much to list; read the page';

// The reasons that a summary or a `since` read can't compare renders, in the words of
// each.
const UNTRACKED = {
  unread: { summary: 'read the page first', since: 'no earlier read of this document' },
  tooLarge: { summary: 'the page is too large to keep', since: 'the page is too large to keep' },
  switched: { summary: 'the working tab changed; read the page' },
};

// Resolves the changes in the working tab `t` since its retained render, `source`
// 'summary' for an acting call and 'since' for a read:
//   - { untracked, render? }: why the renders couldn't be compared, in the source's
//     words; `render` is the new render when it crossed the retained size cap;
//   - { notMeasured }: why a summary's render failed, which leaves the call's outcome
//     alone;
//   - { line, body, render, gaveUp? }: the Changed: or Since: line, the hunks, and the
//     new render; `gaveUp` when the region differed past the edit cap, the body then
//     holding the overlays' hunks alone.
// Rethrows for a closed pipe or a working tab no longer registered, and under `since`
// for anything but a scope that is gone.
async function renderChanges(sessions, session, t, { source, deadline }) {
  const since = source === 'since';
  const before = retained.current(session, t);
  if (!before) return untracked('unread', since);
  if (before.tooLarge) return untracked('tooLarge', since);
  // A summary of a tab that the agent didn't last read would diff against a render
  // whose refs it hasn't seen.
  if (!since && session.refsTarget !== null && session.refsTarget !== t.targetId) return untracked('switched', since);
  const { scope } = before.params;
  let render;
  try {
    render = await renderRegion(sessions, session, t, { ...before.params, source, deadline });
  } catch (e) {
    return failed(e, { sessions, session, t, scope, since });
  }
  if (!render.kept) return { ...untracked('tooLarge', since), render };
  return compare(before, render, since);
}

function compare(before, render, since) {
  const overlays = diffLines(lines(before.overlayBlocks.join('\n')), lines(render.overlayBlocks.join('\n')), { maxEdits: MAX_EDITS });
  const region = diffLines(lines(before.region), lines(render.region), { maxEdits: MAX_EDITS });
  const overlayText = overlays.tooLarge ? OVERLAYS_TOO_MUCH : formatDiff(overlays, { maxChars: since ? Infinity : BLOCK_CHARS }).text;
  if (region.tooLarge) {
    const line = since
      ? `Since: most of the page changed (${region.differing} lines differ); the region follows`
      : `Changed: most of the page (${region.differing} lines differ); read the page`;
    return { line, body: overlayText, render, gaveUp: true };
  }
  const regionText = formatDiff(region, { maxChars: since ? Infinity : REGION_CHARS }).text;
  const body = [overlayText, regionText].filter(Boolean).join('\n');
  // When the region is unchanged, the line names the overlays, whose change passed the
  // edit cap.
  if (overlays.tooLarge && !region.added && !region.removed) {
    const line = since
      ? `Since: most of the overlays changed (${overlays.differing} lines differ)`
      : `Changed: most of the overlays (${overlays.differing} lines differ); read the page`;
    return { line, body, render };
  }
  const added = region.added + (overlays.tooLarge ? 0 : overlays.added);
  const removed = region.removed + (overlays.tooLarge ? 0 : overlays.removed);
  const label = since ? 'Since:' : 'Changed:';
  const none = since ? 'no change' : 'nothing';
  const counts = added + removed ? `${added} ${added === 1 ? 'line' : 'lines'} added, ${removed} removed` : none;
  return { line: `${label} ${counts}`, body, render };
}

// Returns the lines that a render is compared by: the blank ones only separate blocks
// of the markdown, so they are neither counted nor printed.
function lines(text) {
  return text.split('\n').filter((line) => line.trim());
}

function untracked(reason, since) {
  return { untracked: UNTRACKED[reason][since ? 'since' : 'summary'] };
}

// Maps a render's failure to the answer of a summary or a `since` read. The
// exception's text, which a page can shape, goes to the journal and stays out of the
// summary's line.
function failed(e, { sessions, session, t, scope, since }) {
  if (pipeClosedOrTabGone(sessions, t, e)) throw e;
  // The retained render's scope is gone: its ref no longer resolves, or its frame is gone.
  if (e instanceof OutcomeError && !e.unreadable) {
    retained.drop(session, t);
    return { untracked: since ? `the scope ${scope} is gone` : `the scope ${scope} is gone; read the page again` };
  }
  if (since) throw e;
  sessions.log.info(`the change summary was not measured: ${e.message}`);
  if (e instanceof OutcomeError) return { notMeasured: `the frame ${scope} was not readable` };
  if (e instanceof DocumentChangedError) return { notMeasured: 'the document changed while it was rendered' };
  const cause = e instanceof RenderError ? e.cause : e;
  return { notMeasured: cause instanceof TimeoutError ? 'the deadline passed' : 'the renderer failed' };
}

module.exports = { renderChanges };
