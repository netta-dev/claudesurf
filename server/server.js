#!/usr/bin/env node

// Thin MCP server — one per Claude Code session.
// Forwards all tool calls to the daemon via HTTP.
// No external dependencies.

const http = require('http');
const readline = require('readline');
const crypto = require('crypto');

const DAEMON_PORT = 7865;
// Identity must stay stable for the life of the Claude Code session so the extension
// reuses the *same* dedicated window across MCP reconnects/respawns. A per-process
// `crypto.randomUUID()` changed whenever this process was respawned, which orphaned the
// old window. Prefer Claude Code's own session id (the same UUID used by --resume/
// --continue) — it's unique per session, so two `claude` runs in one dir still get
// separate windows. Fall back to a hash of the project dir, then a random id, for
// Claude Code versions predating these env vars.
const SESSION_ID_SOURCE =
  process.env.CLAUDE_CODE_SESSION_ID ? 'CLAUDE_CODE_SESSION_ID'
    : process.env.CLAUDE_PROJECT_DIR ? 'CLAUDE_PROJECT_DIR(hash)'
      : 'randomUUID';
const SESSION_ID =
  process.env.CLAUDE_CODE_SESSION_ID
  || (process.env.CLAUDE_PROJECT_DIR
    ? 'dir-' + crypto.createHash('sha256').update(process.env.CLAUDE_PROJECT_DIR).digest('hex').slice(0, 32)
    : crypto.randomUUID());

function sendToDaemon(action, params = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ sessionId: SESSION_ID, action, params });
    const req = http.request({
      hostname: '127.0.0.1',
      port: DAEMON_PORT,
      path: '/api',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error(parsed.error));
          } else {
            resolve(parsed);
          }
        } catch {
          reject(new Error('Invalid response from daemon'));
        }
      });
    });
    req.on('error', (e) => {
      reject(new Error('Cannot reach ClaudeSurf daemon. Run: node /home/z/workspaces/claudesurf/server/daemon.js'));
    });
    req.setTimeout(35000, () => {
      req.destroy();
      reject(new Error('Daemon request timed out'));
    });
    req.end(body);
  });
}

// --- MCP protocol over stdio ---
const rl = readline.createInterface({ input: process.stdin });

rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line);
    handleMcpMessage(msg);
  } catch {
    // ignore malformed lines
  }
});

function sendMcp(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function log(...args) {
  process.stderr.write('[ClaudeSurf MCP] ' + args.join(' ') + '\n');
}

const TOOLS = [
  {
    name: 'read_page',
    description: 'Read the full text content and links of the current active Chrome tab. Returns the page title, URL, visible text, and all links with their text and selectors. PREFERRED over screenshot — use this first to read pages. Only fall back to screenshot if the text content is empty or clearly missing the page body (e.g. canvas-rendered apps like Google Docs).',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'click_element',
    description: 'Click an element on the current page. Provide either a CSS selector or link/button text to match.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the element to click' },
        text: { type: 'string', description: 'Text content of the link or button to click (case-insensitive partial match)' }
      }
    }
  },
  {
    name: 'navigate',
    description: 'Navigate the working tab in the dedicated ClaudeSurf window to a URL, and label the session so the human can identify which window belongs to which task. Waits for the page to finish loading. The session name persists across navigates — pass the same name to keep it, a new one to change it.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to navigate to' },
        name: { type: 'string', description: 'Short session name shown on the pinned session tab (always visible). E.g. "reviewing PR #42" or "researching kubernetes networking". Same value on repeat calls is a no-op.' },
        description: { type: 'string', description: 'Optional longer description shown in the pinned tab body. Omit to keep the previous value; pass empty string to clear.' }
      },
      required: ['url', 'name']
    }
  },
  {
    name: 'scroll',
    description: 'Scroll the current page.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'], description: 'Direction to scroll' },
        amount: { type: 'number', description: 'Pixels to scroll (default 500, ignored for top/bottom)' }
      },
      required: ['direction']
    }
  },
  {
    name: 'get_page_info',
    description: 'Get the current URL, page title, and scroll position of the active tab.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'screenshot',
    description: 'Capture a screenshot of the visible area of the active Chrome tab. Returns a PNG image. Only use this as a fallback when read_page returns empty/useless text (e.g. canvas-rendered sites like Google Docs), or when you need to see visual layout. Prefer read_page for normal websites since text is much cheaper on tokens.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  }
];

async function handleMcpMessage(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      sendMcp({
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'claudesurf', version: '1.0.0' }
        }
      });
      break;

    case 'notifications/initialized':
      break;

    case 'tools/list':
      sendMcp({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      break;

    case 'tools/call': {
      const { name, arguments: args } = params;
      try {
        const result = await sendToDaemon(name, args || {});

        if (name === 'screenshot' && result.image) {
          sendMcp({
            jsonrpc: '2.0', id,
            result: {
              content: [{ type: 'image', data: result.image, mimeType: 'image/png' }]
            }
          });
          break;
        }

        let text = JSON.stringify(result, null, 2);
        if (text.length > 100000) {
          if (result.text && result.text.length > 50000) {
            result.text = result.text.substring(0, 50000) + '\n\n[...truncated, page text was ' + result.text.length + ' chars]';
          }
          text = JSON.stringify(result, null, 2);
        }
        sendMcp({
          jsonrpc: '2.0', id,
          result: { content: [{ type: 'text', text }] }
        });
      } catch (e) {
        sendMcp({
          jsonrpc: '2.0', id,
          result: { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true }
        });
      }
      break;
    }

    default:
      sendMcp({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
  }
}

// [debug] pid/ppid let us tell a *respawned* MCP process (new pid + new SESSION_ID,
// same ppid = same Claude Code CLI) from a genuinely new Claude session. If a fresh
// line with the same ppid appears right after a compaction, the UUID changed = a new
// window-lookup key = a new window.
log('MCP server started (session ' + SESSION_ID.slice(0, 8) + ' [' + SESSION_ID + '] via ' + SESSION_ID_SOURCE + ', daemon port ' + DAEMON_PORT + ', pid ' + process.pid + ', ppid ' + process.ppid + ')');
