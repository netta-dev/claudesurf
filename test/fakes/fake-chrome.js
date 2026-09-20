#!/usr/bin/env node

// The fake browser as an executable speaking the pipe on fds 3 and 4, so daemon-level
// tests run the real launch path with CLAUDESURF_BROWSER pointing here. Environment:
//   CLAUDESURF_FAKE_EXIT=<code>     exit with that code before answering anything
//   CLAUDESURF_FAKE_STDERR=<text>   written to stderr first
//   CLAUDESURF_FAKE_SCRIPT=<path>   module exporting (fake) => void, applied at start
//                                   (see scripts/)
//   CLAUDESURF_FAKE_ENV_DUMP=<path> the environment as received, written as JSON first

const fs = require('fs');
const { FakeBrowser } = require('./fake-browser');

if (process.env.CLAUDESURF_FAKE_ENV_DUMP) fs.writeFileSync(process.env.CLAUDESURF_FAKE_ENV_DUMP, JSON.stringify(process.env));
if (process.env.CLAUDESURF_FAKE_STDERR) process.stderr.write(process.env.CLAUDESURF_FAKE_STDERR + '\n');
if (process.env.CLAUDESURF_FAKE_EXIT) process.exit(Number(process.env.CLAUDESURF_FAKE_EXIT));

const input = fs.createReadStream(null, { fd: 3 });
const output = fs.createWriteStream(null, { fd: 4 });
const fake = new FakeBrowser();
if (process.env.CLAUDESURF_FAKE_SCRIPT) require(process.env.CLAUDESURF_FAKE_SCRIPT)(fake);
fake.attach(input, output);
input.on('end', () => process.exit(0));
input.on('error', () => process.exit(0));
output.on('error', () => process.exit(0));
