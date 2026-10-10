// SOMET-604 (S3). The aura library floor seed-catalogs restores, and the
// behaviour -> default aura bindings it applies to entities whose auras are
// NULL ("never authored"). [] is an admin's explicit "no auras" and is never
// touched. Values are Champion's as of 2026-10-10 (1714440085000).
const AURA_EFFECTS = [
  { name: 'pack_leader', target_side: 'allies', radius: 260, damage_mult: 1.25, defense_mult: 1.2,
    speed_mult: 1.1, shape: 'ring', color: '#d4a017', pulse_ms: 1200 },
  // SOMET-609 (S9): one aura per dungeon Elite boss. ALLY side only -- enemy-
  // side gameplay is S4, and aura_effects_dot_side_check forbids a DoT here.
  { name: 'ossuary_dread', target_side: 'allies', radius: 320, damage_mult: 1, defense_mult: 1.3,
    speed_mult: 1, shape: 'ring', color: '#cfc8b0', pulse_ms: 1600 },
  { name: 'cinder_brood', target_side: 'allies', radius: 300, damage_mult: 1.25, defense_mult: 1,
    speed_mult: 1.1, shape: 'ring', color: '#ff7a1a', pulse_ms: 900 },
  { name: 'shade_veil', target_side: 'allies', radius: 340, damage_mult: 1, defense_mult: 1.15,
    speed_mult: 1.25, shape: 'ring', color: '#7c3aed', pulse_ms: 1400 },
];
const BEHAVIOR_DEFAULT_AURAS = { Champion: ['pack_leader'] };
module.exports = { AURA_EFFECTS, BEHAVIOR_DEFAULT_AURAS };
