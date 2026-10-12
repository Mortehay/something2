// backend/tests/required_tiles_boss.test.js
// SOMET-609 (S9). A boss post sits on GENERATED terrain like a vault chest:
// requiredTilesFor must list it so assertNavigable rejects a post a player can
// never reach (the same seam the chest uses, seed-map.js:133).
const test = require('node:test');
const assert = require('node:assert/strict');
const { requiredTilesFor } = require('../scripts/seed-map.js');
const { buildWorldGenConfig } = require('../src/services/worldGenConfig.js');
const { assertNavigable } = require('../src/services/navigability.js');
const { DEFAULT_TILE_TYPES } = require('../seeds/data/tileTypes.js');
const { STARTER_BIOMES } = require('../seeds/data/biomes.js');

const TILE_TYPES = Object.fromEntries(DEFAULT_TILE_TYPES.map((t) => [t.name, { walkable: t.walkable }]));
const DEEP_FOREST = STARTER_BIOMES.find((b) => b.name === 'Deep Forest');

const world = (boss) => ({
  key: 'zz', name: 'Zz', seed: 991, width: 64, height: 64, chunk_size: 32, biome_cell: 32,
  biomes: ['Deep Forest'], level_band: [1, 1], ...(boss === undefined ? {} : { boss }),
});
const rowOf = (w) => ({ seed: w.seed, chunk_size: w.chunk_size, width: w.width, height: w.height,
  entry_spawn: null, biome_cell: w.biome_cell, level_min: 1, level_max: 1 });

test('a boss block adds exactly one "dungeon boss" required tile at its post', () => {
  const w = world({ entity: 'x', x: 3250, y: 3850, respawn_s: 1 });
  const tiles = requiredTilesFor(w, { links: [] }, rowOf(w), ['W']);
  assert.deepEqual(tiles.filter((t) => t.what === 'dungeon boss'), [{ row: 38, col: 32, what: 'dungeon boss' }]);
});

test('no boss, or a malformed one, adds no tile and does not throw', () => {
  for (const boss of [undefined, null, { entity: 'x' }, { x: 'a', y: 2 }]) {
    const w = world(boss);
    assert.equal(requiredTilesFor(w, { links: [] }, rowOf(w), ['W']).filter((t) => t.what === 'dungeon boss').length, 0);
  }
});

test('a boss post on the wall ring fails assertNavigable; an interior post passes', () => {
  const run = (x, y) => {
    const w = world({ entity: 'x', x, y, respawn_s: 1 });
    const cfg = buildWorldGenConfig({ row: rowOf(w), tileTypes: TILE_TYPES, doorways: ['W'], villages: [], biomes: [DEEP_FOREST] });
    return assertNavigable(cfg, requiredTilesFor(w, { links: [] }, rowOf(w), ['W']));
  };
  assert.ok(run(50, 50).some((p) => /dungeon boss/.test(p)), 'corner (0,0) is the stamped wall ring');
  assert.deepEqual(run(3250, 3250), []);
});
