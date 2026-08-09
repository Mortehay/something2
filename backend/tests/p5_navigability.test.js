// backend/tests/p5_navigability.test.js
//
// SOMET-251 final review, Important #1: the 14 hand-picked SEED_OVERRIDES in
// gen-p5-map-content.js (discovered via live-apply trial-and-error during
// Task 7) had zero automated regression coverage. seed_map_db.test.js's
// "every shipped spec applies cleanly" test iterates fs.readdirSync over
// backend/seeds/maps/*.map.json and throws on the FIRST failing spec --
// hub-vale's pre-existing "mire" navigability issue aborts that loop before
// p5-descent.map.json is ever reached, so a future change to grid spacing,
// dungeon ordering, or skeleton room count could silently break P5's
// navigability with no signal until someone runs `make seed-map` months
// later.
//
// This test closes that gap: it regenerates the spec with generateSpec() and
// runs the EXACT SAME offline navigability check seed-map.js's applyMapSpec
// runs at apply time (buildWorldGenConfig + assertNavigable + the same
// requiredTilesFor tile list), against every one of the 66 P5 worlds, with NO
// database involved -- catalog data (tile walkability, biome terrain lists)
// comes from backend/seeds/data/tileTypes.js and biomes.js, the same
// checked-in source-of-truth files `make seed-catalogs` loads into Postgres
// (pinned equal by catalog_seed_data.test.js), so this cannot drift from what
// a real seed would actually check. Fast (no DB, no live apply) and belongs
// in the normal suite.
const test = require('node:test');
const assert = require('node:assert');
const { generateSpec } = require('../scripts/dungeon/gen-p5-map-content.js');
const { requiredTilesFor } = require('../scripts/seed-map.js');
const { buildWorldGenConfig } = require('../src/services/worldGenConfig.js');
const { assertNavigable } = require('../src/services/navigability.js');
const { DEFAULT_TILE_TYPES } = require('../seeds/data/tileTypes.js');
const { STARTER_BIOMES } = require('../seeds/data/biomes.js');

// assertNavigable only ever reads `def.walkable === false` off a tile-type
// entry (see navigability.js) -- no other field it carries (color, speed,
// image, sprite...) affects reachability, so only `walkable` needs to survive
// the DB round trip loadTileTypes normally does.
const TILE_TYPES = Object.fromEntries(
  DEFAULT_TILE_TYPES.map((t) => [t.name, { walkable: t.walkable }]),
);

// normalizeBiomes (mapService.js) only reads name/terrain_tiles/flora_types/
// creature_types off a biome record -- exactly what STARTER_BIOMES already
// carries, unlike the DB row loadBiomes returns (which also has `id`, unused
// here).
const BIOMES_BY_NAME = new Map(STARTER_BIOMES.map((b) => [b.name, b]));

const OPPOSITE_EDGE = { N: 'S', S: 'N', E: 'W', W: 'E' };

// Mirrors what fetchLinks(client, worldId) returns for a world once setLink
// has written both a link's forward row and its mirror: every edge this
// world is either side of, in spec.links (portals excluded -- those aren't
// compass doorways).
function doorwaysFor(w, spec) {
  const edges = [];
  for (const l of spec.links) {
    if (l.kind === 'portal') continue;
    if (l.from === w.key) edges.push(l.edge);
    if (l.to === w.key) edges.push(OPPOSITE_EDGE[l.edge]);
  }
  return edges;
}

// Mirrors fetchVillages' camelCase shape (villages.js) -- worldConfig
// (mapService.js) reads v.minRow/minCol/gateEdge/spawnX/spawnY, not the spec's
// own snake_case village fields.
function villagesFor(w) {
  if (!w.village) return [];
  const v = w.village;
  return [{
    id: 0, minRow: v.min_row, minCol: v.min_col, width: v.width, height: v.height,
    gateEdge: v.gate_edge, spawnX: v.spawn_x, spawnY: v.spawn_y,
  }];
}

test('every P5 world in the generated spec is navigable (offline, no DB)', () => {
  const spec = generateSpec();
  assert.equal(spec.worlds.length, 66, 'expected the documented 66 P5 worlds -- update this test deliberately if that count is meant to change');

  const allProblems = [];
  for (const w of spec.worlds) {
    const doorways = doorwaysFor(w, spec);
    const villages = villagesFor(w);
    const biomes = (w.biomes || []).map((n) => BIOMES_BY_NAME.get(n)).filter(Boolean);
    assert.equal(biomes.length, (w.biomes || []).length,
      `${w.key}: references a biome not present in STARTER_BIOMES`);

    // Same shape buildWorldGenConfig's caller (seed-map.js) passes as `row` --
    // a DB worlds row, reconstructed here straight from the spec instead of
    // read back from Postgres.
    const row = {
      seed: w.seed, chunk_size: w.chunk_size, width: w.width, height: w.height,
      entry_spawn: w.entry_spawn || null, biome_cell: w.biome_cell,
      level_min: w.level_band ? w.level_band[0] : 1,
      level_max: w.level_band ? w.level_band[1] : 1,
    };
    const cfg = buildWorldGenConfig({ row, tileTypes: TILE_TYPES, doorways, villages, biomes });
    const required = requiredTilesFor(w, spec, row, doorways);
    const problems = assertNavigable(cfg, required);
    for (const p of problems) allProblems.push(`${w.key}: ${p}`);
  }

  assert.deepEqual(allProblems, [], `${allProblems.length} navigability problem(s) across the P5 spec:\n  - ${allProblems.join('\n  - ')}`);
});
