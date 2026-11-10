/* eslint-disable camelcase */
// Character buff auras. buff_visuals holds how each visual buff draws (ground or body, size,
// priority, colour, optional sprite sheet); one row per visual buff skill, seeded here from the
// skill catalog. effect_sprite_jobs gains the 'buff' subject kind so the Sprite tab can draw them.
//
// The seed is frozen: (skill_id, placement, color) for the 55 visual buffs as of 2026-11-10,
// generated once from services/buffVisuals.js (type 'buff' minus forms and traps, GROUND_DEFAULT,
// iconColor). A migration must not require application code: a later edit would silently change
// what a fresh install gets. A buff skill added later has no row and reads as its default.
exports.shorthands = undefined;

const SEED = [
  ['war_battle_shout', 'body', '#ef4444'],
  ['war_shield_wall', 'body', '#3b82f6'],
  ['war_iron_will', 'body', '#64748b'],
  ['war_bloodlust_stance', 'body', '#dc2626'],
  ['war_colossus_stance', 'body', '#78716c'],
  ['war_unstoppable', 'body', '#f97316'],
  ['war_last_stand', 'body', '#fbbf24'],
  ['war_steel_tempering', 'body', '#94a3b8'],
  ['war_duelist_focus', 'body', '#a855f7'],
  ['war_banner_of_victory', 'ground', '#e11d48'],
  ['mag_mana_shield', 'body', '#818cf8'],
  ['mag_ice_armor', 'body', '#38bdf8'],
  ['mag_immolation_aura', 'ground', '#ea580c'],
  ['mag_haste', 'body', '#facc15'],
  ['mag_arcane_brilliance', 'body', '#c084fc'],
  ['mag_mana_surge', 'body', '#3b82f6'],
  ['mag_elemental_focus', 'body', '#f43f5e'],
  ['mag_spell_ward', 'body', '#a855f7'],
  ['mag_ethereal_form', 'body', '#93c5fd'],
  ['mag_empower_elements', 'body', '#fb923c'],
  ['mnk_fast_mana_aura', 'ground', '#38bdf8'],
  ['mnk_jade_body', 'body', '#059669'],
  ['mnk_drunken_brawler_stance', 'body', '#d97706'],
  ['mnk_inner_peace', 'body', '#f1f5f9'],
  ['mnk_tiger_stance', 'body', '#f97316'],
  ['mnk_touch_of_life', 'body', '#ec4899'],
  ['mnk_diamond_skin', 'body', '#e0e7ff'],
  ['mnk_zen_focus', 'body', '#c084fc'],
  ['mnk_wind_blessing', 'body', '#67e8f9'],
  ['mnk_karma_redirection', 'body', '#a855f7'],
  ['cul_blood_pact', 'body', '#b91c1c'],
  ['cul_bone_armor', 'body', '#e2e8f0'],
  ['cul_fanatic_frenzy', 'body', '#ef4444'],
  ['cul_vampiric_embrace', 'body', '#7f1d1d'],
  ['cul_undead_resilience', 'body', '#334155'],
  ['cul_dark_blessing', 'body', '#6b21a8'],
  ['cul_martyrdom_aura', 'ground', '#e11d48'],
  ['cul_life_transfusion', 'body', '#be123c'],
  ['cul_abyssal_cloak', 'body', '#1e1b4b'],
  ['cul_blood_rebirth', 'body', '#dc2626'],
  ['arc_rapid_fire', 'body', '#eab308'],
  ['arc_eagle_eye', 'body', '#38bdf8'],
  ['arc_camouflage', 'body', '#15803d'],
  ['arc_cheetah_stride', 'body', '#f97316'],
  ['arc_hunters_instinct', 'body', '#a855f7'],
  ['arc_tailwind_aura', 'ground', '#4ade80'],
  ['arc_sniper_stance', 'body', '#64748b'],
  ['dru_primal_metamorphosis', 'body', '#10b981'],
  ['dru_mark_of_the_wild', 'body', '#10b981'],
  ['dru_rejuvenation', 'body', '#4ade80'],
  ['dru_barkskin', 'body', '#78350f'],
  ['dru_tranquility', 'ground', '#f472b6'],
  ['dru_thorns_aura', 'ground', '#16a34a'],
  ['dru_natures_swiftness', 'body', '#facc15'],
  ['dru_healing_touch', 'body', '#22c55e'],
];

const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

exports.up = (pgm) => {
  pgm.createTable('buff_visuals', {
    skill_id: { type: 'text', primaryKey: true },
    placement: { type: 'text', notNull: true, check: "placement IN ('ground','body')" },
    radius: { type: 'real', notNull: true, default: 64 },
    scale: { type: 'real', notNull: true, default: 1.3 },
    priority: { type: 'integer', notNull: false },
    color: { type: 'text', notNull: true },
    sprite_image: { type: 'text', notNull: false },
    sprite_frames: { type: 'integer', notNull: true, default: 1 },
    sprite_additive: { type: 'boolean', notNull: true, default: true },
    sprite_fps: { type: 'real', notNull: false },
    sync_uuid: { type: 'uuid', notNull: true, default: pgm.func('gen_random_uuid()'), unique: true },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  const values = SEED.map((r) => `(${r.map(lit).join(', ')})`);
  pgm.sql(`INSERT INTO buff_visuals (skill_id, placement, color) VALUES ${values.join(',\n  ')}`);

  pgm.dropConstraint('effect_sprite_jobs', 'effect_sprite_jobs_subject_kind_check');
  pgm.addConstraint('effect_sprite_jobs', 'effect_sprite_jobs_subject_kind_check',
    "CHECK (subject_kind IN ('vfx','aura','buff'))");
};

exports.down = (pgm) => {
  pgm.sql("DELETE FROM effect_sprite_jobs WHERE subject_kind = 'buff'");
  pgm.dropConstraint('effect_sprite_jobs', 'effect_sprite_jobs_subject_kind_check');
  pgm.addConstraint('effect_sprite_jobs', 'effect_sprite_jobs_subject_kind_check',
    "CHECK (subject_kind IN ('vfx','aura'))");
  pgm.dropTable('buff_visuals');
};

exports.SEED = SEED;
