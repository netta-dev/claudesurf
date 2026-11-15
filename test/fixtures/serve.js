// This server exposes live-test fixtures over HTTP because navigate accepts only
// http(s) URLs. The listeners on 127.0.0.1 and 127.0.0.2 act as separate sites so
// Chrome gives cross-site frames their own processes and targets.
// Fixtures use `__CROSS_SITE__` for the second listener's base URL and runtime port.
// worker.html's service worker answers /sw-only itself; this server answers 404 there.
// `served.site` and `served.cross` record requested paths; `served.aborted` records
// responses that the client closed before completion.
// close() destroys open connections so unfinished responses don't hold tests open.

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

function html(res, body, headers = {}, status = 200) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
  res.end(`<!doctype html>${body}`);
}

function json(req, res, body, { cors = false, credentials = true } = {}) {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (cors && req.headers.origin) headers['Access-Control-Allow-Origin'] = req.headers.origin;
  if (cors && credentials && req.headers.origin) headers['Access-Control-Allow-Credentials'] = 'true';
  res.writeHead(200, headers);
  res.end(JSON.stringify(body));
}

let counted = 0;

const CAPTURE_ROUTES = {
  '/': (req, res) => html(res, '<title>Home</title><p>An ordinary page.</p>'),
  '/challenge': (req, res) => html(res, '<title>Just a moment...</title><p>Checking your browser.</p>', { 'cf-mitigated': 'challenge', 'X-Amzn-Waf-Action': 'captcha' }, 403),
  '/clears': (req, res) => html(res, "<title>Just a moment...</title><p>Checking your browser.</p><script>setTimeout(() => { location.href = '/'; }, 1000);</script>", { 'cf-mitigated': 'challenge' }, 403),
  '/csp': (req, res) => html(res, '<title>CSP</title><p>connect-src is self.</p>', { 'Content-Security-Policy': "connect-src 'self'" }),
  '/long': (req, res, url) => {
    const chars = Number(url.searchParams.get('chars') || '50000');
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('0123456789'.repeat(Math.ceil(chars / 10)).slice(0, chars));
  },
  // The 40,000th UTF-16 unit is the first half of an emoji.
  '/long-emoji': (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`${'x'.repeat(39_999)}${'\u{1F600}'.repeat(10)}`);
  },
  '/binary': (req, res, url) => {
    const bytes = Math.round(Number(url.searchParams.get('mib') || '1') * 1024 * 1024);
    const type = url.searchParams.get('type');
    res.writeHead(200, type ? { 'Content-Type': type } : {});
    res.end(Buffer.alloc(bytes, 0xff));
  },
  '/mixed': (req, res) => {
    res.writeHead(200);
    res.end(Buffer.concat([Buffer.from('valid text first, '.repeat(100)), Buffer.alloc(4096, 0xff)]));
  },
  '/long-partial': (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(Buffer.concat([Buffer.from('x'.repeat(40_000)), Buffer.from([0xe2, 0x82])]));
  },
  '/endless-text': (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.write('0123456789'.repeat(5_000));
    const timer = setInterval(() => res.write('y'), 50);
    res.on('close', () => clearInterval(timer));
  },
  '/endless-mixed': (req, res) => {
    res.writeHead(200);
    res.write('valid text first, '.repeat(100));
    const chunk = Buffer.alloc(256 * 1024, 0xff);
    const more = () => {
      let room = true;
      while (room && !res.destroyed) room = res.write(chunk);
    };
    res.on('drain', more);
    const timer = setTimeout(more, 200);
    res.on('close', () => clearTimeout(timer));
  },
  '/untyped': (req, res) => {
    res.writeHead(200);
    res.end('héllo, untyped wörld');
  },
  // "café" in ISO-8859-1, whose é is the byte 0xE9 that UTF-8 can't decode.
  '/latin1': (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=iso-8859-1' });
    res.end(Buffer.from('café', 'latin1'));
  },
  '/typed-text': (req, res, url) => {
    res.writeHead(200, { 'Content-Type': url.searchParams.get('type') || 'text/plain; charset=utf-8' });
    res.end('typed text with a charset');
  },
  '/px': (req, res, url) => {
    const size = Number(url.searchParams.get('size') || '100');
    html(res, `<title>Press and hold</title><div id="px-captcha" style="width:${size}px;height:${size}px;background:#ccc"></div>`);
  },
  '/signin': (req, res) => html(res, '<title>Sign in</title><form action="/post" method="post"><label>User <input name="user"></label><label>Password <input type="password" name="pw"></label><button>Sign in</button></form>'),
  '/otp': (req, res) => html(res, '<title>Verify</title><label>Code <input name="code" autocomplete="one-time-code"></label>'),
  '/throws': (req, res) => html(res, `<title>Throws</title><script>
window.hookCalls = 0;
Error.prepareStackTrace = (error) => { window.hookCalls += 1; return String(error); };
console.log('hello', { a: 1 });
console.error('Error: save failed: 500');
setTimeout(() => { throw new RangeError('boom'); }, 0);
Promise.reject(new Error('rejected'));
</script><img src="/missing.png">`),
  '/cookie': (req, res) => html(res, '<title>Cookie</title><p>Set.</p>', { 'Set-Cookie': ['strict=s1; SameSite=Strict; Path=/', 'sid=abc123; SameSite=Lax; Path=/'] }),
  '/echo': (req, res) => json(req, res, { cookie: req.headers.cookie || null, origin: req.headers.origin || null }),
  '/cors-echo': (req, res) => json(req, res, { cookie: req.headers.cookie || null, origin: req.headers.origin || null }, { cors: true }),
  '/cors-uncredentialed': (req, res) => json(req, res, { origin: req.headers.origin || null }, { cors: true, credentials: false }),
  '/counted': (req, res) => {
    counted += 1;
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'max-age=3600' });
    res.end(`request ${counted}`);
  },
  '/post': (req, res) => {
    req.resume();
    req.on('end', () => html(res, '<title>Posted</title><p>Thanks.</p>'));
  },
};

function handler(crossBase, served, aborted) {
  return (req, res) => {
    const url = new URL(req.url, 'http://x');
    served.push(url.pathname);
    res.on('close', () => { if (!res.writableFinished) aborted.push(url.pathname); });
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
    const routed = CAPTURE_ROUTES[url.pathname];
    if (routed) {
      routed(req, res, url);
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
  const served = { site: [], cross: [], aborted: [] };
  cross.on('request', handler(crossBase, served.cross, served.aborted));
  const site = http.createServer(handler(crossBase, served.site, served.aborted));
  const base = await listen(site, '127.0.0.1');
  return {
    base,
    crossBase,
    served,
    close: () => {
      for (const server of [site, cross]) {
        server.close();
        server.closeAllConnections();
      }
    },
  };
}

module.exports = { serve };
