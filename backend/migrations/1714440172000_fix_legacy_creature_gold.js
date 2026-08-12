// SOMET-155: four legacy creatures are underpaid versus identically-statted peers.
//
// Gold scales by BEHAVIOUR RUNG, not by hp. loot.js's spawnDrops picks the
// creature's OWN entity_types.gold_min/gold_max whenever gold_max > 0, and only
// falls back to the rung's creature_behaviors.gold_min/gold_max when it doesn't:
//
//   const goldAmt = rollGold(typeRange.max > 0 ? typeRange : rungRange, rng);
//
// 289 of the 293 creature types carry 0/0 and therefore correctly inherit their
// rung. Wolf, Slime, Skeleton and Bat still carry ranges derived from their
// PRE-SOMET-250 hp by 1714440031000_gold_economy.js's formula
// (GREATEST(1, floor(hp/10)) .. floor(hp/4) on hp 12/18/14/8). SOMET-250 retuned
// all four to the Line rung (hp 30, defense 3) but left the gold behind, so a
// non-zero stale range permanently outranks Line's 1-5 and these four can never
// be paid at their rung's rate:
//
//   Bat 1-2, Skeleton 1-3, Wolf 1-3, Slime 1-4   vs.   Line rung 1-5
//
// Zeroing them makes them fall through to the rung — verified before writing
// this: all four have behavior_id pointing at the Line rung, whose own range is
// 1-5, so they gain gold rather than losing it (0/0 does NOT mean "no gold",
// it means "no range of my own").
//
// A NEW migration rather than an edit to the seed alone: scripts/seed-catalogs.js
// inserts entity_types with `ON CONFLICT (name) DO NOTHING`, so the seed change
// only reaches a FRESH database. Existing rows need this UPDATE.
//
// TARGETED and IDEMPOTENT by construction: each UPDATE matches the creature by
// name AND by the exact stale (gold_min, gold_max) pair recorded below. Re-running
// it matches nothing (the row is already 0/0), and a range an admin deliberately
// sets later — any value other than the stale pair — is left completely alone.
// That is why this is four one-row statements and not a single
// `WHERE name IN (...)`.
const LEGACY_GOLD = [
  { name: 'Wolf', min: 1, max: 3 },
  { name: 'Slime', min: 1, max: 4 },
  { name: 'Skeleton', min: 1, max: 3 },
  { name: 'Bat', min: 1, max: 2 },
];

exports.up = (pgm) => {
  for (const c of LEGACY_GOLD) {
    pgm.sql(`
      UPDATE entity_types
         SET gold_min = 0, gold_max = 0
       WHERE name = '${c.name}'
         AND gold_min = ${c.min} AND gold_max = ${c.max}
    `);
  }
};

exports.down = (pgm) => {
  // Restores the exact pre-migration values, and only onto a row that is still
  // in the state `up` left it (0/0) — so a range set after the migration ran is
  // not clobbered on the way back down either. Symmetric with `up`: down-then-up
  // is a no-op, and so is up-then-down.
  for (const c of LEGACY_GOLD) {
    pgm.sql(`
      UPDATE entity_types
         SET gold_min = ${c.min}, gold_max = ${c.max}
       WHERE name = '${c.name}'
         AND gold_min = 0 AND gold_max = 0
    `);
  }
};
