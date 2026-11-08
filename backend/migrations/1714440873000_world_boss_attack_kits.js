// backend/migrations/1714440873000_world_boss_attack_kits.js
//
// More attacks for the four world bosses, and the schema to author them:
//
//  * creature_skills.kind admits the boss kinds the sim already resolves
//    (charge, blink, rain) plus `chain` (a lightning that jumps between players).
//  * creature_skills.params (jsonb): the optional knobs of those kinds -- hits,
//    dash_distance, inner_radius (a ring with a safe middle), proj_count/proj_spread/
//    proj_speed (a fan of projectiles), pull (drags players in), ultimate, zones.
//  * creature_behavior_skills.min_phase / requires_enrage: a binding that opens in a later
//    boss phase, or only once the boss is enraged.
//  * vfx_effects.sprite_*: an attack effect can be drawn from a sprite sheet (a horizontal
//    strip of frames) instead of -- or on top of -- the vector shape.
//  * Each boss gets 4-6 new skills, bound to the slots after the two it already has, and
//    its own vfx_effects rows (copies of an existing look) so an author can attach sprites
//    to one boss's attack without touching a shared effect.
//
// Idempotent: skills/effects are ON CONFLICT DO NOTHING, bindings ON CONFLICT (behavior, slot).
exports.shorthands = undefined;

const KINDS = ['slam', 'nova', 'summon', 'projectile', 'charge', 'blink', 'rain', 'chain'];

// [name, shape, color, width, duration_ms, particle_count, particle_speed, particle_lifetime_ms]
const EFFECTS = [
  ['boss_lava_ring', 'ring', '#ff4d1f', 5, 450, 28, 160, 450],
  ['boss_meteor', 'burst', '#ff7a1a', 4, 420, 32, 200, 450],
  ['boss_blazing_charge', 'line', '#ff6a00', 6, 380, 20, 150, 350],
  ['boss_magma_cataclysm', 'ring', '#ff2e00', 7, 600, 40, 240, 600],
  ['boss_ice_spikes', 'burst', '#a6f0ff', 4, 400, 30, 160, 420],
  ['boss_frost_breath', 'bolt', '#b8f2ff', 4, 300, 16, 140, 300],
  ['boss_glacier_blink', 'burst', '#c8f5ff', 4, 330, 24, 190, 360],
  ['boss_frozen_cataclysm', 'ring', '#7fe8ff', 7, 600, 40, 200, 600],
  ['boss_chain_lightning', 'bolt', '#ffff88', 4, 260, 24, 220, 280],
  ['boss_overload', 'ring', '#ffee44', 5, 330, 26, 200, 340],
  ['boss_storm_dash', 'line', '#ffee44', 6, 340, 20, 180, 320],
  ['boss_thunderstorm', 'burst', '#fff066', 4, 380, 30, 210, 400],
  ['boss_storm_cataclysm', 'ring', '#ffffaa', 7, 600, 40, 240, 600],
  ['boss_void_orbs', 'bolt', '#c055ff', 4, 320, 18, 160, 320],
  ['boss_gravity_well', 'ring', '#6b21a8', 6, 520, 30, 120, 520],
  ['boss_void_blink', 'burst', '#e0e7ff', 4, 300, 24, 190, 320],
  ['boss_rift_rain', 'burst', '#9933dd', 4, 400, 28, 170, 420],
  ['boss_void_cataclysm', 'ring', '#a855f7', 7, 600, 40, 220, 600],
];

const fx = (name, impact) => ({ telegraph: name, cast: name, impact });

// name, kind, telegraph_ms, cooldown_ms, radius, range, damage_mult, element, vfx, params
const SKILLS = [
  // ---- Ignis ----
  ['Lava Ring', 'nova', 1400, 12000, 300, 380, 2.0, 'fire', fx('boss_lava_ring', 'meteor_impact'), { inner_radius: 110 }],
  ['Meteor Shower', 'rain', 1800, 16000, 120, 700, 1.2, 'fire', fx('boss_meteor', 'meteor_impact'),
    { zones: { count: 6, spread: 420, pattern: 'scatter' } }],
  ['Blazing Charge', 'charge', 1100, 10000, 80, 650, 1.4, 'fire', fx('boss_blazing_charge', 'fireball_blast'), { dash_distance: 520 }],
  ['Magma Cataclysm', 'nova', 2200, 26000, 430, 900, 2.8, 'fire', fx('boss_magma_cataclysm', 'meteor_impact'), { ultimate: true }],
  // ---- Glacius ----
  ['Ice Spikes', 'rain', 1500, 12000, 90, 700, 1.5, 'ice', fx('boss_ice_spikes', 'ice_shard'),
    { zones: { count: 6, spread: 220, pattern: 'ring' } }],
  ['Frost Breath', 'projectile', 600, 7000, 18, 600, 1.0, 'ice', fx('boss_frost_breath', 'ice_shard'),
    { proj_count: 3, proj_spread: 0.5, proj_speed: 520 }],
  ['Glacier Blink', 'blink', 900, 11000, 160, 760, 1.2, 'ice', fx('boss_glacier_blink', 'frost_nova'), {}],
  ['Frozen Cataclysm', 'nova', 2200, 26000, 430, 900, 2.8, 'ice', fx('boss_frozen_cataclysm', 'ice_shard'), { ultimate: true }],
  // ---- Gorgon ----
  ['Chain Lightning', 'chain', 900, 9000, 260, 650, 1.6, 'lightning', fx('boss_chain_lightning', 'thunder_clap'), { hits: 4 }],
  ['Overload', 'nova', 700, 8000, 160, 200, 1.5, 'lightning', fx('boss_overload', 'thunder_clap'), {}],
  ['Storm Dash', 'charge', 1100, 10000, 80, 650, 1.4, 'lightning', fx('boss_storm_dash', 'thunder_clap'), { dash_distance: 520 }],
  ['Thunderstorm', 'rain', 1600, 14000, 110, 700, 1.1, 'lightning', fx('boss_thunderstorm', 'thunder_clap'),
    { zones: { count: 9, spread: 360, pattern: 'cross' } }],
  ['Storm Cataclysm', 'nova', 2200, 26000, 430, 900, 2.8, 'lightning', fx('boss_storm_cataclysm', 'thunder_clap'), { ultimate: true }],
  // ---- Abyssor ----
  ['Void Orbs', 'projectile', 900, 10000, 26, 650, 1.1, 'arcane', fx('boss_void_orbs', 'curse_blast'),
    { proj_count: 5, proj_spread: 0.9, proj_speed: 260 }],
  ['Gravity Well', 'nova', 1500, 14000, 320, 450, 1.4, 'arcane', fx('boss_gravity_well', 'curse_blast'), { pull: 160 }],
  ['Void Blink', 'blink', 900, 11000, 150, 760, 1.3, 'arcane', fx('boss_void_blink', 'curse_blast'), {}],
  ['Rift Rain', 'rain', 1700, 14000, 110, 700, 1.2, 'arcane', fx('boss_rift_rain', 'curse_blast'),
    { zones: { count: 7, spread: 400, pattern: 'scatter' } }],
  ['Void Cataclysm', 'nova', 2200, 26000, 430, 900, 2.8, 'arcane', fx('boss_void_cataclysm', 'curse_blast'), { ultimate: true }],
];

// boss, skill, slot, power_scale, min_phase, requires_enrage
// Slot order IS priority (the lowest ready slot casts), so each boss's ultimate comes first.
// The last binding of each boss is a SECOND copy of one rain skill that only opens once the
// boss is enraged: an independent cooldown, so enrage doubles the hazard pressure.
const BINDINGS = [
  ['Ignis, the Magma Colossus', 'Magma Cataclysm', 3, 1, 3, false],
  ['Ignis, the Magma Colossus', 'Lava Ring', 4, 1, 2, false],
  ['Ignis, the Magma Colossus', 'Blazing Charge', 5, 1, 2, false],
  ['Ignis, the Magma Colossus', 'Meteor Shower', 6, 1, 3, false],
  ['Ignis, the Magma Colossus', 'Meteor Shower', 7, 1.2, 3, true],

  ['Glacius, the Frost Leviathan', 'Frozen Cataclysm', 3, 1, 3, false],
  ['Glacius, the Frost Leviathan', 'Frost Breath', 4, 1, 1, false],
  ['Glacius, the Frost Leviathan', 'Glacier Blink', 5, 1, 2, false],
  ['Glacius, the Frost Leviathan', 'Ice Spikes', 6, 1, 2, false],
  ['Glacius, the Frost Leviathan', 'Ice Spikes', 7, 1.2, 3, true],

  ['Gorgon, the Thunder Titan', 'Storm Cataclysm', 3, 1, 3, false],
  ['Gorgon, the Thunder Titan', 'Chain Lightning', 4, 1, 1, false],
  ['Gorgon, the Thunder Titan', 'Overload', 5, 1, 1, false],
  ['Gorgon, the Thunder Titan', 'Storm Dash', 6, 1, 2, false],
  ['Gorgon, the Thunder Titan', 'Thunderstorm', 7, 1, 3, false],
  ['Gorgon, the Thunder Titan', 'Thunderstorm', 8, 1.2, 3, true],

  ['Abyssor, the Voidreaver', 'Void Cataclysm', 3, 1, 3, false],
  ['Abyssor, the Voidreaver', 'Void Orbs', 4, 1, 1, false],
  ['Abyssor, the Voidreaver', 'Gravity Well', 5, 1, 2, false],
  ['Abyssor, the Voidreaver', 'Void Blink', 6, 1, 2, false],
  ['Abyssor, the Voidreaver', 'Rift Rain', 7, 1, 3, false],
  ['Abyssor, the Voidreaver', 'Rift Rain', 8, 1.2, 3, true],
];

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

exports.up = (pgm) => {
  pgm.dropConstraint('creature_skills', 'creature_skills_kind_check');
  pgm.addConstraint('creature_skills', 'creature_skills_kind_check',
    `CHECK (kind IN (${KINDS.map(q).join(', ')}))`);
  pgm.addColumns('creature_skills', { params: { type: 'jsonb', notNull: false } });

  pgm.addColumns('creature_behavior_skills', {
    min_phase: { type: 'integer', notNull: true, default: 1 },
    requires_enrage: { type: 'boolean', notNull: true, default: false },
  });
  pgm.addConstraint('creature_behavior_skills', 'creature_behavior_skills_min_phase_check',
    'CHECK (min_phase BETWEEN 1 AND 4)');

  pgm.addColumns('vfx_effects', {
    // A key under vfx/ in the asset store (POST /api/vfx-effects/sprite), or NULL for none.
    sprite_image: { type: 'text', notNull: false },
    // Frames in the sheet (a horizontal strip); played once across the effect's duration_ms.
    sprite_frames: { type: 'integer', notNull: true, default: 1 },
    // World units across; 0 = size it from the event (the attack's reach / the telegraph radius).
    sprite_size: { type: 'real', notNull: true, default: 0 },
    sprite_additive: { type: 'boolean', notNull: true, default: false },
  });
  pgm.addConstraint('vfx_effects', 'vfx_effects_sprite_frames_check',
    'CHECK (sprite_frames BETWEEN 1 AND 64)');
  pgm.addConstraint('vfx_effects', 'vfx_effects_sprite_size_check',
    'CHECK (sprite_size >= 0 AND sprite_size <= 2000)');

  for (const [name, shape, color, width, dur, count, speed, life] of EFFECTS) {
    pgm.sql(`
      INSERT INTO vfx_effects
        (name, shape, color, width, duration_ms, ease, fade, follows_weapon,
         particle_count, particle_spread, particle_speed, particle_gravity, particle_lifetime_ms, particle_size, sync_uuid)
      VALUES (${q(name)}, ${q(shape)}, ${q(color)}, ${width}, ${dur}, 'out', true, false,
              ${count}, 6.283, ${speed}, 0, ${life}, 3, md5('s2sync:vfx_effects:' || ${q(name)})::uuid)
      ON CONFLICT (name) DO NOTHING
    `);
  }

  for (const [name, kind, tele, cd, radius, range, mult, element, vfx, params] of SKILLS) {
    pgm.sql(`
      INSERT INTO creature_skills
        (name, kind, telegraph_ms, cooldown_ms, radius, range, damage_mult, element, summon_count, vfx, params, sync_uuid)
      VALUES (${q(name)}, ${q(kind)}, ${tele}, ${cd}, ${radius}, ${range}, ${mult}, ${q(element)}, 1,
              ${q(JSON.stringify(vfx))}::jsonb, ${q(JSON.stringify(params))}::jsonb,
              md5('s2sync:creature_skills:' || ${q(name)})::uuid)
      ON CONFLICT (name) DO NOTHING
    `);
  }

  const rows = BINDINGS
    .map(([boss, skill, slot, scale, minPhase, enrage]) => `(${q(boss)}, ${q(skill)}, ${slot}, ${scale}, ${minPhase}, ${enrage})`)
    .join(',\n      ');
  pgm.sql(`
    WITH b(boss, skill, slot, power_scale, min_phase, requires_enrage) AS (VALUES
      ${rows}
    )
    INSERT INTO creature_behavior_skills (behavior_id, skill_id, slot, power_scale, min_phase, requires_enrage, sync_uuid)
    SELECT e.behavior_id, s.id, b.slot, b.power_scale, b.min_phase, b.requires_enrage,
           md5('s2sync:creature_behavior_skills:' || cb.name || '|' || b.slot)::uuid
      FROM b
      JOIN entity_types e ON e.name = b.boss AND e.boss_tier = 'world' AND e.behavior_id IS NOT NULL
      JOIN creature_behaviors cb ON cb.id = e.behavior_id
      JOIN creature_skills s ON s.name = b.skill
    ON CONFLICT (behavior_id, slot) DO NOTHING
  `);
};

exports.down = (pgm) => {
  const skillNames = [...new Set(SKILLS.map((s) => s[0]))].map(q).join(', ');
  pgm.sql(`DELETE FROM creature_behavior_skills WHERE skill_id IN (SELECT id FROM creature_skills WHERE name IN (${skillNames}))`);
  pgm.sql(`DELETE FROM creature_skills WHERE name IN (${skillNames})`);
  pgm.sql(`DELETE FROM vfx_effects WHERE name IN (${EFFECTS.map((e) => q(e[0])).join(', ')})`);
  pgm.dropConstraint('vfx_effects', 'vfx_effects_sprite_size_check');
  pgm.dropConstraint('vfx_effects', 'vfx_effects_sprite_frames_check');
  pgm.dropColumns('vfx_effects', ['sprite_image', 'sprite_frames', 'sprite_size', 'sprite_additive']);
  pgm.dropConstraint('creature_behavior_skills', 'creature_behavior_skills_min_phase_check');
  pgm.dropColumns('creature_behavior_skills', ['min_phase', 'requires_enrage']);
  pgm.dropColumns('creature_skills', ['params']);
  pgm.dropConstraint('creature_skills', 'creature_skills_kind_check');
  pgm.addConstraint('creature_skills', 'creature_skills_kind_check',
    "CHECK (kind IN ('slam', 'nova', 'summon', 'projectile'))");
};

exports.SKILLS = SKILLS;
exports.BINDINGS = BINDINGS;
exports.EFFECTS = EFFECTS;
