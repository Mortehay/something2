// The authoritative creature_abilities catalog for `make seed-catalogs`.
//
// Mirrors what migration 1714440083000 inserts, the same arrangement
// creature_behaviors uses: migrations make a fresh database work, this file
// lets the seeder re-apply and extend.
//
// Keyed by behaviour NAME, never by id: ids are not portable between
// databases (this project's `Line` row is id 31 in dev, from a sequence gap).
//
// `element: null` means "use the creature type's attack_element", which is
// what every backfilled slot-1 ability carries and what reproduces today's
// behaviour exactly.
const CREATURE_ABILITIES = [
  { behavior_name: 'Swarm',      slot: 1, name: 'Swarm',      attack_kind: 'melee',  attack_range: 60,  attack_cooldown: 0.7, projectile_speed: 0,   projectile_radius: 0,  element: null, damage_mult: 1, knockback: 0 },
  { behavior_name: 'Skirmisher', slot: 1, name: 'Skirmisher', attack_kind: 'melee',  attack_range: 60,  attack_cooldown: 0.9, projectile_speed: 0,   projectile_radius: 0,  element: null, damage_mult: 1, knockback: 0 },
  { behavior_name: 'Line',       slot: 1, name: 'Line',       attack_kind: 'melee',  attack_range: 60,  attack_cooldown: 1.0, projectile_speed: 0,   projectile_radius: 0,  element: null, damage_mult: 1, knockback: 0 },
  { behavior_name: 'Ranged',     slot: 1, name: 'Ranged',     attack_kind: 'ranged', attack_range: 340, attack_cooldown: 1.8, projectile_speed: 520, projectile_radius: 6,  element: null, damage_mult: 1, knockback: 0 },
  { behavior_name: 'Caster',     slot: 1, name: 'Caster',     attack_kind: 'cast',   attack_range: 300, attack_cooldown: 2.4, projectile_speed: 420, projectile_radius: 8,  element: null, damage_mult: 1, knockback: 0 },
  { behavior_name: 'Brute',      slot: 1, name: 'Brute',      attack_kind: 'melee',  attack_range: 70,  attack_cooldown: 1.8, projectile_speed: 0,   projectile_radius: 0,  element: null, damage_mult: 1, knockback: 140 },
  { behavior_name: 'Heavy',      slot: 1, name: 'Heavy',      attack_kind: 'melee',  attack_range: 65,  attack_cooldown: 1.5, projectile_speed: 0,   projectile_radius: 0,  element: null, damage_mult: 1, knockback: 0 },
  { behavior_name: 'Champion',   slot: 1, name: 'Champion',   attack_kind: 'melee',  attack_range: 65,  attack_cooldown: 1.1, projectile_speed: 0,   projectile_radius: 0,  element: null, damage_mult: 1, knockback: 0 },
  { behavior_name: 'Apex',       slot: 1, name: 'Apex',       attack_kind: 'cast',   attack_range: 260, attack_cooldown: 2.0, projectile_speed: 460, projectile_radius: 10, element: null, damage_mult: 1, knockback: 0 },
  { behavior_name: 'Apex',       slot: 2, name: 'Slam',       attack_kind: 'melee',  attack_range: 90,  attack_cooldown: 1.2, projectile_speed: 0,   projectile_radius: 0,  element: 'physical', damage_mult: 1.4, knockback: 120 },
  { behavior_name: 'Guard',      slot: 1, name: 'Guard',      attack_kind: 'melee',  attack_range: 60,  attack_cooldown: 1.0, projectile_speed: 0,   projectile_radius: 0,  element: null, damage_mult: 1, knockback: 0 },
  { behavior_name: 'Sentry',     slot: 1, name: 'Sentry',     attack_kind: 'ranged', attack_range: 380, attack_cooldown: 2.0, projectile_speed: 500, projectile_radius: 6,  element: null, damage_mult: 1, knockback: 0 },
  { behavior_name: 'Lurker',     slot: 1, name: 'Lurker',     attack_kind: 'melee',  attack_range: 60,  attack_cooldown: 0.9, projectile_speed: 0,   projectile_radius: 0,  element: null, damage_mult: 1, knockback: 0 },
];

module.exports = { CREATURE_ABILITIES };
