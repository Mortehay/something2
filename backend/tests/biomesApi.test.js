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
    // The cur-select now also fetches terrain_tiles (for the invalidation
    // check below), so match on the common "FROM biomes WHERE id" fragment
    // rather than the exact old column list.
    [/SELECT name.*FROM biomes WHERE id/i, () => ({ rows: [{ name: 'Meadow', terrain_tiles: ['grass'] }] })],
    [/FROM worlds WHERE biomes/i, () => ({ rows: [{ id: 'w1', name: 'Entry' }] })],
  ]);
  __setPool(pool);
  const res = await request(app).put('/api/biomes/1').set(ADMIN_HEADERS).send({ ...BIOME, name: 'Pasture' });
  assert.equal(res.status, 409);
  assert.deepEqual(res.body.referencing_worlds, [{ id: 'w1', name: 'Entry' }]);
});

test('PUT /api/biomes/:id allows a rename when nothing references the old name', async () => {
  // Pins the guard's condition itself (mutation testing: `if (refs.length > 0)`
  // mutated to `if (true)` would 409 here even though nothing references
  // 'Meadow' -- the earlier 409 test alone can't distinguish "correctly
  // refused" from "always refuses").
  const pool = mockPool([
    [/SELECT name.*FROM biomes WHERE id/i, () => ({ rows: [{ name: 'Meadow', terrain_tiles: ['grass'] }] })],
    [/FROM worlds WHERE biomes/i, () => ({ rows: [] })],
    [/UPDATE biomes SET/i, () => ({ rows: [{ ...BIOME, name: 'Pasture' }] })],
  ]);
  __setPool(pool);
  const res = await request(app).put('/api/biomes/1').set(ADMIN_HEADERS).send({ ...BIOME, name: 'Pasture' });
  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'Pasture');
});

test('PUT /api/biomes/:id invalidates every world listing it when terrain_tiles changes', async () => {
  // Real bug (not a coverage gap): editing a biome's terrain_tiles changes
  // what GET /chunk generates for any world that lists it, but until now
  // nothing invalidated that world's already-persisted world_chunks rows --
  // the authority would keep serving pre-edit terrain while /chunk computed
  // post-edit terrain, and the client would rubber-band off walls the
  // authority doesn't have. Name is unchanged here, so this exercises the
  // invalidation path independent of the rename guard.
  const pool = mockPool([
    [/SELECT name.*FROM biomes WHERE id/i, () => ({ rows: [{ name: 'Meadow', terrain_tiles: ['grass'] }] })],
    [/UPDATE biomes SET/i, () => ({ rows: [{ ...BIOME, terrain_tiles: ['sand'] }] })],
    [/FROM worlds WHERE biomes/i, () => ({ rows: [{ id: 'w1', name: 'Entry' }] })],
    [/DELETE FROM world_chunks/i, () => ({ rows: [] })],
  ]);
  __setPool(pool);
  const res = await request(app).put('/api/biomes/1').set(ADMIN_HEADERS).send({ ...BIOME, terrain_tiles: ['sand'] });
  assert.equal(res.status, 200);
  assert.ok(pool.calls.some((c) => /DELETE FROM world_chunks/i.test(c.sql)),
    'a terrain_tiles change must invalidate every world that lists this biome');
});

test('PUT /api/biomes/:id does NOT invalidate worlds when only cosmetic fields change', async () => {
  // palette/art_style/exclusions/color are prompt-and-display only -- wiping
  // every referencing world's terrain over an art-style typo fix would be a
  // separate bug. No /FROM worlds WHERE biomes/i handler is registered below
  // on purpose: if the route mistakenly looked up referencing worlds anyway,
  // the mock's throw-on-unexpected-query guard would turn that into a 500.
  const pool = mockPool([
    [/SELECT name.*FROM biomes WHERE id/i, () => ({ rows: [{ name: 'Meadow', terrain_tiles: ['grass'] }] })],
    [/UPDATE biomes SET/i, () => ({ rows: [{ ...BIOME, color: '#123456' }] })],
  ]);
  __setPool(pool);
  const res = await request(app).put('/api/biomes/1').set(ADMIN_HEADERS)
    .send({ ...BIOME, terrain_tiles: ['grass'], color: '#123456' });
  assert.equal(res.status, 200);
  assert.ok(!pool.calls.some((c) => /DELETE FROM world_chunks/i.test(c.sql)));
});

test('DELETE /api/biomes/:id refuses while a world still lists it', async () => {
  const pool = mockPool([
    [/SELECT name.*FROM biomes WHERE id/i, () => ({ rows: [{ name: 'Meadow' }] })],
    [/FROM worlds WHERE biomes/i, () => ({ rows: [{ id: 'w1', name: 'Entry' }] })],
  ]);
  __setPool(pool);
  const res = await request(app).delete('/api/biomes/1').set(ADMIN_HEADERS);
  assert.equal(res.status, 409);
});

test('DELETE /api/biomes/:id succeeds when unreferenced', async () => {
  __setPool(mockPool([
    [/SELECT name.*FROM biomes WHERE id/i, () => ({ rows: [{ name: 'Meadow' }] })],
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

test('renaming a tile type succeeds when nothing references it', async () => {
  // Pins the guard's condition itself, the same way as the biome-guard happy
  // path above: a genuine rename (oldName !== name) with EMPTY reference
  // rows must return 200. Every other test that renames a tile type expects
  // 409, so without this one, a mutated guard that always 409s on any rename
  // is indistinguishable from the correct guard.
  __setPool(mockPool([
    [/SELECT name FROM tile_types WHERE id/i, () => ({ rows: [{ name: 'grass' }] })],
    [/FROM entity_types WHERE spawn_tiles/i, () => ({ rows: [] })],
    [/FROM biomes WHERE terrain_tiles/i, () => ({ rows: [] })],
    [/UPDATE tile_types/i, () => ({ rows: [{ id: 1, name: 'lawn' }] })],
  ]));
  const res = await request(app).put('/api/tile-types/1').set(ADMIN_HEADERS).send({ name: 'lawn', color: '#0f0' });
  assert.equal(res.status, 200);
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
  // silently clear a world's biome set and regenerate its terrain. Fixture
  // uses a non-null stored biome_cell (32, not the ambiguous default null) so
  // the biome_cell half of the omitted-field guard is actually pinned too --
  // with biome_cell left null in the fixture, a regression that defaults the
  // omitted case straight to null is indistinguishable from correct behavior.
  const pool = mockPool([
    [/SELECT id, width, height, biomes, biome_cell FROM worlds WHERE id/i,
      () => ({ rows: [{ id: 'w1', width: 30, height: 30, biomes: ['Meadow'], biome_cell: 32 }] })],
    // is_entry: true issues an extra `UPDATE worlds SET is_entry = false ...`
    // before the main update, which also matches /UPDATE worlds SET/i -- give
    // it its own earlier handler so the main-update handler below only sees
    // the actual UPDATE we care about.
    [/UPDATE worlds SET is_entry = false/i, () => ({ rows: [] })],
    // biomes is $8 in the UPDATE below -> params[7]; biome_cell is $9 -> params[8].
    [/UPDATE worlds SET name/i, (params) => {
      assert.equal(params[7], JSON.stringify(['Meadow']), 'an omitted biomes field must preserve the stored set');
      assert.equal(params[8], 32, 'an omitted biome_cell field must preserve the stored value');
      return { rows: [{ id: 'w1' }] };
    }],
  ]);
  __setPool(pool);
  const res = await request(app).put('/api/worlds/w1').set(ADMIN_HEADERS).send({ name: 'Entry', is_entry: true });
  assert.equal(res.status, 200);
  assert.ok(!pool.calls.some((c) => /DELETE FROM world_chunks/i.test(c.sql)));
});

// worldPreviewCache and the overview cache are in-memory Maps, invisible to
// pool.calls -- a test that only checks for `DELETE FROM world_chunks` can't
// tell whether the OTHER two cache clears in that same branch got dropped.
// Exercise the real GET /preview route before and after the PUT and count how
// many times it actually hits the DB: if the cache wasn't busted, the second
// GET reuses the stale entry and the world query count doesn't move.
const PREVIEW_TILE_ROWS = { rows: [
  { name: 'grass', color: '#3a3', walkable: true, speed: 1 },
  { name: 'water', color: '#36f', walkable: false, speed: 1 },
] };

test("PUT /api/worlds/:id changing the biome set busts the preview cache too", async () => {
  let worldSelectCount = 0;
  const pool = mockPool([
    [/SELECT id, width, height, biomes, biome_cell FROM worlds WHERE id/i,
      () => ({ rows: [{ id: 'wPrev', width: 30, height: 30, biomes: [], biome_cell: null }] })],
    [/DELETE FROM world_chunks/i, () => ({ rows: [] })],
    [/UPDATE worlds SET/i, () => ({ rows: [{ id: 'wPrev', name: 'Entry', biomes: ['Meadow'] }] })],
    // GET /preview's own pipeline (mirrors tests/worldPreviewRoute.test.js).
    // biomes: [] on this row keeps loadBiomes from firing a THIRD query shape.
    [/SELECT \* FROM worlds WHERE id/i, () => {
      worldSelectCount += 1;
      return { rows: [{ id: 'wPrev', seed: '7', chunk_size: 64, biomes: [] }] };
    }],
    [/FROM tile_types/i, () => PREVIEW_TILE_ROWS],
    [/FROM map_links/i, () => ({ rows: [] })],
    [/FROM villages WHERE world_id/i, () => ({ rows: [] })],
  ]);
  __setPool(pool);

  const first = await request(app).get('/api/worlds/wPrev/preview');
  assert.equal(first.status, 200);
  assert.equal(worldSelectCount, 1, 'sanity: the first GET must populate the preview cache from the DB');

  const put = await request(app).put('/api/worlds/wPrev').set(ADMIN_HEADERS).send({
    name: 'Entry', biomes: ['Meadow'],
  });
  assert.equal(put.status, 200);

  const second = await request(app).get('/api/worlds/wPrev/preview');
  assert.equal(second.status, 200);
  assert.equal(worldSelectCount, 2,
    'a biome-set change must bust the preview cache, not just world_chunks -- ' +
    'otherwise /preview keeps serving pre-change terrain after the game switches to post-change terrain');
});
