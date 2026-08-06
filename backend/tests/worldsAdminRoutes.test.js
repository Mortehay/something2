const test = require('node:test');
const assert = require('node:assert');
const { adminToken, isUserLookup, ADMIN_USER_ROW } = require('./helpers/auth.js');
const request = require('supertest');
const { app, __setPool, __setAuthorityHandle } = require('../src/index.js');

// Always leave the module-level authorityHandle clean for every OTHER test in
// this process (node:test runs a file's tests sequentially by default, but
// nothing enforces that a later test file wouldn't also see a handle a prior
// test forgot to clear).
test.afterEach(() => { __setAuthorityHandle(null); });

const AUTH = ['Authorization', `Bearer ${adminToken()}`];

// F-007 (SOMET-187) wraps village create/delete and the creature re-roll in a
// real transaction via pool.connect(), so this mock needs a connect() that
// hands back a client dispatching through the same handlers -- and BEGIN/
// COMMIT/ROLLBACK are answered directly rather than requiring every test to
// register a handler for them.
function mockPool(handlers) {
  const calls = [];
  const dispatch = async (sql, params) => {
    if (isUserLookup(sql)) return ADMIN_USER_ROW;
    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql.trim())) return { rows: [] };
    calls.push({ sql, params });
    for (const [re, fn] of handlers) {
      if (re.test(sql)) return fn(params);
    }
    throw new Error(`unexpected query: ${sql}`);
  };
  return {
    calls,
    query: dispatch,
    connect: async () => ({ query: dispatch, release: () => {} }),
  };
}

test('PUT /api/worlds/:id requires a non-empty name', async () => {
  __setPool(mockPool([]));
  const res = await request(app).put('/api/worlds/w1').set(...AUTH).send({ name: '   ' });
  assert.equal(res.status, 400);
});

test('PUT /api/worlds/:id rejects width without height', async () => {
  __setPool(mockPool([]));
  const res = await request(app).put('/api/worlds/w1').set(...AUTH)
    .send({ name: 'A', width: 24, height: null });
  assert.equal(res.status, 400);
});

test('PUT /api/worlds/:id rejects out-of-range bounds', async () => {
  __setPool(mockPool([]));
  const res = await request(app).put('/api/worlds/w1').set(...AUTH)
    .send({ name: 'A', width: 4, height: 4 });
  assert.equal(res.status, 400);
});

test('PUT /api/worlds/:id updates and returns the row', async () => {
  const pool = mockPool([
    // current row (to detect bounds change)
    [/SELECT .* FROM worlds WHERE id/i, () => ({ rows: [{ id: 'w1', width: 24, height: 24 }] })],
    [/UPDATE worlds SET/i, (p) => ({ rows: [{ id: 'w1', name: p[0] }] })],
  ]);
  __setPool(pool);
  const res = await request(app).put('/api/worlds/w1').set(...AUTH)
    .send({ name: 'Renamed', width: 24, height: 24, creature_count: 5, allowed_creature_types: ['goblin'] });
  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'Renamed');
});

// F-044 (SOMET-224): renaming a world into collision with another world's
// name must surface the same clean 409 POST /api/worlds now does, not the
// generic 500 catch-all a raw Postgres unique_violation would produce.
test('PUT /api/worlds/:id returns 409 on a rename that collides with another world', async () => {
  const pool = mockPool([
    [/SELECT .* FROM worlds WHERE id/i, () => ({ rows: [{ id: 'w1', width: 24, height: 24 }] })],
    [/UPDATE worlds SET/i, () => {
      const err = new Error('duplicate key value violates unique constraint "worlds_name_unique"');
      err.code = '23505';
      throw err;
    }],
  ]);
  __setPool(pool);
  const res = await request(app).put('/api/worlds/w1').set(...AUTH)
    .send({ name: 'AlreadyTaken', width: 24, height: 24 });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /already exists/i);
});

// F-008 (SOMET-188): creature_count had no server-side upper bound. The
// re-roll route (POST /api/worlds/:id/creatures) issues one generateRegion()
// call and one INSERT round-trip per placement attempt, so an admin-supplied
// count in the hundreds of thousands ties up the request and a pool
// connection indefinitely. MapsAdmin's Creatures field is a plain
// <input type="number"> with no max, so this cap has to live server-side.
test('PUT /api/worlds/:id rejects a creature_count above the cap', async () => {
  __setPool(mockPool([
    [/SELECT .* FROM worlds WHERE id/i, () => ({ rows: [{ id: 'w1', width: 24, height: 24 }] })],
  ]));
  const res = await request(app).put('/api/worlds/w1').set(...AUTH)
    .send({ name: 'Big', width: 24, height: 24, creature_count: 200000 });
  assert.equal(res.status, 400);
});

test('PUT /api/worlds/:id accepts a creature_count at the cap', async () => {
  const pool = mockPool([
    [/SELECT .* FROM worlds WHERE id/i, () => ({ rows: [{ id: 'w1', width: 24, height: 24 }] })],
    [/UPDATE worlds SET/i, (p) => ({ rows: [{ id: 'w1', name: p[0], creature_count: p[3] }] })],
  ]);
  __setPool(pool);
  const res = await request(app).put('/api/worlds/w1').set(...AUTH)
    .send({ name: 'AtCap', width: 24, height: 24, creature_count: 2000 });
  assert.equal(res.status, 200);
  assert.equal(res.body.creature_count, 2000);
});

test('PUT /api/worlds/:id 404 when the row is absent', async () => {
  __setPool(mockPool([
    [/SELECT .* FROM worlds WHERE id/i, () => ({ rows: [] })],
  ]));
  const res = await request(app).put('/api/worlds/nope').set(...AUTH).send({ name: 'X' });
  assert.equal(res.status, 404);
});

// F-004 (SOMET-184): PUT /api/worlds/:id stored entry_spawn without checking
// it lands inside the world bounds. chooseSpawn() only checks Number.isFinite,
// so an out-of-range entry_spawn puts every first-time joiner inside the solid
// wall ring stamped by stampBounds() -- confirmed live: entry_spawn
// {x:99999,y:99999} on a 24x24 world saved with 200, and a fresh joiner spawned
// there and never moved across 50 subsequent state frames.
test('PUT /api/worlds/:id rejects an entry_spawn far outside a bounded world', async () => {
  __setPool(mockPool([
    [/SELECT .* FROM worlds WHERE id/i, () => ({ rows: [{ id: 'w1', width: 24, height: 24 }] })],
  ]));
  const res = await request(app).put('/api/worlds/w1').set(...AUTH)
    .send({ name: 'Entry', width: 24, height: 24, is_entry: true, entry_spawn: { x: 99999, y: 99999 } });
  assert.equal(res.status, 400);
});

test('PUT /api/worlds/:id rejects an entry_spawn landing in the wall ring', async () => {
  __setPool(mockPool([
    [/SELECT .* FROM worlds WHERE id/i, () => ({ rows: [{ id: 'w1', width: 24, height: 24 }] })],
  ]));
  // (0,0) is tile (0,0) -- the outer wall ring stampBounds() always solidifies.
  const res = await request(app).put('/api/worlds/w1').set(...AUTH)
    .send({ name: 'Entry', width: 24, height: 24, is_entry: true, entry_spawn: { x: 0, y: 0 } });
  assert.equal(res.status, 400);
});

test('PUT /api/worlds/:id accepts an entry_spawn inside the interior', async () => {
  const pool = mockPool([
    [/SELECT .* FROM worlds WHERE id/i, () => ({ rows: [{ id: 'w1', width: 24, height: 24 }] })],
    [/UPDATE worlds SET/i, (p) => ({ rows: [{ id: 'w1', name: p[0] }] })],
  ]);
  __setPool(pool);
  const res = await request(app).put('/api/worlds/w1').set(...AUTH)
    .send({ name: 'Entry', width: 24, height: 24, is_entry: true, entry_spawn: { x: 1200, y: 1200 } });
  assert.equal(res.status, 200);
});

test('PUT /api/worlds/:id ignores entry_spawn bounds when the world is unbounded', async () => {
  const pool = mockPool([
    [/SELECT .* FROM worlds WHERE id/i, () => ({ rows: [{ id: 'w1', width: null, height: null }] })],
    [/UPDATE worlds SET/i, (p) => ({ rows: [{ id: 'w1', name: p[0] }] })],
  ]);
  __setPool(pool);
  const res = await request(app).put('/api/worlds/w1').set(...AUTH)
    .send({ name: 'Entry', is_entry: true, entry_spawn: { x: 99999, y: 99999 } });
  assert.equal(res.status, 200);
});

test('PUT /api/worlds/:id with is_entry clears the previous entry first', async () => {
  const pool = mockPool([
    [/SELECT .* FROM worlds WHERE id/i, () => ({ rows: [{ id: 'w1', width: 24, height: 24 }] })],
    [/UPDATE worlds SET is_entry = false/i, () => ({ rows: [], rowCount: 1 })],
    [/UPDATE worlds SET/i, (p) => ({ rows: [{ id: 'w1', name: p[0], is_entry: true }] })],
  ]);
  __setPool(pool);
  const res = await request(app).put('/api/worlds/w1').set(...AUTH)
    .send({ name: 'Entry', is_entry: true, entry_spawn: { x: 1200, y: 1200 } });
  assert.equal(res.status, 200);
  const clearedFirst = pool.calls.some(c => /UPDATE worlds SET is_entry = false/i.test(c.sql));
  assert.ok(clearedFirst, 'previous entry cleared');
});

test('PUT /api/worlds/:id deletes chunks + clears cache when bounds change', async () => {
  const pool = mockPool([
    [/SELECT .* FROM worlds WHERE id/i, () => ({ rows: [{ id: 'w1', width: 24, height: 24 }] })],
    [/DELETE FROM world_chunks WHERE world_id/i, () => ({ rows: [], rowCount: 3 })],
    [/UPDATE world_players SET/i, () => ({ rows: [], rowCount: 0 })],
    [/UPDATE worlds SET/i, (p) => ({ rows: [{ id: 'w1', name: p[0] }] })],
  ]);
  __setPool(pool);
  const res = await request(app).put('/api/worlds/w1').set(...AUTH)
    .send({ name: 'Bigger', width: 32, height: 32 });
  assert.equal(res.status, 200);
  const deleted = pool.calls.some(c => /DELETE FROM world_chunks WHERE world_id/i.test(c.sql));
  assert.ok(deleted, 'chunks invalidated on bounds change');
});

// F-049 (SOMET-229): shrinking a bounded world's ring can strand an already-
// persisted world_players row outside the new walkable interior -- same
// symptom class as F-004/SOMET-184 (entry_spawn), but for existing players
// rather than a fresh join. chooseSpawn() hands a persisted position straight
// to the client with only a Number.isFinite check, so a stranded player loads
// inside (or beyond) the new wall ring and cannot move.
test('PUT /api/worlds/:id clamps persisted world_players into the new bounds when shrinking', async () => {
  const pool = mockPool([
    [/SELECT .* FROM worlds WHERE id/i, () => ({ rows: [{ id: 'w1', width: 300, height: 300 }] })],
    [/DELETE FROM world_chunks WHERE world_id/i, () => ({ rows: [], rowCount: 3 })],
    [/UPDATE world_players SET/i, (p) => ({ rows: [], rowCount: 1 })],
    [/UPDATE worlds SET/i, (p) => ({ rows: [{ id: 'w1', name: p[0] }] })],
  ]);
  __setPool(pool);
  const res = await request(app).put('/api/worlds/w1').set(...AUTH)
    .send({ name: 'Shrunk', width: 100, height: 100 });
  assert.equal(res.status, 200);
  const clamp = pool.calls.find(c => /UPDATE world_players SET/i.test(c.sql));
  assert.ok(clamp, 'world_players must be clamped into the new bounds on a shrink');
  assert.equal(clamp.params[0], 'w1');
  const [, minPx, maxX, maxY] = clamp.params;
  assert.equal(minPx, 100);           // CREATURE_TILE_PX: first walkable tile in from the wall
  assert.equal(maxX, 99 * 100 - 1);   // (nextW-1)*100 - 1, strictly clear of the east wall
  assert.equal(maxY, 99 * 100 - 1);
});

test('PUT /api/worlds/:id does not touch world_players when bounds are unchanged', async () => {
  const pool = mockPool([
    [/SELECT .* FROM worlds WHERE id/i, () => ({ rows: [{ id: 'w1', width: 24, height: 24 }] })],
    [/UPDATE worlds SET/i, (p) => ({ rows: [{ id: 'w1', name: p[0] }] })],
  ]);
  __setPool(pool);
  const res = await request(app).put('/api/worlds/w1').set(...AUTH)
    .send({ name: 'Same', width: 24, height: 24 });
  assert.equal(res.status, 200);
  assert.ok(!pool.calls.some(c => /UPDATE world_players SET/i.test(c.sql)));
});

const TILE_ROWS = [
  { id: 1, name: 'grass', color: '#0a0', walkable: true, speed: 1, image: null, valid_neighbors: [] },
  { id: 2, name: 'map_wall', color: '#2b2b2b', walkable: false, speed: 1, image: null, valid_neighbors: [] },
  { id: 3, name: 'map_doorway', color: '#6b4f2a', walkable: true, speed: 1, image: null, valid_neighbors: [] },
];

test('POST /api/worlds/:id/regenerate reseeds and clears chunks+creatures', async () => {
  const pool = mockPool([
    [/SELECT .* FROM worlds WHERE id/i, () => ({ rows: [{ id: 'w1', seed: '42' }] })],
    [/DELETE FROM world_chunks WHERE world_id/i, () => ({ rows: [], rowCount: 2 })],
    [/DELETE FROM world_creatures WHERE world_id/i, () => ({ rows: [], rowCount: 5 })],
    [/FROM villages WHERE world_id/i, () => ({ rows: [] })],
    [/INSERT INTO world_creatures/i, () => ({ rows: [] })],
    [/UPDATE worlds SET seed/i, (p) => ({ rows: [{ id: 'w1', seed: String(p[0]) }] })],
  ]);
  __setPool(pool);
  const res = await request(app).post('/api/worlds/w1/regenerate').set(...AUTH).send({});
  assert.equal(res.status, 200);
  const deletedChunks = pool.calls.some(c => /DELETE FROM world_chunks/i.test(c.sql));
  const deletedCreatures = pool.calls.some(c => /DELETE FROM world_creatures/i.test(c.sql));
  assert.ok(deletedChunks && deletedCreatures);
});

test('POST /api/worlds/:id/regenerate re-derives guards for surviving villages', async () => {
  const pool = mockPool([
    [/SELECT .* FROM worlds WHERE id/i, () => ({ rows: [{ id: 'w1', seed: '42' }] })],
    [/DELETE FROM world_chunks WHERE world_id/i, () => ({ rows: [], rowCount: 2 })],
    [/DELETE FROM world_creatures WHERE world_id/i, () => ({ rows: [], rowCount: 5 })],
    // Villages survive a regenerate (separate table) — the wipe above has no
    // village_id to spare guards by, so they must be re-inserted afterward.
    [/FROM villages WHERE world_id/i, () => ({ rows: [{
      id: 'v1', min_row: 5, min_col: 5, width: 8, height: 6, gate_edge: 'S', spawn_x: 650, spawn_y: 750,
    }] })],
    [/INSERT INTO world_creatures/i, () => ({ rows: [] })],
    [/UPDATE worlds SET seed/i, (p) => ({ rows: [{ id: 'w1', seed: String(p[0]) }] })],
  ]);
  __setPool(pool);
  const res = await request(app).post('/api/worlds/w1/regenerate').set(...AUTH).send({});
  assert.equal(res.status, 200);
  const guardInserts = pool.calls.filter((c) => /INSERT INTO world_creatures/i.test(c.sql)
    && c.params.includes('Village Guard'));
  assert.equal(guardInserts.length, 2, 'regenerate must restore exactly two guards for the surviving village');
});

test('POST /api/worlds/:id/regenerate 404 when absent', async () => {
  __setPool(mockPool([
    [/SELECT .* FROM worlds WHERE id/i, () => ({ rows: [] })],
  ]));
  const res = await request(app).post('/api/worlds/nope/regenerate').set(...AUTH).send({});
  assert.equal(res.status, 404);
});

test('POST /api/worlds/:id/creatures rejects an unbounded world', async () => {
  __setPool(mockPool([
    [/SELECT .* FROM worlds WHERE id/i, () => ({ rows: [{ id: 'w1', width: null, height: null }] })],
  ]));
  const res = await request(app).post('/api/worlds/w1/creatures').set(...AUTH).send({});
  assert.equal(res.status, 400);
});

// SOMET-246 Task 7: this route now delegates to populateWorld (the same
// function seeding uses), which counts by resolveDensity(world.density,
// width, height) rather than the old worlds.creature_count literal --
// world.creature_count is no longer read for placement at all, only written
// back from what actually lands. With no density set this world resolves to
// the 'normal' tier on a 24x24 board: scatterCount = round(3 * 576 / 1000) =
// 2 (fixed), plus ONE pack sized randomly in [3, 4] (packSizeMin/Max for
// 'normal') -- so `placed` is 5 or 6 depending on the route's per-call
// Math.random() seed, never a fixed number. Assert the deterministic part
// (the range) and that placed/inserted/creature_count-write agree with each
// other, instead of pinning one arbitrary sample.
test('POST /api/worlds/:id/creatures places creatures and reports the count', async () => {
  const world = { id: 'w1', seed: '42', chunk_size: 64, width: 24, height: 24,
    allowed_creature_types: ['goblin'] };
  const inserted = [];
  let wroteCreatureCount = null;
  const pool = mockPool([
    [/SELECT .* FROM worlds WHERE id/i, () => ({ rows: [world] })],
    [/SELECT .*FROM tile_types/i, () => ({ rows: TILE_ROWS })],
    [/FROM map_links/i, () => ({ rows: [] })],
    [/FROM entity_types[\s\S]*WHERE is_creature/i, () => ({
      rows: [{ id: 1, name: 'goblin', hp: 12, defense: 1, resistances: {} }] })],
    [/FROM villages WHERE world_id/i, () => ({ rows: [] })],
    [/DELETE FROM world_creatures WHERE world_id/i, () => ({ rows: [], rowCount: 3 })],
    [/UPDATE worlds SET creature_count/i, (p) => { wroteCreatureCount = p[0]; return { rows: [], rowCount: 1 }; }],
    // populateWorld batches its inserts (SOMET-246 final review, finding 4):
    // ONE statement carries up to 200 rows of 9 bind parameters each, rather
    // than one round-trip per creature. Split the flat parameter list back
    // into rows so `inserted.length` still means "creatures written" -- a
    // future regression back to per-creature inserts keeps working here, and
    // a batch that silently dropped rows still shows up as a mismatch below.
    [/INSERT INTO world_creatures/i, (p) => {
      for (let i = 0; i < p.length; i += 9) inserted.push(p.slice(i, i + 9));
      return { rows: [], rowCount: p.length / 9 };
    }],
  ]);
  __setPool(pool);
  const res = await request(app).post('/api/worlds/w1/creatures').set(...AUTH).send({});
  assert.equal(res.status, 200);
  assert.ok(res.body.placed === 5 || res.body.placed === 6,
    `placed must be scatter(2) + one normal-tier pack(3-4), got ${res.body.placed}`);
  assert.equal(inserted.length, res.body.placed);
  // populateWorld writes creature_count from the SCATTER count only (not
  // scatter+packed) -- see worldPopulation.js's own comment on that split.
  assert.equal(wroteCreatureCount, 2);
  assert.equal(res.body.liveWarning, undefined, 'no warning when the world was not live');
});

// The re-roll builds placeMapCreatures's config inline inside a DB
// transaction; before this it hand-built a config literal that never
// resolved the world's declared biomes. A later task makes placeMapCreatures
// biome-aware (restricting which creature types spawn to the owning biome's
// creature_types); if this call site silently drops biomes, that feature
// would never activate in production even though its unit tests (which call
// placeMapCreatures directly) would still pass. Pin that the re-roll now
// resolves biomes via loadBiomes -- on the SAME transaction client, not a
// separate pool.query() -- whenever the world declares any.
// SOMET-246 Task 7: same density-driven count as the test above (`placed` is
// 5 or 6, not a fixed literal) -- see that test's comment for the full
// scatter/pack breakdown.
test('POST /api/worlds/:id/creatures threads the world\'s declared biomes into placeMapCreatures', async () => {
  const world = { id: 'w1', seed: '42', chunk_size: 64, width: 24, height: 24,
    allowed_creature_types: ['goblin'], biomes: ['Meadow'] };
  const pool = mockPool([
    [/SELECT .* FROM worlds WHERE id/i, () => ({ rows: [world] })],
    [/SELECT .*FROM tile_types/i, () => ({ rows: TILE_ROWS })],
    [/FROM map_links/i, () => ({ rows: [] })],
    [/FROM entity_types[\s\S]*WHERE is_creature/i, () => ({
      rows: [{ id: 1, name: 'goblin', hp: 12, defense: 1, resistances: {} }] })],
    [/FROM villages WHERE world_id/i, () => ({ rows: [] })],
    [/FROM biomes/i, () => ({ rows: [
      { id: 1, name: 'Meadow', terrain_tiles: ['grass'], flora_types: [], creature_types: ['goblin'],
        palette: [], art_style: '', exclusions: '', color: '#5aa84f' },
    ] })],
    [/DELETE FROM world_creatures WHERE world_id/i, () => ({ rows: [], rowCount: 3 })],
    [/UPDATE worlds SET creature_count/i, () => ({ rows: [], rowCount: 1 })],
    [/INSERT INTO world_creatures/i, () => ({ rows: [], rowCount: 1 })],
  ]);
  __setPool(pool);
  const res = await request(app).post('/api/worlds/w1/creatures').set(...AUTH).send({});
  assert.equal(res.status, 200);
  assert.ok(res.body.placed === 5 || res.body.placed === 6,
    `placement still succeeds once biomes are threaded in, got ${res.body.placed}`);
  assert.ok(
    pool.calls.some((c) => /FROM biomes/i.test(c.sql) && c.params?.[0]?.includes('Meadow')),
    'the re-roll must resolve the world\'s declared biomes via loadBiomes instead of skipping past them',
  );
});

// F-017 (SOMET-197): evictWorld refuses to evict a world with live sockets
// and returns false, and every admin caller (this route included) discarded
// that return value outright — so a re-roll against a world with a connected
// player replies 200 {"placed": N} while the live simulation keeps its OLD
// in-memory creatures. Confirmed live via the real admin route: the
// connected player kept receiving broadcast frames for ~1600-1700 creatures
// the DB no longer had, and kills against them dropped no loot/gold at all
// (commitCreatureDeath's DELETE matched nothing). This test does not
// reproduce that live consequence (that needs a real authority + socket) —
// it pins the narrower, directly-testable contract: when evictWorld refuses
// because a player is connected, the admin response must say so rather than
// silently claiming success.
test('POST /api/worlds/:id/creatures warns when a player is connected so the re-roll cannot reach the live world', async () => {
  const world = { id: 'w1', seed: '42', chunk_size: 64, width: 24, height: 24,
    allowed_creature_types: ['goblin'] };
  const pool = mockPool([
    [/SELECT .* FROM worlds WHERE id/i, () => ({ rows: [world] })],
    [/SELECT .*FROM tile_types/i, () => ({ rows: TILE_ROWS })],
    [/FROM map_links/i, () => ({ rows: [] })],
    [/FROM entity_types[\s\S]*WHERE is_creature/i, () => ({
      rows: [{ id: 1, name: 'goblin', hp: 12, defense: 1, resistances: {} }] })],
    [/FROM villages WHERE world_id/i, () => ({ rows: [] })],
    [/DELETE FROM world_creatures WHERE world_id/i, () => ({ rows: [], rowCount: 3 })],
    [/UPDATE worlds SET creature_count/i, () => ({ rows: [], rowCount: 1 })],
    [/INSERT INTO world_creatures/i, () => ({ rows: [], rowCount: 1 })],
  ]);
  __setPool(pool);
  // A fake authority handle whose evictWorld behaves exactly like the real
  // one for a world with a connected socket: refuses (false) but the entry
  // is still live.
  __setAuthorityHandle({ evictWorld: () => false, isWorldLive: () => true });

  const res = await request(app).post('/api/worlds/w1/creatures').set(...AUTH).send({});
  assert.equal(res.status, 200, 'the DB write still succeeds — only the live simulation is stale');
  // SOMET-246 Task 7: density-driven count, not the old creature_count
  // literal -- see the first creatures test's comment for the breakdown.
  assert.ok(res.body.placed === 5 || res.body.placed === 6, `got ${res.body.placed}`);
  assert.match(res.body.liveWarning, /connected/i,
    'the response must say the change did not reach the live world, not silently claim success');
});
