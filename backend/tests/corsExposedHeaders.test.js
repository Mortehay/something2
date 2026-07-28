const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { adminToken, isUserLookup, ADMIN_USER_ROW } = require('./helpers/auth.js');
const { app, __setPool, __setAuthorityHandle } = require('../src/index.js');

// F2: X-Live-World-Pending (F-017/SOMET-197's liveWarning signal on the two
// 204 routes below) was invisible to the browser because `app.use(cors())`
// never set Access-Control-Expose-Headers. The API is cross-origin (frontend
// :15173 -> backend :13101), so per the Fetch spec only the safelisted
// response headers are readable via a cross-origin fetch()'s
// `res.headers.get(...)` unless the server explicitly exposes more.
//
// The frontend's own liveWarning.test.js cannot catch this: it feeds
// liveWarningFromHeader() a literal 'true' string directly, which can never
// occur in a real browser if the header was never exposed in the first
// place -- it tests the string-parsing helper in isolation, not the header's
// actual browser visibility. These tests instead read the value off a real
// `Headers` object built from a filter that mirrors the Fetch spec's
// CORS-cross-origin response filtering, applied to supertest's raw
// (server-sent) response headers -- proving what a browser would actually
// hand to useMapsAdmin.js, not just what the server put on the wire.

test.afterEach(() => { __setAuthorityHandle(null); });

const AUTH = ['Authorization', `Bearer ${adminToken()}`];
// The village-delete route runs its DELETE inside a real transaction via
// pool.connect() (F-007/SOMET-187), same as villageRoutes.test.js's mock:
// BEGIN/COMMIT/ROLLBACK are answered directly, connect() hands back a
// client that dispatches through the same handlers.
function mockPool(handlers) {
  const dispatch = async (sql, params) => {
    if (isUserLookup(sql)) return ADMIN_USER_ROW;
    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql.trim())) return { rows: [] };
    for (const [re, fn] of handlers) if (re.test(sql)) return fn(params);
    throw new Error(`unexpected query: ${sql}`);
  };
  return { query: dispatch, connect: async () => ({ query: dispatch, release: () => {} }) };
}

// Per the Fetch spec, these response headers are always readable by a
// cross-origin fetch() with no Access-Control-Expose-Headers needed at all.
// Everything else -- X-Live-World-Pending included -- needs to be listed
// there, or a browser's Headers object silently omits it even though the
// server sent it (this is exactly what bare `cors()` failed to do).
const SAFELISTED_RESPONSE_HEADERS = new Set([
  'cache-control', 'content-language', 'content-length', 'content-type', 'expires', 'last-modified', 'pragma',
]);

// A faithful stand-in for the header-filtering step a real browser performs
// before handing JS a cross-origin Response: keep only the safelisted names
// plus whatever Access-Control-Expose-Headers explicitly lists, and return
// a genuine `Headers` instance so the assertion below calls the exact same
// `.get(...)` API useMapsAdmin.js calls. supertest's `res.headers` are the
// RAW headers the server put on the wire (supertest talks to the app
// in-process, no browser sits in between) -- this function is what turns
// that into what a browser would actually expose.
function asBrowserVisibleHeaders(rawHeaders) {
  const exposed = new Set(
    (rawHeaders['access-control-expose-headers'] || '')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  );
  const visible = new Headers();
  for (const [name, value] of Object.entries(rawHeaders)) {
    const lower = name.toLowerCase();
    if (SAFELISTED_RESPONSE_HEADERS.has(lower) || exposed.has(lower)) visible.set(name, value);
  }
  return visible;
}

test('a browser fetch() can read X-Live-World-Pending cross-origin on DELETE /api/worlds/:id/links/:edge', async () => {
  __setPool(mockPool([
    [/SELECT to_world_id FROM map_links/i, () => ({ rows: [{ to_world_id: 'B' }] })],
    [/DELETE FROM map_links/i, () => ({ rows: [] })],
    [/DELETE FROM world_chunks/i, () => ({ rows: [], rowCount: 0 })],
  ]));
  __setAuthorityHandle({ evictWorld: () => false, isWorldLive: () => true });
  const res = await request(app).delete('/api/worlds/A/links/E').set(...AUTH);
  assert.equal(res.status, 204);
  assert.equal(res.headers['x-live-world-pending'], 'true', 'sanity: the server does send it on the wire');

  const visible = asBrowserVisibleHeaders(res.headers);
  assert.equal(visible.get('x-live-world-pending'), 'true',
    'a real browser Headers object, filtered per the Fetch spec CORS rules, must still expose it');
});

test('a browser fetch() can read X-Live-World-Pending cross-origin on DELETE /api/worlds/:id/villages/:villageId', async () => {
  __setPool(mockPool([
    [/DELETE FROM villages WHERE id = \$1/i, () => ({ rows: [], rowCount: 1 })],
    [/DELETE FROM world_creatures WHERE world_id = \$1 AND type = \$2/i, () => ({ rows: [], rowCount: 2 })],
    [/FROM villages WHERE world_id = \$1/i, () => ({ rows: [] })],
    [/DELETE FROM world_chunks/i, () => ({ rows: [], rowCount: 0 })],
  ]));
  __setAuthorityHandle({ evictWorld: () => false, isWorldLive: () => true });
  const res = await request(app).delete('/api/worlds/w1/villages/v1').set(...AUTH);
  assert.equal(res.status, 204);
  assert.equal(res.headers['x-live-world-pending'], 'true', 'sanity: the server does send it on the wire');

  const visible = asBrowserVisibleHeaders(res.headers);
  assert.equal(visible.get('x-live-world-pending'), 'true');
});

test('regression guard: the filter itself is faithful -- bare cors() (no exposedHeaders) would hide the header', () => {
  // Direct proof this test suite would have caught the original bug: a raw
  // header set shaped exactly like what pre-fix `app.use(cors())` sent (no
  // access-control-expose-headers at all) must NOT expose the custom header,
  // even though it's present on the wire -- independent of the live app's
  // current (now-fixed) config.
  const rawHeadersBeforeFix = {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'x-live-world-pending': 'true',
  };
  const visible = asBrowserVisibleHeaders(rawHeadersBeforeFix);
  assert.equal(visible.get('x-live-world-pending'), null,
    'without Access-Control-Expose-Headers a browser must not be able to read this header');
});
