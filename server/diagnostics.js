// Leveled logging to stderr. Level from CLAUDESURF_LOG_LEVEL (debug|info|warn|error,
// default info), read when the logger is created. Under systemd (JOURNAL_STREAM set)
// each line carries a <N> syslog priority prefix so journald files it by level.

const LEVELS = { debug: 7, info: 6, warn: 4, error: 3 };

function threshold(env) {
  const name = (env.CLAUDESURF_LOG_LEVEL || 'info').toLowerCase();
  return LEVELS[name] === undefined ? LEVELS.info : LEVELS[name];
}

// scope is the bracketed tag on every line, e.g. "claudesurf daemon".
function createLogger(scope, { env = process.env, write = (s) => process.stderr.write(s) } = {}) {
  const max = threshold(env);
  const journal = Boolean(env.JOURNAL_STREAM);
  const emit = (level) => (...args) => {
    const priority = LEVELS[level];
    if (priority > max) return;
    const text = args.map((a) => (a instanceof Error ? a.stack || a.message : String(a))).join(' ');
    write(`${journal ? `<${priority}>` : ''}[${scope}] ${text}\n`);
  };
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}

module.exports = { createLogger };
