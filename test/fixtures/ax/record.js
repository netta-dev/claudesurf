#!/usr/bin/env node

// Records an accessibility tree as `<name>.json` beside this file: the input
// test/snapshot.test.js reads, so the tree logic is tested against what Chrome
// answers rather than a hand-built tree. Run it after changing a fixture page, with
// the names to re-record or none for all of them:
//
//   node test/fixtures/ax/record.js render
//
// It launches a headless Chrome against a temp profile, as the live tests do, and
// keeps of each node the id, the ignored flag, the role, the name, the properties,
// the children, and the DOM node behind it. The fixture server's base, whose port is
// ephemeral, is recorded as FIXTURE_BASE so a re-recording changes nothing else and a
// test can assert a URL.
//
// One source is a live page, of a size and landmark count no fixture reproduces, so
// recording needs the network. That tree is condensed: its text leaves go, since the
// DOM supplies prose to a render; every property snapshot.js does not read goes; and
// an unnamed structural container is spliced out with its children reattached to its
// parent, which leaves every control, landmark, and containment the tree logic reads.
// The fixture pages are recorded whole.

const fs = require('fs');
const path = require('path');
const { liveBinary, liveBrowser } = require('../../helpers');
const { serve } = require('../serve');
const navigation = require('../../../server/navigation');

const PAGES = [
  { name: 'render', path: 'render.html' },
  { name: 'frames', path: 'frames.html' },
  { name: 'menu', path: 'menu.html?open=menu,aria-modal' },
  { name: 'wikipedia', url: 'https://en.wikipedia.org/wiki/Web_browser', condense: true },
];
const FIXTURE_BASE = 'http://fixture.test';
const READ_PROPERTIES = new Set(['url', 'checked', 'disabled', 'expanded', 'selected', 'pressed', 'required', 'readonly', 'valuemin', 'valuemax', 'editable']);
const TEXT_ROLES = new Set(['StaticText', 'InlineTextBox']);
const SPLICED_ROLES = new Set(['none', 'generic', 'ListMarker', 'LayoutTable', 'LayoutTableRow', 'LayoutTableCell']);

const roleOf = (node) => (node.role ? node.role.value : null);
const nameOf = (node) => (node.name ? node.name.value : '');

function trim(node) {
  const out = { nodeId: node.nodeId };
  if (node.ignored) out.ignored = true;
  if (node.role) out.role = { type: node.role.type, value: node.role.value };
  if (node.name) out.name = { type: node.name.type, value: node.name.value };
  if (node.properties && node.properties.length) {
    out.properties = node.properties.map((p) => ({ name: p.name, value: { type: p.value.type, value: p.value.value } }));
  }
  if (node.childIds && node.childIds.length) out.childIds = node.childIds;
  if (node.backendDOMNodeId !== undefined) out.backendDOMNodeId = node.backendDOMNodeId;
  return out;
}

function condense(nodes) {
  const kept = nodes
    .filter((n) => !TEXT_ROLES.has(roleOf(n)))
    .map((n) => {
      const properties = (n.properties || []).filter((p) => READ_PROPERTIES.has(p.name));
      return properties.length ? { ...n, properties } : { ...n, properties: undefined };
    });
  const byId = new Map(kept.map((n) => [n.nodeId, n]));
  const spliced = new Set(kept.slice(1)
    .filter((n) => (n.ignored || SPLICED_ROLES.has(roleOf(n))) && !nameOf(n) && !n.properties)
    .map((n) => n.nodeId));
  const children = (ids) => ids.flatMap((id) => {
    const child = byId.get(id);
    if (!child) return [];
    return spliced.has(id) ? children(child.childIds || []) : [id];
  });
  return kept.filter((n) => !spliced.has(n.nodeId)).map((n) => {
    const childIds = children(n.childIds || []);
    return { ...n, childIds: childIds.length ? childIds : undefined };
  });
}

// One node per line: a recording is read by grep and by diff, not end to end.
function serialize(nodes, base) {
  const lines = nodes.map((n) => JSON.stringify(n).split(base).join(FIXTURE_BASE));
  return `[\n${lines.join(',\n')}\n]\n`;
}

(async () => {
  if (!liveBinary()) throw new Error('no Chrome binary found');
  const named = process.argv.slice(2);
  const pages = named.length ? PAGES.filter((page) => named.includes(page.name)) : PAGES;
  if (!pages.length) throw new Error(`no such page: ${named.join(', ')}`);
  const live = await liveBrowser();
  const site = await serve();
  try {
    const session = await live.sessions.ensure('record-ax');
    for (const page of pages) {
      await navigation.navigate(live.context, session, { url: page.url || `${site.base}/${page.path}`, name: 'record' });
      const { nodes } = await live.sessions.send(session.workingTargetId, 'Accessibility.getFullAXTree', {});
      const trimmed = page.condense ? condense(nodes.map(trim)) : nodes.map(trim);
      const file = path.join(__dirname, `${page.name}.json`);
      fs.writeFileSync(file, serialize(trimmed, site.base));
      process.stdout.write(`${path.relative(process.cwd(), file)}: ${nodes.length} nodes, ${trimmed.length} kept\n`);
    }
  } finally {
    site.close();
    await live.close();
  }
})().catch((e) => { process.stderr.write(`${e.stack}\n`); process.exit(1); });
