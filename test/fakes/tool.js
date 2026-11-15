// This fake stands in for notify-send, xdotool, and wmctrl through test/fakes/bin.
// CLAUDESURF_TEST_TOOL_ANSWER is a JSON object mapping tool names to answer lists.
// Entries set `args`, `stdout`, `stderr`, `code`, and `sleepMs`. The fake uses the
// first entry whose `args` matches a prefix of the command's arguments.
// An unmatched command exits 0 with empty stdout and stderr.
// CLAUDESURF_TEST_TOOL_LOG names an optional JSONL log with `tool`, `args`, and
// `env` fields. The fake records a command after writing its output, so a command
// killed before answering isn't logged.

const fs = require('fs');

module.exports = function run(tool) {
  const args = process.argv.slice(2);
  let answers = {};
  try { answers = JSON.parse(process.env.CLAUDESURF_TEST_TOOL_ANSWER || '{}'); } catch { answers = {}; }
  const answer = (answers[tool] || []).find((a) => (a.args || []).every((arg, i) => args[i] === arg)) || {};
  const finish = () => {
    if (answer.stdout) process.stdout.write(answer.stdout);
    if (answer.stderr) process.stderr.write(answer.stderr);
    if (process.env.CLAUDESURF_TEST_TOOL_LOG) {
      fs.appendFileSync(process.env.CLAUDESURF_TEST_TOOL_LOG, `${JSON.stringify({ tool, args, env: process.env })}\n`);
    }
    process.exitCode = answer.code || 0;
  };
  if (!answer.sleepMs) {
    finish();
    return;
  }
  setTimeout(finish, answer.sleepMs);
  // A sleeping run ends without answering once the process that ran it is gone, so a
  // daemon that a test stops doesn't leave a fake running past the test.
  const parent = process.ppid;
  setInterval(() => { if (process.ppid !== parent) process.exit(); }, 100).unref();
};
