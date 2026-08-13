exports.shorthands = undefined;

// SOMET-291 — a gate guard's leash reaches past its own gate.
//
// THE DEFECT. `creature_behaviors.Guard` shipped with aggro_radius 400 and
// leash_radius 300. Both numbers are read by the guard branch of
// authority/creatures.js's tick, and the leash is applied twice: once as a
// filter on which hostiles selectGuardTarget may even consider (measured from
// the guard's POST, not from the guard), and once as a clamp refusing any chase
// step that would leave the post's radius. A leash shorter than the aggro
// radius therefore makes the aggro radius fiction -- and 300 is shorter than
// the guard's own village. What a player sees is a guard chasing the thing that
// is killing them to an invisible line four tiles from the gate, stopping,
// dropping the target (the held-target check is
// withinLeash(target, home, leash) too), and walking home.
//
// THE DERIVATION. 600 = 6 tiles. Redo it if any input moves; every input is
// named with the file it lives in, and services/villages.js's
// guardRescueLeashTerms() is the executable form of exactly this arithmetic
// (guard_rescue_leash.test.js fails if the row below stops matching it).
//
//   MAP_TILE_SIZE       = 100 world px / tile     (authority/coords.js)
//   GUARD_AGGRO_RADIUS  = 400 px                  (authority/creatures.js)
//   VILLAGE_LIMITS      = w in 3..8, h in 3..6, w + h <= 10  (services/villages.js;
//                         the sum cap is SOMET-282's on-screen budget)
//   guard posts         = the two INTERIOR tiles flanking the gate, clamped
//                         into the interior box (mapService.villageGatePosts)
//   gate                = the mid tile of the gate edge (mapService.villageGatePoint)
//
// Three things a guard must be able to do, each measured over EVERY legal
// (w, h, gateEdge) and both posts, never over one hand-picked village:
//
//  1. Engage everything it can see.                        -> 400 px
//     Anything less and the leash filter, not the aggro radius, decides what a
//     guard will fight.
//
//  2. Fight anywhere inside its own village.               -> 400 px
//     Worst box: 7x3 with the gate on a short (E/W) edge. Its interior is a
//     single 5-tile row; both posts clamp onto the one interior tile beside the
//     gate, and the far end of that row is 4 tiles = 400 px away. A hostile that
//     follows a fleeing player through the gate can stand exactly there.
//
//  3. Finish an interception at the doorway.               -> 541.42 px
//     A post is at worst one diagonal tile from the gate (sqrt(2) * 100 =
//     141.42), and a guard that has walked to its gate should still be allowed
//     to hold a hostile out to the edge of the aggro radius it had when it got
//     there: 141.42 + 400 = 541.42.
//
//   max(400, 400, 541.42) = 541.42  ->  rounded up to a whole tile: 600.
//
// Rounded up because every other distance in this geometry is a tile multiple;
// a leash of 541.42 would read as a measurement rather than a decision.
//
// WHAT THIS IS NOT. It is not a licence to roam. selectGuardTarget still bounds
// ACQUISITION by aggro_radius from the guard's current position, so a guard
// standing its post notices exactly what it noticed before this migration. The
// leash governs only how far an engagement that has already started may travel,
// and SOMET-154's walk-home path search brings the guard back afterwards.
//
// WHY authority/creatures.js's GUARD_LEASH_RADIUS STAYS AT 300. That constant
// is not the live number: it builds GUARD_DEFAULT_BEHAVIOR, the fallback for a
// creature whose entity_types.behavior_id is NULL, and its documented job is
// reproducing pre-catalog behaviour byte for byte. Every live guard is
// profiled -- migration 1714440081000 points Village Guard at this row -- so
// the fallback is reached only by hand-built test fixtures. The divergence is
// deliberate and is asserted, not left to be discovered, in
// creature_behaviors_invariants.test.js.
const GUARD_LEASH_BEFORE = 300;
const GUARD_LEASH_AFTER = 600;

// Scoped by name and by the value being replaced. `creature_behaviors.name` is
// unique (1714440080000_creature_behaviors.js), so the name alone would be
// enough -- the leash_radius predicate makes the statement IDEMPOTENT and, more
// to the point, makes it refuse to run against a row an admin has already
// retuned through the behaviours API rather than silently overwriting them. The
// incident recorded in 1714440191000's header is a WHERE clause that matched
// 94 rows it should not have.
exports.up = (pgm) => {
  pgm.sql(`
    UPDATE creature_behaviors
       SET leash_radius = ${GUARD_LEASH_AFTER}
     WHERE name = 'Guard' AND leash_radius = ${GUARD_LEASH_BEFORE}
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    UPDATE creature_behaviors
       SET leash_radius = ${GUARD_LEASH_BEFORE}
     WHERE name = 'Guard' AND leash_radius = ${GUARD_LEASH_AFTER}
  `);
};

// Exported so the tests can assert the migration's own before/after rather than
// re-typing them, the same way 1714440080000's BEHAVIORS array is imported by
// creature_behaviors_invariants.test.js.
exports.GUARD_LEASH_BEFORE = GUARD_LEASH_BEFORE;
exports.GUARD_LEASH_AFTER = GUARD_LEASH_AFTER;
