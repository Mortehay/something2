// SOMET-285 — every village guard is level 150, in every world.
//
// The product decision, verbatim: "guards are 150 lvl and they are very
// strong." This lifts the ten live rows (5 villages x 2 gate guards) off
// SOMET-279's band-derived level (worlds.level_max: 1 in Vale Crossing, 2 in
// Old Trailhead, 14 / 29 / 50 in the three hubs) onto the single fixed level
// services/villages.js now writes for every newly placed guard.
//
// What the numbers become, from the Village Guard entity type's base stats
// (hp 300, defense 10) and the seeded Guard damage (25) through the shared
// curve at 149 steps:
//
//     hp      300 * (1 + 0.15 * 149) = 7005
//     damage   25 * (1 + 0.10 * 149) = 397.5
//     defense  10 +  0.5  * 149      = 84.5
//
// Against the strongest hostile the catalog contains -- an Apex at the top
// band's level 50: hp 1086, damage 29.5, defense 37.5 -- a guard lands 360 a
// swing (4 swings to kill) and takes applyDamage's MIN_DAMAGE floor of 1 back,
// because 29.5 is far under 84.5. That is the intended "overwhelming at every
// tier" ordering, and it holds in all five worlds at once.
//
// Absolute, not incremental: every value is recomputed from the entity type's
// base stats, so running this twice produces exactly the same rows. Targeted
// by type, so no other creature is touched. hp is set to the FULL scaled value
// (a damaged guard is healed) for the same reason 1714440173000 gave: guards
// are structural gate defenders with no respawn timer, and leaving one
// permanently short because it happened to be mid-fight is the more surprising
// outcome.
//
// The growth constants below are DELIBERATELY inlined rather than imported
// from services/creatureLevel.js, exactly as 1714440173000 inlined them: a
// migration is a frozen historical statement of what the database was set to
// on this date, and importing live code would silently rewrite history the
// next time the curve is tuned. They mirror LEVEL_HP_GROWTH (0.15),
// LEVEL_DAMAGE_GROWTH (0.10) and LEVEL_DEFENSE_PER_LEVEL (0.5) as they stand
// today; villages.js calls scaleCreature directly, so newly placed guards
// follow the curve wherever it goes next. GUARD_BASE_DAMAGE mirrors
// GUARD_DAMAGE (authority/creatures.js) for the same reason.
//
// This migration does NOT touch creature_behaviors.Guard.damage_override.
// 1714440173000 nulled it (a non-null override SHADOWS world_creatures.damage
// and would put every guard back on a flat 25), and it must stay null -- so
// this migration leaves it exactly as it found it, in both directions.

exports.shorthands = undefined;

const GUARD_TYPE = 'Village Guard';
const GUARD_BASE_DAMAGE = 25;
const GUARD_LEVEL = 150;
// The curve counts steps BEYOND level 1. Passed as its own parameter rather
// than derived from $2 inside the SQL: `level = $2` types that placeholder as
// the column's integer, and reusing it as `$2::numeric` in the same statement
// is a "numeric versus integer" parameter-type conflict at parse time.
const GUARD_LEVEL_STEPS = GUARD_LEVEL - 1;
const HP_GROWTH = 0.15;
const DAMAGE_GROWTH = 0.10;
const DEFENSE_PER_LEVEL = 0.5;

exports.up = async (pgm) => {
  await pgm.db.query(
    `UPDATE world_creatures wc
        SET level   = $2,
            hp      = GREATEST(1, ROUND(et.hp * (1 + $4::numeric * $3::numeric))),
            damage  = ROUND($5::numeric * (1 + $6::numeric * $3::numeric), 2),
            defense = ROUND(et.defense::numeric + $7::numeric * $3::numeric, 2),
            updated_at = now()
       FROM entity_types et
      WHERE wc.type = $1
        AND et.name = $1`,
    [GUARD_TYPE, GUARD_LEVEL, GUARD_LEVEL_STEPS,
      HP_GROWTH, GUARD_BASE_DAMAGE, DAMAGE_GROWTH, DEFENSE_PER_LEVEL],
  );
};

exports.down = async (pgm) => {
  // Byte-for-byte the statement 1714440173000's up() ran: every guard back on
  // its world's band top (worlds.level_max) through the same curve. That is
  // the state this migration found the ten live rows in, including the two
  // Old Trailhead guards 1714440175000 created via insertVillageGuards (which
  // used the band rule at the time it ran).
  //
  // A guard whose world row is missing is left untouched, exactly as
  // 1714440173000's join left it -- there is no band to restore it to, and
  // inventing one would be worse than leaving the row alone.
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
