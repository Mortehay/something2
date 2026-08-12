const test = require('node:test');
const assert = require('node:assert');
const { adminToken, isUserLookup, ADMIN_USER_ROW } = require('./helpers/auth.js');
const request = require('supertest');
const { app, __setPool, __setAuthorityHandle } = require('../src/index.js');

test.afterEach(() => { __setAuthorityHandle(null); });

const AUTH = ['Authorization', `Bearer ${adminToken()}`];
function mockPool(handlers) {
  const calls = [];
  return { calls, query: async (sql, params) => {
    if (isUserLookup(sql)) return ADMIN_USER_ROW;
    calls.push({ sql, params });
    for (const [re, fn] of handlers) if (re.test(sql)) return fn(params);
    throw new Error(`unexpected query: ${sql}`);
  } };
}

test('GET /api/worlds/:id/links lists edges', async () => {
  __setPool(mockPool([[/FROM map_links/i, () => ({ rows: [{ edge: 'E', to_world_id: 'B', to_width: 16, to_height: 16 }] })]]));
  const res = await request(app).get('/api/worlds/A/links');
  assert.equal(res.status, 200);
  assert.equal(res.body[0].edge, 'E');
  assert.equal(res.body[0].to_world_id, 'B');
});

test('POST links rejects a bad edge', async () => {
  __setPool(mockPool([]));
  const res = await request(app).post('/api/worlds/A/links').set(...AUTH).send({ edge: 'X', to_world_id: 'B' });
  assert.equal(res.status, 400);
});

test('POST links rejects linking a world to itself', async () => {
  __setPool(mockPool([]));
  const res = await request(app).post('/api/worlds/A/links').set(...AUTH).send({ edge: 'E', to_world_id: 'A' });
  assert.equal(res.status, 400);
});

test('POST links rejects when a target is not bounded', async () => {
  __setPool(mockPool([
    [/SELECT .* FROM worlds WHERE id = \$1/i, (p) => ({ rows: [{ id: p[0], width: p[0] === 'A' ? 24 : null, height: p[0] === 'A' ? 24 : null }] })],
  ]));
  const res = await request(app).post('/api/worlds/A/links').set(...AUTH).send({ edge: 'E', to_world_id: 'B' });
  assert.equal(res.status, 400);
});

test('POST links writes both directions and returns ok', async () => {
  const pool = mockPool([
    [/SELECT .* FROM worlds WHERE id = \$1/i, (p) => ({ rows: [{ id: p[0], width: 24, height: 24 }] })],
    [/INSERT INTO map_links/i, () => ({ rows: [] })],
    [/DELETE FROM world_chunks/i, () => ({ rows: [], rowCount: 0 })],
  ]);
  __setPool(pool);
  const res = await request(app).post('/api/worlds/A/links').set(...AUTH).send({ edge: 'E', to_world_id: 'B' });
  assert.equal(res.status, 200);
  assert.equal(pool.calls.filter(c => /INSERT INTO map_links/i.test(c.sql)).length, 2);
  // A link change reshapes the wall ring like a bounds change: both the from-
  // and to-world's persisted chunks must be invalidated, not just the authority cache.
  const invalidated = pool.calls.filter(c => /DELETE FROM world_chunks/i.test(c.sql)).map(c => c.params[0]);
  assert.deepEqual(invalidated.sort(), ['A', 'B']);
});

test('DELETE links removes the link (204)', async () => {
  const pool = mockPool([
    [/SELECT to_world_id FROM map_links/i, () => ({ rows: [{ to_world_id: 'B' }] })],
    [/DELETE FROM map_links/i, () => ({ rows: [] })],
    [/DELETE FROM world_chunks/i, () => ({ rows: [], rowCount: 0 })],
  ]);
  __setPool(pool);
  const res = await request(app).delete('/api/worlds/A/links/E').set(...AUTH);
  assert.equal(res.status, 204);
  // Clearing a link reshapes the wall ring for the from-world too: its persisted
  // chunks must be invalidated, not just the authority cache.
  const invalidated = pool.calls.filter(c => /DELETE FROM world_chunks/i.test(c.sql)).map(c => c.params[0]);
  assert.deepEqual(invalidated.sort(), ['A', 'B']);
});

// F-017 (SOMET-197): both invalidateWorld() calls' return values used to be
// discarded, so a link edit against a world with a connected player silently
// never reached that player's live session (its wall ring / doorway would
// stay stale until the world emptied).
//
// SOMET-236: a single link edit calls invalidateWorld() on BOTH endpoint
// worlds (see the ticket's own "map-link graph tab" example), and this test's
// shared authority handle refuses eviction for both. No
// /DELETE FROM world_chunks/i handler is registered below on purpose: chunks
// must not be wiped for EITHER world when eviction is refused for it, so that
// query hitting the mock's throw-on-unexpected-query guard would fail this
// test loud if the ordering regressed back to delete-then-check.
test('POST links warns when either world is live (JSON body can carry it)', async () => {
  const pool = mockPool([
    [/SELECT .* FROM worlds WHERE id = \$1/i, (p) => ({ rows: [{ id: p[0], width: 24, height: 24 }] })],
    [/INSERT INTO map_links/i, () => ({ rows: [] })],
  ]);
  __setPool(pool);
  __setAuthorityHandle({ evictWorld: () => false, isWorldLive: () => true });
  const res = await request(app).post('/api/worlds/A/links').set(...AUTH).send({ edge: 'E', to_world_id: 'B' });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.match(res.body.liveWarning, /connected/i);
  assert.ok(!pool.calls.some(c => /DELETE FROM world_chunks/i.test(c.sql)),
    'SOMET-236: neither endpoint world\'s chunks may be wiped while its eviction is refused');
});

// SOMET-236: same reasoning as the POST test above -- no chunk-delete handler
// registered on purpose.
test('DELETE links sets a header when a world is live (204 has no body to carry it)', async () => {
  const pool = mockPool([
    [/SELECT to_world_id FROM map_links/i, () => ({ rows: [{ to_world_id: 'B' }] })],
    [/DELETE FROM map_links/i, () => ({ rows: [] })],
  ]);
  __setPool(pool);
  __setAuthorityHandle({ evictWorld: () => false, isWorldLive: () => true });
  const res = await request(app).delete('/api/worlds/A/links/E').set(...AUTH);
  assert.equal(res.status, 204);
  assert.equal(res.headers['x-live-world-pending'], 'true');
  assert.ok(!pool.calls.some(c => /DELETE FROM world_chunks/i.test(c.sql)),
    'SOMET-236: neither endpoint world\'s chunks may be wiped while its eviction is refused');
});
