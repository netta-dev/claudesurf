// The rule for a textual MIME type, as a pattern's source and flags, matched against a
// whole Content-Type value: the part before any `;`, trimmed and in any case, is
// text/*, one of four application types, or ends in +json or +xml. network.js matches
// a record's MIME type against it, and page/fetch.js takes it as an argument, since a
// RegExp doesn't cross the protocol. It doesn't match an empty type, which each caller
// judges on its own.
const TEXTUAL = {
  source: String.raw`^\s*(?:text/[^;\s]+|application/(?:json|xml|javascript|x-www-form-urlencoded)|[^;\s/]+/[^;\s]+\+(?:json|xml))\s*(?:;|$)`,
  flags: 'i',
};

module.exports = { TEXTUAL };
