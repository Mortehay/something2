const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { seedOneBehavior } = require('../scripts/seed-catalogs.js');

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

test('creature_behaviors seeding', { skip: !url ? 'no database URL' : false }, async (t) => {
  const pool = new Pool({ connectionString: url });
  t.after(() => pool.end());

  await t.test('Line carries today\'s hostile constants exactly', async () => {
    const r = await pool.query('SELECT * FROM creature_behaviors WHERE name = $1', ['Line']);
    assert.equal(r.rowCount, 1);
    const b = r.rows[0];
    // Literals, deliberately: importing these from the seed file would make
    // the assertion compare the data to itself.
    assert.equal(b.attack_kind, 'melee');
    assert.equal(b.attack_range, 60);
    assert.equal(b.attack_cooldown, 1);
    assert.equal(b.aggro_radius, 400);
    assert.equal(b.leash_radius, 800);
    assert.equal(b.chase_style, 'charge');
    assert.equal(b.move_speed_mult, 1);
    assert.equal(b.damage_override, null);
  });

  await t.test('Guard carries today\'s guard constants exactly', async () => {
    const r = await pool.query('SELECT * FROM creature_behaviors WHERE name = $1', ['Guard']);
    assert.equal(r.rowCount, 1);
    const b = r.rows[0];
    assert.equal(b.aggro_radius, 400);
    assert.equal(b.leash_radius, 300);
    assert.equal(b.damage_override, 25);
    assert.equal(b.chase_style, 'guard');
  });

  await t.test('every chase style value has at least one profile using it', async () => {
    const r = await pool.query('SELECT DISTINCT chase_style FROM creature_behaviors');
    const styles = r.rows.map((x) => x.chase_style).sort();
    assert.deepEqual(styles, ['ambush', 'charge', 'guard', 'hold', 'kite', 'skirmish']);
  });

  await t.test('the chase_style CHECK rejects an unknown value', async () => {
    await assert.rejects(
      () => pool.query(
        `INSERT INTO creature_behaviors
           (name, attack_kind, attack_range, attack_cooldown, aggro_radius, leash_radius, chase_style)
         VALUES ('zzbadstyle','melee',60,1,400,800,'teleport')`),
      /creature_behaviors_chase_style_check/,
    );
  });

  await t.test('re-seeding preserves a hand-tuned field the seed entry omits', async () => {
    try {
      await pool.query(
        `INSERT INTO creature_behaviors
           (name, attack_kind, attack_range, attack_cooldown, aggro_radius, leash_radius,
            chase_style, damage_override)
         VALUES ('zzTuned','melee',60,1,400,800,'charge',99)`);
      // The seed entry has no damage_override, so the hand-set 99 must survive.
      await seedOneBehavior(pool, {
        name: 'zzTuned', attack_kind: 'melee', attack_range: 61, attack_cooldown: 1,
        aggro_radius: 400, leash_radius: 800, chase_style: 'charge',
      });
      const r = await pool.query('SELECT * FROM creature_behaviors WHERE name = $1', ['zzTuned']);
      assert.equal(r.rows[0].damage_override, 99, 'omitted field must be preserved');
      assert.equal(r.rows[0].attack_range, 61, 'specified field must be overwritten');
    } finally {
      // By name, unconditionally.
      await pool.query('DELETE FROM creature_behaviors WHERE name = $1', ['zzTuned']);
      await pool.query('DELETE FROM creature_behaviors WHERE name = $1', ['zzbadstyle']);
    }
  });
});
