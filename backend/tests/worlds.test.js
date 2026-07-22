const test = require('node:test');
const assert = require('node:assert');
const { adminToken, isUserLookup, ADMIN_USER_ROW } = require('./helpers/auth.js');
const request = require('supertest');

const { app, __setPool } = require('../src/index.js');

// POST /api/worlds is behind requireAdmin now.
const AUTH = ['Authorization', `Bearer ${adminToken()}`];

// A pool mock whose query() dispatches on the SQL text. `handlers` is an array
// of [regex, (params) => ({ rows }|Promise)] pairs, tried in order. The auth
// middleware's user lookup is answered automatically with an admin row.
function mockPool(handlers) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      if (isUserLookup(sql)) return ADMIN_USER_ROW;
      calls.push({ sql, params });
      for (const [re, fn] of handlers) {
        if (re.test(sql)) return fn(params);
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

test('POST /api/worlds rejects a missing name', async () => {
  __setPool(mockPool([]));
  const res = await request(app).post('/api/worlds').set(...AUTH).send({ seed: 5 });
  assert.equal(res.status, 400);
});

test('POST /api/worlds creates and returns the row', async () => {
  __setPool(mockPool([
    [/INSERT INTO worlds/i, (p) => ({
      rows: [{ id: 'w1', name: p[0], seed: String(p[1]), chunk_size: p[2] }],
    })],
  ]));
  const res = await request(app)
    .post('/api/worlds').set(...AUTH)
    .send({ name: 'Test World', seed: 42, chunk_size: 32 });
  assert.equal(res.status, 201);
  assert.equal(res.body.id, 'w1');
  assert.equal(res.body.name, 'Test World');
  assert.equal(res.body.chunk_size, 32);
});

test('GET /api/worlds lists worlds', async () => {
  __setPool(mockPool([
    [/FROM worlds/i, () => ({ rows: [{ id: 'w1', name: 'A' }, { id: 'w2', name: 'B' }] })],
  ]));
  const res = await request(app).get('/api/worlds');
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 2);
});

test('GET /api/worlds/:id returns 404 when absent', async () => {
  __setPool(mockPool([
    [/FROM worlds WHERE id/i, () => ({ rows: [] })],
  ]));
  const res = await request(app).get('/api/worlds/nope');
  assert.equal(res.status, 404);
});

// Build a tile_types result the generator accepts (object-per-row in getTileTypesMap;
// here as raw rows the SELECT returns).
const TILE_ROWS = [
  { id: 1, name: 'grass', color: '#0a0', walkable: true, speed: 1, image: null, valid_neighbors: [] },
  { id: 2, name: 'forest', color: '#060', walkable: true, speed: 1, image: null, valid_neighbors: [] },
  { id: 3, name: 'water', color: '#00a', walkable: false, speed: 1, image: null, valid_neighbors: [] },
  { id: 4, name: 'dirt', color: '#985', walkable: true, speed: 1, image: null, valid_neighbors: [] },
];

test('GET chunk rejects non-integer cx/cy', async () => {
  __setPool(mockPool([]));
  const res = await request(app).get('/api/worlds/w1/chunk?cx=foo&cy=0');
  assert.equal(res.status, 400);
});

test('GET chunk cache MISS generates and returns an NxN grid WITHOUT inserting', async () => {
  const pool = mockPool([
    [/SELECT .* FROM world_chunks/i, () => ({ rows: [] })],               // cache miss
    [/FROM worlds WHERE id/i, () => ({ rows: [{ id: 'w1', seed: '42', chunk_size: 8 }] })],
    [/FROM tile_types/i, () => ({ rows: TILE_ROWS })],
    [/FROM map_links/i, () => ({ rows: [] })],
    [/FROM villages WHERE world_id/i, () => ({ rows: [] })],
    // NO INSERT INTO world_chunks / entity_types / world_creatures handlers:
    // the authority alone materializes chunks and spawns creatures now, so if
    // the route issues any of those queries, mockPool throws.
  ]);
  __setPool(pool);
  const res = await request(app).get('/api/worlds/w1/chunk?cx=1&cy=-2');
  assert.equal(res.status, 200);
  assert.equal(res.body.world_id, 'w1');
  assert.equal(res.body.cx, 1);
  assert.equal(res.body.cy, -2);
  assert.equal(res.body.data.length, 8);        // chunk_size rows
  assert.equal(res.body.data[0].length, 8);     // chunk_size cols
  assert.ok(
    !pool.calls.some((c) => /INSERT INTO world_chunks/i.test(c.sql)),
    'GET /chunk must not insert into world_chunks',
  );
  assert.ok(
    pool.calls.some((c) => /FROM villages WHERE world_id/i.test(c.sql)),
    'GET /chunk must thread villages into the terrain config',
  );
});

test('GET chunk cache HIT returns cached data without regenerating', async () => {
  const cached = [['grass', 'grass'], ['dirt', 'water']];
  const pool = mockPool([
    [/SELECT .* FROM world_chunks/i, () => ({ rows: [{ data: cached }] })],  // cache hit
    // No worlds/tile_types handlers: if the route queries them on a hit, mockPool throws.
  ]);
  __setPool(pool);
  const res = await request(app).get('/api/worlds/w1/chunk?cx=0&cy=0');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, cached);
});

test('GET chunk returns 404 for an unknown world on cache miss', async () => {
  const pool = mockPool([
    [/SELECT .* FROM world_chunks/i, () => ({ rows: [] })],   // miss
    [/FROM worlds WHERE id/i, () => ({ rows: [] })],          // no such world
  ]);
  __setPool(pool);
  const res = await request(app).get('/api/worlds/ghost/chunk?cx=0&cy=0');
  assert.equal(res.status, 404);
});

test('POST /api/worlds rejects chunk_size out of range', async () => {
  __setPool(mockPool([
    [/INSERT INTO worlds/i, (p) => ({ rows: [{ id: 'w', name: p[0], seed: String(p[1]), chunk_size: p[2] }] })],
  ]));
  const zero = await request(app).post('/api/worlds').set(...AUTH).send({ name: 'Z', seed: 1, chunk_size: 0 });
  assert.equal(zero.status, 400);
  const huge = await request(app).post('/api/worlds').set(...AUTH).send({ name: 'H', seed: 1, chunk_size: 1000000 });
  assert.equal(huge.status, 400);
  const neg = await request(app).post('/api/worlds').set(...AUTH).send({ name: 'N', seed: 1, chunk_size: -5 });
  assert.equal(neg.status, 400);
});

test('POST /api/worlds persists width/height together or 400s on one', async () => {
  const pool = mockPool([
    [/INSERT INTO worlds/i, (p) => ({ rows: [{ id: 'w1', name: p[0], width: p[3], height: p[4] }] })],
  ]);
  __setPool(pool);
  const ok = await request(app).post('/api/worlds').set(...AUTH)
    .send({ name: 'arena', seed: 1, width: 40, height: 30 });
  assert.equal(ok.status, 201);
  const call = pool.calls.find((c) => /INSERT INTO worlds/i.test(c.sql));
  assert.equal(Number(call.params[3]), 40);
  assert.equal(Number(call.params[4]), 30);

  const bad = await request(app).post('/api/worlds').set(...AUTH)
    .send({ name: 'x', seed: 1, width: 40 }); // height missing
  assert.equal(bad.status, 400);
});
