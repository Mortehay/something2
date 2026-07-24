const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { attachAuthority } = require('../src/authority/server');

// A pool stub that answers only what attachAuthority's timers might touch.
// attachAuthority does no queries until a socket connects, so a throwing
// stub is fine for evictWorld (which never queries).
const noopPool = { query: async () => ({ rows: [], rowCount: 0 }) };

function withAuthority(fn) {
  const server = http.createServer();
  const handle = attachAuthority(server, noopPool, { jwtSecret: 'test' });
  try { return fn(handle); } finally { handle.close(); }
}

test('evictWorld returns false for a world that was never loaded', () => {
  withAuthority((h) => {
    assert.equal(h.evictWorld('missing-id'), false);
  });
});

test('evictWorld exposes a function on the handle', () => {
  withAuthority((h) => {
    assert.equal(typeof h.evictWorld, 'function');
  });
});

// F-017 (SOMET-197): evictWorld() returning false is ambiguous — "nothing was
// loaded" and "a player is connected, refused" both return false. isWorldLive
// disambiguates so an admin caller can tell the two apart and only warn in
// the second case (see index.js's evictOrWarn / the worldsAdminRoutes and
// villageRoutes/worldLinksRoutes live-warning tests for the caller side).
test('isWorldLive returns false for a world that was never loaded', () => {
  withAuthority((h) => {
    assert.equal(h.isWorldLive('missing-id'), false);
  });
});
