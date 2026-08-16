// backend/tests/authored_maps_navigability.test.js
//
// SOMET-313: p5-descent has tests/p5_navigability.test.js, a fast DB-free
// guard that runs the EXACT check applyMapSpec runs at apply time over all 66
// generated worlds. The three HAND-AUTHORED specs -- hub-vale,
// spine-descent, loop-catacombs -- had nothing equivalent.
//
// That gap is not theoretical. SOMET-306/307 put every world onto a
// depth-derived size ramp, terrain is generated from (seed, size), and the
// resize re-rolled all 20 authored worlds' terrain: three of them came up
// sealed and needed retuned seeds (hub-vale/mire 2005->2006,
// loop-catacombs/eastwing 3003->3008, loop-catacombs/deepvault 3006->3009 --
// see 92aeb84). Nothing in the suite would have caught that.
// seed_map_db.test.js's "every shipped spec applies cleanly" loop is not the
// missing guard: it needs a database, does a full live apply, and throws on
// the FIRST failing spec, so it can only ever name one world.
//
// This file aggregates instead: every world of every authored spec is
// checked, and every problem found is reported in one message.
//
// TWO DOORWAY SETS, DELIBERATELY. A spec-only check is not sufficient for at
// least one world. hub-vale.map.json declares only `hub --S--> mire`, so the
// spec gives Blackfen Sinks a single N doorway; the live database also has
// `Rimehollow --W--> Blackfen Sinks`, an E doorway drawn by hand through the
// admin map-link graph (PUT /api/worlds/:id/links) on 2026-08-08 and not
// expressible in any spec (see 1714440164000's header: the live shape is not
// grid-representable, so hub-vale.map.json CANNOT declare it). Seed 2011 --
// what migration 1714440165000 installs -- passes at 96x96 against the
// spec's declared doorways and fails against the live set with
// "doorway E at (48,95) is unreachable". A guard that read only the spec
// would have waved that through. So both sets are covered: the spec leg is
// DB-free and always runs, the live leg reads real map_links rows and is the
// one that sees drift.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { fetchLinks } = require('../src/services/mapLinks.js');
const { requiredTilesFor } = require('../scripts/seed-map.js');
const { buildWorldGenConfig } = require('../src/services/worldGenConfig.js');
const { assertNavigable } = require('../src/services/navigability.js');
const { DEFAULT_TILE_TYPES } = require('../seeds/data/tileTypes.js');
const { STARTER_BIOMES } = require('../seeds/data/biomes.js');

const MAPS_DIR = path.join(__dirname, '..', 'seeds', 'maps');

// p5-descent is GENERATED (scripts/dungeon/gen-p5-map-content.js) and already
// has its own guard over the generator's output, which is the level that can
// actually regress there. Excluding it by name -- rather than listing the
// three authored files -- means a fourth hand-authored spec dropped into
// seeds/maps/ is covered here automatically, the same "nothing to register"
// promise .claude/skills/map-planner/SKILL.md makes authors.
const GENERATED_SPEC = 'p5-descent.map.json';

// Pinned so a spec that loses worlds cannot quietly shrink what this file
// checks. Not an exhaustive registry: an unlisted authored spec is still
// checked, it just has no pinned count of its own.
// SOMET-355: hub-vale (5) + spine-descent (8) + loop-catacombs (7) were merged
// into the single spec `vale-region`, so the doorways between them could be
// declared on one shared grid instead of living only as hand-drawn map_links
// rows. 20 is their sum -- a pin that still fails loudly if a world is dropped.
const EXPECTED_WORLD_COUNTS = {
  'vale-region.map.json': 20,
};

const specFiles = () => fs.readdirSync(MAPS_DIR)
  .filter((f) => f.endsWith('.map.json') && f !== GENERATED_SPEC)
  .sort();

const readSpec = (f) => JSON.parse(fs.readFileSync(path.join(MAPS_DIR, f), 'utf8'));

const SPECS = specFiles().map((file) => ({ file, spec: readSpec(file) }));

// Same reduction p5_navigability.test.js makes, for the same reason:
// assertNavigable only ever reads `def.walkable === false` off a tile-type
// entry, so `walkable` is the only field that has to survive the DB round
// trip loadTileTypes normally does. DEFAULT_TILE_TYPES is the checked-in
// source `make seed-catalogs` loads into Postgres, pinned equal to the live
// table by catalog_seed_data.test.js.
const TILE_TYPES = Object.fromEntries(
  DEFAULT_TILE_TYPES.map((t) => [t.name, { walkable: t.walkable }]),
);

// normalizeBiomes (mapService.js) reads only name/terrain_tiles/flora_types/
// creature_types off a biome record -- exactly what STARTER_BIOMES carries.
const BIOMES_BY_NAME = new Map(STARTER_BIOMES.map((b) => [b.name, b]));

const OPPOSITE_EDGE = { N: 'S', S: 'N', E: 'W', W: 'E' };

// What fetchLinks(client, worldId) returns for this world once setLink has
// written both a link's forward row and its mirror: every compass edge this
// world is on EITHER side of. Filtering on `l.from === w.key` alone would
// give a link's target zero doorway requirements while stampBounds still
// stamps a gap in its wall ring -- precisely the unchecked hole
// requiredTilesFor's header warns about.
function specDoorwaysFor(w, spec) {
  const edges = [];
  for (const l of spec.links || []) {
    if (l.kind === 'portal') continue;
    if (l.from === w.key) edges.push(l.edge);
    if (l.to === w.key) edges.push(OPPOSITE_EDGE[l.edge]);
  }
  return edges;
}

// fetchVillages' camelCase shape (services/villages.js) -- worldConfig reads
// v.minRow/minCol/gateEdge/spawnX/spawnY, not the spec's snake_case fields.
function villagesFor(w) {
  if (!w.village) return [];
  const v = w.village;
  return [{
    id: 0, minRow: v.min_row, minCol: v.min_col, width: v.width, height: v.height,
    gateEdge: v.gate_edge, spawnX: v.spawn_x, spawnY: v.spawn_y,
  }];
}

// The `worlds` row applyMapSpec would read back after its own upsert, rebuilt
// from the spec instead of from Postgres. Column names and defaults mirror
// that INSERT one for one (seed-map.js ~line 176): notably `authored_roads`
// comes from the spec's `roads`, and safe_road_radius/safe_rects default to
// 0/[] -- three authored worlds carry roads, and a road is walkable path
// tile, so dropping them here would make this check STRICTER than reality and
// could fail a world that is genuinely fine.
function rowFor(w) {
  return {
    seed: w.seed,
    chunk_size: w.chunk_size ?? 64,
    width: w.width,
    height: w.height,
    entry_spawn: w.entry_spawn || null,
    biome_cell: w.biome_cell ?? null,
    level_min: w.level_band ? w.level_band[0] : 1,
    level_max: w.level_band ? w.level_band[1] : 1,
    safe_road_radius: w.safe_road_radius ?? 0,
    safe_rects: w.safe_rects ?? [],
    authored_roads: w.roads ?? [],
  };
}

// One world, one doorway set -> the problems applyMapSpec would report, plus
// how many tiles were actually required. The count is not decoration: with an
// empty required list assertNavigable RETURNS [] before it generates a single
// tile, so a world reduced to zero requirements passes without being looked
// at. Callers assert on it.
function checkWorld(w, spec, row, doorways, villages) {
  const biomes = (w.biomes || []).map((n) => BIOMES_BY_NAME.get(n)).filter(Boolean);
  assert.equal(biomes.length, (w.biomes || []).length,
    `${w.key}: references a biome not present in STARTER_BIOMES`);
  const cfg = buildWorldGenConfig({ row, tileTypes: TILE_TYPES, doorways, villages, biomes });
  const required = requiredTilesFor(w, spec, row, doorways);
  return { problems: assertNavigable(cfg, required), required: required.length };
}

// --- What this file actually covers --------------------------------------

test('the hand-authored specs this file guards are on disk, at their pinned world counts', () => {
  const files = SPECS.map((s) => s.file);
  for (const name of Object.keys(EXPECTED_WORLD_COUNTS)) {
    assert.ok(files.includes(name), `${name} is missing from seeds/maps -- this guard covers nothing for it`);
  }
  // p5-descent must still exist and still be excluded, or the exclusion above
  // is silently covering nothing (or, worse, silently double-covering).
  assert.ok(fs.existsSync(path.join(MAPS_DIR, GENERATED_SPEC)),
    `${GENERATED_SPEC} is gone -- update the exclusion, and check p5_navigability.test.js still has a subject`);
  assert.ok(!files.includes(GENERATED_SPEC));

  for (const { file, spec } of SPECS) {
    const expected = EXPECTED_WORLD_COUNTS[file];
    if (expected === undefined) continue;
    assert.equal(spec.worlds.length, expected,
      `${file} has ${spec.worlds.length} worlds, pinned at ${expected} -- update this pin deliberately if that is meant to change`);
  }
});

// --- Leg 1: the specs as authored (no database) ---------------------------

test('every world in every hand-authored spec is navigable with its DECLARED doorways (offline, no DB)', () => {
  const allProblems = [];
  const unchecked = [];
  let checked = 0;
  for (const { file, spec } of SPECS) {
    for (const w of spec.worlds) {
      const row = rowFor(w);
      const { problems, required } = checkWorld(w, spec, row, specDoorwaysFor(w, spec), villagesFor(w));
      for (const p of problems) allProblems.push(`${file} ${w.key} (${row.width}x${row.height} seed ${row.seed}): ${p}`);
      if (required === 0) unchecked.push(`${file} ${w.key}`);
      checked += 1;
    }
  }

  // Non-vacuity: the loop above is the whole test, so a spec directory that
  // stopped yielding worlds would leave allProblems empty and pass.
  const expectedTotal = SPECS.reduce((n, s) => n + s.spec.worlds.length, 0);
  assert.equal(checked, expectedTotal);
  assert.ok(checked >= 20,
    `only ${checked} authored worlds checked -- the three shipped specs carry 20 between them`);
  // Every authored world is either the entry (entry_spawn) or on at least one
  // link, so none of them may reduce to zero required tiles.
  assert.deepEqual(unchecked, [],
    `world(s) with NO required tiles -- assertNavigable returns clean without generating anything for these:\n  - ${unchecked.join('\n  - ')}`);

  assert.deepEqual(allProblems, [],
    `${allProblems.length} navigability problem(s) across ${checked} hand-authored worlds:\n  - ${allProblems.join('\n  - ')}`);
});

// --- Leg 2: the doorways that actually exist (live database) --------------
//
// Read-only: SELECTs against worlds and map_links, nothing written, so this
// runs against a plain DATABASE_URL as well as TEST_DATABASE_URL.
const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

test('every authored world is navigable with its LIVE doorways, not just the ones its spec declares', async (t) => {
  if (!DB_URL) {
    const msg = 'neither TEST_DATABASE_URL nor DATABASE_URL is set -- skipping the live-doorway leg';
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  const pool = new Pool({ connectionString: DB_URL });
  try {
    try {
      await pool.query('SELECT 1');
    } catch (err) {
      t.skip(`NO DATABASE at ${DB_URL}: ${err.message}`);
      return;
    }

    const allProblems = [];
    const drift = [];
    const unchecked = [];
    let matched = 0;
    let absent = 0;
    for (const { file, spec } of SPECS) {
      for (const w of spec.worlds) {
        const wr = await pool.query('SELECT id FROM worlds WHERE name = $1', [w.name]);
        if (wr.rows.length === 0) { absent += 1; continue; }
        const links = await fetchLinks(pool, wr.rows[0].id);
        const doorways = links.filter((l) => l.edge !== 'PORTAL').map((l) => l.edge);
        // Deduped: setLink's mirror plus a second link into the same edge can
        // list an edge twice, and requiredTilesFor already builds a Set. Sorted
        // only so the drift report reads consistently.
        const live = [...new Set(doorways)].sort();
        const declared = [...new Set(specDoorwaysFor(w, spec))].sort();
        if (live.join() !== declared.join()) {
          drift.push(`${file} ${w.key}: declares [${declared}], live has [${live}]`);
        }
        // The spec's OWN seed and size against the LIVE doorway set: exactly
        // the combination applyMapSpec checks, because it upserts the spec's
        // values and then reads doorways back out of map_links -- which
        // carries links the spec never declared and seed-map.js never deletes.
        const row = rowFor(w);
        const { problems, required } = checkWorld(w, spec, row, live, villagesFor(w));
        for (const p of problems) {
          allProblems.push(`${file} ${w.key} (${row.width}x${row.height} seed ${row.seed}, live doorways [${live}]): ${p}`);
        }
        if (required === 0) unchecked.push(`${file} ${w.key}`);
        matched += 1;
      }
    }

    // Non-vacuity, twice over: a database with none of these worlds would
    // make the deepEqual below trivially true, and a world whose map_links
    // rows were all deleted would reach requiredTilesFor with no doorways --
    // assertNavigable early-returns clean on an empty required list, so that
    // world would "pass" without a single tile being generated.
    assert.notEqual(matched, 0,
      `none of the ${SPECS.reduce((n, s) => n + s.spec.worlds.length, 0)} authored worlds exist in this database by name -- nothing was checked`);
    assert.deepEqual(unchecked, [],
      `live world(s) with NO required tiles -- no entry_spawn and no map_links rows, so nothing was actually checked:\n  - ${unchecked.join('\n  - ')}`);

    assert.deepEqual(allProblems, [],
      `${allProblems.length} navigability problem(s) across ${matched} live authored world(s)`
      + `${absent ? ` (${absent} not present in this database)` : ''}:\n  - ${allProblems.join('\n  - ')}`
      + (drift.length
        ? `\n\nlive topology differs from the specs here (not itself a failure -- see this file's header):\n  - ${drift.join('\n  - ')}`
        : ''));
  } finally {
    await pool.end();
  }
});
