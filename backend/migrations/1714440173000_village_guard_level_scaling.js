// SOMET-279 — village guards are not level-scaled.
//
// Two separate breakages, both fixed here:
//
//  1. Every world_creatures row of type 'Village Guard' was written with
//     level 1, hp 300, damage at the column default (5) and defense NULL,
//     regardless of its world's level band. This migration lifts the eight
//     live rows (4 villages x 2 guards) to their world's band.
//
//  2. Even a correctly-written per-row `damage` was INERT for guards. The
//     tick computes a creature's hit as
//         (bh.damageOverride ?? c.damage) * ...      (authority/creatures.js)
//     and the seeded 'Guard' behaviour carries damage_override = 25, so the
//     behaviour row SHADOWED world_creatures.damage for every guard that has
//     ever existed. A guard therefore hit for a flat 25 forever, which the
//     applyDamage floor (raw - defense, min 1) turns into literally 1 damage
//     against a level-46+ hostile: The Abyss: Hub's guards could not dent a
//     level-50 Void Line (defense 27.5) in ten minutes of standing next to
//     it. Nulling the override is what lets the per-instance value through;
//     'Guard' is the only behaviour with a damage_override, and 'Village
//     Guard' is the only entity type using the 'Guard' behaviour, so nothing
//     else in the catalog changes meaning.
//
// KNOWN FOLLOW-UP (not fixable from this ticket's file ownership):
// seeds/data/creatureBehaviors.js still authors `damage_override: 25` for
// Guard, and scripts/seed-catalogs.js writes it on both INSERT and UPDATE
// (COALESCE($7, ...) with $7 = 25 keeps 25). So re-running the catalog seeder
// RESTORES the override and re-breaks guard damage. Removing it there also
// means retiring GUARD_DAMAGE's role in authority/creatures.js and updating
// creature_behaviors_invariants.test.js, both files owned by other work in
// flight. tests/village_guard_level_scaling_db.test.js asserts the live row
// is NULL so the regression cannot pass unnoticed.
//
// The two growth constants below are DELIBERATELY inlined rather than
// imported from services/creatureLevel.js: a migration is a frozen historical
// statement of what the database was set to on this date, and importing live
// code would silently rewrite history the next time the curve is tuned. They
// mirror LEVEL_HP_GROWTH (0.15), LEVEL_DAMAGE_GROWTH (0.10) and
// LEVEL_DEFENSE_PER_LEVEL (0.5) as they stand today; villages.js calls
// scaleCreature directly, so newly placed guards follow the curve wherever it
// goes next.
//
// GUARD_BASE_DAMAGE mirrors GUARD_DAMAGE (authority/creatures.js) / the
// seeded Guard.damage_override, for the same frozen-history reason.

exports.shorthands = undefined;

const GUARD_TYPE = 'Village Guard';
const GUARD_BASE_DAMAGE = 25;
const HP_GROWTH = 0.15;
const DAMAGE_GROWTH = 0.10;
const DEFENSE_PER_LEVEL = 0.5;

exports.up = async (pgm) => {
  await pgm.db.query(
    `UPDATE creature_behaviors
        SET damage_override = NULL, updated_at = now()
      WHERE name = 'Guard' AND damage_override IS NOT NULL`,
  );

  // Absolute, not incremental: every value is recomputed from the world's
  // band and the entity type's base stats, so running this twice produces
  // exactly the same rows. Targeted by type, so no other creature is touched.
  //
  // hp is set to the FULL scaled value, i.e. a damaged guard is healed. Guards
  // are structural gate defenders with no respawn timer of their own; scaling
  // "current" hp proportionally would leave a guard that happened to be
  // mid-fight permanently short, which is the more surprising outcome.
  await pgm.db.query(
    `UPDATE world_creatures wc
        SET level   = w.level_max,
            hp      = GREATEST(1, ROUND(et.hp * (1 + $2::numeric * (w.level_max - 1)))),
            damage  = ROUND($3::numeric * (1 + $4::numeric * (w.level_max - 1)), 2),
            defense = ROUND(et.defense::numeric + $5::numeric * (w.level_max - 1), 2),
            updated_at = now()
       FROM worlds w, entity_types et
      WHERE wc.world_id = w.id
        AND wc.type = $1
        AND et.name = $1`,
    [GUARD_TYPE, HP_GROWTH, GUARD_BASE_DAMAGE, DAMAGE_GROWTH, DEFENSE_PER_LEVEL],
  );
};

exports.down = async (pgm) => {
  // Exactly the pre-migration state: every guard row carried level 1, hp 300
  // (the literal insertVillageGuards wrote), damage 5 (the world_creatures
  // column default, never written by the old insert) and defense NULL (the
  // authority COALESCEd it to entity_types.defense).
  await pgm.db.query(
    `UPDATE world_creatures
        SET level = 1, hp = 300, damage = 5, defense = NULL, updated_at = now()
      WHERE type = $1`,
    [GUARD_TYPE],
  );

  await pgm.db.query(
    `UPDATE creature_behaviors
        SET damage_override = $1, updated_at = now()
      WHERE name = 'Guard'`,
    [GUARD_BASE_DAMAGE],
  );
};
