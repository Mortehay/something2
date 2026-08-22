const test = require('node:test');
const assert = require('node:assert');
const { worldConfig, generateRegion } = require('../src/services/mapService');
const { assertNavigable } = require('../src/services/navigability');

// SOMET-366. The sealed-world guard was disarmed by the road network, and the
// fix for that (SOMET-349) was itself inert for three days because of how
// worldConfig treats roads. Both halves are pinned here.
//
// Why the existing navigability fixtures never caught it: they are 12x12 with a
// SINGLE doorway, and generateConnectingRoads needs two endpoints to draw
// anything. So every sealed-world test in the suite ran on a world with no
// roads, and the one configuration where roads matter -- more than one way in
// -- had no coverage at all.

// `dirt` is the road surface. It has to be a REAL tile the world knows about:
// collectPathCells only stamps roads when cfg.pathTile is set, so a fixture
// without one generates a road network that never touches the grid -- which
// looks exactly like "roads do not affect navigability" and would have made
// every assertion below vacuous.
const TILE_TYPES = {
  floor: { walkable: true, speed: 1 },
  dirt: { walkable: true, speed: 1 },
  wall: { walkable: false, speed: 1 },
};

// 24x24 with doorways on opposite edges, so the road network has two endpoints
// to connect. The biome bands nothing but `wall`: on terrain alone this world
// is solid rock, and a player arriving through either door is entombed.
const sealedTwoDoorWorld = () => ({
  seed: 11, chunkSize: 32, tileTypes: TILE_TYPES, pathTile: 'dirt',
  width: 24, height: 24, doorways: new Set(['N', 'S']),
  biomes: [{ name: 'Sealed', terrain_tiles: ['wall'], flora_types: [], creature_types: [] }],
  biomeCell: 8,
});

const REQUIRED = [
  { row: 0, col: 12, what: 'doorway N' },
  { row: 1, col: 12, what: 'arrival via doorway N' },
  { row: 22, col: 12, what: 'arrival via doorway S' },
];

// --- the trap that made the SOMET-349 fix inert ---------------------------

test('worldConfig IGNORES a generatedRoads override -- the spread that looked like a strip', () => {
  const world = sealedTwoDoorWorld();
  const withRoads = worldConfig(world).generatedRoads;
  assert.ok(withRoads.length > 0, 'fixture must generate roads, or the rest of this file proves nothing');

  // This is the shape seed-map.js passed for three days believing it removed
  // the roads. worldConfig never reads world.generatedRoads: it recomputes.
  const spread = worldConfig({ ...world, generatedRoads: [] });
  assert.equal(spread.generatedRoads.length, withRoads.length,
    'if this ever starts passing, the spread form works and the flag below is redundant');
});

test('worldConfig honours the explicit noGeneratedRoads opt-out', () => {
  assert.equal(worldConfig({ ...sealedTwoDoorWorld(), noGeneratedRoads: true }).generatedRoads.length, 0);
});

// --- what the roads were hiding -------------------------------------------

test('the connecting road is what carves walkable ground through solid rock', () => {
  const world = sealedTwoDoorWorld();
  const count = (g) => g.flat().reduce((m, t) => ({ ...m, [t]: (m[t] || 0) + 1 }), {});

  // `noGeneratedRoads` removes the DOORWAY/VILLAGE connector network only. A
  // separate coarse path lattice still stamps some walkable dirt, so "road-free"
  // does not mean "one hundred percent biome terrain" -- assert the difference
  // the connector makes, not an absolute that would be wrong for the wrong
  // reason. What matters is proved by the next test: the lattice alone does not
  // join the two doorways, the connector does.
  const bare = count(generateRegion({ ...world, noGeneratedRoads: true }, 1, 1, 22, 22));
  const paved = count(generateRegion(world, 1, 1, 22, 22));

  assert.ok(bare.wall > 0, 'the biome must band impassable terrain, or nothing here is sealed');
  assert.ok(paved.dirt > bare.dirt,
    `the connector must add walkable ground: bare=${bare.dirt} paved=${paved.dirt}`);
  assert.ok(paved.wall < bare.wall, 'and it must do so by replacing wall');
});

test('the sealed world is refused ONLY when roads are off', () => {
  const world = sealedTwoDoorWorld();

  // With roads — the highway between the two doorways connects everything the
  // guard asks about, so it reports clean on a world of solid rock. This is
  // the disarmed state, asserted deliberately: it is why seeding MUST pass the
  // flag, and if this assertion ever flips, the flag has stopped being needed.
  assert.deepEqual(assertNavigable(world, REQUIRED), [],
    'roads make a solid-rock world look navigable -- that is the whole defect');

  // Without roads — the guard does its job.
  const problems = assertNavigable({ ...world, noGeneratedRoads: true }, REQUIRED);
  assert.ok(problems.length > 0, 'terrain-only must refuse a world banded entirely in wall');
  assert.ok(problems.some((m) => m.includes('effectively sealed') || m.includes('unreachable')),
    `expected a seal/unreachable report, got: ${problems.join(' | ')}`);
});

// --- and that seeding actually passes it ----------------------------------

// A behavioural test would need a database; this reads the source instead,
// because the failure being guarded is textual — someone "simplifying" the
// terrainOnly line back to a spread. The assertion names the exact wrong form
// so the message explains itself.
test('seed-map hands assertNavigable a road-free world', () => {
  // Comments stripped first: this file's own explanation of the wrong form
  // names it verbatim, and so does seed-map's.
  const src = require('node:fs').readFileSync(require.resolve('../scripts/seed-map.js'), 'utf8')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.match(src, /noGeneratedRoads:\s*true/,
    'seed-map must opt out of roads explicitly');
  assert.doesNotMatch(src, /\.\.\.cfg,\s*generatedRoads:\s*\[\]/,
    'the spread form does not strip roads -- worldConfig recomputes them');
});
