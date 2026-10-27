// backend/migrations/1714440731000_boss_skill_kits.js
//
// SOMET-610 (S7, spec §3.8/§4.3). The skill catalog content: one signature
// skill per element/physical family, reused across tiers via power_scale --
// the same "shared template, scaled per binding" design S6's power_scale
// column exists for, and the spec's own example ("Fire Elemental with
// ignis_slam @0.4"). Depends on 1714440730000's dedicated behaviour rows --
// every binding below targets one of THOSE, never the shared Line/Apex/
// Champion rows the rest of the bestiary still uses.
//
// vfx bindings reuse EXISTING vfx_effects rows (seeded by
// 1714440519000_seed_skill_vfx_effects.js) rather than inventing new ones --
// `meteor_impact`/`fireball_blast`/`frost_nova`/`void_bolt`/`thunder_clap`/
// `hammer_smash` already exist with fitting shapes/colors. `telegraph` reuses
// the CAST effect's name too: resolveEffectName (authority/vfx.js) is a
// generic `vfx[moment]` lookup with no fixed moment vocabulary, so this
// needs no vfx.js change -- the renderer reads the resolved effect's own
// `color` for the ground-fill tint (RenderSystem.js's _drawTelegraphs),
// falling back to its existing red when a skill sets no telegraph binding.
//
// Idempotent: skill insert is ON CONFLICT DO NOTHING; the binding insert is
// guarded by NOT EXISTS on (behavior_id, skill_id) so a re-run never
// duplicates or overwrites an admin's own retune of slot/power_scale.
exports.shorthands = undefined;

const SKILLS = [
  { name: 'Magma Slam', kind: 'slam', telegraph_ms: 1000, cooldown_ms: 8000,
    radius: 200, range: 300, damage_mult: 2.0, element: 'fire',
    vfx: { telegraph: 'fireball_blast', cast: 'fireball_blast', impact: 'meteor_impact' } },
  { name: 'Permafrost Nova', kind: 'nova', telegraph_ms: 1200, cooldown_ms: 10000,
    radius: 250, range: 300, damage_mult: 1.8, element: 'ice',
    vfx: { telegraph: 'frost_nova', cast: 'frost_nova', impact: 'ice_shard' } },
  { name: 'Void Bolt', kind: 'projectile', telegraph_ms: 800, cooldown_ms: 6000,
    radius: 15, range: 500, damage_mult: 2.2, element: 'arcane',
    vfx: { telegraph: 'void_bolt', cast: 'void_bolt', impact: 'curse_blast' } },
  { name: 'Thunder Slam', kind: 'slam', telegraph_ms: 900, cooldown_ms: 7000,
    radius: 180, range: 280, damage_mult: 1.9, element: 'lightning',
    vfx: { telegraph: 'ball_lightning', cast: 'ball_lightning', impact: 'thunder_clap' } },
  { name: 'Bone Crush', kind: 'slam', telegraph_ms: 900, cooldown_ms: 7000,
    radius: 150, range: 250, damage_mult: 1.6, element: null,
    vfx: { telegraph: 'hammer_smash', cast: 'hammer_smash', impact: 'crushing_blow' } },
];

// [entity (-> its own dedicated behaviour, from 1714440730000), skill, power_scale]
// Elites are capped at power_scale <= 0.6 per spec; dungeon_end reuse a
// world boss's own skill at a moderate scale; the one ordinary-creature
// example (Fire Elemental Guard) reuses Magma Slam at the spec's own
// illustrative 0.4.
const BINDINGS = [
  ['Ignis, the Magma Colossus', 'Magma Slam', 1.0],
  ['Glacius, the Frost Leviathan', 'Permafrost Nova', 1.0],
  ['Abyssor, the Voidreaver', 'Void Bolt', 1.0],
  ['Gorgon, the Thunder Titan', 'Thunder Slam', 1.0],
  ['The Bone Regent', 'Bone Crush', 0.9],
  ['The Ember Queen', 'Magma Slam', 0.7],
  ['The Umbral Gatekeeper', 'Void Bolt', 0.8],
  ['Ossuary Warden', 'Bone Crush', 0.5],
  ['Cinder Matriarch', 'Magma Slam', 0.5],
  ['Shade Herald', 'Void Bolt', 0.5],
  ['Fire Elemental Guard', 'Magma Slam', 0.4],
];

const sqlString = (s) => `'${s.replace(/'/g, "''")}'`;

exports.up = (pgm) => {
  for (const s of SKILLS) {
    pgm.sql(`
      INSERT INTO creature_skills
        (name, kind, telegraph_ms, cooldown_ms, radius, range, damage_mult, element, vfx)
      VALUES (${sqlString(s.name)}, ${sqlString(s.kind)}, ${s.telegraph_ms}, ${s.cooldown_ms},
              ${s.radius}, ${s.range}, ${s.damage_mult},
              ${s.element ? sqlString(s.element) : 'NULL'}, ${sqlString(JSON.stringify(s.vfx))}::jsonb)
      ON CONFLICT (name) DO NOTHING
    `);
  }

  const bindingValues = BINDINGS
    .map(([entity, skill, scale]) => `(${sqlString(entity)}, ${sqlString(skill)}, ${scale})`)
    .join(',\n      ');
  pgm.sql(`
    WITH bindings(entity_name, skill_name, power_scale) AS (VALUES
      ${bindingValues}
    )
    INSERT INTO creature_behavior_skills (behavior_id, skill_id, slot, power_scale)
    SELECT b.id, s.id, 1, bind.power_scale
      FROM bindings bind
      JOIN creature_behaviors b ON b.name = bind.entity_name
      JOIN creature_skills s ON s.name = bind.skill_name
     WHERE NOT EXISTS (
       SELECT 1 FROM creature_behavior_skills ex WHERE ex.behavior_id = b.id AND ex.skill_id = s.id
     )
  `);
};

exports.down = (pgm) => {
  const entityNames = BINDINGS.map(([entity]) => sqlString(entity)).join(', ');
  pgm.sql(`
    DELETE FROM creature_behavior_skills
     WHERE behavior_id IN (SELECT id FROM creature_behaviors WHERE name IN (${entityNames}))
  `);
  pgm.sql(`DELETE FROM creature_skills WHERE name IN (${SKILLS.map((s) => sqlString(s.name)).join(', ')})`);
};

exports.SKILLS = SKILLS;
exports.BINDINGS = BINDINGS;
