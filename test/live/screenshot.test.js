// Screenshots against real Chrome (headless): a viewport PNG and the segmented
// full-page capture with its coverage line.

const { test } = require('node:test');
const assert = require('node:assert');
const read = require('../../server/read');
const input = require('../../server/input');
const { liveBinary, liveBrowser } = require('../helpers');
const { serve } = require('../fixtures/serve');

const skip = liveBinary() ? false : 'no Chrome binary found';
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

test('viewport PNG, then a tall fixture in four segments with the coverage note', { skip }, async () => {
  const live = await liveBrowser();
  const site = await serve();
  try {
    const session = await live.sessions.ensure('live-shot');
    await input.navigate(live.sessions, session, { url: `${site.base}/tall.html`, name: 'shots' });
    const viewport = await read.screenshot(live.sessions, session, { fullPage: false });
    assert.strictEqual(viewport.payload, `URL: ${site.base}/tall.html\nTitle: Tall fixture`);
    assert.strictEqual(viewport.images.length, 1);
    assert.strictEqual(viewport.images[0].mimeType, 'image/png');
    assert.ok(Buffer.from(viewport.images[0].data, 'base64').subarray(0, 4).equals(PNG_MAGIC));

    const full = await read.screenshot(live.sessions, session, { fullPage: true });
    assert.strictEqual(full.images.length, 4);
    const m = full.payload.match(/^URL: .*\nTitle: Tall fixture\nCaptured: 0–(\d+) of (\d+) px in 4 segments \((\d+) px below not captured; scroll and capture again\)$/);
    assert.ok(m, full.payload);
    const [, covered, total, cut] = m.map(Number);
    assert.strictEqual(covered + cut, total);
    assert.ok(total >= 6000, 'page height reflects six 1000 px sections');
    for (const image of full.images) assert.ok(Buffer.from(image.data, 'base64').subarray(0, 4).equals(PNG_MAGIC));

    await input.navigate(live.sessions, session, { url: `${site.base}/other`, name: 'shots' });
    const short = await read.screenshot(live.sessions, session, { fullPage: true });
    assert.ok(short.images.length >= 1 && short.images.length <= 4);
    assert.match(short.payload, /Captured: 0–(\d+) of \1 px in \d segments?$/);
  } finally {
    site.close();
    await live.close();
  }
});
