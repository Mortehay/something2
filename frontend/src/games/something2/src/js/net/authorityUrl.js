// Derives the authority websocket URL from the shared API base
// (frontend/src/config.js). Split out as a pure function -- rather than left
// inline in Game.js -- specifically so this is unit-testable: vitest runs in
// a node environment here, and Game.initChunked() has no `window` to read.
//
// Two cases:
//   - apiUrl set (cross-origin deployment): keep today's behaviour exactly,
//     http(s) -> ws(s) on the configured origin.
//   - apiUrl empty (same-origin default, e.g. compose/orangepi's Caddy):
//     there is no origin to rewrite, so derive one from the page itself --
//     wss:// on an https page, ws:// otherwise, same host. This mirrors what
//     a relative fetch('/api/...') already does for the REST calls.
export function authorityWsUrl(apiUrl, loc) {
  if (apiUrl) return apiUrl.replace(/^http/, 'ws') + '/authority';
  const proto = loc.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${loc.host}/authority`;
}
