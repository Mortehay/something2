const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
// SOMET-559: this route is behind playerGuard now. helpers/auth.js MUST be
// required before ../src/index.js -- it sets JWT_SECRET before the guards read it.
const { playerToken, isUserLookup, userRowFor } = require('./helpers/auth.js');
const { app, __setPool } = require('../src/index.js');

// A plain PLAYER token, not an admin one: the real caller here is the game
// client, and using a player identity means these tests would catch the route
// being tightened to adminGuard by mistake.
const AUTH = ['Authorization', `Bearer ${playerToken()}`];

const { generateChunk, generateChunkDecorations } = require('../src/services/mapService');
const { buildWorldGenConfig } = require('../src/services/worldGenConfig');

function mockPool(handlers) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      // Answered ahead of calls.push so the guard's user lookup never lands
      // in `calls` -- these tests count queries.
      if (isUserLookup(sql)) return userRowFor(params);
      calls.push({ sql, params });
      for (const [re, fn] of handlers) if (re.test(sql)) return fn(params);
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

// A small bounded world with one terrain and a dense, always-blocking
// decoration def, matching the fixture shape used by
// tests/mapService_decorations.test.js so placement is easy to reproduce
// independently in this test.
const WORLD_ROW = {
  id: 'w1', seed: '12345', chunk_size: 8, width: 8, height: 8, entry_spawn: null,
  biomes: [],
};
const TILE_ROWS = { rows: [{ id: 1, name: 'grass', color: '#3a3', walkable: true, speed: 1 }] };
const DECORATION_DEF = { name: 'Tree', walkable: false, spawn_tiles: ['grass'], chance: 1 };
const ENTITY_TYPE_ROWS = { rows: [DECORATION_DEF] };

function poolFor({ world = WORLD_ROW, cached = null } = {}) {
  return mockPool([
    [/FROM world_chunks WHERE world_id/i, () => ({ rows: cached ? [{ data: cached }] : [] })],
    [/FROM worlds WHERE id/i, () => ({ rows: world ? [world] : [] })],
    [/FROM tile_types/i, () => TILE_ROWS],
    [/FROM entity_types/i, () => ENTITY_TYPE_ROWS],
    [/FROM map_links/i, () => ({ rows: [] })],
    [/FROM villages v\b[\s\S]*WHERE v\.world_id/i, () => ({ rows: [] })],
  ]);
}

// The worldCfg the handler is expected to build. Uses the same builder the
// handler calls (services/worldGenConfig.js) instead of a second hand-written
// literal, so this test compares against the real construction path rather
// than a copy that can drift from it.
function expectedWorldCfg(world = WORLD_ROW) {
  return buildWorldGenConfig({
    row: world, tileTypes: { grass: { walkable: true, speed: 1 } },
    doorways: [], villages: [], biomes: [],
  });
}

test('GET /chunk (cache miss) returns decorations matching generateChunkDecorations', async () => {
  __setPool(poolFor());
  const res = await request(app).get('/api/worlds/w1/chunk?cx=0&cy=0').set(...AUTH);
  assert.equal(res.status, 200);

  const cfg = expectedWorldCfg();
  const expectedData = generateChunk(cfg, 0, 0);
  const expectedDecorations = generateChunkDecorations(cfg, 0, 0, expectedData, [DECORATION_DEF]);

  assert.deepEqual(res.body.data, expectedData);
  assert.deepEqual(res.body.decorations, expectedDecorations);
  assert.ok(expectedDecorations.length > 0, 'fixture should place at least one decoration');
  for (const d of res.body.decorations) {
    assert.deepEqual(Object.keys(d).sort(), ['blocking', 'col', 'name', 'row']);
    assert.equal(d.name, 'Tree');
    assert.equal(d.blocking, true);
  }
});

test('GET /chunk (cache hit) also returns decorations, computed over the cached grid', async () => {
  const cfg = expectedWorldCfg();
  const cachedData = generateChunk(cfg, 0, 0);
  const pool = poolFor({ cached: cachedData });
  __setPool(pool);

  const res = await request(app).get('/api/worlds/w1/chunk?cx=0&cy=0').set(...AUTH);
  assert.equal(res.status, 200);

  const expectedDecorations = generateChunkDecorations(cfg, 0, 0, cachedData, [DECORATION_DEF]);
  assert.deepEqual(res.body.data, cachedData);
  assert.deepEqual(res.body.decorations, expectedDecorations);
  assert.ok(expectedDecorations.length > 0, 'fixture should place at least one decoration');

  assert.ok(
    pool.calls.some((c) => /FROM entity_types/i.test(c.sql)),
    'a cache hit must still load decoration defs so it can return decorations',
  );
});

test('GET /chunk includes entry_spawn in the world config so spawn exclusion matches the authority', async () => {
  // Spawn at world px (250,250) -> tile (2,2), inside chunk (0,0) for an 8x8
  // chunk. With a chance:1 blocking def, the spawn tile and its Chebyshev-1
  // neighborhood must never get a blocking decoration.
  const world = { ...WORLD_ROW, entry_spawn: { x: 250, y: 250 } };
  __setPool(poolFor({ world }));

  const res = await request(app).get('/api/worlds/w1/chunk?cx=0&cy=0').set(...AUTH);
  assert.equal(res.status, 200);

  for (const d of res.body.decorations) {
    const cheb = Math.max(Math.abs(d.row - 2), Math.abs(d.col - 2));
    assert.ok(!(d.blocking && cheb <= 1), `blocking deco too close to spawn at (${d.row},${d.col})`);
  }
});

test('GET /chunk 404s for an unknown world', async () => {
  __setPool(poolFor({ world: null }));
  const res = await request(app).get('/api/worlds/nope/chunk?cx=0&cy=0').set(...AUTH);
  assert.equal(res.status, 404);
});

// --- SOMET-559: the route is behind playerGuard ---------------------------
// The auth_protection suite proves a guard is present in the router stack;
// these prove the running server actually refuses, and actually serves. Both
// halves matter: a guard that rejects everyone would pass a "is it guarded?"
// check while breaking terrain streaming for every player.

test('GET /chunk without a token is 401, and returns no terrain', async () => {
  __setPool(poolFor());
  const res = await request(app).get('/api/worlds/w1/chunk?cx=0&cy=0');
  assert.equal(res.status, 401);
  assert.equal(res.body.data, undefined, 'a rejected request must not leak the tile grid');
  assert.equal(res.body.decorations, undefined);
});

test('GET /chunk admits a plain player, not just an admin', async () => {
  // The whole point of playerGuard here. If this route is ever tightened to
  // adminGuard, every non-admin stops being able to load the map and this
  // fails with 403 rather than silently shipping.
  __setPool(poolFor());
  const res = await request(app).get('/api/worlds/w1/chunk?cx=0&cy=0').set(...AUTH);
  assert.equal(res.status, 200, `a player token must be accepted, got ${res.status}`);
  assert.ok(Array.isArray(res.body.data), 'the player must actually receive the tile grid');
});

test('GET /chunk rejects a token whose token_version is stale (revocation is live)', async () => {
  // The guard's DB lookup exists to make revocation real -- a signature-only
  // check would accept this token forever. Bumping the stored version is what
  // logout-everywhere and a password change do.
  // A RAW pool, not mockPool(): mockPool answers the guard's lookup itself with
  // a current-version row, which would authenticate this token and make the
  // test vacuous (it 500'd on the un-stubbed follow-up queries instead of
  // 401'ing, which is how that was caught).
  __setPool({
    query: async (sql) => {
      if (isUserLookup(sql)) return { rows: [{ token_version: 99, role: 'player' }] };
      throw new Error(`request should have been rejected before querying: ${sql}`);
    },
  });
  const res = await request(app).get('/api/worlds/w1/chunk?cx=0&cy=0').set(...AUTH);
  assert.equal(res.status, 401);
});
