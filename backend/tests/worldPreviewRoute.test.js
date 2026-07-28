const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { app, __setPool } = require('../src/index.js');

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
const tileRows = { rows: [
  { name: 'grass', color: '#3a3', walkable: true, speed: 1 },
  { name: 'water', color: '#36f', walkable: false, speed: 1 },
  { name: 'path', color: '#ca8', walkable: true, speed: 1 },
] };

test('GET /preview returns a 64x64 grid for a known world', async () => {
  const pool = mockPool([
    [/FROM worlds WHERE id/i, () => ({ rows: [{ id: 'w1', seed: '7', chunk_size: 64 }] })],
    [/FROM tile_types/i, () => tileRows],
    [/FROM map_links/i, () => ({ rows: [] })],
    [/FROM villages WHERE world_id/i, () => ({ rows: [] })],
  ]);
  __setPool(pool);
  const res = await request(app).get('/api/worlds/w1/preview');
  assert.equal(res.status, 200);
  assert.equal(res.body.world_id, 'w1');
  assert.equal(res.body.data.length, 64);
  assert.ok(res.body.data.every((row) => row.length === 64));
  assert.ok(
    pool.calls.some((c) => /FROM villages WHERE world_id/i.test(c.sql)),
    'GET /preview must thread villages into the terrain config',
  );
});

test('GET /preview 404s for an unknown world', async () => {
  __setPool(mockPool([
    [/FROM worlds WHERE id/i, () => ({ rows: [] })],
  ]));
  const res = await request(app).get('/api/worlds/nope/preview');
  assert.equal(res.status, 404);
});

// Before wiring buildWorldGenConfig into this route, it hand-built its config
// literal without ever loading the world's declared biomes -- so a world
// with a biome set would render pre-biome terrain here while /chunk and the
// authority (both already biome-aware) rendered biome-restricted terrain for
// the SAME world: the preview thumbnail and the actual map would disagree.
// Pin the user-visible symptom directly: a tile outside the declared biome
// must never appear in the preview grid.
test('GET /preview restricts terrain to the world\'s declared biome', async () => {
  const pool = mockPool([
    [/FROM worlds WHERE id/i, () => ({ rows: [{ id: 'biomePreview', seed: '7', chunk_size: 64, biomes: ['Meadow'] }] })],
    [/FROM tile_types/i, () => tileRows],
    [/FROM map_links/i, () => ({ rows: [] })],
    [/FROM villages WHERE world_id/i, () => ({ rows: [] })],
    [/FROM biomes/i, () => ({ rows: [
      { id: 1, name: 'Meadow', terrain_tiles: ['grass'], flora_types: [], creature_types: [],
        palette: [], art_style: '', exclusions: '', color: '#5aa84f' },
    ] })],
  ]);
  __setPool(pool);
  const res = await request(app).get('/api/worlds/biomePreview/preview');
  assert.equal(res.status, 200);
  const seen = new Set(res.body.data.flat());
  assert.ok(!seen.has('water'), 'water is outside the declared biome and must not appear');
  assert.ok(seen.has('grass'), 'grass belongs to the declared biome and should appear');
  assert.ok(
    pool.calls.some((c) => /FROM biomes/i.test(c.sql)),
    'GET /preview must resolve the world\'s declared biomes via loadBiomes',
  );
});

test('GET /preview memoizes: a second request does not re-query the world', async () => {
  const pool = mockPool([
    [/FROM worlds WHERE id/i, () => ({ rows: [{ id: 'memo1', seed: '9', chunk_size: 64 }] })],
    [/FROM tile_types/i, () => tileRows],
    [/FROM map_links/i, () => ({ rows: [] })],
    [/FROM villages WHERE world_id/i, () => ({ rows: [] })],
  ]);
  __setPool(pool);
  const a = await request(app).get('/api/worlds/memo1/preview');
  const b = await request(app).get('/api/worlds/memo1/preview');
  assert.deepEqual(a.body.data, b.body.data);
  const worldQueries = pool.calls.filter((c) => /FROM worlds WHERE id/i.test(c.sql)).length;
  assert.equal(worldQueries, 1, 'second request should hit the memo, not the DB');
});
