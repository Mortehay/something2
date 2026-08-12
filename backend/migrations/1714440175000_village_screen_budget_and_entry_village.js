// SOMET-282 — two changes, both about villages, both needing the live rows
// moved as well as the checked-in specs.
//
// ---------------------------------------------------------------------------
// PART 1: the three p5-descent hubs are too big for the screen.
//
// services/villages.js now caps a village at VILLAGE_LIMITS.maxSum = 10 tiles
// of width + height, derived there from ISO_K (0.64), MAP_TILE_SIZE (100) and
// the fixed 1280x720 viewport: the on-screen BOUNDING BOX of a w x h village
// is 64(w+h) x 32(w+h) px, i.e. 2048(w+h)^2 px^2, and the budget is a quarter
// of the viewport = 230400 px^2. 6x5 = 11 tiles = 704x352 = 247808 px^2 = 108%
// of that budget. 6x4 = 10 tiles = 640x320 = 204800 px^2 = 89%.
//
// "The Underdeep: Hub", "The Frozen Vaults: Hub" and "The Abyss: Hub" all
// carry the identical 6x5 box at min_row 28 / min_col 28, gate S. Dropping
// height to 4 moves the south wall from row 32 to row 31, which moves the
// interior (rows 29..31 -> 29..30) and therefore invalidates every derived
// position on the row:
//
//   spawn     3150,3150 = tile (row 31, col 31) -- was the last interior row,
//             is now the SOUTH WALL RING. Left alone this re-creates the exact
//             SOMET-153 defect (respawn inside a wall).
//   merchant  3150,3050 = tile (row 30, col 31) -- villageMerchantPost for the
//             new box is (row 29, col 31).
//   guards    3050,3150 / 3250,3150 = tiles (row 31, cols 30/32) -- also the
//             new wall ring; villageGatePosts for the new box is
//             (row 30, cols 30/32).
//
// The replacements below are villageMerchantPost / villageGatePosts /
// villageSpawnError evaluated on the NEW box, written as literals for the
// frozen-history reason migration 1714440173000 states. tests/
// village_screen_budget_db.test.js recomputes all of them from the live rows
// with the real helper functions, so a wrong literal here fails there rather
// than sitting undetected.
//
// The new spawn is tile (row 29, col 30), not the just-inside-the-gate tile
// (row 30, col 31) SOMET-153 chose for the 6x5 box. Two reasons: (row 30, col
// 31) is one row above the new wall ring, and a player is a 64px square placed
// by its TOP-LEFT corner, so a spawn there would put a quarter of the player
// inside the south wall; and (row 29, col 31) is the merchant post. (row 29,
// col 30) keeps the whole player square in the interior and is free of both
// the merchant and the two gate guards. It is also byte-identical to the spawn
// Vale Crossing -- the one village already shipping a legal 6x4 box -- uses.
//
// ---------------------------------------------------------------------------
// PART 2: the entry world finally gets a village, and entry_spawn comes FROM
// it (SOMET-153's original acceptance criterion, never actually delivered).
//
// "Old Trailhead" is the only is_entry world: 64x64 tiles, band 1-2, compass
// links W and E only (no portals). A 6x4 box at min_row 31 / min_col 30, gate
// S, covers rows 31..34 and cols 30..35 -- it contains the historical entry
// spawn tile (32,32) and comes nowhere near the two doorway tiles (row 32,
// col 0) and (row 32, col 63) or their arrival tiles, so neither exit is
// blocked. Offline navigability (the assertNavigable check seed-map.js runs at
// apply time) passes with the village stamped: the gate tile is walkable, so
// the interior stays connected to the rest of the map.
//
// entry_spawn moves 3250,3250 -> 3150,3250 = the village's own spawn tile
// (row 32, col 31), and it is written FROM villages.spawn_x/spawn_y rather
// than re-typed, so the two cannot disagree. That tile is interior, is not the
// merchant post (row 32, col 33) or either gate-guard post (row 33, cols 32
// and 34), and leaves the whole 64px player square inside the interior.
//
// Hostiles inside the box are deleted: the epic's invariant is that only
// Village Guards stand inside a village footprint, and seven Slimes are
// currently clustered on the old entry spawn -- createVillage would otherwise
// wall them in. They are matched by position at migration time (they have
// roamed away from their spawn tiles), so `down` cannot put them back; see
// its comment.
//
// ---------------------------------------------------------------------------
// WHY THIS MIGRATION CALLS APPLICATION CODE (createVillage), unlike 1714440173000
// which deliberately inlined its constants: creating a village is a
// three-table write -- the villages row with a merchant post derived from the
// box, two level-scaled gate guards (SOMET-279's scaleCreature curve, which is
// exactly what "guards must be created via insertVillageGuards" means), and
// the merchant's base catalog from item_types. Re-implementing all three in
// SQL would be a fourth copy of the village geometry rules and a second copy
// of the base-catalog query, which is a worse failure mode than the migration
// tracking the curve. services/villages.js and its requires have no top-level
// pool creation, so this stays safe to require from a migration.

exports.shorthands = undefined;

const { createVillage, GUARD_TYPE } = require('../src/services/villages.js');

const HUB_BOX = "min_row = 28 AND min_col = 28 AND width = 6 AND gate_edge = 'S'";

const ENTRY_VILLAGE = {
  min_row: 31, min_col: 30, width: 6, height: 4, gate_edge: 'S',
  spawn_x: 3150, spawn_y: 3250,
};
// The box in world pixels: cols 30..35 -> x [3000,3600), rows 31..34 ->
// y [3100,3500). MAP_TILE_SIZE is 100.
const ENTRY_BOX_PX = { x0: 3000, x1: 3600, y0: 3100, y1: 3500 };

async function entryWorldId(pgm) {
  const r = await pgm.db.query('SELECT id FROM worlds WHERE is_entry = true ORDER BY created_at ASC LIMIT 1');
  return r.rows[0] ? r.rows[0].id : null;
}

exports.up = async (pgm) => {
  // --- Part 1a: move the guards BEFORE the box shrinks -------------------
  // Scoped by `height = 5`, which is what makes both this and the box update
  // below idempotent: after the box update the subquery matches nothing, so a
  // second run is a no-op. Each guard is identified by the post it is standing
  // on, so the left guard goes to the left post and the right to the right.
  for (const [oldX, oldY, newX, newY] of [
    [3050, 3150, 3050, 3050],
    [3250, 3150, 3250, 3050],
  ]) {
    await pgm.db.query(
      `UPDATE world_creatures
          SET x = $3, y = $4, home_x = $3, home_y = $4, updated_at = now()
        WHERE type = $5
          AND home_x = $1 AND home_y = $2
          AND world_id IN (SELECT world_id FROM villages WHERE ${HUB_BOX} AND height = 5)`,
      [oldX, oldY, newX, newY, GUARD_TYPE],
    );
  }

  // --- Part 1b: shrink the box and re-derive spawn + merchant ------------
  await pgm.db.query(
    `UPDATE villages
        SET height = 4,
            spawn_x = 3050, spawn_y = 2950,
            merchant_x = 3150, merchant_y = 2950
      WHERE ${HUB_BOX} AND height = 5`,
  );

  // --- Part 2a: the entry world's village --------------------------------
  const worldId = await entryWorldId(pgm);
  if (!worldId) return;   // no entry world (a bare/test database): nothing to do

  // Hostiles first: createVillage stamps nothing itself, but the terrain
  // generator walls this footprint from the row, and a Slime left inside it
  // would be sealed in. Guards are excluded by type, which is the invariant
  // itself ("only Village Guards stand inside a village box"), not a proxy
  // for it.
  await pgm.db.query(
    `DELETE FROM world_creatures
      WHERE world_id = $1 AND type <> $2
        AND x >= $3 AND x < $4 AND y >= $5 AND y < $6`,
    [worldId, GUARD_TYPE, ENTRY_BOX_PX.x0, ENTRY_BOX_PX.x1, ENTRY_BOX_PX.y0, ENTRY_BOX_PX.y1],
  );

  // Idempotent: one village per entry world. A second run finds the row and
  // skips createVillage entirely (which would otherwise insert a duplicate
  // village plus two more guards).
  const existing = await pgm.db.query('SELECT id FROM villages WHERE world_id = $1', [worldId]);
  if (existing.rows.length === 0) {
    await createVillage(pgm.db, worldId, ENTRY_VILLAGE);
  }

  // --- Part 2b: entry_spawn, read off the village row --------------------
  // FROM the village, never re-typed: this is the "the two agree by
  // construction" half of the ticket. Idempotent by definition (it recomputes
  // the same value), and a no-op for any is_entry world that has no village.
  await pgm.db.query(
    `UPDATE worlds w
        SET entry_spawn = jsonb_build_object('x', v.spawn_x, 'y', v.spawn_y),
            updated_at = now()
       FROM villages v
      WHERE v.world_id = w.id AND w.is_entry = true`,
  );

  // --- Cached terrain -----------------------------------------------------
  // world_chunks caches generated terrain, and stampVillage paints the walls
  // from the village row at generation time. Every world touched above needs
  // its cache dropped or it keeps serving the pre-change map (the entry world
  // has 16 cached chunks; the three hubs have none, but that is a fact about
  // today's database, not a guarantee). Scoped to the four worlds this
  // migration actually changed -- Vale Crossing's village is untouched and its
  // cache has no reason to be thrown away.
  await pgm.db.query(
    `DELETE FROM world_chunks
      WHERE world_id = $1
         OR world_id IN (SELECT world_id FROM villages WHERE ${HUB_BOX} AND height = 4)`,
    [worldId],
  );
};

exports.down = async (pgm) => {
  // --- Part 2 reversed ----------------------------------------------------
  const worldId = await entryWorldId(pgm);
  if (worldId) {
    // The village row first: merchant_stock is ON DELETE CASCADE from it, so
    // the base catalog goes with it. Scoped by the exact box this migration
    // created, so a village an operator has since added or moved survives.
    const del = await pgm.db.query(
      `DELETE FROM villages
        WHERE world_id = $1 AND min_row = $2 AND min_col = $3 AND width = $4 AND height = $5
       RETURNING id`,
      [worldId, ENTRY_VILLAGE.min_row, ENTRY_VILLAGE.min_col, ENTRY_VILLAGE.width, ENTRY_VILLAGE.height],
    );
    if (del.rows.length > 0) {
      // Guards are world_creatures rows with no FK to the village, so the
      // cascade above does not reach them. Scoped to the two posts this
      // village's geometry produces.
      await pgm.db.query(
        `DELETE FROM world_creatures
          WHERE world_id = $1 AND type = $2
            AND (home_x, home_y) IN ((3250, 3350), (3450, 3350))`,
        [worldId, GUARD_TYPE],
      );
    }
    // The pre-migration entry_spawn, the centre of a 64x64 world -- the value
    // the checked-in spec carried before this ticket.
    await pgm.db.query(
      `UPDATE worlds SET entry_spawn = '{"x": 3250, "y": 3250}'::jsonb, updated_at = now()
        WHERE id = $1`,
      [worldId],
    );
    // HONEST LIMITATION: the hostiles deleted from the footprint are not
    // restored. They were matched by their live positions (already roamed away
    // from wherever they were placed), so nothing here records what they were.
    // Re-rolling the world's creatures (POST /api/worlds/:id/creatures)
    // repopulates it; putting arbitrary Slimes back at guessed coordinates
    // would be inventing data.
  }

  // --- Part 1 reversed ----------------------------------------------------
  // Exactly the pre-migration hub state. Scoped by BOTH the box and the
  // corrected spawn so it cannot clobber a village since moved by hand, and
  // re-running it is a no-op.
  await pgm.db.query(
    `UPDATE villages
        SET height = 5,
            spawn_x = 3150, spawn_y = 3150,
            merchant_x = 3150, merchant_y = 3050
      WHERE ${HUB_BOX} AND height = 4
        AND spawn_x = 3050 AND spawn_y = 2950`,
  );

  for (const [oldX, oldY, newX, newY] of [
    [3050, 3050, 3050, 3150],
    [3250, 3050, 3250, 3150],
  ]) {
    await pgm.db.query(
      `UPDATE world_creatures
          SET x = $3, y = $4, home_x = $3, home_y = $4, updated_at = now()
        WHERE type = $5
          AND home_x = $1 AND home_y = $2
          AND world_id IN (SELECT world_id FROM villages WHERE ${HUB_BOX} AND height = 5)`,
      [oldX, oldY, newX, newY, GUARD_TYPE],
    );
  }

  // Same four worlds as `up`. The entry world is named explicitly because it
  // no longer has a village row to be found through.
  await pgm.db.query(
    `DELETE FROM world_chunks
      WHERE world_id = $1
         OR world_id IN (SELECT world_id FROM villages WHERE ${HUB_BOX} AND height = 5)`,
    [worldId],
  );
};
