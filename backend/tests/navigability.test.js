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

// Neither prior sealed-world test exercises the post-flood-fill "unreached
// required tile" scan: the fully-sealed fixture's start tile is itself
// unwalkable, so it takes the early-return before the BFS ever runs; the
// open-world fixture runs the BFS but nothing is ever left unseen. This is
// the scenario the module's own doc comment names -- "a doorway walled off
// from the rest of the interior" -- and it is the only one that forces the
// BFS to run AND leave something unreached, exercising the final membership
// check that a regression could silently break.
//
// Needs its own tileTypes: stampBounds stamps the boundary ring with
// map_wall/map_doorway regardless of the biome, so those names must resolve
// to real walkable flags or the ring reads as always-walkable (undefined
// def) rather than the walled ring this fixture depends on.
const RING_TILE_TYPES = {
  floor: { walkable: true, speed: 1 },
  wall: { walkable: false, speed: 1 },
  map_wall: { walkable: false, speed: 1 },
  map_doorway: { walkable: true, speed: 1 },
};
// A 12x12 bounded world with a single N doorway, whose interior is entirely
// `wall`-banded. The doorway gap itself is stamped by stampBounds and stays
// walkable, but everything one tile south of it is sealed -- so the doorway
// is reachable from itself, and the interior is not reachable from the
// doorway.
const doorwaySealedWorld = () => ({
  seed: 7, chunkSize: 32, tileTypes: RING_TILE_TYPES,
  width: 12, height: 12, doorways: new Set(['N']),
  biomes: [{ name: 'Sealed', terrain_tiles: ['wall'], flora_types: [], creature_types: [] }],
  biomeCell: 8,
});

test('a doorway cut off from the sealed interior is reported unreachable; the doorway itself is not', () => {
  const { generateRegion } = require('../src/services/mapService');
  const world = doorwaySealedWorld();
  const grid = generateRegion(world, 0, 0, 12, 12);
  // Prove the fixture is what it claims before trusting assertNavigable's
  // verdict on it -- a fixture that quietly generated an open interior, or a
  // doorway that didn't stamp, would make this test vacuous.
  assert.equal(grid[0][6], 'map_doorway', `expected doorway cell to be map_doorway, got ${grid[0][6]}`);
  assert.equal(grid[2][2], 'wall', `expected interior cell to be wall-banded, got ${grid[2][2]}`);

  // Doorway first: it anchors the BFS (walkable by construction). The
  // interior cell second: wall-banded and severed from the doorway gap by a
  // solid ring of `wall` directly south of it.
  const required = [
    { row: 0, col: 6, what: 'north doorway' },
    { row: 2, col: 2, what: 'interior chamber' },
  ];
  const unreachable = assertNavigable(world, required);
  assert.equal(unreachable.length, 1);
  assert.ok(unreachable.some((m) => m.includes('interior chamber')));
  // Not just "interior chamber is present" -- confirm the reachable doorway
  // is genuinely absent, not just outnumbered. A membership check that
  // reported everything would still pass a weaker assertion.
  assert.ok(!unreachable.some((m) => m.includes('north doorway')));
});
