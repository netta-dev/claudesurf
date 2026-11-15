// This module sends desktop notifications through notify-send and marks browser
// windows through xdotool and wmctrl. The window mark uses the ICCCM urgency bit and
// EWMH demands-attention state because taskbars differ in which state they display.
// A tool run is killed after 5 s. Tool failures are logged without failing the
// browser call. A missing binary is logged once at info.
// A failure's first stderr line is logged at info on its first occurrence and at
// debug on later occurrences.

const { execFile } = require('child_process');
const { GRAPHICAL_VARS, dropUnreadableXauthority } = require('./paths');

const TOOL_TIMEOUT_MS = 5_000;

class Notifier {
  // Takes `log`, the daemon's logger, and `env()`, which returns the environment that
  // the tools run under, read at each run.
  constructor({ log, env }) {
    this.log = log;
    this.env = env;
    this.missing = new Set();
    this.failures = new Set();
  }

  // Resolves whether notify-send showed the notification; `urgency` is low, normal, or
  // critical. The body has &, <, and > escaped, since notification servers read body
  // markup.
  async notify({ summary, body, urgency }) {
    const escaped = String(body).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const { ok } = await this.run('notify-send', ['--app-name=ClaudeSurf', `--urgency=${urgency}`, '--', summary, escaped]);
    return ok;
  }

  // Resolves with the id of the one window of process `pid` whose name starts with
  // `<title> - `, or null: under Wayland without DISPLAY, for an empty title, without
  // xdotool, and unless exactly one window matches, each logged at info. The search
  // includes unmapped windows, since a window manager unmaps a minimized one.
  async findWindow({ pid, title }) {
    if (!this.env().DISPLAY) return this.skip('the session lacks DISPLAY');
    if (!title) return this.skip('the page has no title');
    // xdotool search exits 1, silently, when it doesn't find a window.
    const search = await this.run('xdotool', ['search', '--pid', String(pid)], { missExit: 1 });
    if (!search.ok) return this.skip('xdotool could not search the windows');
    const matches = [];
    for (const id of search.stdout.split(/\s+/).filter((word) => /^\d+$/.test(word))) {
      const named = await this.run('xdotool', ['getwindowname', id]);
      if (named.ok && named.stdout.replace(/\n$/, '').startsWith(`${title} - `)) matches.push(id);
    }
    if (matches.length !== 1) return this.skip(matches.length ? `${matches.length} browser windows carry the page's title` : "no browser window carries the page's title");
    return matches[0];
  }

  // Resolves whether both of the window's marks were set, with `on`, or cleared. The
  // two commands fail independently, so a missing wmctrl still lets xdotool set or
  // clear the urgency bit.
  async mark(windowId, on) {
    const urgency = await this.run('xdotool', ['set_window', '--urgency', on ? '1' : '0', String(windowId)]);
    const attention = await this.run('wmctrl', ['-i', '-r', String(windowId), '-b', `${on ? 'add' : 'remove'},demands_attention`]);
    return urgency.ok && attention.ok;
  }

  skip(why) {
    this.log.info(`urgency hint skipped: ${why}`);
    return null;
  }

  // Resolves { ok, stdout } for a run of `binary` without rejecting on tool failure.
  // An exit with `missExit` counts as success when stdout and stderr are empty,
  // supporting tools that use that exit code when a search finds nothing.
  run(binary, args, { missExit } = {}) {
    return new Promise((resolve) => {
      const done = (error, stdout, stderr) => {
        if (!error || (missExit !== undefined && error.code === missExit && !stdout && !stderr)) { resolve({ ok: true, stdout }); return; }
        if (error.code === 'ENOENT') {
          if (!this.missing.has(binary)) this.log.info(`${binary} is not installed; the desktop goes without it`);
          this.missing.add(binary);
        } else {
          const what = args[0] && !args[0].startsWith('-') ? `${binary} ${args[0]}` : binary;
          const first = `${what}: ${error.killed ? `killed after ${TOOL_TIMEOUT_MS} ms` : String(stderr || error.message).split('\n')[0]}`;
          this.log[this.failures.has(first) ? 'debug' : 'info'](first);
          this.failures.add(first);
        }
        resolve({ ok: false, stdout: '' });
      };
      // execFile throws for an argument that it refuses, such as one with a NUL.
      try {
        execFile(binary, args, { env: this.env(), timeout: TOOL_TIMEOUT_MS, killSignal: 'SIGKILL', encoding: 'utf8' }, done);
      } catch (e) {
        this.log.warn(`running ${binary}: ${e.message}`);
        resolve({ ok: false, stdout: '' });
      }
    });
  }
}

// Returns the environment that the tools run under: the daemon's, plus the request's
// value of each graphical variable that the daemon lacks, so notify-send keeps the
// daemon's session bus while xdotool takes the bridge's DISPLAY. An XAUTHORITY naming a
// file that this process can't read is dropped.
function toolEnv(processEnv, requestEnv = {}) {
  const env = { ...processEnv };
  for (const name of GRAPHICAL_VARS) {
    if (!env[name] && typeof requestEnv[name] === 'string' && requestEnv[name] !== '') env[name] = requestEnv[name];
  }
  return dropUnreadableXauthority(env);
}

module.exports = { Notifier, toolEnv };
