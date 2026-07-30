// helpers/auth.js MUST be required before ../src/index.js — it sets JWT_SECRET
// before the guards read it.
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { authHeaders, isUserLookup, ADMIN_USER_ROW } = require('./helpers/auth.js');
const { app, __setPool } = require('../src/index.js');

const ADMIN = authHeaders();

function mockPool(handlers) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      if (isUserLookup(sql)) return ADMIN_USER_ROW;
      calls.push({ sql, params });
      for (const [re, fn] of handlers) if (re.test(sql)) return fn(params);
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

const OK = [/UPDATE worlds SET graph_x/i, (p) => ({ rows: [{ id: 'w1', graph_x: p[0], graph_y: p[1] }] })];

test('saves a position and echoes it back', async () => {
  const pool = mockPool([OK]);
  __setPool(pool);
  const res = await request(app).put('/api/worlds/w1/graph-position').set(ADMIN).send({ x: 120.5, y: -40 });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { id: 'w1', graph_x: 120.5, graph_y: -40 });
  assert.deepEqual(pool.calls[0].params, [120.5, -40, 'w1']);
});

// THE point of this route existing separately. PUT /api/worlds/:id deletes
// world_chunks and clears caches when bounds or biomes change; dragging a node
// on a diagram must never be able to reach that path.
test('a position save NEVER invalidates terrain or caches', async () => {
  const pool = mockPool([OK]);
  __setPool(pool);
  await request(app).put('/api/worlds/w1/graph-position').set(ADMIN).send({ x: 1, y: 2 });
  for (const c of pool.calls) {
    assert.ok(!/DELETE FROM world_chunks/i.test(c.sql), `must not wipe chunks: ${c.sql}`);
    assert.ok(!/DELETE FROM world_creatures/i.test(c.sql), `must not touch creatures: ${c.sql}`);
  }
  assert.equal(pool.calls.length, 1, 'exactly one UPDATE, nothing else');
});

test('rejects non-finite coordinates rather than coercing them', async () => {
  for (const body of [{ x: 'left', y: 0 }, { x: 0 }, {}, { x: null, y: 3 }]) {
    __setPool(mockPool([OK]));
    const res = await request(app).put('/api/worlds/w1/graph-position').set(ADMIN).send(body);
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
  }
});

test('404s for an unknown world', async () => {
  __setPool(mockPool([[/UPDATE worlds SET graph_x/i, () => ({ rows: [] })]]));
  const res = await request(app).put('/api/worlds/nope/graph-position').set(ADMIN).send({ x: 0, y: 0 });
  assert.equal(res.status, 404);
});

test('requires admin', async () => {
  __setPool(mockPool([OK]));
  const res = await request(app).put('/api/worlds/w1/graph-position').send({ x: 0, y: 0 });
  assert.ok(res.status === 401 || res.status === 403, `expected auth failure, got ${res.status}`);
});
