const test = require('node:test');
const assert = require('node:assert');
const { placeMapCreatures, worldConfig, sampleBiomeRegion } = require('../src/services/mapService');

const SLIME = { name: 'Slime', hp: 10, defense: 0, resistances: {} };
const BAT = { name: 'Bat', hp: 8, defense: 0, resistances: {} };
const ALLOWED = [SLIME, BAT];

const MEADOW = { name: 'Meadow', terrain_tiles: ['grass'], flora_types: [], creature_types: ['Slime'] };
const WASTE = { name: 'Frozen Waste', terrain_tiles: ['snow'], flora_types: [], creature_types: ['Bat'] };

function world(biomes) {
  return {
    seed: 4242, chunkSize: 16, width: 40, height: 40, pathTile: null,
    tileTypes: {
      grass: { walkable: true, speed: 1 },
      snow: { walkable: true, speed: 1 },
      map_wall: { walkable: false, speed: 1 },
      map_doorway: { walkable: true, speed: 1 },
    },
    biomes, biomeCell: 12,
  };
}

test('without biomes both allowed types are used (unchanged behaviour)', () => {
  const out = placeMapCreatures(world([]), 60, ALLOWED, 7);
  assert.ok(out.length > 0);
  assert.deepEqual([...new Set(out.map((c) => c.type))].sort(), ['Bat', 'Slime']);
});

test('each placement uses a type its own biome lists', () => {
  const w = world([MEADOW, WASTE]);
  const cfg = worldConfig(w);
  const out = placeMapCreatures(w, 60, ALLOWED, 7);
  assert.ok(out.length > 0, 'fixture must place creatures');
  for (const c of out) {
    const row = Math.floor(c.y / 100), col = Math.floor(c.x / 100);
    const region = sampleBiomeRegion(cfg, row, col);
    assert.ok(region.creatureTypes.includes(c.type),
      `${c.type} at (${row},${col}) is not native to ${region.name}`);
  }
});

test('BOTH biomes are actually exercised (the test above is not vacuous)', () => {
  const out = placeMapCreatures(world([MEADOW, WASTE]), 60, ALLOWED, 7);
  assert.deepEqual([...new Set(out.map((c) => c.type))].sort(), ['Bat', 'Slime']);
});

test('the world allowlist still wins: a biome cannot widen it', () => {
  const out = placeMapCreatures(world([MEADOW, WASTE]), 60, [SLIME], 7);
  assert.ok(out.length > 0, 'Meadow cells can still host Slimes');
  assert.deepEqual([...new Set(out.map((c) => c.type))], ['Slime']);
});

test('a world whose biomes list no allowed creature places nothing', () => {
  const barren = { name: 'Barren', terrain_tiles: ['grass'], flora_types: [], creature_types: [] };
  assert.deepEqual(placeMapCreatures(world([barren]), 20, ALLOWED, 7), []);
});

test('placements stay deterministic for a given rng seed', () => {
  const a = placeMapCreatures(world([MEADOW, WASTE]), 30, ALLOWED, 99);
  const b = placeMapCreatures(world([MEADOW, WASTE]), 30, ALLOWED, 99);
  assert.deepEqual(a, b);
});
