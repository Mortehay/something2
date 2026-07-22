// backend/tests/biomeExcludesStructural.test.js
//
// Structural overlay tiles (map_wall, map_doorway, wooden_wall, village_gate)
// must never be sampled as biome terrain — they are stamped explicitly by
// stampBounds/stampVillage. Regression test for the biome-leak bug where
// worldConfig's biomeNames included every non-path tile, letting the
// structural overlay tiles show up as random terrain blobs.
const test = require('node:test');
const assert = require('node:assert');
const { worldConfig, generateRegion } = require('../src/services/mapService');

const STRUCTURAL = ['map_wall', 'map_doorway', 'wooden_wall', 'village_gate'];

test('worldConfig.biomeNames excludes structural overlay tiles', () => {
  const cfg = worldConfig({
    tileTypes: {
      grass: {}, water: {},
      map_wall: {}, map_doorway: {}, wooden_wall: {}, village_gate: {},
    },
  });
  assert.ok(cfg.biomeNames.includes('grass'));
  assert.ok(cfg.biomeNames.includes('water'));
  for (const name of STRUCTURAL) {
    assert.ok(!cfg.biomeNames.includes(name), `biomeNames should not include ${name}`);
  }
});

test('generateRegion never leaks structural tiles into biome-sampled terrain', () => {
  const world = {
    seed: 5,
    chunkSize: 20,
    tileTypes: {
      grass: {}, water: {}, forest: {}, meadow: {},
      map_wall: {}, map_doorway: {}, wooden_wall: {}, village_gate: {},
    },
    // no width/height (unbounded) and no villages -> nothing should EVER
    // stamp a structural tile; any occurrence must come from biome sampling.
  };
  const grid = generateRegion(world, 0, 0, 20, 20);
  const flat = grid.flat();
  for (const name of STRUCTURAL) {
    assert.ok(!flat.includes(name), `region should not contain structural tile ${name}`);
  }
});

test('worldConfig falls back to structural tiles when they are the ONLY tiles (degenerate fixture)', () => {
  const cfg = worldConfig({ tileTypes: { map_wall: {} } });
  assert.ok(Array.isArray(cfg.biomeNames));
  assert.ok(cfg.biomeNames.length > 0, 'biomeNames must never be empty');
  assert.deepEqual(cfg.biomeNames, ['map_wall']);
});
