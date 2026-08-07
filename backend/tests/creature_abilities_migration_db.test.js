const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

function pick(row) {
  return {
    attack_kind: row.attack_kind,
    attack_range: row.attack_range,
    attack_cooldown: row.attack_cooldown,
  };
}

test('creature_abilities migration', { skip: !url ? 'no database URL' : false }, async (t) => {
  const pool = new Pool({ connectionString: url });
  t.after(() => pool.end());

  await t.test('every behaviour has a slot-1 ability matching what it used to carry', async () => {
    const r = await pool.query(
      `SELECT b.name, a.attack_kind, a.attack_range, a.attack_cooldown, a.knockback
       FROM creature_abilities a JOIN creature_behaviors b ON b.id = a.behavior_id
       WHERE a.slot = 1 ORDER BY b.name`);
    const byName = new Map(r.rows.map((x) => [x.name, x]));
    // Literal, NOT imported from seeds/data -- a test that reads the same
    // file the seeder reads passes against a seeder that writes nothing at
    // all.
    assert.deepEqual(pick(byName.get('Line')), { attack_kind: 'melee', attack_range: 60, attack_cooldown: 1 });
    assert.deepEqual(pick(byName.get('Ranged')), { attack_kind: 'ranged', attack_range: 340, attack_cooldown: 1.8 });
    assert.deepEqual(pick(byName.get('Guard')), { attack_kind: 'melee', attack_range: 60, attack_cooldown: 1 });
    // Brute's slot-1 is the one generic-backfill row the migration overrides
    // after the fact (ABILITY_OVERRIDES) -- pin its knockback too, not just
    // kind/range/cooldown, so that override cannot silently regress to 0.
    assert.equal(byName.get('Brute').knockback, 140);
  });

  await t.test('Apex has two abilities in slot order', async () => {
    const r = await pool.query(
      `SELECT a.slot, a.attack_kind, a.attack_range, a.attack_cooldown, a.element, a.damage_mult, a.knockback
       FROM creature_abilities a JOIN creature_behaviors b ON b.id = a.behavior_id
       WHERE b.name = 'Apex' ORDER BY a.slot`);
    assert.deepEqual(r.rows.map((x) => x.slot), [1, 2]);
    assert.deepEqual(r.rows.map((x) => x.attack_kind), ['cast', 'melee']);
    // Slot 2 (Slam) is the migration's hand-authored second ability -- pin
    // every column it carries, not just kind, so a value drifting in the
    // migration or the seed file is caught here rather than only by the
    // static field-for-field test in catalog_seed_data.test.js.
    const slam = r.rows[1];
    assert.equal(slam.attack_range, 90);
    assert.equal(slam.attack_cooldown, 1.2);
    assert.equal(slam.element, 'physical');
    assert.equal(slam.damage_mult, 1.4);
    assert.equal(slam.knockback, 120);
  });

  await t.test('the slot uniqueness constraint refuses a duplicate slot', async () => {
    // Builds its OWN zz-prefixed behaviour and inserts two abilities into
    // slot 1 of THAT -- never a real catalog row. See the task's global
    // constraint: an earlier task's test destroyed the real 'Line' row by
    // targeting it directly for a rejected write that was not actually
    // rejected.
    try {
      await pool.query(
        `INSERT INTO creature_behaviors
           (name, aggro_radius, leash_radius, chase_style)
         VALUES ('zzAbilityDupe',400,800,'charge')`);
      const b = await pool.query(
        'SELECT id FROM creature_behaviors WHERE name = $1', ['zzAbilityDupe']);
      const behaviorId = b.rows[0].id;
      await pool.query(
        `INSERT INTO creature_abilities
           (behavior_id, slot, name, attack_kind, attack_range, attack_cooldown)
         VALUES ($1, 1, 'First', 'melee', 60, 1)`,
        [behaviorId],
      );
      await assert.rejects(
        () => pool.query(
          `INSERT INTO creature_abilities
             (behavior_id, slot, name, attack_kind, attack_range, attack_cooldown)
           VALUES ($1, 1, 'Second', 'melee', 60, 1)`,
          [behaviorId],
        ),
        /creature_abilities_slot_unique/,
      );
    } finally {
      // By name, unconditionally. The abilities row cascades away with its
      // behaviour (ON DELETE CASCADE on creature_abilities.behavior_id), so
      // deleting the fixture behaviour is enough.
      await pool.query('DELETE FROM creature_behaviors WHERE name = $1', ['zzAbilityDupe']);
    }
  });
});
