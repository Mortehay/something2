const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { adminToken, isUserLookup, ADMIN_USER_ROW } = require('./helpers/auth.js');
const { app, __setPool } = require('../src/index.js');

const AUTH = ['Authorization', `Bearer ${adminToken()}`];

// SQL-text-dispatch pool mock; auth's user lookup answered with an admin row.
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

test('POST /api/tile-types sends prompt as INSERT param $7 and echoes it', async () => {
  const pool = mockPool([
    [/INSERT INTO tile_types/i, (p) => ({ rows: [{ id: 1, name: 'lava', prompt: p[6] }] })],
  ]);
  __setPool(pool);
  const res = await request(app).post('/api/tile-types').set(...AUTH).send({
    name: 'lava', color: '#f00', walkable: false, speed: 0,
    valid_neighbors: [], prompt: 'molten glowing lava',
  });
  assert.equal(res.status, 201);
  const call = pool.calls.find((c) => /INSERT INTO tile_types/i.test(c.sql));
  assert.equal(call.params[6], 'molten glowing lava', 'prompt must be INSERT $7');
  assert.equal(res.body.prompt, 'molten glowing lava');
});

test('PUT /api/tile-types/:id sends prompt as UPDATE param $7, wall_height/place_order as $8/$9, and id as $10', async () => {
  const pool = mockPool([
    // name is unchanged ('grass' -> 'grass'), so the rename guard's reference
    // checks are skipped entirely.
    [/SELECT name FROM tile_types WHERE id/i, () => ({ rows: [{ name: 'grass' }] })],
    [/UPDATE tile_types/i, (p) => ({ rows: [{ id: Number(p[9]), name: p[0], prompt: p[6] }] })],
  ]);
  __setPool(pool);
  const res = await request(app).put('/api/tile-types/9').set(...AUTH).send({
    name: 'grass', color: '#0f0', walkable: true, speed: 1,
    image: '', valid_neighbors: ['grass'], prompt: 'edited meadow grass',
    wall_height: 40, place_order: 1,
  });
  assert.equal(res.status, 200);
  const call = pool.calls.find((c) => /UPDATE tile_types/i.test(c.sql));
  assert.equal(call.params[6], 'edited meadow grass', 'prompt must be UPDATE $7');
  assert.equal(call.params[7], 40, 'wall_height must be UPDATE $8');
  assert.equal(call.params[8], 1, 'place_order must be UPDATE $9');
  assert.equal(String(call.params[9]), '9', 'id must be UPDATE $10');
  assert.equal(res.body.prompt, 'edited meadow grass');
});

test('POST defaults prompt to empty string when omitted', async () => {
  const pool = mockPool([
    [/INSERT INTO tile_types/i, (p) => ({ rows: [{ id: 2, prompt: p[6] }] })],
  ]);
  __setPool(pool);
  const res = await request(app).post('/api/tile-types').set(...AUTH).send({
    name: 'plain', color: '#111',
  });
  assert.equal(res.status, 201);
  const call = pool.calls.find((c) => /INSERT INTO tile_types/i.test(c.sql));
  assert.equal(call.params[6], '', 'missing prompt must default to empty string');
});

// SOMET-238: DELETE had no reference guard at all, though the PUT rename
// guard right above already refuses exactly this (see also
// biomesApi.test.js's "renaming a tile type is refused while a biome still
// lists it"). Same two reference sites, same 409 shape, now on DELETE too. No
// /DELETE FROM tile_types/i handler is registered in the refused cases below
// on purpose: if the guard regressed away, that query would hit the mock's
// throw-on-unexpected-query guard instead of silently deleting a
// still-referenced row.
test('DELETE /api/tile-types/:id 409s when still referenced by an entity type\'s spawn tiles', async () => {
  __setPool(mockPool([
    [/SELECT name FROM tile_types WHERE id/i, () => ({ rows: [{ name: 'grass' }] })],
    [/FROM entity_types WHERE spawn_tiles/i, () => ({ rows: [{ id: 3, name: 'Bush' }] })],
    [/FROM biomes WHERE terrain_tiles/i, () => ({ rows: [] })],
  ]));
  const res = await request(app).delete('/api/tile-types/1').set(...AUTH);
  assert.equal(res.status, 409);
  assert.deepEqual(res.body.referencing_entity_types, [{ id: 3, name: 'Bush' }]);
});

test('DELETE /api/tile-types/:id 409s when still referenced by a biome\'s terrain_tiles', async () => {
  __setPool(mockPool([
    [/SELECT name FROM tile_types WHERE id/i, () => ({ rows: [{ name: 'grass' }] })],
    [/FROM entity_types WHERE spawn_tiles/i, () => ({ rows: [] })],
    [/FROM biomes WHERE terrain_tiles/i, () => ({ rows: [{ id: 1, name: 'Meadow' }] })],
  ]));
  const res = await request(app).delete('/api/tile-types/1').set(...AUTH);
  assert.equal(res.status, 409);
  assert.deepEqual(res.body.referencing_biomes, [{ id: 1, name: 'Meadow' }]);
});

test('DELETE /api/tile-types/:id succeeds when nothing references it (no regression)', async () => {
  const pool = mockPool([
    [/SELECT name FROM tile_types WHERE id/i, () => ({ rows: [{ name: 'grass' }] })],
    [/FROM entity_types WHERE spawn_tiles/i, () => ({ rows: [] })],
    [/FROM biomes WHERE terrain_tiles/i, () => ({ rows: [] })],
    [/DELETE FROM tile_types WHERE id/i, () => ({ rows: [{ id: 1 }] })],
  ]);
  __setPool(pool);
  const res = await request(app).delete('/api/tile-types/1').set(...AUTH);
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.id, 1);
});

test('DELETE /api/tile-types/:id 404s when the row does not exist', async () => {
  __setPool(mockPool([
    [/SELECT name FROM tile_types WHERE id/i, () => ({ rows: [] })],
  ]));
  const res = await request(app).delete('/api/tile-types/999').set(...AUTH);
  assert.equal(res.status, 404);
});
