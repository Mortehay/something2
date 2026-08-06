const test = require('node:test');
const assert = require('node:assert');
const { assertNavigable } = require('../src/services/navigability');

const TILE_TYPES = {
  floor: { walkable: true, speed: 1 },
  wall: { walkable: false, speed: 1 },
};
// A 12x12 bounded world whose interior is entirely `floor`.
//
// `biomes` entries are RAW catalog rows -- snake_case `terrain_tiles` /
// `flora_types` / `creature_types` -- exactly what services/biomes.js
// loadBiomes returns. worldConfig's normalizeBiomes is what converts them to
// the camelCase `terrainNames`/`creatureTypes` the generator uses, so a
// fixture written in the camelCase shape would silently band nothing.
const openWorld = () => ({
  seed: 7, chunkSize: 32, tileTypes: TILE_TYPES,
  width: 12, height: 12, doorways: new Set(['N']),
  biomes: [{ name: 'Open', terrain_tiles: ['floor'], flora_types: [], creature_types: [] }],
  biomeCell: 8,
});
// Same, but the biome bands only `wall`, so the interior is solid.
const sealedWorld = () => ({
  ...openWorld(),
  biomes: [{ name: 'Sealed', terrain_tiles: ['wall'], flora_types: [], creature_types: [] }],
});

const REQUIRED = [
  { row: 2, col: 2, what: 'entry spawn' },
  { row: 9, col: 9, what: 'portal source' },
];

test('an open world reports nothing unreachable', () => {
  assert.deepEqual(assertNavigable(openWorld(), REQUIRED), []);
});

// This test must FIRST prove the fixture actually generated impassable
// terrain. "nothing is unreachable" is vacuously true of a world with no
// walls, so a sealed-world test that silently generated an open map would
// pass while asserting nothing.
test('a sealed world reports its required tiles unreachable', () => {
  const { generateRegion } = require('../src/services/mapService');
  const grid = generateRegion(sealedWorld(), 1, 1, 10, 10);
  const names = new Set(grid.flat());
  assert.ok(names.has('wall'), `fixture must generate walls, got ${[...names]}`);

  const unreachable = assertNavigable(sealedWorld(), REQUIRED);
  assert.equal(unreachable.length, 2);
  assert.ok(unreachable.some((m) => m.includes('entry spawn')));
  assert.ok(unreachable.some((m) => m.includes('portal source')));
});

test('a required tile outside the map bounds is reported, not crashed on', () => {
  const out = assertNavigable(openWorld(), [{ row: 99, col: 99, what: 'stray portal' }]);
  assert.equal(out.length, 1);
  assert.ok(out[0].includes('stray portal'));
});

test('no required tiles means nothing to check', () => {
  assert.deepEqual(assertNavigable(openWorld(), []), []);
});

test('an unbounded world is skipped rather than flood-filled', () => {
  const unbounded = { seed: 1, chunkSize: 32, tileTypes: TILE_TYPES };
  assert.deepEqual(assertNavigable(unbounded, REQUIRED), []);
});
