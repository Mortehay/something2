'use strict';
// Worlds + defs for scenery_oracle.test.js. The expected output in
// tests/fixtures/scenery_oracle.json was captured from the generator BEFORE the
// per-call eligibility cache (commit a7fa51ba), so the cache must reproduce it
// pick-for-pick. Do not regenerate the fixture to make a test pass.
const TILES = {
  grass: { walkable: true, speed: 1 },
  dirt: { walkable: true, speed: 1 },
  sand: { walkable: true, speed: 1 },
  rock: { walkable: true, speed: 1 },
};

const DEFS = [
  { name: 'Oak', walkable: false, spawn_tiles: ['grass', 'dirt'], chance: 3, scenery_layer: 'feature', block_radius: 14 },
  { name: 'Boulder', walkable: false, spawn_tiles: ['rock', 'grass'], chance: 1, scenery_layer: 'feature', block_radius: 30 },
  { name: 'Shrub', walkable: true, spawn_tiles: ['grass', 'sand'], chance: 2, scenery_layer: 'feature' },
  { name: 'Ghost', walkable: true, spawn_tiles: ['grass'], chance: 0, scenery_layer: 'feature' },
  { name: 'Moss', walkable: true, spawn_tiles: ['grass', 'rock'], chance: 2, scenery_layer: 'cover', max_per_tile: 3 },
  { name: 'Pebble', walkable: true, spawn_tiles: ['dirt', 'sand', 'rock'], chance: 1, scenery_layer: 'cover', max_per_tile: 1 },
  { name: 'Clover', walkable: true, spawnTiles: ['grass'], chance: 4, scenery_layer: 'cover' },
  { name: 'Fern', walkable: true, spawn_tiles: ['grass', 'dirt'], chance: 1, scenery_layer: 'cover', max_per_tile: 2 },
  { name: 'NoChance', walkable: true, spawn_tiles: ['grass'], chance: 0, scenery_layer: 'cover' },
  { name: 'Lichen', walkable: true, spawn_tiles: ['rock'], chance: 5, scenery_layer: 'cover', max_per_tile: 4 },
];

const BIOMES = [
  { name: 'Meadow', terrain_tiles: ['grass', 'dirt'], flora_types: ['Oak', 'Shrub', 'Moss', 'Clover', 'Fern', 'Ghost', 'NoChance'], creature_types: [], feature_density: 0.8, cover_density: 2.5 },
  { name: 'Crag', terrain_tiles: ['rock', 'sand'], flora_types: ['Boulder', 'Pebble', 'Lichen', 'Moss'], creature_types: [], feature_density: 1, cover_density: 1.4 },
  { name: 'Barren', terrain_tiles: ['grass', 'sand'], flora_types: [], creature_types: [], cover_density: 3 },
  { name: 'Plain', terrain_tiles: ['grass', 'rock', 'dirt'], flora_types: ['Oak', 'Pebble', 'Fern'], creature_types: [] },
];

function mk(seed, biomes, extra = {}) {
  return { seed, chunkSize: 24, width: 96, height: 96, tileTypes: TILES, pathTile: 'dirt', noGeneratedRoads: true, biomeCell: 12, biomes, ...extra };
}

// name, world, chunk x, chunk y
const CASES = [
  { name: 'four biomes', world: mk(777, BIOMES), cx: 1, cy: 2 },
  { name: 'four biomes, other seed', world: mk(31337, BIOMES), cx: 2, cy: 0 },
  { name: 'no biomes (flora null)', world: mk(4242, []), cx: 0, cy: 1 },
  { name: 'single meadow', world: mk(9, [BIOMES[0]]), cx: 3, cy: 3 },
  { name: 'generated roads', world: mk(555, BIOMES, { noGeneratedRoads: false }), cx: 1, cy: 1 },
];

module.exports = { DEFS, CASES };
