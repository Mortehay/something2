// The home region, applied to the live rows (SOMET-289).
//
// The entry world and its two direct compass neighbours become settled
// territory: a village each, an authored road joining every village gate to
// every doorway, a safe corridor two tiles wide either side of it, and four
// off-road pens of skittish level 1-2 wildlife. Everything beyond these three
// worlds is untouched -- hostile, banded, exactly as before.
//
// ---------------------------------------------------------------------------
// WHY A MIGRATION AS WELL AS THE SPECS. `make seed-map` is additive on what is
// already present: it skips village creation for any world that already has
// one, and the pen pass skips a world that already has penned creatures. So
// editing the two spec files alone would leave 86 live worlds unchanged, and
// re-seeding would print a warning rather than converge. Both must move
// together or they drift -- the same argument, and the same shape, as
// 1714440175000.
//
// The three worlds are matched BY NAME (worlds_name_unique, migration
// 1714440037000). The two specs that carry them are `spine-descent`
// (Old Trailhead, Windwatch Pass) and `hub-vale` (Thornbriar Reach) -- the
// Old Trailhead <-> Thornbriar link that makes them neighbours exists only in
// the live database and is in no checked-in spec.
//
// LITERALS, not a read of the spec files, for the frozen-history reason
// 1714440173000 states: a migration must do the same thing forever, and a later
// spec edit must not silently rewrite what this already applied.
// tests/home_region_db.test.js asserts the live rows equal the CHECKED-IN
// specs, so a divergence between these literals and those files fails there
// rather than sitting undetected.
//
// ---------------------------------------------------------------------------
// WHY IT CALLS APPLICATION CODE (createVillage, placePenCreatures), unlike
// 1714440173000 which deliberately inlined its constants: creating a village is
// a three-table write (the row with a merchant post derived from the box, two
// level-150 gate guards through scaleCreature, and the merchant's base
// catalog), and seating a pen means sampling generated terrain. Re-implementing
// either in SQL would be a fourth copy of the village geometry rules and a
// second copy of the terrain generator. Same judgement 1714440175000 made.
//
// ---------------------------------------------------------------------------
// MOVING A VILLAGE BOX INVALIDATES EVERY DERIVED POSITION ON IT -- spawn,
// merchant post, both guard posts. That is not a risk here: Old Trailhead's
// village is left EXACTLY where 1714440175000 put it (the authored road bends
// around it instead), and the two new villages are created by createVillage,
// which derives all four positions from the box itself. Every spawn below was
// checked against villageGeometryError and against the merchant and guard posts
// its own box produces, so none lands on the wall ring (SOMET-153) or on top of
// another occupant.

exports.shorthands = undefined;

const { createVillage, fetchVillages, GUARD_TYPE } = require('../src/services/villages.js');
const { pensOf, placePenCreatures, insertPenCreatures } = require('../src/services/pens.js');
const { buildWorldGenConfig } = require('../src/services/worldGenConfig.js');
const { loadTileTypes } = require('../src/services/tileTypes.js');
const { loadBiomes } = require('../src/services/biomes.js');
const { fetchLinks } = require('../src/services/mapLinks.js');
const { populateWorld } = require('../src/services/worldPopulation.js');

const TILE = 100;   // MAP_TILE_SIZE: world px per tile

// Byte-identical to the `safe_road_radius` / `roads` / `pens` / `village` keys
// in backend/seeds/maps/spine-descent.map.json and hub-vale.map.json.
const REGION = [
  {
    name: 'Old Trailhead',
    seed: 1001,
    safeRoadRadius: 2,
    // Enters at the west arrival tile (32,1), detours south around the village
    // box (rows 31..34, cols 30..35), leaves at the east arrival tile (32,62).
    // The second polyline joins the gate at (34,33) to that detour.
    roads: [
      [[32, 1], [32, 27], [37, 27], [37, 39], [32, 39], [32, 62]],
      [[35, 33], [37, 33]],
    ],
    pens: [
      { min_row: 12, min_col: 33, width: 6, height: 5, creature_type: 'Beast Swarm', count: 5, level: 1 },
      { min_row: 36, min_col: 15, width: 6, height: 5, creature_type: 'Woodland Swarm', count: 5, level: 1 },
    ],
    // Already exists, created by 1714440175000. Listed so `village` below can be
    // null and the loop stays uniform.
    village: null,
  },
  {
    name: 'Windwatch Pass',
    seed: 1002,
    safeRoadRadius: 2,
    // Four doorways, so a full cross joining all four arrival tiles, plus the
    // gate spur from (27,41) south to the east-west highway.
    roads: [
      [[32, 1], [32, 62]],
      [[1, 32], [62, 32]],
      [[28, 41], [32, 41]],
    ],
    pens: [
      { min_row: 10, min_col: 36, width: 6, height: 5, creature_type: 'Beast Swarm', count: 5, level: 2 },
    ],
    // Interior rows 25..26, cols 39..42. Spawn tile (25,39) is interior and is
    // neither the merchant post (25,41) nor either gate-guard post (26,40) /
    // (26,42).
    village: {
      min_row: 24, min_col: 38, width: 6, height: 4, gate_edge: 'S',
      spawn_x: 3950, spawn_y: 2550,
    },
  },
  {
    name: 'Thornbriar Reach',
    seed: 2002,
    safeRoadRadius: 2,
    roads: [
      [[32, 1], [32, 62]],
      [[29, 31], [32, 31]],
    ],
    pens: [
      { min_row: 36, min_col: 14, width: 6, height: 5, creature_type: 'Woodland Swarm', count: 5, level: 1 },
    ],
    // Interior rows 26..27, cols 29..32. Spawn tile (26,29) is interior and is
    // neither the merchant post (26,31) nor either gate-guard post (27,30) /
    // (27,32).
    village: {
      min_row: 25, min_col: 28, width: 6, height: 4, gate_edge: 'S',
      spawn_x: 2950, spawn_y: 2650,
    },
  },
];

async function worldByName(pgm, name) {
  const r = await pgm.db.query('SELECT * FROM worlds WHERE name = $1', [name]);
  return r.rows[0] || null;
}

exports.up = async (pgm) => {
  for (const w of REGION) {
    const row = await worldByName(pgm, w.name);
    // A bare or fixture database need not contain these worlds. Skipping is
    // correct: this migration moves live CONTENT, and content that is not there
    // has nothing to move.
    if (!row) continue;

    // --- the authored columns -------------------------------------------
    await pgm.db.query(
      `UPDATE worlds
          SET safe_road_radius = $2, authored_roads = $3::jsonb, pens = $4::jsonb,
              updated_at = now()
        WHERE id = $1`,
      [row.id, w.safeRoadRadius, JSON.stringify(w.roads), JSON.stringify(w.pens)],
    );

    // --- the village ------------------------------------------------------
    if (w.village) {
      // Hostiles first. createVillage stamps nothing itself, but the terrain
      // generator walls this footprint from the row, so anything standing
      // inside it would be sealed in -- and the epic's invariant is that only
      // Village Guards stand inside a village. Guards are excluded by type,
      // which IS the invariant rather than a proxy for it.
      const v = w.village;
      await pgm.db.query(
        `DELETE FROM world_creatures
          WHERE world_id = $1 AND type <> $2
            AND x >= $3 AND x < $4 AND y >= $5 AND y < $6`,
        [row.id, GUARD_TYPE,
          v.min_col * TILE, (v.min_col + v.width) * TILE,
          v.min_row * TILE, (v.min_row + v.height) * TILE],
      );
      // Idempotent: one village per world here. A second run finds the row and
      // skips createVillage, which would otherwise insert a duplicate village
      // plus two more guards and a second merchant catalog.
      const existing = await pgm.db.query('SELECT id FROM villages WHERE world_id = $1', [row.id]);
      if (existing.rows.length === 0) {
        await createVillage(pgm.db, row.id, v);
      }
    }

    // --- the pens ---------------------------------------------------------
    // Idempotent by the penned creature's own structural marker: a non-guard
    // world_creatures row carrying a home anchor. Note this must run AFTER the
    // village exists, both because the placer refuses village tiles and because
    // a village guard would otherwise be the only homed row and this check
    // excludes it by type.
    const penned = await pgm.db.query(
      `SELECT 1 FROM world_creatures
        WHERE world_id = $1 AND type <> $2 AND blocks_portal_id IS NULL
          AND home_x IS NOT NULL LIMIT 1`,
      [row.id, GUARD_TYPE],
    );
    if (penned.rows.length === 0 && w.pens.length > 0) {
      const fresh = await worldByName(pgm, w.name);
      const links = await fetchLinks(pgm.db, row.id);
      const world = buildWorldGenConfig({
        row: fresh,
        tileTypes: await loadTileTypes(pgm.db),
        doorways: links.filter((l) => l.edge !== 'PORTAL').map((l) => l.edge),
        villages: await fetchVillages(pgm.db, row.id),
        biomes: await loadBiomes(pgm.db, fresh.biomes),
      });
      for (const [i, pen] of pensOf(fresh).entries()) {
        const et = await pgm.db.query(
          'SELECT name, hp, defense FROM entity_types WHERE name = $1 AND is_creature = true',
          [pen.creatureType]);
        if (et.rows.length === 0) {
          throw new Error(
            `pen creature type "${pen.creatureType}" is missing from entity_types -- `
            + 'run `make seed-catalogs` before this migration');
        }
        // The SAME seed formula scripts/seed-map.js uses, so a world seeded
        // from the spec and a world migrated here lay their pens out
        // identically. A second formula would make the two paths disagree,
        // which is the class of bug worldPopulation.js was created to end.
        await insertPenCreatures(pgm.db, row.id,
          placePenCreatures(world, pen, et.rows[0], (w.seed ^ (0x9e37 + i)) >>> 0));
      }
    }

    // --- re-roll the wild hostiles ---------------------------------------
    // WITHOUT THIS THE WHOLE SLICE IS INERT ON LIVE DATA. safe_road_radius is a
    // SPAWN-TIME rule (SOMET-288), and these three worlds were populated long
    // before there was a corridor to avoid. Measured on the live database with
    // the columns set and before this step existed: 12 of 15 wild hostiles in
    // Old Trailhead, 9 of 15 in Windwatch Pass and 6 of 15 in Thornbriar Reach
    // were standing inside the new safe territory. A player would walk out of
    // the village gate onto a road covered in slimes and the feature would read
    // as broken -- which it would be.
    //
    // populateWorld is the ONE place a world's hostile population is written,
    // and applyMapSpec calls it in exactly this position for exactly this
    // reason. Its opening DELETE spares `type = 'Village Guard'`, a non-null
    // blocks_portal_id, and a non-null home_x -- so the two gate guards and the
    // pen creatures inserted moments ago survive, and running it HERE rather
    // than before the pen pass is what makes that sparing observable in this
    // migration rather than on some later seed.
    //
    // rngSeed is the world's own seed, matching applyMapSpec, so a world
    // migrated here and a world re-seeded from the spec scatter identically.
    //
    // The accepted cost, the same one `make seed-map` carries: killed creatures
    // come back and survivors move. Scoped to these three worlds; the other 83
    // are untouched.
    const populated = await worldByName(pgm, w.name);
    await populateWorld(pgm.db, populated, { rngSeed: w.seed });
  }

  // --- entry_spawn, READ OFF the entry village's row ----------------------
  // FROM the village, never re-typed: that is the "the two agree by
  // construction" half of the ticket, and the criterion SOMET-153 set and
  // 1714440175000 first delivered. Idempotent by definition (it recomputes the
  // same value), and a no-op for an is_entry world with no village. Restated
  // here rather than assumed from 1714440175000 because a migration must be
  // correct when replayed against a database that ran neither.
  await pgm.db.query(
    `UPDATE worlds w
        SET entry_spawn = jsonb_build_object('x', v.spawn_x, 'y', v.spawn_y),
            updated_at = now()
       FROM villages v
      WHERE v.world_id = w.id AND w.is_entry = true`,
  );

  // --- cached terrain ------------------------------------------------------
  // world_chunks caches generated terrain, and BOTH changes above reshape it:
  // stampVillage paints walls from the village row, and collectPathCells now
  // unions the authored roads into the path tiles. A world left with its old
  // chunks serves terrain the database no longer has -- the client draws a map
  // the authority does not collide against.
  //
  // NOTE this reaches only the cache that lives in Postgres. The backend's
  // world-preview cache, its minimap overview cache and the authority's
  // in-memory copy of a live world all sit in its heap: RESTART THE BACKEND
  // after running this against a running stack.
  await pgm.db.query(
    'DELETE FROM world_chunks WHERE world_id IN (SELECT id FROM worlds WHERE name = ANY($1::text[]))',
    [REGION.map((w) => w.name)],
  );
};

// `down` scopes every delete to the LITERALS above, which is what keeps it from
// clobbering a village or a pen an operator has since moved. The corollary bit
// while this migration was being written: editing a pen box in REGION and THEN
// running down leaves the old rows stranded, because down now searches the new
// box -- and the next `up` sees those strays, decides the world is already
// penned, and skips the pass. Always run `down` against the version of this
// file that ran the matching `up`.
exports.down = async (pgm) => {
  for (const w of REGION) {
    const row = await worldByName(pgm, w.name);
    if (!row) continue;

    // Pen creatures: matched by type AND by a home anchor inside the pen box
    // this migration authored, so a creature an operator has since placed
    // elsewhere survives. `home_x` rather than `x`: a creature roams, its
    // anchor does not.
    for (const pen of w.pens) {
      await pgm.db.query(
        `DELETE FROM world_creatures
          WHERE world_id = $1 AND type = $2 AND home_x IS NOT NULL
            AND home_x >= $3 AND home_x < $4 AND home_y >= $5 AND home_y < $6`,
        [row.id, pen.creature_type,
          pen.min_col * TILE, (pen.min_col + pen.width) * TILE,
          pen.min_row * TILE, (pen.min_row + pen.height) * TILE],
      );
    }

    // The two villages this migration created. Old Trailhead's `village` is
    // null, so its village -- created by 1714440175000 and left untouched
    // here -- is correctly not deleted. Scoped to the exact box, so a village
    // an operator has since moved survives. merchant_stock is ON DELETE CASCADE
    // from the villages row, so the base catalog goes with it; the gate guards
    // are world_creatures rows with no FK, so they are deleted by their posts.
    if (w.village) {
      const v = w.village;
      const del = await pgm.db.query(
        `DELETE FROM villages
          WHERE world_id = $1 AND min_row = $2 AND min_col = $3 AND width = $4 AND height = $5
         RETURNING id`,
        [row.id, v.min_row, v.min_col, v.width, v.height],
      );
      if (del.rows.length > 0) {
        // villageGatePosts for a gate-S box: the two interior tiles flanking
        // the gate, at row (min_row + height - 2) and cols midCol-1 / midCol+1.
        const postRow = (v.min_row + v.height - 2) * TILE + TILE / 2;
        const midCol = v.min_col + Math.floor(v.width / 2);
        await pgm.db.query(
          `DELETE FROM world_creatures
            WHERE world_id = $1 AND type = $2 AND home_y = $3 AND home_x = ANY($4::real[])`,
          [row.id, GUARD_TYPE, postRow,
            [(midCol - 1) * TILE + TILE / 2, (midCol + 1) * TILE + TILE / 2]],
        );
      }
    }

    await pgm.db.query(
      `UPDATE worlds
          SET safe_road_radius = 0, authored_roads = '[]'::jsonb, pens = '[]'::jsonb,
              updated_at = now()
        WHERE id = $1`,
      [row.id],
    );
  }

  // entry_spawn is deliberately NOT restored: `up` recomputed it from Old
  // Trailhead's village, which this migration never touched, so the value it
  // wrote is the value 1714440175000 already had there. There is nothing to
  // put back, and re-typing the pre-1714440175000 centre-of-the-map coordinate
  // would undo a different migration's work.
  //
  // HONEST LIMITATION, the same one 1714440175000 records, and wider here: the
  // wild hostiles in these three worlds are not put back where they were. `up`
  // re-rolled them through populateWorld (they had to move -- most were standing
  // in what became safe territory), and nothing records their previous
  // positions. Resetting safe_road_radius to 0 above means a re-roll now scatters
  // them across the whole map again, which is the pre-migration DISTRIBUTION but
  // not the pre-migration creatures. Deliberately not re-run here: a `down` that
  // silently re-rolls three worlds' populations a second time would destroy more
  // than it restores. Use POST /api/worlds/:id/creatures if a repopulate is
  // wanted; putting arbitrary creatures back at guessed coordinates would be
  // inventing data.

  await pgm.db.query(
    'DELETE FROM world_chunks WHERE world_id IN (SELECT id FROM worlds WHERE name = ANY($1::text[]))',
    [REGION.map((w) => w.name)],
  );
};
