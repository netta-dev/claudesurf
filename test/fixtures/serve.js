// Serves the fixture pages to the live tests over http, since navigate accepts http(s)
// only. Two listeners: one on 127.0.0.1 and one on 127.0.0.2, which Chrome treats as
// another site, so a frame served from it runs in its own process and gets a target of
// its own. `__CROSS_SITE__` in a fixture is replaced with the cross-site base as the
// page is served, so a fixture can name a port only known at run time.
//
// Routes: /download answers with Content-Disposition: attachment; /slow answers a form
// post after a delay; /data.json a JSON document; /page.pdf a one-page PDF;
// /bulk.html?n=<n> a page whose prose is longer than the per-frame cap on a read;
// /redir?to=<url> a 302 to that URL; /sw.js the service worker that worker.html
// registers, which answers /sw-only itself, a path that this server answers 404; /delay?ms=<n> a JSON
// document after n milliseconds, 1,000 by default and at most 30,000; /busy.json a
// JSON response that never ends; /no-content a 204, to any method. close() destroys the
// open connections, so a response that never ends doesn't hold the test process open.

const http = require('http');
const fs = require('fs');
const path = require('path');

// A one-page PDF with a correct cross-reference table, built here so the offsets stay
// right; Chrome's viewer is stricter about those than about the page's content.
function onePagePdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((object, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

// The service worker's source, which takes control at once and answers /sw-only from
// its own code, so a navigation that it serves never reaches the network.
const SERVICE_WORKER = `
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  if (new URL(event.request.url).pathname !== '/sw-only') return;
  event.respondWith(new Response('<!doctype html><title>From the worker</title><p>The service worker answered this page.</p>', { headers: { 'Content-Type': 'text/html' } }));
});
`;

function handler(crossBase) {
  return (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/download') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="fixture.bin"' });
      res.end('binary');
      return;
    }
    if (url.pathname === '/slow') {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!doctype html><title>Slow</title><p>Slow page</p>');
      }, 1500);
      return;
    }
    if (url.pathname === '/other') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><title>Other</title><p>Other page</p><a href="/labels.html">back</a>');
      return;
    }
    if (url.pathname === '/bulk.html') {
      const n = url.searchParams.get('n') || '1';
      const paragraphs = Array.from({ length: 60 }, (unused, i) => (
        `<p>Frame ${n} paragraph ${i}: ${'filler words that make this frame longer than the cap a read inlines it under. '.repeat(2)}</p>`
      )).join('\n');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><title>Bulk ${n}</title><h1>Bulk frame ${n}</h1>${paragraphs}`);
      return;
    }
    if (url.pathname === '/redir') {
      res.writeHead(302, { Location: url.searchParams.get('to') });
      res.end();
      return;
    }
    if (url.pathname === '/sw.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end(SERVICE_WORKER);
      return;
    }
    if (url.pathname === '/data.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ items: [{ id: 1, name: 'alpha' }, { id: 2, name: 'beta' }] }, null, 2));
      return;
    }
    if (url.pathname === '/delay') {
      const asked = Number.parseInt(url.searchParams.get('ms'), 10);
      const ms = Number.isFinite(asked) && asked >= 0 ? Math.min(asked, 30000) : 1000;
      const timer = setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ delayed: ms }));
      }, ms);
      res.on('close', () => clearTimeout(timer));
      return;
    }
    if (url.pathname === '/busy.json') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.write('{"items": [');
      return;
    }
    if (url.pathname === '/no-content') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (url.pathname === '/page.pdf') {
      res.writeHead(200, { 'Content-Type': 'application/pdf' });
      res.end(onePagePdf());
      return;
    }
    const file = path.join(__dirname, path.basename(url.pathname));
    if (!file.endsWith('.html') || !fs.existsSync(file)) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(file, 'utf8').replaceAll('__CROSS_SITE__', crossBase));
  };
}

function listen(server, host) {
  return new Promise((resolve) => server.listen(0, host, () => resolve(`http://${host}:${server.address().port}`)));
}

// The cross-site listener comes up first: both handlers substitute its base into a
// fixture as they serve it, and its port is known only once it is listening.
async function serve() {
  const cross = http.createServer();
  const crossBase = await listen(cross, '127.0.0.2');
  cross.on('request', handler(crossBase));
  const site = http.createServer(handler(crossBase));
  const base = await listen(site, '127.0.0.1');
  return {
    base,
    crossBase,
    close: () => {
      for (const server of [site, cross]) {
        server.close();
        server.closeAllConnections();
      }
    },
  };
}

module.exports = { serve };
