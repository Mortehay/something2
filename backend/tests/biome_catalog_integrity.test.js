const test = require('node:test');
const assert = require('node:assert');
const { STARTER_BIOMES } = require('../seeds/data/biomes.js');
const { DEFAULT_TILE_TYPES } = require('../seeds/data/tileTypes.js');
const { NEW_DECORATIONS, SIZE_FIXES } = require('../seeds/data/decorationTypes.js');

const ORIGINAL = new Set(['Meadow', 'Deep Forest', 'Arid Dunes', 'Frozen Waste', 'Mire']);
const added = () => STARTER_BIOMES.filter((b) => !ORIGINAL.has(b.name));

test('the catalog gained exactly 27 biomes', () => {
  assert.equal(added().length, 27);
  assert.equal(STARTER_BIOMES.length, 32);
});

// The failure this repo has already had: STARTER_BIOMES listing a creature
// that no longer existed made `make seed-catalogs` rewrite a dangling
// reference on every run. The same shape applies to terrain.
test("every biome's terrain_tiles exist in the tile catalog", () => {
  const tiles = new Set(DEFAULT_TILE_TYPES.map((t) => t.name));
  const dangling = [];
  for (const b of STARTER_BIOMES) {
    for (const t of b.terrain_tiles) if (!tiles.has(t)) dangling.push(`${b.name}->${t}`);
  }
  assert.deepEqual(dangling, []);
});

// The flora half of the same rule, and it covers ALL 32 biomes on purpose.
//
// biomes_seed.test.js used to carry this check, but its loop was scoped to the
// original five to accommodate P3's deliberately empty fauna -- and the flora
// assertion went with it. This file then picked up the terrain check for every
// biome but not the flora one, leaving a dangling flora reference in any of the
// 27 new biomes completely unguarded. That is the exact bug class this repo has
// already paid for (see the LIVE_CREATURES note in biomes_seed.test.js: `Wolf`
// sat dangling for weeks behind a check that compared the data to itself).
//
// DERIVED, never hand-listed, for that same reason. The names come from the two
// checked-in sources that actually create these rows: SIZE_FIXES keys are the
// three decorations migration 1714440003000 seeds (Tree/Stone/IceRock -- the
// only enumeration of them outside the migration's own SQL), and
// NEW_DECORATIONS is what seed-catalogs.js inserts. A hand-written literal here
// would go stale the moment a decoration is renamed and would then agree with
// nothing.
const LIVE_FLORA = new Set([...Object.keys(SIZE_FIXES), ...NEW_DECORATIONS.map((d) => d.name)]);

test("every biome's flora_types exist in the decoration catalog", () => {
  // Guard the derivation itself: if both seed sources were emptied or renamed
  // away, the set would be empty and the loop below would pass by vacuity
  // while every reference in the file was dangling.
  assert.ok(LIVE_FLORA.size >= 7, `flora set collapsed to ${LIVE_FLORA.size} names`);
  const dangling = [];
  for (const b of STARTER_BIOMES) {
    for (const f of b.flora_types) if (!LIVE_FLORA.has(f)) dangling.push(`${b.name}->${f}`);
  }
  assert.deepEqual(dangling, []);
});

// P3 shipped `creature_types: []` on all 27 new biomes with a comment saying
// "P4 fills them as it authors each creature line" (see biomes.js's header).
// P4 (SOMET-250) authored the 288 "{Line} {Rung}" creatures into entity_types
// but never came back to fill this field -- leaving every P5 (SOMET-251)
// world using one of these biomes with zero possible wild spawns, since
// placeMapCreatures intersects a world's allowed_creature_types against its
// biome's creature_types and an empty biome list makes that intersection
// empty no matter what the world allows. Fixed as a SOMET-251 follow-up
// (closing the SOMET-247/SOMET-250 gap): each of the 27 now ships exactly
// its Line's [Swarm, Skirmisher, Line] rung set -- the same three rungs
// gen-p5-map-content.js already declares in every P5 world's
// allowed_creature_types, so the intersection is non-empty by construction.
//
// This asserts the SHAPE (one consistent Line prefix per biome, no biome
// left at [], no two biomes sharing a Line) rather than hand-duplicating the
// biome->Line name table here, which would just be a second copy of the same
// mapping to go stale in lockstep with the first.
test('every new biome ships a real, single-Line Swarm/Skirmisher/Line fauna set', () => {
  const RUNGS = ['Swarm', 'Skirmisher', 'Line'];
  const linesSeen = new Map(); // line -> biome name, to catch two biomes sharing a Line
  for (const b of added()) {
    assert.ok(Array.isArray(b.creature_types) && b.creature_types.length === 3,
      `${b.name} must ship exactly 3 creature_types, got ${JSON.stringify(b.creature_types)}`);
    const names = b.creature_types.map((n) => n.split(' '));
    const lines = new Set(names.map((parts) => parts.slice(0, -1).join(' ')));
    assert.equal(lines.size, 1, `${b.name}'s creature_types must all share one Line prefix`);
    const [line] = lines;
    const rungs = names.map((parts) => parts[parts.length - 1]).sort();
    assert.deepEqual(rungs, [...RUNGS].sort(), `${b.name} must ship Swarm+Skirmisher+Line, not ${rungs}`);
    assert.ok(!linesSeen.has(line), `Line "${line}" used by both ${linesSeen.get(line)} and ${b.name}`);
    linesSeen.set(line, b.name);
  }
});

test('every new biome carries palette, art_style, exclusions and a colour', () => {
  for (const b of added()) {
    assert.ok(Array.isArray(b.palette) && b.palette.length >= 2, `${b.name} palette`);
    assert.ok(b.art_style && b.art_style.trim(), `${b.name} art_style`);
    assert.ok(b.exclusions && b.exclusions.trim(), `${b.name} exclusions`);
    assert.ok(/^#[0-9a-f]{6}$/i.test(b.color || ''), `${b.name} color`);
  }
});

test('biome names are unique', () => {
  const names = STARTER_BIOMES.map((b) => b.name);
  assert.equal(new Set(names).size, names.length);
});

test('every seeded biome declares a creature_density in range', () => {
  for (const b of STARTER_BIOMES) {
    assert.ok(Number.isFinite(b.creature_density),
      `biome ${b.name} is missing creature_density`);
    assert.ok(b.creature_density >= 0.4 && b.creature_density <= 2.5,
      `biome ${b.name} density ${b.creature_density} outside [0.4, 2.5]`);
  }
});

// The design's rule is about the three tiles THIS sub-project adds, not about
// impassable terrain in general -- `water` is pre-existing and `Mire` has
// always banded it. Deriving the set from every walkable:false tile would
// sweep in Storm Coast and Sunken Cistern, which band water on purpose: a
// coast needs a sea and a flooded cistern needs standing water.
//
// An explicit list, deliberately NOT a tier rule: a tier rule would sweep in
// Crystal Hollows and Hive Warrens, which sit at bands 4-6 where sealed
// terrain is least acceptable.
test('exactly ten biomes band one of the three new impassable tiles', () => {
  const NEW_IMPASSABLE = new Set(['cave_wall', 'rubble', 'chasm']);
  const withBlocked = STARTER_BIOMES
    .filter((b) => b.terrain_tiles.some((t) => NEW_IMPASSABLE.has(t)))
    .map((b) => b.name).sort();
  assert.deepEqual(withBlocked, [
    'Abyssal Rift', 'Deepvault', 'Dreaming Dark', 'Fallen Sanctum',
    'Infernal Gate', 'Pestilent Deep', 'Shattered Vault', 'The Maw',
    'Grave of Titans', 'Umbral Warren',
  ].sort());
});
