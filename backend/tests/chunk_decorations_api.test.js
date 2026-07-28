const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { app, __setPool } = require('../src/index.js');
const { generateChunk, generateChunkDecorations } = require('../src/services/mapService');

function mockPool(handlers) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
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
    [/FROM villages WHERE world_id/i, () => ({ rows: [] })],
  ]);
}

// The worldCfg the handler is expected to build, mirroring authority/server.js's
// ServerMap config (seed, chunkSize, tileTypes, width, height, doorways,
// villages, entry_spawn) closely enough that generateChunk/generateChunkDecorations
// reproduce the exact same output the endpoint should return.
function expectedWorldCfg(world = WORLD_ROW) {
  return {
    seed: Number(world.seed), chunkSize: world.chunk_size,
    tileTypes: { grass: { walkable: true, speed: 1 } },
    width: world.width, height: world.height,
    doorways: [], villages: [], entry_spawn: world.entry_spawn,
  };
}

test('GET /chunk (cache miss) returns decorations matching generateChunkDecorations', async () => {
  __setPool(poolFor());
  const res = await request(app).get('/api/worlds/w1/chunk?cx=0&cy=0');
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

  const res = await request(app).get('/api/worlds/w1/chunk?cx=0&cy=0');
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

  const res = await request(app).get('/api/worlds/w1/chunk?cx=0&cy=0');
  assert.equal(res.status, 200);

  for (const d of res.body.decorations) {
    const cheb = Math.max(Math.abs(d.row - 2), Math.abs(d.col - 2));
    assert.ok(!(d.blocking && cheb <= 1), `blocking deco too close to spawn at (${d.row},${d.col})`);
  }
});

test('GET /chunk 404s for an unknown world', async () => {
  __setPool(poolFor({ world: null }));
  const res = await request(app).get('/api/worlds/nope/chunk?cx=0&cy=0');
  assert.equal(res.status, 404);
});
