// backend/tests/world_population_clamp_warning.test.js
//
// SOMET-301 final review, finding 2: worldPopulation.js's clamp warning
// (populateWorld, "was clamped to ... by MAX_WORLD_CREATURES") had ZERO
// coverage. resolveDensity's `clamped` flag is well covered by
// densityTiers.test.js, but the SURFACING of it -- the entire point of that
// code -- was asserted nowhere. After the density tier re-scale (SOMET-350),
// the deepest shipped world (224x224 swarm, ~4466 creatures) IS now clamped
// against the 4000 ceiling. A warning that used to be unreachable can be
// deleted by accident with the whole suite still green -- exactly the "inert
// feature, passing suite" pattern this project has shipped before (see e.g.
// SOMET-249's TWO-LOADER trap).
//
// Deliberately NOT in world_population_db.test.js: that file is DB-backed
// (requires DATABASE_URL against the shared dev database), and the plan's
// original verification command (`node --test tests/worldPopulation*.test.js`)
// doesn't even match it -- the real file is named world_population_db.test.js.
// This test instead runs populateWorld with a STUBBED client (dispatch by SQL
// substring, no network, no DB) so it belongs in the normal fast suite.
//
// Why a stub client works here: every downstream read populateWorld makes
// (loadTileTypes, fetchVillages, fetchLinks, loadBiomes) only ever consumes
// `.rows`. tile_types is the one exception that can't just be `[]` --
// mapService's worldConfig throws on an empty tile-type catalog ("a world
// must have at least one tile") -- so that one query returns the real
// checked-in catalog (DEFAULT_TILE_TYPES), the same source of truth
// p5_navigability.test.js and blackfen_sinks_navigable_seed.test.js already
// feed this exact machinery from. Villages/links/biomes staying empty is a
// legitimate, if minimal, world: creatureTileCandidates treats a tile as
// walkable whenever `world.tileTypes[name]` is undefined for OTHER reasons,
// but here tileTypes is the full catalog, so this is just "no villages, no
// doorways, no biome banding" -- fine for exercising scatter placement.
const test = require('node:test');
const assert = require('node:assert');
const { populateWorld } = require('../src/services/worldPopulation');
const { MAX_WORLD_CREATURES } = require('../src/services/densityTiers');
const { DEFAULT_TILE_TYPES } = require('../seeds/data/tileTypes.js');

const HOSTILE_ROWS = [
  { name: 'Skeleton', hp: 10, defense: 1, resistances: null, faction: 'hostile' },
];

// Matches populateWorld's own queries plus every service it calls through
// (tileTypes.js, villages.js, mapLinks.js, biomes.js) by SQL substring --
// order-independent, so this does not need to track call sequence.
function makeClient({ entityTypeRows = HOSTILE_ROWS } = {}) {
  const calls = [];
  async function query(sql) {
    calls.push(sql);
    if (/DELETE FROM world_creatures/.test(sql)) return { rows: [] };
    if (/FROM entity_types/.test(sql)) return { rows: entityTypeRows };
    if (/FROM tile_types/.test(sql)) return { rows: DEFAULT_TILE_TYPES };
    if (/FROM villages/.test(sql)) return { rows: [] };
    if (/FROM map_links/.test(sql)) return { rows: [] };
    if (/FROM biomes/.test(sql)) return { rows: [] };
    if (/UPDATE worlds SET creature_count/.test(sql)) return { rows: [] };
    if (/INSERT INTO world_creatures/.test(sql)) return { rows: [] };
    throw new Error(`world_population_clamp_warning stub client: unhandled query: ${sql}`);
  }
  return { query, calls };
}

// Captures console.warn calls made during `fn`, restoring the real one
// afterward even if `fn` throws.
async function captureWarnings(fn) {
  const original = console.warn;
  const messages = [];
  console.warn = (...args) => { messages.push(args.join(' ')); };
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  return messages;
}

const CLAMP_MARKER = 'was clamped to';

test('populateWorld warns when MAX_WORLD_CREATURES truncates the scatter count', async () => {
  // A 4096x4096 'normal' world is exactly the case MAX_WORLD_CREATURES's own
  // comment cites as still guarded (resolveDensity('normal', 4096, 4096) ->
  // clamped: true, per densityTiers.js).
  const worldRow = {
    id: 1, name: 'zzClampFires', width: 4096, height: 4096, chunk_size: 32,
    density: 'normal', allowed_creature_types: ['Skeleton'], biomes: [],
    biome_cell: 16, entry_spawn: null, level_min: 1, level_max: 1,
  };
  const client = makeClient();
  const messages = await captureWarnings(
    () => populateWorld(client, worldRow, { rngSeed: 1 }));

  const clampWarning = messages.find((m) => m.includes(CLAMP_MARKER));
  assert.ok(clampWarning, `expected a clamp warning; got console.warn calls:\n  - ${messages.join('\n  - ')}`);
  assert.match(clampWarning, /world 1 \(4096x4096, density "normal"\)/);
  assert.match(clampWarning, new RegExp(`MAX_WORLD_CREATURES`));
});

test('populateWorld does not warn when the density tier is not clamped', async () => {
  // A 64x64 'normal' world: resolveDensity('normal', 64, 64) targets far
  // below MAX_WORLD_CREATURES (~74 scattered creatures), so clamped is false.
  const worldRow = {
    id: 2, name: 'zzClampSilent', width: 64, height: 64, chunk_size: 32,
    density: 'normal', allowed_creature_types: ['Skeleton'], biomes: [],
    biome_cell: 16, entry_spawn: null, level_min: 1, level_max: 1,
  };
  const client = makeClient();
  const messages = await captureWarnings(
    () => populateWorld(client, worldRow, { rngSeed: 1 }));

  const clampWarning = messages.find((m) => m.includes(CLAMP_MARKER));
  assert.equal(clampWarning, undefined,
    `expected no clamp warning for an unclamped world; got:\n  - ${messages.join('\n  - ')}`);
});

// Sanity anchor: if MAX_WORLD_CREATURES ever moves, the "fires" test above
// still needs SOME world that clamps. 4096x4096 'normal' comfortably exceeds
// it today (packBudget 4, ceiling MAX_WORLD_CREATURES-4, target ~100663), so
// this documents the margin rather than hand-waving it.
test('sanity: the clamp fixture world genuinely exceeds MAX_WORLD_CREATURES', () => {
  const area = 4096 * 4096;
  const target = Math.round((18 * area) / 1000); // 'normal' perThousand = 18
  assert.ok(target > MAX_WORLD_CREATURES,
    `fixture no longer clamps (target ${target} <= ceiling ${MAX_WORLD_CREATURES}) -- pick a larger world`);
});
