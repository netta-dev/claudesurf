// This preload makes building a policy call's response throw, as a bug in respond.js
// would. The daemon loads it with node's --require, ahead of daemon.js, which takes
// respond.js's exports as it loads.

const respond = require('../../../server/respond');

const original = respond.respond;
respond.respond = (sessions, session, result, opts) => {
  if (/^Allowed: /.test(result.head)) throw new Error('building the response failed');
  return original(sessions, session, result, opts);
};
