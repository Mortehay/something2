const test = require('node:test');
const assert = require('node:assert');
const { generateChunk, generateChunkDecorations } = require('../src/services/mapService');

// Two defs that both match 'grass', so the ONLY thing that can separate them
// is the biome flora filter.
const BUSH = { id: 1, name: 'bush', walkable: true, spawn_tiles: ['grass'], chance: 1 };
const PINE = { id: 2, name: 'pine_tree', walkable: false, spawn_tiles: ['grass'], chance: 1 };
const DEFS = [BUSH, PINE];

function world(biomes) {
  return {
    seed: 12345, chunkSize: 16, width: 16, height: 16,
    tileTypes: { grass: { walkable: true, speed: 1 } },
    biomes, biomeCell: 24,
  };
}

function place(biomes) {
  const w = world(biomes);
  return generateChunkDecorations(w, 0, 0, generateChunk(w, 0, 0), DEFS);
}

test('without biomes both types can be placed (unchanged behaviour)', () => {
  const out = place([]);
  assert.ok(out.length > 0, 'fixture must place decorations');
  assert.deepEqual([...new Set(out.map((d) => d.name))].sort(), ['bush', 'pine_tree']);
});

test('a biome restricts placement to its own flora', () => {
  const out = place([{ name: 'Meadow', terrain_tiles: ['grass'], flora_types: ['bush'], creature_types: [] }]);
  assert.ok(out.length > 0, 'a biome with matching flora still places decorations');
  assert.deepEqual([...new Set(out.map((d) => d.name))], ['bush']);
});

test('MUTATION GUARD: the filter is what removes pine_tree, not the fixture', () => {
  // The same world with pine_tree as the only flora must place pine_tree and
  // no bush -- if either direction failed, the filter would be inert or the
  // fixture would be rigged.
  const out = place([{ name: 'Grove', terrain_tiles: ['grass'], flora_types: ['pine_tree'], creature_types: [] }]);
  assert.ok(out.length > 0);
  assert.deepEqual([...new Set(out.map((d) => d.name))], ['pine_tree']);
});

test('a biome with empty flora_types places nothing', () => {
  assert.deepEqual(place([{ name: 'Barrens', terrain_tiles: ['grass'], flora_types: [], creature_types: [] }]), []);
});

test('the same tiles are still eligible: the filter changes WHICH type, not WHERE', () => {
  // Density and fill gates run before the flora filter and are biome-blind, so
  // a single-flora biome decorates a subset of the biome-less placement.
  const all = new Set(place([]).map((d) => `${d.row},${d.col}`));
  for (const d of place([{ name: 'Meadow', terrain_tiles: ['grass'], flora_types: ['bush'], creature_types: [] }])) {
    assert.ok(all.has(`${d.row},${d.col}`), `unexpected new cell ${d.row},${d.col}`);
  }
});

test('blocking flag still comes from the def, not the biome', () => {
  const out = place([{ name: 'Grove', terrain_tiles: ['grass'], flora_types: ['pine_tree'], creature_types: [] }]);
  for (const d of out) assert.equal(d.blocking, true);
});
