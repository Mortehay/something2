const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
// helpers/auth.js MUST be required before ../src/index.js — it sets JWT_SECRET
// before the guards read it.
const { authHeaders, isUserLookup, ADMIN_USER_ROW } = require('./helpers/auth.js');
const { app, __setPool } = require('../src/index.js');

const ADMIN_HEADERS = authHeaders();

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

const BIOME = {
  id: 1, name: 'Meadow', terrain_tiles: ['grass'], flora_types: ['bush'],
  creature_types: ['Slime'], palette: ['spring green'], art_style: 'lush',
  exclusions: 'no snow', color: '#5aa84f',
};

test('GET /api/biomes lists biomes ordered by id', async () => {
  const pool = mockPool([[/FROM biomes/i, () => ({ rows: [BIOME] })]]);
  __setPool(pool);
  const res = await request(app).get('/api/biomes');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, [BIOME]);
  assert.match(pool.calls[0].sql, /ORDER BY id/i);
});

test('POST /api/biomes rejects a missing name', async () => {
  __setPool(mockPool([]));
  const res = await request(app).post('/api/biomes').set(ADMIN_HEADERS).send({ terrain_tiles: ['grass'] });
  assert.equal(res.status, 400);
});

test('POST /api/biomes creates a biome', async () => {
  const pool = mockPool([[/INSERT INTO biomes/i, () => ({ rows: [BIOME] })]]);
  __setPool(pool);
  const res = await request(app).post('/api/biomes').set(ADMIN_HEADERS).send({
    name: 'Meadow', terrain_tiles: ['grass'], flora_types: ['bush'],
    creature_types: ['Slime'], palette: ['spring green'],
    art_style: 'lush', exclusions: 'no snow', color: '#5aa84f',
  });
  assert.equal(res.status, 201);
  assert.deepEqual(res.body, BIOME);
});

test('PUT /api/biomes/:id refuses a rename while a world still lists the old name', async () => {
  const pool = mockPool([
    [/SELECT name FROM biomes WHERE id/i, () => ({ rows: [{ name: 'Meadow' }] })],
    [/FROM worlds WHERE biomes/i, () => ({ rows: [{ id: 'w1', name: 'Entry' }] })],
  ]);
  __setPool(pool);
  const res = await request(app).put('/api/biomes/1').set(ADMIN_HEADERS).send({ ...BIOME, name: 'Pasture' });
  assert.equal(res.status, 409);
  assert.deepEqual(res.body.referencing_worlds, [{ id: 'w1', name: 'Entry' }]);
});

test('DELETE /api/biomes/:id refuses while a world still lists it', async () => {
  const pool = mockPool([
    [/SELECT name FROM biomes WHERE id/i, () => ({ rows: [{ name: 'Meadow' }] })],
    [/FROM worlds WHERE biomes/i, () => ({ rows: [{ id: 'w1', name: 'Entry' }] })],
  ]);
  __setPool(pool);
  const res = await request(app).delete('/api/biomes/1').set(ADMIN_HEADERS);
  assert.equal(res.status, 409);
});

test('DELETE /api/biomes/:id succeeds when unreferenced', async () => {
  __setPool(mockPool([
    [/SELECT name FROM biomes WHERE id/i, () => ({ rows: [{ name: 'Meadow' }] })],
    [/FROM worlds WHERE biomes/i, () => ({ rows: [] })],
    [/DELETE FROM biomes/i, () => ({ rows: [{ id: 1 }] })],
  ]));
  const res = await request(app).delete('/api/biomes/1').set(ADMIN_HEADERS);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { success: true, id: 1 });
});

test('renaming a tile type is refused while a biome still lists it', async () => {
  __setPool(mockPool([
    [/SELECT name FROM tile_types WHERE id/i, () => ({ rows: [{ name: 'grass' }] })],
    [/FROM entity_types WHERE spawn_tiles/i, () => ({ rows: [] })],
    [/FROM biomes WHERE terrain_tiles/i, () => ({ rows: [{ id: 1, name: 'Meadow' }] })],
  ]));
  const res = await request(app).put('/api/tile-types/1').set(ADMIN_HEADERS).send({ name: 'lawn', color: '#0f0' });
  assert.equal(res.status, 409);
  assert.deepEqual(res.body.referencing_biomes, [{ id: 1, name: 'Meadow' }]);
});

test('renaming an entity type is refused while a biome still lists it', async () => {
  __setPool(mockPool([
    [/SELECT name FROM entity_types WHERE id/i, () => ({ rows: [{ name: 'bush' }] })],
    [/FROM worlds WHERE allowed_creature_types/i, () => ({ rows: [] })],
    [/FROM world_creatures WHERE type/i, () => ({ rows: [] })],
    [/FROM biomes WHERE/i, () => ({ rows: [{ id: 1, name: 'Meadow' }] })],
  ]));
  const res = await request(app).put('/api/entity-types/1').set(ADMIN_HEADERS).send({ name: 'shrub' });
  assert.equal(res.status, 409);
});

test('PUT /api/worlds/:id changing the biome set wipes that world\'s cached chunks', async () => {
  const pool = mockPool([
    [/SELECT id, width, height, biomes, biome_cell FROM worlds WHERE id/i,
      () => ({ rows: [{ id: 'w1', width: 30, height: 30, biomes: [], biome_cell: null }] })],
    [/DELETE FROM world_chunks/i, () => ({ rows: [] })],
    [/UPDATE worlds SET/i, () => ({ rows: [{ id: 'w1', name: 'Entry', biomes: ['Meadow'] }] })],
  ]);
  __setPool(pool);
  const res = await request(app).put('/api/worlds/w1').set(ADMIN_HEADERS).send({
    name: 'Entry', biomes: ['Meadow'],
  });
  assert.equal(res.status, 200);
  assert.ok(pool.calls.some((c) => /DELETE FROM world_chunks/i.test(c.sql)),
    'changing the biome set changes terrain, so cached chunks must be invalidated');
});

test('PUT /api/worlds/:id with an unchanged biome set does NOT wipe chunks', async () => {
  const pool = mockPool([
    [/SELECT id, width, height, biomes, biome_cell FROM worlds WHERE id/i,
      () => ({ rows: [{ id: 'w1', width: 30, height: 30, biomes: ['Meadow'], biome_cell: null }] })],
    [/UPDATE worlds SET/i, () => ({ rows: [{ id: 'w1', name: 'Entry' }] })],
  ]);
  __setPool(pool);
  const res = await request(app).put('/api/worlds/w1').set(ADMIN_HEADERS).send({
    name: 'Entry', biomes: ['Meadow'],
  });
  assert.equal(res.status, 200);
  assert.ok(!pool.calls.some((c) => /DELETE FROM world_chunks/i.test(c.sql)));
});

test('PUT /api/worlds/:id omitting biomes leaves the stored set alone', async () => {
  // Same trap as width/height: an unrelated PUT (toggling is_entry) must not
  // silently clear a world's biome set and regenerate its terrain.
  const pool = mockPool([
    [/SELECT id, width, height, biomes, biome_cell FROM worlds WHERE id/i,
      () => ({ rows: [{ id: 'w1', width: 30, height: 30, biomes: ['Meadow'], biome_cell: null }] })],
    // is_entry: true issues an extra `UPDATE worlds SET is_entry = false ...`
    // before the main update, which also matches /UPDATE worlds SET/i -- give
    // it its own earlier handler so the main-update handler below only sees
    // the actual UPDATE we care about.
    [/UPDATE worlds SET is_entry = false/i, () => ({ rows: [] })],
    // biomes is $8 in the UPDATE below -> params[7]; biome_cell is $9 -> params[8].
    [/UPDATE worlds SET name/i, (params) => {
      assert.equal(params[7], JSON.stringify(['Meadow']), 'an omitted biomes field must preserve the stored set');
      return { rows: [{ id: 'w1' }] };
    }],
  ]);
  __setPool(pool);
  const res = await request(app).put('/api/worlds/w1').set(ADMIN_HEADERS).send({ name: 'Entry', is_entry: true });
  assert.equal(res.status, 200);
  assert.ok(!pool.calls.some((c) => /DELETE FROM world_chunks/i.test(c.sql)));
});
