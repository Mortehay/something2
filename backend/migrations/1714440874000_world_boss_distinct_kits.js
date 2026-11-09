// backend/migrations/1714440874000_world_boss_distinct_kits.js
//
// The four world bosses had too many skills of the same shape (a circle, a nova, a rain of
// circles, a dash) under different names. Each boss now has ONE signature mechanic family and
// five or six different attacks, built on mechanics the sim learned alongside this migration:
//
//   Ignis   (fire)       ground that STAYS: lava pools, a ring of fire, a delayed-blast mark,
//                        a meltdown with one safe circle
//   Glacius (ice)        CONTROL: roots, a slowing frost field, a ring of spikes around you,
//                        a freeze that holds everyone
//   Gorgon  (lightning)  SPEED and CHAINS: arcs that jump between players, a dash, a charge
//                        EVERYONE carries (spread out), a storm in four rounds
//   Abyssor (arcane)     SPACE and MIND: a pull, a teleport, silence, slow orbs, a tear that
//                        silences wherever it lands
//
// New skill kinds `zone`, `mark` and `shelter` (a rain with `waves` is still a rain); a
// creature_skills.params.status puts root / slow / silence on whoever a skill hits.
// Every boss's bindings are REPLACED (slot order is priority: ultimate first, plain filler
// last), the skills nothing binds any more are removed, and the enrage-only duplicate
// bindings of the previous migration are gone: enrage now only speeds the cooldowns up.
//
// Idempotent. down() removes the new kinds' skills and bindings and puts the kind check back;
// it cannot restore the previous kits (that would be the previous migration's data again).
exports.shorthands = undefined;

const KINDS_OLD = ['slam', 'nova', 'summon', 'projectile', 'charge', 'blink', 'rain', 'chain'];
const KINDS_NEW = [...KINDS_OLD, 'zone', 'mark', 'shelter'];

// [name, shape, color, width, duration_ms, particle_count, particle_speed, particle_lifetime_ms]
const EFFECTS = [
  ['boss_lava_pools', 'burst', '#ff5a1f', 4, 600, 28, 120, 600],
  ['boss_ember_mark', 'ring', '#ffb347', 5, 500, 24, 150, 500],
  ['boss_scorched_earth', 'ring', '#ff3d00', 7, 700, 40, 200, 700],
  ['boss_meltdown', 'ring', '#ff2e00', 8, 700, 44, 240, 700],
  ['boss_flash_freeze', 'burst', '#bfeaff', 5, 450, 30, 140, 450],
  ['boss_frost_field', 'ring', '#8fdcff', 4, 600, 20, 70, 600],
  ['boss_absolute_zero', 'ring', '#e0f7ff', 8, 700, 44, 180, 700],
  ['boss_static_charge', 'burst', '#fff27a', 5, 450, 32, 230, 450],
  ['boss_mind_rend', 'burst', '#d6b3ff', 5, 450, 28, 160, 450],
  ['boss_reality_tear', 'burst', '#b066ff', 6, 600, 36, 200, 600],
];

const fx = (name, impact) => ({ telegraph: name, cast: name, impact });

// name, kind, telegraph_ms, cooldown_ms, radius, range, damage_mult, element, vfx, params
// A skill an earlier migration already created is updated to this definition (same name).
const SKILLS = [
  // ---- Ignis: ground that stays ----
  ['Lava Pools', 'zone', 1400, 14000, 110, 800, 0.35, 'fire', fx('boss_lava_pools', 'meteor_impact'),
    { hazard: { pattern: 'targets', count: 4, linger_ms: 9000, tick_ms: 500 } }],
  ['Ember Mark', 'mark', 3000, 16000, 230, 900, 2.2, 'fire', fx('boss_ember_mark', 'fireball_blast'),
    { mark: { targets: 1 } }],
  ['Scorched Earth', 'zone', 2000, 32000, 720, 1000, 0.3, 'fire', fx('boss_scorched_earth', 'meteor_impact'),
    { hazard: { pattern: 'ring', outer: 720, inner: 430, linger_ms: 16000, tick_ms: 500 } }],
  ['Meltdown', 'shelter', 2600, 30000, 0, 1000, 3.2, 'fire', fx('boss_meltdown', 'meteor_impact'),
    { ultimate: true, shelter: { safe_radius: 150, safe_dist: 420, reach: 1100 } }],
  // ---- Glacius: control ----
  ['Flash Freeze', 'slam', 1100, 11000, 170, 700, 1.0, 'ice', fx('boss_flash_freeze', 'ice_shard'),
    { status: { root_s: 2.2 } }],
  ['Frost Field', 'zone', 1500, 18000, 150, 800, 0, 'ice', fx('boss_frost_field', 'ice_shard'),
    { hazard: { pattern: 'scatter', count: 5, spread: 450, linger_ms: 12000, tick_ms: 500, slow_pct: 65 } }],
  ['Absolute Zero', 'nova', 2400, 30000, 430, 900, 2.4, 'ice', fx('boss_absolute_zero', 'ice_shard'),
    { ultimate: true, status: { root_s: 2.5, slow_pct: 50, slow_s: 3 } }],
  // ---- Gorgon: speed and chains ----
  ['Static Charge', 'mark', 3000, 18000, 170, 900, 1.6, 'lightning', fx('boss_static_charge', 'thunder_clap'),
    { mark: { targets: 'all' } }],
  ['Thunderstorm', 'rain', 1600, 30000, 100, 800, 1.1, 'lightning', fx('boss_thunderstorm', 'thunder_clap'),
    { ultimate: true, waves: 4, wave_ms: 1100, zones: { count: 7, spread: 380, pattern: 'scatter' } }],
  // ---- Abyssor: space and mind ----
  ['Mind Rend', 'slam', 1000, 12000, 220, 700, 1.2, 'arcane', fx('boss_mind_rend', 'curse_blast'),
    { status: { silence_s: 4 } }],
  ['Reality Tear', 'rain', 1700, 28000, 130, 800, 1.4, 'arcane', fx('boss_reality_tear', 'curse_blast'),
    { ultimate: true, status: { silence_s: 3 }, zones: { count: 8, spread: 420, pattern: 'scatter' } }],
];

// Skills that stay as they were but gain a rider (matched by name, params merged).
const PARAM_PATCHES = [
  ['Permafrost Nova', { status: { slow_pct: 40, slow_s: 3 } }],
];

// boss, skill, slot, min_phase. Slot order is PRIORITY: the ultimate first, the plain filler last.
const BINDINGS = [
  ['Ignis, the Magma Colossus', 'Meltdown', 1, 4],
  ['Ignis, the Magma Colossus', 'Scorched Earth', 2, 3],
  ['Ignis, the Magma Colossus', 'Ember Mark', 3, 2],
  ['Ignis, the Magma Colossus', 'Lava Pools', 4, 2],
  ['Ignis, the Magma Colossus', 'Cinder Brood', 5, 1],
  ['Ignis, the Magma Colossus', 'Magma Slam', 6, 1],

  ['Glacius, the Frost Leviathan', 'Absolute Zero', 1, 4],
  ['Glacius, the Frost Leviathan', 'Frost Field', 2, 3],
  ['Glacius, the Frost Leviathan', 'Ice Spikes', 3, 2],
  ['Glacius, the Frost Leviathan', 'Flash Freeze', 4, 2],
  ['Glacius, the Frost Leviathan', 'Glacial Lance', 5, 1],
  ['Glacius, the Frost Leviathan', 'Permafrost Nova', 6, 1],

  ['Gorgon, the Thunder Titan', 'Thunderstorm', 1, 4],
  ['Gorgon, the Thunder Titan', 'Static Charge', 2, 3],
  ['Gorgon, the Thunder Titan', 'Storm Dash', 3, 2],
  ['Gorgon, the Thunder Titan', 'Static Pulse', 4, 1],
  ['Gorgon, the Thunder Titan', 'Chain Lightning', 5, 1],
  ['Gorgon, the Thunder Titan', 'Thunder Slam', 6, 1],

  ['Abyssor, the Voidreaver', 'Reality Tear', 1, 4],
  ['Abyssor, the Voidreaver', 'Gravity Well', 2, 2],
  ['Abyssor, the Voidreaver', 'Mind Rend', 3, 2],
  ['Abyssor, the Voidreaver', 'Void Blink', 4, 2],
  ['Abyssor, the Voidreaver', 'Void Orbs', 5, 1],
  ['Abyssor, the Voidreaver', 'Void Bolt', 6, 1],
];

// Skills an earlier migration made that no boss uses any more: removed when nothing binds them.
const OBSOLETE = [
  'Lava Ring', 'Meteor Shower', 'Blazing Charge', 'Magma Cataclysm', 'Frost Breath', 'Glacier Blink',
  'Frozen Cataclysm', 'Overload', 'Storm Cataclysm', 'Rift Rain', 'Void Cataclysm', 'Rift Collapse',
];
const OBSOLETE_EFFECTS = [
  'boss_lava_ring', 'boss_meteor', 'boss_blazing_charge', 'boss_magma_cataclysm', 'boss_frost_breath',
  'boss_glacier_blink', 'boss_frozen_cataclysm', 'boss_overload', 'boss_storm_cataclysm',
  'boss_rift_rain', 'boss_void_cataclysm',
];

const BOSSES = [...new Set(BINDINGS.map((b) => b[0]))];
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

exports.up = (pgm) => {
  pgm.dropConstraint('creature_skills', 'creature_skills_kind_check');
  pgm.addConstraint('creature_skills', 'creature_skills_kind_check', `CHECK (kind IN (${KINDS_NEW.map(q).join(', ')}))`);

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
      ON CONFLICT (name) DO UPDATE SET
        kind = EXCLUDED.kind, telegraph_ms = EXCLUDED.telegraph_ms, cooldown_ms = EXCLUDED.cooldown_ms,
        radius = EXCLUDED.radius, range = EXCLUDED.range, damage_mult = EXCLUDED.damage_mult,
        element = EXCLUDED.element, vfx = EXCLUDED.vfx, params = EXCLUDED.params, updated_at = now()
    `);
  }
  for (const [name, patch] of PARAM_PATCHES) {
    pgm.sql(`UPDATE creature_skills SET params = COALESCE(params, '{}'::jsonb) || ${q(JSON.stringify(patch))}::jsonb, updated_at = now()
              WHERE name = ${q(name)}`);
  }

  // Replace each boss's whole kit.
  pgm.sql(`
    DELETE FROM creature_behavior_skills
     WHERE behavior_id IN (SELECT behavior_id FROM entity_types
                            WHERE boss_tier = 'world' AND name IN (${BOSSES.map(q).join(', ')}) AND behavior_id IS NOT NULL)
  `);
  const rows = BINDINGS.map(([boss, skill, slot, minPhase]) => `(${q(boss)}, ${q(skill)}, ${slot}, ${minPhase})`).join(',\n      ');
  pgm.sql(`
    WITH b(boss, skill, slot, min_phase) AS (VALUES
      ${rows}
    )
    INSERT INTO creature_behavior_skills (behavior_id, skill_id, slot, power_scale, min_phase, requires_enrage, sync_uuid)
    SELECT e.behavior_id, s.id, b.slot, 1, b.min_phase, false,
           md5('s2sync:creature_behavior_skills:' || cb.name || '|' || b.slot)::uuid
      FROM b
      JOIN entity_types e ON e.name = b.boss AND e.boss_tier = 'world' AND e.behavior_id IS NOT NULL
      JOIN creature_behaviors cb ON cb.id = e.behavior_id
      JOIN creature_skills s ON s.name = b.skill
  `);

  // What nothing binds any more goes (a skill still bound by some other behaviour stays).
  pgm.sql(`
    DELETE FROM creature_skills s
     WHERE s.name IN (${OBSOLETE.map(q).join(', ')})
       AND NOT EXISTS (SELECT 1 FROM creature_behavior_skills cbs WHERE cbs.skill_id = s.id)
  `);
  pgm.sql(`
    DELETE FROM vfx_effects v
     WHERE v.name IN (${OBSOLETE_EFFECTS.map(q).join(', ')})
       AND NOT EXISTS (SELECT 1 FROM creature_skills s WHERE s.vfx::text LIKE '%"' || v.name || '"%')
       AND NOT EXISTS (SELECT 1 FROM item_types i WHERE i.vfx IS NOT NULL AND i.vfx::text LIKE '%"' || v.name || '"%')
       AND NOT EXISTS (SELECT 1 FROM entity_types et WHERE et.vfx IS NOT NULL AND et.vfx::text LIKE '%"' || v.name || '"%')
  `);
};

exports.down = (pgm) => {
  const names = SKILLS.filter((s) => ['zone', 'mark', 'shelter'].includes(s[1])).map((s) => q(s[0])).join(', ');
  pgm.sql(`DELETE FROM creature_behavior_skills WHERE skill_id IN (SELECT id FROM creature_skills WHERE name IN (${names}))`);
  pgm.sql(`DELETE FROM creature_skills WHERE name IN (${names})`);
  pgm.dropConstraint('creature_skills', 'creature_skills_kind_check');
  pgm.addConstraint('creature_skills', 'creature_skills_kind_check', `CHECK (kind IN (${KINDS_OLD.map(q).join(', ')}))`);
};

exports.SKILLS = SKILLS;
exports.EFFECTS = EFFECTS;
exports.BINDINGS = BINDINGS;
exports.OBSOLETE = OBSOLETE;
exports.PARAM_PATCHES = PARAM_PATCHES;
