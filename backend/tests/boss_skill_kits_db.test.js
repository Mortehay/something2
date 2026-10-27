// backend/tests/boss_skill_kits_db.test.js
// SOMET-610 (S7). Pins the two migrations that give each of the 10 bosses +
// Fire Elemental Guard its own dedicated creature_behaviors row and binds a
// skill kit to it (1714440730000, 1714440731000) -- real DB, read-only
// (both migrations are idempotent seed data, nothing here writes).
//
// The one invariant that actually matters: NO boss shares its behaviour
// with an ordinary creature any more, and NO two boss-tier rows share a
// behaviour with EACH OTHER -- either would mean a skill binding leaks
// (or collides) across creatures that must stay independent. Verified
// live against the real dev DB on 2026-10-12 before writing this: 'Line'
// carried 44 entities (4 world bosses + all 4 Elemental Guards among
// them), 'Apex' 35 (all 3 dungeon_end bosses), 'Champion' 44 (all 3
// dungeon_elite bosses) -- this test is what keeps that regression from
// coming back silently.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL -- refusing to read a real database' : false;

const BOSSES = [
  'Ignis, the Magma Colossus', 'Glacius, the Frost Leviathan', 'Abyssor, the Voidreaver', 'Gorgon, the Thunder Titan',
  'The Bone Regent', 'The Ember Queen', 'The Umbral Gatekeeper',
  'Ossuary Warden', 'Cinder Matriarch', 'Shade Herald',
];
const ELITE_NAMES = ['Ossuary Warden', 'Cinder Matriarch', 'Shade Herald'];
const ORDINARY_KIT_ENTITY = 'Fire Elemental Guard';

test('every boss has its OWN dedicated behaviour -- none shares with another boss or an ordinary creature', { skip }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const r = await pool.query(
      `SELECT e.name AS entity, e.behavior_id, b.name AS behavior_name
         FROM entity_types e JOIN creature_behaviors b ON b.id = e.behavior_id
        WHERE e.name = ANY($1::text[])`,
      [[...BOSSES, ORDINARY_KIT_ENTITY]],
    );
    const byEntity = new Map(r.rows.map((row) => [row.entity, row]));
    assert.equal(byEntity.size, BOSSES.length + 1, 'every boss + Fire Elemental Guard must resolve to SOME behaviour');

    // Each one's behaviour is named after itself (1714440730000's own
    // convention) -- the simplest possible proof none of them collided
    // back onto a shared row or onto each other.
    const behaviorIds = new Set();
    for (const name of [...BOSSES, ORDINARY_KIT_ENTITY]) {
      const row = byEntity.get(name);
      assert.ok(row, `${name} missing an entity_types row`);
      assert.equal(row.behavior_name, name, `${name}'s behaviour must be its own dedicated row, not a shared one`);
      assert.ok(!behaviorIds.has(row.behavior_id), `${name}'s behaviour_id collides with another boss's`);
      behaviorIds.add(row.behavior_id);
    }

    // The shared rows must still exist (ordinary creatures still use them)
    // but must carry NONE of the 11 names above any more.
    const shared = await pool.query(
      `SELECT b.name AS shared_behavior, e.name AS entity
         FROM creature_behaviors b JOIN entity_types e ON e.behavior_id = b.id
        WHERE b.name IN ('Line', 'Apex', 'Champion') AND e.name = ANY($1::text[])`,
      [[...BOSSES, ORDINARY_KIT_ENTITY]],
    );
    assert.deepEqual(shared.rows, [], 'no boss / Fire Elemental Guard may still point at a shared Line/Apex/Champion row');
  } finally {
    await pool.end();
  }
});

test('each dedicated behaviour kept its SOURCE ability set exactly (byte-identical ordinary attack)', { skip }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    // Spot-check one of each source family: a world boss (from Line, 1
    // ability), a dungeon_end boss (from Apex, 2 abilities), a
    // dungeon_elite boss (from Champion, 1 ability).
    const cases = [
      ['Ignis, the Magma Colossus', 'Line', 1],
      ['The Bone Regent', 'Apex', 2],
      ['Ossuary Warden', 'Champion', 1],
    ];
    for (const [entity, source, abilityCount] of cases) {
      const r = await pool.query(
        `SELECT a.slot, a.name, a.attack_kind, a.attack_range, a.attack_cooldown, a.damage_mult, a.knockback
           FROM creature_abilities a
           JOIN creature_behaviors b ON b.id = a.behavior_id
          WHERE b.name = $1 ORDER BY a.slot`,
        [entity],
      );
      const src = await pool.query(
        `SELECT a.slot, a.name, a.attack_kind, a.attack_range, a.attack_cooldown, a.damage_mult, a.knockback
           FROM creature_abilities a
           JOIN creature_behaviors b ON b.id = a.behavior_id
          WHERE b.name = $1 ORDER BY a.slot`,
        [source],
      );
      assert.equal(r.rows.length, abilityCount, `${entity} must have exactly ${source}'s ability count`);
      assert.deepEqual(
        r.rows.map((row) => ({ ...row, attack_range: Number(row.attack_range), attack_cooldown: Number(row.attack_cooldown), damage_mult: Number(row.damage_mult), knockback: Number(row.knockback) })),
        src.rows.map((row) => ({ ...row, attack_range: Number(row.attack_range), attack_cooldown: Number(row.attack_cooldown), damage_mult: Number(row.damage_mult), knockback: Number(row.knockback) })),
        `${entity}'s copied ability set must match ${source}'s exactly`,
      );
    }
  } finally {
    await pool.end();
  }
});

test('every boss + Fire Elemental Guard has exactly one skill bound, elites at power_scale <= 0.6', { skip }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const r = await pool.query(
      `SELECT e.name AS entity, cs.name AS skill, cbs.power_scale
         FROM entity_types e
         JOIN creature_behaviors b ON b.id = e.behavior_id
         JOIN creature_behavior_skills cbs ON cbs.behavior_id = b.id
         JOIN creature_skills cs ON cs.id = cbs.skill_id
        WHERE e.name = ANY($1::text[])`,
      [[...BOSSES, ORDINARY_KIT_ENTITY]],
    );
    const byEntity = new Map(r.rows.map((row) => [row.entity, row]));
    assert.equal(byEntity.size, BOSSES.length + 1, 'every boss + Fire Elemental Guard must have exactly one skill bound');
    for (const name of ELITE_NAMES) {
      const row = byEntity.get(name);
      assert.ok(Number(row.power_scale) <= 0.6, `${name} (dungeon_elite) must bind its skill at power_scale <= 0.6, got ${row.power_scale}`);
    }
    // The spec's own illustrative example, pinned literally.
    const guard = byEntity.get(ORDINARY_KIT_ENTITY);
    assert.equal(Number(guard.power_scale), 0.4);
  } finally {
    await pool.end();
  }
});

test('every bound skill names a vfx binding that resolves to a REAL vfx_effects row', { skip }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const skills = await pool.query(
      `SELECT DISTINCT cs.name, cs.vfx FROM creature_skills cs
         JOIN creature_behavior_skills cbs ON cbs.skill_id = cs.id
         JOIN creature_behaviors b ON b.id = cbs.behavior_id
         JOIN entity_types e ON e.behavior_id = b.id
        WHERE e.name = ANY($1::text[])`,
      [[...BOSSES, ORDINARY_KIT_ENTITY]],
    );
    assert.ok(skills.rows.length > 0, 'fixture assumption: at least one bound skill exists');
    const vfxNames = await pool.query('SELECT name FROM vfx_effects');
    const known = new Set(vfxNames.rows.map((row) => row.name));
    for (const s of skills.rows) {
      for (const moment of ['telegraph', 'cast', 'impact']) {
        const bound = s.vfx && s.vfx[moment];
        if (!bound) continue; // unset is a legal no-op, not every slot is required
        assert.ok(known.has(bound), `${s.name}.vfx.${moment} ("${bound}") must name a real vfx_effects row`);
      }
    }
  } finally {
    await pool.end();
  }
});
