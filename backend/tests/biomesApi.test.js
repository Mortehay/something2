const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
// helpers/auth.js MUST be required before ../src/index.js — it sets JWT_SECRET
// before the guards read it.
const { authHeaders, isUserLookup, ADMIN_USER_ROW } = require('./helpers/auth.js');
const { app, __setPool, __setAuthorityHandle } = require('../src/index.js');

const ADMIN_HEADERS = authHeaders();

// Always leave the module-level authorityHandle clean for every other test in
// this process, mirroring tests/worldsAdminRoutes.test.js.
test.afterEach(() => { __setAuthorityHandle(null); });

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
    // flora_types/creature_types included and matching BIOME's so this test
    // stays scoped to the rename guard: no decoration change means no second
    // worldsReferencingBiome lookup or evictOrWarn call to account for.
    [/SELECT name.*FROM biomes WHERE id/i, () => ({
      rows: [{ name: 'Meadow', terrain_tiles: ['grass'], flora_types: ['bush'], creature_types: ['Slime'] }],
    })],
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
  // separate bug. terrain_tiles/flora_types/creature_types in the cur-select
  // fixture all match what's sent below, so neither terrainChanged nor
  // decorationChanged should fire. No /FROM worlds WHERE biomes/i handler is
  // registered below on purpose: if the route mistakenly looked up
  // referencing worlds anyway, the mock's throw-on-unexpected-query guard
  // would turn that into a 500.
  const pool = mockPool([
    [/SELECT name.*FROM biomes WHERE id/i, () => ({
      rows: [{ name: 'Meadow', terrain_tiles: ['grass'], flora_types: ['bush'], creature_types: ['Slime'] }],
    })],
    [/UPDATE biomes SET/i, () => ({ rows: [{ ...BIOME, color: '#123456' }] })],
  ]);
  __setPool(pool);
  const res = await request(app).put('/api/biomes/1').set(ADMIN_HEADERS)
    .send({ ...BIOME, terrain_tiles: ['grass'], color: '#123456' });
  assert.equal(res.status, 200);
  assert.ok(!pool.calls.some((c) => /DELETE FROM world_chunks/i.test(c.sql)));
  assert.equal(res.body.liveWarning, undefined, 'a cosmetic-only edit must not surface a live-world warning either');
});

test('PUT /api/biomes/:id surfaces a liveWarning when terrain_tiles changes on a world with a connected player', async () => {
  // invalidateWorld() returns evictOrWarn()'s string; every other caller in
  // this file surfaces it (F-017/SOMET-197). Dropping it here would mean the
  // DB write (and the chunk wipe) happened but the admin got a bare 200 with
  // no indication the live simulation is still serving pre-edit terrain.
  const pool = mockPool([
    [/SELECT name.*FROM biomes WHERE id/i, () => ({ rows: [{ name: 'Meadow', terrain_tiles: ['grass'] }] })],
    [/UPDATE biomes SET/i, () => ({ rows: [{ ...BIOME, terrain_tiles: ['sand'] }] })],
    [/FROM worlds WHERE biomes/i, () => ({ rows: [{ id: 'w1', name: 'Entry' }] })],
    [/DELETE FROM world_chunks/i, () => ({ rows: [] })],
  ]);
  __setPool(pool);
  __setAuthorityHandle({ evictWorld: () => false, isWorldLive: () => true });
  const res = await request(app).put('/api/biomes/1').set(ADMIN_HEADERS).send({ ...BIOME, terrain_tiles: ['sand'] });
  assert.equal(res.status, 200, 'the DB write still succeeds -- only the live simulation is stale');
  assert.match(res.body.liveWarning, /connected/i,
    'the response must say the change did not reach the live world, not silently claim success');
});

test('PUT /api/biomes/:id evicts an idle referencing world when only flora_types/creature_types change', async () => {
  // flora_types/creature_types are never persisted, so an idle world doesn't
  // need world_chunks wiped -- it just needs to be evicted from the
  // authority's in-memory registry so its NEXT load re-resolves biomes,
  // instead of a live session silently keeping its activation-era config
  // forever (see the decorationChanged comment in the route for why that
  // config goes stale: loadWorld() resolves loadBiomes() once and bakes it
  // into ServerMap; blockedDecorationsFor() memoizes per chunk off that same
  // frozen config, not off a re-resolution).
  const evicted = [];
  const pool = mockPool([
    [/SELECT name.*FROM biomes WHERE id/i, () => ({
      rows: [{ name: 'Meadow', terrain_tiles: ['grass'], flora_types: ['bush'], creature_types: ['Slime'] }],
    })],
    [/UPDATE biomes SET/i, () => ({ rows: [{ ...BIOME, flora_types: ['pine_tree'] }] })],
    [/FROM worlds WHERE biomes/i, () => ({ rows: [{ id: 'w1', name: 'Entry' }] })],
  ]);
  __setPool(pool);
  __setAuthorityHandle({ evictWorld: (id) => { evicted.push(id); return true; }, isWorldLive: () => false });
  const res = await request(app).put('/api/biomes/1').set(ADMIN_HEADERS)
    .send({ ...BIOME, flora_types: ['pine_tree'] });
  assert.equal(res.status, 200);
  assert.deepEqual(evicted, ['w1'], 'a flora_types change must evict every referencing world, not just terrain_tiles');
  assert.ok(!pool.calls.some((c) => /DELETE FROM world_chunks/i.test(c.sql)),
    'flora_types/creature_types are never persisted, so no chunk wipe is needed -- only eviction');
  assert.equal(res.body.liveWarning, undefined, 'eviction succeeded, so there is nothing to warn about');
});

test('PUT /api/biomes/:id warns (without wiping chunks) when creature_types changes on a connected world', async () => {
  const pool = mockPool([
    [/SELECT name.*FROM biomes WHERE id/i, () => ({
      rows: [{ name: 'Meadow', terrain_tiles: ['grass'], flora_types: ['bush'], creature_types: ['Slime'] }],
    })],
    [/UPDATE biomes SET/i, () => ({ rows: [{ ...BIOME, creature_types: ['Wolf'] }] })],
    [/FROM worlds WHERE biomes/i, () => ({ rows: [{ id: 'w1', name: 'Entry' }] })],
  ]);
  __setPool(pool);
  __setAuthorityHandle({ evictWorld: () => false, isWorldLive: () => true });
  const res = await request(app).put('/api/biomes/1').set(ADMIN_HEADERS).send({ ...BIOME, creature_types: ['Wolf'] });
  assert.equal(res.status, 200);
  assert.match(res.body.liveWarning, /connected/i);
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

test('PUT /api/worlds/:id changing the biome set surfaces a liveWarning for a connected world', async () => {
  // Mirrors tests/worldsAdminRoutes.test.js's creature-reroll liveWarning
  // test. The biomesChanged disjunct feeding evictOrWarn(id) here has no
  // other test able to see it -- dropping it (mutation M8) still passes
  // every OTHER test in this suite, since none of them set an authority
  // handle.
  const pool = mockPool([
    [/SELECT id, width, height, biomes, biome_cell FROM worlds WHERE id/i,
      () => ({ rows: [{ id: 'w1', width: 30, height: 30, biomes: [], biome_cell: null }] })],
    [/DELETE FROM world_chunks/i, () => ({ rows: [] })],
    [/UPDATE worlds SET/i, () => ({ rows: [{ id: 'w1', name: 'Entry', biomes: ['Meadow'] }] })],
  ]);
  __setPool(pool);
  __setAuthorityHandle({ evictWorld: () => false, isWorldLive: () => true });
  const res = await request(app).put('/api/worlds/w1').set(ADMIN_HEADERS).send({
    name: 'Entry', biomes: ['Meadow'],
  });
  assert.equal(res.status, 200, 'the DB write still succeeds -- only the live simulation is stale');
  assert.match(res.body.liveWarning, /connected/i,
    'a biome-set change on a world with a connected player must warn, exactly like a bounds change does');
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
    // is_entry: true issues an extra single-entry-world UPDATE, which also
    // matches /UPDATE worlds SET/i -- give it its own earlier handler so the
    // main-update handler below only sees the actual UPDATE we care about.
    // It now runs AFTER the main update and is one atomic statement
    // (services/entryWorld.js); it used to be a bare
    // `UPDATE worlds SET is_entry = false` BEFORE it, which could leave the
    // game with zero entry worlds. Unanswered, it throws and the route 500s.
    [/UPDATE worlds SET is_entry = \(id = \$1\)/i, () => ({ rows: [], rowCount: 1 })],
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
