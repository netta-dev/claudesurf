// Serves the fixture pages to the live tests over http on an ephemeral port, since
// navigate accepts http(s) only. /download answers with Content-Disposition:
// attachment; /slow answers a form post after a delay.

const http = require('http');
const fs = require('fs');
const path = require('path');

function serve() {
  const server = http.createServer((req, res) => {
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
    const file = path.join(__dirname, path.basename(url.pathname));
    if (!file.endsWith('.html') || !fs.existsSync(file)) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({ base, close: () => server.close() });
    });
  });
}

module.exports = { serve };
