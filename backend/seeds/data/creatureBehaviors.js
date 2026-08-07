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
//   Guard  -- today's hardcoded guard constants, moved into data. Its
//             damage_override of 25 is GUARD_DAMAGE; without that column the
//             Guard profile could not reproduce current behaviour, which is
//             this sub-project's load-bearing invariant.
//   Sentry -- gives the `hold` style a consumer. An immobile ranged turret.
//   Lurker -- gives the `ambush` style a consumer. Dormant, then a fast charge.
//
// `Line` is the fallback every creature without a profile resolves to, and its
// values are today's hostile constants exactly: CONTACT_RANGE 60,
// CREATURE_ATTACK_COOLDOWN 1.0, AGGRO_RADIUS 400, LEASH_RADIUS 800,
// CREATURE_SPEED x 1. Changing them changes the whole game.
const CREATURE_BEHAVIORS = [
  { name: 'Swarm',      attack_kind: 'melee',  attack_range: 60,  attack_cooldown: 0.7, projectile_speed: 0,   projectile_radius: 0,  aggro_radius: 400, leash_radius: 800,  chase_style: 'charge',   preferred_range: 0,   move_speed_mult: 1.2 },
  { name: 'Skirmisher', attack_kind: 'melee',  attack_range: 60,  attack_cooldown: 0.9, projectile_speed: 0,   projectile_radius: 0,  aggro_radius: 450, leash_radius: 800,  chase_style: 'skirmish', preferred_range: 150, move_speed_mult: 1.5 },
  { name: 'Line',       attack_kind: 'melee',  attack_range: 60,  attack_cooldown: 1.0, projectile_speed: 0,   projectile_radius: 0,  aggro_radius: 400, leash_radius: 800,  chase_style: 'charge',   preferred_range: 0,   move_speed_mult: 1.0 },
  { name: 'Ranged',     attack_kind: 'ranged', attack_range: 340, attack_cooldown: 1.8, projectile_speed: 520, projectile_radius: 6,  aggro_radius: 460, leash_radius: 800,  chase_style: 'kite',     preferred_range: 240, move_speed_mult: 1.0 },
  { name: 'Caster',     attack_kind: 'cast',   attack_range: 300, attack_cooldown: 2.4, projectile_speed: 420, projectile_radius: 8,  aggro_radius: 460, leash_radius: 800,  chase_style: 'kite',     preferred_range: 220, move_speed_mult: 0.9 },
  { name: 'Brute',      attack_kind: 'melee',  attack_range: 70,  attack_cooldown: 1.8, projectile_speed: 0,   projectile_radius: 0,  aggro_radius: 380, leash_radius: 800,  chase_style: 'charge',   preferred_range: 0,   move_speed_mult: 0.7 },
  { name: 'Heavy',      attack_kind: 'melee',  attack_range: 65,  attack_cooldown: 1.5, projectile_speed: 0,   projectile_radius: 0,  aggro_radius: 300, leash_radius: 500,  chase_style: 'charge',   preferred_range: 0,   move_speed_mult: 0.6 },
  { name: 'Champion',   attack_kind: 'melee',  attack_range: 65,  attack_cooldown: 1.1, projectile_speed: 0,   projectile_radius: 0,  aggro_radius: 480, leash_radius: 900,  chase_style: 'charge',   preferred_range: 0,   move_speed_mult: 1.05 },
  { name: 'Apex',       attack_kind: 'cast',   attack_range: 260, attack_cooldown: 2.0, projectile_speed: 460, projectile_radius: 10, aggro_radius: 600, leash_radius: 1200, chase_style: 'charge',   preferred_range: 0,   move_speed_mult: 0.95 },
  { name: 'Guard',      attack_kind: 'melee',  attack_range: 60,  attack_cooldown: 1.0, projectile_speed: 0,   projectile_radius: 0,  aggro_radius: 400, leash_radius: 300,  chase_style: 'guard',    preferred_range: 0,   move_speed_mult: 1.0, damage_override: 25 },
  { name: 'Sentry',     attack_kind: 'ranged', attack_range: 380, attack_cooldown: 2.0, projectile_speed: 500, projectile_radius: 6,  aggro_radius: 400, leash_radius: 800,  chase_style: 'hold',     preferred_range: 0,   move_speed_mult: 1.0 },
  { name: 'Lurker',     attack_kind: 'melee',  attack_range: 60,  attack_cooldown: 0.9, projectile_speed: 0,   projectile_radius: 0,  aggro_radius: 180, leash_radius: 700,  chase_style: 'ambush',   preferred_range: 0,   move_speed_mult: 1.6 },
];

module.exports = { CREATURE_BEHAVIORS };
