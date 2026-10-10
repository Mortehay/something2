// SOMET-604 (S3). The aura library floor seed-catalogs restores, and the
// behaviour -> default aura bindings it applies to entities whose auras are
// NULL ("never authored"). [] is an admin's explicit "no auras" and is never
// touched. Values are Champion's as of 2026-10-10 (1714440085000).
const AURA_EFFECTS = [
  { name: 'pack_leader', target_side: 'allies', radius: 260, damage_mult: 1.25, defense_mult: 1.2,
    speed_mult: 1.1, shape: 'ring', color: '#d4a017', pulse_ms: 1200 },
  // SOMET-606 (S4). One enemies aura per world boss; colours are the boss rows'
  // (1714440671000). Placeholder values -- tuning is SOMET-613. Kept contiguous
  // at the END of the array so the S9 append merges as "keep both".
  { name: 'ignis_inferno', target_side: 'enemies', radius: 360, damage_mult: 1, defense_mult: 1, speed_mult: 1,
    dot_dps: 6, dot_element: 'fire', tick_ms: 1000, shape: 'ring', color: '#ff4757', pulse_ms: 1200 },
  { name: 'glacius_permafrost', target_side: 'enemies', radius: 400, damage_mult: 1, defense_mult: 1, speed_mult: 0.7,
    dot_dps: 0, dot_element: 'physical', tick_ms: 1000, shape: 'ring', color: '#70a1ff', pulse_ms: 1200 },
  { name: 'abyssor_void_rend', target_side: 'enemies', radius: 360, damage_mult: 1, defense_mult: 0.7, speed_mult: 1,
    dot_dps: 0, dot_element: 'physical', tick_ms: 1000, shape: 'ring', color: '#a55eea', pulse_ms: 1200 },
  { name: 'gorgon_static_field', target_side: 'enemies', radius: 380, damage_mult: 0.8, defense_mult: 1, speed_mult: 1,
    dot_dps: 0, dot_element: 'physical', tick_ms: 1000, shape: 'ring', color: '#ffd166', pulse_ms: 1200 },
];
const BEHAVIOR_DEFAULT_AURAS = { Champion: ['pack_leader'] };
// Keyed by entity NAME, never by behaviour: bosses use `Line`, so a
// BEHAVIOR_DEFAULT_AURAS.Line entry would bind every Line creature.
const WORLD_BOSS_DEFAULT_AURAS = {
  'Ignis, the Magma Colossus': ['ignis_inferno'],
  'Glacius, the Frost Leviathan': ['glacius_permafrost'],
  'Abyssor, the Voidreaver': ['abyssor_void_rend'],
  'Gorgon, the Thunder Titan': ['gorgon_static_field'],
};
module.exports = { AURA_EFFECTS, BEHAVIOR_DEFAULT_AURAS, WORLD_BOSS_DEFAULT_AURAS };
