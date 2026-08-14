// SOMET-335 — put the entry world's entry_spawn back on its village's spawn
// tile.
//
// The invariant (SOMET-153's original acceptance criterion): a new character's
// first join and their respawn point are THE SAME TILE, and that tile is the
// starting village's spawn. Two migrations have written it before --
// 1714440175000 (SOMET-282) and 1714440201000 (SOMET-296) -- both by reading
// villages.spawn_x/spawn_y and writing it into worlds.entry_spawn, so the two
// numbers could not disagree.
//
// Neither is a lasting guarantee, because a migration runs once. applyMapSpec
// upserts worlds.entry_spawn from the checked-in spec on EVERY re-seed, and
// seeds/maps/hub-vale.map.json declared its entry world's entry_spawn as the
// geometric centre of the map while its village sat ~20 tiles away. Every
// re-seed since silently overwrote what those migrations had repaired. The
// live symptom was villageScreenBudget_db.test.js's "the entry world has a
// village and its entry_spawn IS that village spawn" failing with
// (6450,6450) against a village spawn of (4650,4550) on Vale Crossing.
//
// The DURABLE fix is not this migration -- it is the gate SOMET-335 added to
// validateMapSpec, which now refuses any spec whose entry world declares a
// village its entry_spawn is not the spawn of, and which map_spec_fixtures.
// test.js runs over the real checked-in specs. This migration only repairs the
// rows already written, in every environment rather than only on the machine
// that noticed. Without the validator it would be a symptom fix; with it, the
// spec can no longer re-break what this puts right.
//
// The statement is byte-for-byte 1714440201000's, deliberately: same
// invariant, same source of truth, same DISTINCT ON tiebreak (ordered by the
// BOX, because geometry is a property of the authored data while an id is a
// property of the insertion order that produced it). Restated rather than
// referenced because a migration must be correct when replayed against a
// database that ran neither of the earlier two.
//
// Idempotent by definition -- it recomputes the same value from the same
// rows -- and a no-op for an is_entry world that has no village.
//
// NOTE this writes only the Postgres row. The backend's world-preview cache,
// its minimap overview cache and the authority's in-memory copy of a live
// world all sit in its heap: RESTART THE BACKEND after running this against a
// running stack.

exports.shorthands = undefined;

const REPAIR = `
  UPDATE worlds w
     SET entry_spawn = jsonb_build_object('x', v.spawn_x, 'y', v.spawn_y),
         updated_at = now()
    FROM (SELECT DISTINCT ON (world_id) world_id, spawn_x, spawn_y
            FROM villages ORDER BY world_id, min_row, min_col, id) v
   WHERE v.world_id = w.id AND w.is_entry = true`;

exports.up = async (pgm) => {
  await pgm.db.query(REPAIR);
};

// Deliberately empty, for the same reason 1714440201000's `down` gives: `up`
// recomputes entry_spawn FROM the village row, which this migration never
// touches, so there is no prior value of its own to restore. Re-typing the
// centre-of-the-map coordinate it replaced would not be a revert -- it would
// re-introduce the defect and undo two earlier migrations' work at the same
// time.
exports.down = async () => {};
