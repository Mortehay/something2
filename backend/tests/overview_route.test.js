const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { app, __setPool } = require('../src/index');

function fakePool(worldRow) {
  return {
    query: async (sql) => {
      if (/FROM worlds WHERE id/.test(sql)) return { rows: worldRow ? [worldRow] : [] };
      if (/FROM tile_types/i.test(sql)) return { rows: [{ name: 'grass', color: '#3a5', walkable: true }] };
      if (/FROM map_links/i.test(sql)) return { rows: [] };
      if (/FROM villages/i.test(sql)) return { rows: [] };
      return { rows: [] };
    },
  };
}

test('overview route 400s without cx/cy', async () => {
  __setPool(fakePool({ id: 'w1', seed: 1, chunk_size: 64 }));
  const res = await request(app).get('/api/worlds/w1/overview');
  assert.strictEqual(res.status, 400);
});

test('overview route 404s for an unknown world', async () => {
  __setPool(fakePool(null));
  const res = await request(app).get('/api/worlds/nope/overview?cx=0&cy=0');
  assert.strictEqual(res.status, 404);
});

test('overview route returns a downsampled grid', async () => {
  __setPool(fakePool({ id: 'w1', seed: 1, chunk_size: 64 }));
  const res = await request(app).get('/api/worlds/w1/overview?cx=0&cy=0');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.step, 4);
  assert.strictEqual(res.body.tiles.length, 64);
  assert.strictEqual(res.body.tiles[0].length, 64);
  assert.strictEqual(res.body.world_id, 'w1');
});

// Before wiring buildWorldGenConfig into this route, it hand-built its config
// literal without ever loading the world's declared biomes -- so a world with
// a biome set would render pre-biome terrain on the in-game minimap while
// /chunk and the authority (already biome-aware) rendered biome-restricted
// terrain for the SAME world. Pin the user-visible symptom directly: a tile
// outside the declared biome must never appear in the overview grid.
test('overview route restricts terrain to the world\'s declared biome', async () => {
  const world = { id: 'biomeOverview', seed: 1, chunk_size: 64, biomes: ['Meadow'] };
  __setPool({
    query: async (sql) => {
      if (/FROM worlds WHERE id/.test(sql)) return { rows: [world] };
      if (/FROM tile_types/i.test(sql)) return { rows: [
        { name: 'grass', color: '#3a5', walkable: true, speed: 1 },
        { name: 'water', color: '#36f', walkable: false, speed: 1 },
      ] };
      if (/FROM map_links/i.test(sql)) return { rows: [] };
      if (/FROM villages/i.test(sql)) return { rows: [] };
      if (/FROM biomes/i.test(sql)) return { rows: [
        { id: 1, name: 'Meadow', terrain_tiles: ['grass'], flora_types: [], creature_types: [],
          palette: [], art_style: '', exclusions: '', color: '#5aa84f' },
      ] };
      throw new Error(`unexpected query: ${sql}`);
    },
  });
  const res = await request(app).get('/api/worlds/biomeOverview/overview?cx=0&cy=0');
  assert.strictEqual(res.status, 200);
  const seen = new Set(res.body.tiles.flat());
  assert.ok(!seen.has('water'), 'water is outside the declared biome and must not appear');
  assert.ok(seen.has('grass'), 'grass belongs to the declared biome and should appear');
});
