// SOMET-604 (S3). The aura library floor seed-catalogs restores, and the
// behaviour -> default aura bindings it applies to entities whose auras are
// NULL ("never authored"). [] is an admin's explicit "no auras" and is never
// touched. Values are Champion's as of 2026-10-10 (1714440085000).
const AURA_EFFECTS = [
  { name: 'pack_leader', target_side: 'allies', radius: 260, damage_mult: 1.25, defense_mult: 1.2,
    speed_mult: 1.1, shape: 'ring', color: '#d4a017', pulse_ms: 1200 },
];
const BEHAVIOR_DEFAULT_AURAS = { Champion: ['pack_leader'] };
module.exports = { AURA_EFFECTS, BEHAVIOR_DEFAULT_AURAS };
