// The authoritative creature_behaviors catalog for `make seed-catalogs`.
//
// These twelve rows are ALSO inserted by migration
// 1714440080000_creature_behaviors.js, the same arrangement tile_types uses:
// migrations make a fresh database work, this file lets the seeder re-apply
// and extend the catalog. catalog_seed_data.test.js pins this file as a
// superset of what the migration inserts.
//
// Nine rungs come from the Bestiary Program umbrella
// (docs/superpowers/specs/2026-08-06-bestiary-program-design.md). Three do not:
//
//   Guard  -- today's hardcoded guard constants, moved into data. It
//             ORIGINALLY carried damage_override: 25 (= GUARD_DAMAGE), which
//             is what migration 1714440080000 still inserts. SOMET-279
//             removed it here and migration 1714440173000 nulled the live
//             column: the tick computes a hit as
//             `(bh.damageOverride ?? c.damage)`, so ANY non-null override on
//             this row SHADOWS the per-instance world_creatures.damage that
//             level-scaled guards now carry -- a level-50 guard went back to
//             hitting for a flat 25, i.e. the applyDamage floor of 1 against
//             a level-50 hostile. Re-authoring it here would silently undo
//             that on the next `npm run seed:catalogs`. GUARD_DAMAGE lives on
//             as the level-1 BASE damage villages.js feeds to scaleCreature,
//             and as the unprofiled-guard fallback in
//             authority/creatures.js's GUARD_DEFAULT_BEHAVIOR -- not as a
//             catalog column. Pinned by
//             creature_behaviors_invariants.test.js and
//             village_guard_seed_durability.test.js.
//   Sentry -- gives the `hold` style a consumer. An immobile ranged turret.
//   Lurker -- gives the `ambush` style a consumer. Dormant, then a fast charge.
//
// `Line` is the fallback every creature without a profile resolves to, and its
// values are today's hostile constants exactly: CONTACT_RANGE 60,
// CREATURE_ATTACK_COOLDOWN 1.0, AGGRO_RADIUS 400, LEASH_RADIUS 800,
// CREATURE_SPEED x 1. Changing them changes the whole game.
// aura_radius/aura_damage_mult/aura_defense_mult/aura_speed_mult and
// gold_min/gold_max are SOMET-253 Task 4 additions, omitted here (falling
// back to the seeder's own INSERT-time defaults of 0/1/1/1/0/0) unless a
// row needs a non-default value -- same convention damage_override already
// uses. Values mirror migration 1714440085000_behavior_auras.js's two UPDATE
// statements exactly: Champion is the only profile with a real aura (the
// umbrella's pack leader), and every rung except Guard carries a gold range
// (a village guard is not a purse).
const CREATURE_BEHAVIORS = [
  { name: 'Swarm',      attack_kind: 'melee',  attack_range: 60,  attack_cooldown: 0.7, projectile_speed: 0,   projectile_radius: 0,  aggro_radius: 400, leash_radius: 800,  chase_style: 'charge',   preferred_range: 0,   move_speed_mult: 1.2, gold_min: 0,  gold_max: 3 },
  { name: 'Skirmisher', attack_kind: 'melee',  attack_range: 60,  attack_cooldown: 0.9, projectile_speed: 0,   projectile_radius: 0,  aggro_radius: 450, leash_radius: 800,  chase_style: 'skirmish', preferred_range: 150, move_speed_mult: 1.5, gold_min: 1,  gold_max: 6 },
  { name: 'Line',       attack_kind: 'melee',  attack_range: 60,  attack_cooldown: 1.0, projectile_speed: 0,   projectile_radius: 0,  aggro_radius: 400, leash_radius: 800,  chase_style: 'charge',   preferred_range: 0,   move_speed_mult: 1.0, gold_min: 1,  gold_max: 5 },
  { name: 'Ranged',     attack_kind: 'ranged', attack_range: 340, attack_cooldown: 1.8, projectile_speed: 520, projectile_radius: 6,  aggro_radius: 460, leash_radius: 800,  chase_style: 'kite',     preferred_range: 240, move_speed_mult: 1.0, gold_min: 2,  gold_max: 8 },
  { name: 'Caster',     attack_kind: 'cast',   attack_range: 300, attack_cooldown: 2.4, projectile_speed: 420, projectile_radius: 8,  aggro_radius: 460, leash_radius: 800,  chase_style: 'kite',     preferred_range: 220, move_speed_mult: 0.9, gold_min: 3,  gold_max: 12 },
  { name: 'Brute',      attack_kind: 'melee',  attack_range: 70,  attack_cooldown: 1.8, projectile_speed: 0,   projectile_radius: 0,  aggro_radius: 380, leash_radius: 800,  chase_style: 'charge',   preferred_range: 0,   move_speed_mult: 0.7, gold_min: 4,  gold_max: 14 },
  { name: 'Heavy',      attack_kind: 'melee',  attack_range: 65,  attack_cooldown: 1.5, projectile_speed: 0,   projectile_radius: 0,  aggro_radius: 300, leash_radius: 500,  chase_style: 'charge',   preferred_range: 0,   move_speed_mult: 0.6, gold_min: 5,  gold_max: 18 },
  { name: 'Champion',   attack_kind: 'melee',  attack_range: 65,  attack_cooldown: 1.1, projectile_speed: 0,   projectile_radius: 0,  aggro_radius: 480, leash_radius: 900,  chase_style: 'charge',   preferred_range: 0,   move_speed_mult: 1.05,
    aura_radius: 260, aura_damage_mult: 1.25, aura_defense_mult: 1.2, aura_speed_mult: 1.1, gold_min: 10, gold_max: 30 },
  { name: 'Apex',       attack_kind: 'cast',   attack_range: 260, attack_cooldown: 2.0, projectile_speed: 460, projectile_radius: 10, aggro_radius: 600, leash_radius: 1200, chase_style: 'charge',   preferred_range: 0,   move_speed_mult: 0.95, gold_min: 25, gold_max: 80 },
  // No damage_override -- deliberately. See the Guard note in the header.
  // leash_radius 600, not the 300 migration 1714440080000 inserted: SOMET-291
  // raised it (migration 1714440210000) because 300 is shorter than the guard's
  // OWN aggro radius and shorter than the largest legal village, so a guard
  // could neither engage everything it could see nor cross its own village to
  // reach a hostile chasing a player. 600 is derived, not picked -- see that
  // migration's header and services/villages.js's guardRescueLeashRadius().
  // Re-authoring 300 here would silently undo it on the next
  // `npm run seed:catalogs`, exactly as re-authoring damage_override would.
  { name: 'Guard',      attack_kind: 'melee',  attack_range: 60,  attack_cooldown: 1.0, projectile_speed: 0,   projectile_radius: 0,  aggro_radius: 400, leash_radius: 600,  chase_style: 'guard',    preferred_range: 0,   move_speed_mult: 1.0 },
  { name: 'Sentry',     attack_kind: 'ranged', attack_range: 380, attack_cooldown: 2.0, projectile_speed: 500, projectile_radius: 6,  aggro_radius: 400, leash_radius: 800,  chase_style: 'hold',     preferred_range: 0,   move_speed_mult: 1.0, gold_min: 2,  gold_max: 9 },
  { name: 'Lurker',     attack_kind: 'melee',  attack_range: 60,  attack_cooldown: 0.9, projectile_speed: 0,   projectile_radius: 0,  aggro_radius: 180, leash_radius: 700,  chase_style: 'ambush',   preferred_range: 0,   move_speed_mult: 1.6, gold_min: 2,  gold_max: 7 },
  { name: 'Skittish',   attack_kind: 'melee',  attack_range: 60,  attack_cooldown: 1.2, projectile_speed: 0,   projectile_radius: 0,  aggro_radius: 300, leash_radius: 500,  chase_style: 'skittish', preferred_range: 150, move_speed_mult: 1.15, gold_min: 0,  gold_max: 2 },
];

module.exports = { CREATURE_BEHAVIORS };
