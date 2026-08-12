exports.shorthands = undefined;

// SOMET-153: three seeded villages have their spawn/respawn point ON the
// village wall ring instead of inside it.
//
// THE DEFECT. stampVillage (src/services/mapService.js) walls the entire
// perimeter of a village box and leaves exactly one passable gate tile. The
// three p5-descent hubs -- "The Underdeep: Hub", "The Frozen Vaults: Hub" and
// "The Abyss: Hub" -- were seeded with min_row 28, min_col 28, 6 wide x 5
// high, gate S, spawn (3250,3250). At 100 px per tile (MAP_TILE_SIZE, both
// authority/collision.js and the frontend's core/constants.js) that pixel is
// tile (row 32, col 32): rMax = 28 + 5 - 1 = 32, so it is the SOUTH wall ring,
// and it is not the gate either (the S gate is col = 28 + floor(6/2) = 31).
// Respawn-at-village therefore teleported the player INSIDE a wooden_wall
// tile, out of which the only escape was southward.
//
// WHY THE SEED PATH LET IT THROUGH. The HTTP admin route validates an
// interior spawn (validateVillageBody), but scripts/seed-map.js calls
// createVillage directly and seeds/mapSpec.js checked only width/height/
// gate_edge. Both call sites now share villageSpawnError() in
// src/services/villages.js, and the checked-in spec has been corrected, so
// re-seeding a fresh database produces the fixed value. This migration exists
// for databases that were ALREADY seeded from the broken spec -- seed-map.js
// is idempotent per world ("one village per seeded world") and will never
// rewrite an existing villages row.
//
// THE CORRECTED SPAWN. The tile just inside the gate, which is what the gate
// guards flank and what a player walking in through the gate steps onto. For
// the three hubs that is tile (row 31, col 31) -> pixel centre (3150,3150).
// Computed here from each row's own geometry rather than hardcoded, so a
// village with different bounds or a different gate edge is repaired
// correctly too. Clamped into the interior so a minimum-size 3x3 village
// still yields a legal tile -- the same clamping villageGatePosts and
// villageMerchantPost use.
const TILE = 100;

// Interior bounds and the just-inside-the-gate tile, as SQL over the row's own
// columns. Kept in one string so `up` and the verification in `down` cannot
// disagree about what "interior" means.
const GEOMETRY = `
  min_row + 1                       AS lo_row,
  min_row + height - 2              AS hi_row,
  min_col + 1                       AS lo_col,
  min_col + width  - 2              AS hi_col,
  min_row + (height / 2)            AS mid_row,
  min_col + (width  / 2)            AS mid_col,
  floor(spawn_x::numeric / ${TILE})::int AS s_col,
  floor(spawn_y::numeric / ${TILE})::int AS s_row
`;

// The three rows this migration was written for, identified by the exact
// broken geometry the spec produced. `down` uses this; `up` deliberately does
// not, so it also repairs a village broken some other way.
const BROKEN_SHAPE = `min_row = 28 AND min_col = 28 AND width = 6 AND height = 5
                      AND gate_edge = 'S'`;

exports.up = (pgm) => {
  // Idempotent: the WHERE clause only matches rows whose spawn is currently
  // OUTSIDE the interior, so a second run (or a database seeded from the
  // already-corrected spec) updates nothing. Villages with a valid spawn --
  // e.g. Vale Crossing, spawn (3050,2950) = tile (row 29, col 30) inside its
  // 6x4 box -- are never touched.
  pgm.sql(`
    WITH g AS (
      SELECT id, gate_edge, ${GEOMETRY}
        FROM villages
    ),
    broken AS (
      SELECT g.*,
             CASE g.gate_edge
               WHEN 'S' THEN g.hi_row
               WHEN 'N' THEN g.lo_row
               ELSE LEAST(g.hi_row, GREATEST(g.lo_row, g.mid_row))
             END AS fix_row,
             CASE g.gate_edge
               WHEN 'W' THEN g.lo_col
               WHEN 'E' THEN g.hi_col
               ELSE LEAST(g.hi_col, GREATEST(g.lo_col, g.mid_col))
             END AS fix_col
        FROM g
       WHERE NOT (g.s_row BETWEEN g.lo_row AND g.hi_row
              AND g.s_col BETWEEN g.lo_col AND g.hi_col)
    )
    UPDATE villages v
       SET spawn_x = broken.fix_col * ${TILE} + ${TILE / 2},
           spawn_y = broken.fix_row * ${TILE} + ${TILE / 2}
      FROM broken
     WHERE v.id = broken.id
  `);
};

// Reverses exactly what this migration was written to change: the three
// p5-descent hubs, back to the (3250,3250) they were seeded with. Scoped by
// both the broken box geometry AND the corrected spawn, so it cannot clobber
// a village an operator has since moved, and re-running it is a no-op.
//
// Honest limitation, stated rather than hidden: `up` is generic, so on some
// other database it could also have repaired a village broken in a way this
// migration never saw. That row's original spawn is not recorded anywhere, so
// `down` cannot restore it -- and putting a player back inside a wall would
// be the wrong thing to do even if it could.
exports.down = (pgm) => {
  pgm.sql(`
    UPDATE villages
       SET spawn_x = 3250, spawn_y = 3250
     WHERE ${BROKEN_SHAPE}
       AND spawn_x = 3150 AND spawn_y = 3150
  `);
};
