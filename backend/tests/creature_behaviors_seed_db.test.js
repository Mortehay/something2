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
    assert.equal(b.aggro_radius, 400);
    assert.equal(b.leash_radius, 800);
    assert.equal(b.chase_style, 'charge');
    assert.equal(b.move_speed_mult, 1);
    assert.equal(b.damage_override, null);

    // SOMET-253 Task 3: the attack itself lives on creature_abilities now --
    // the parent row's own attack_kind/attack_range/attack_cooldown columns
    // are gone (migration 1714440084000).
    const a = await pool.query(
      'SELECT * FROM creature_abilities WHERE behavior_id = $1 AND slot = 1', [b.id]);
    assert.equal(a.rowCount, 1);
    assert.equal(a.rows[0].attack_kind, 'melee');
    assert.equal(a.rows[0].attack_range, 60);
    assert.equal(a.rows[0].attack_cooldown, 1);
  });

  await t.test('Guard carries today\'s guard constants exactly', async () => {
    const r = await pool.query('SELECT * FROM creature_behaviors WHERE name = $1', ['Guard']);
    assert.equal(r.rowCount, 1);
    const b = r.rows[0];
    assert.equal(b.aggro_radius, 400);
    // SOMET-291: 600, not 300. Migration 1714440210000 raised it because a
    // leash under the guard's own 400px aggro radius made that radius fiction
    // (selectGuardTarget filters candidates on the leash FROM THE POST), and
    // because 300 could not cross the largest legal village -- so a hostile
    // that chased a player through the gate reached a corner the guard was
    // forbidden to walk to. Derived, not picked: services/villages.js's
    // guardRescueLeashTerms(). Asserted here as a literal on purpose -- this
    // file's job is pinning what is actually IN the shared database, and a
    // value computed from the same helper the code uses would pass even if the
    // migration had never run.
    assert.equal(b.leash_radius, 600);
    assert.equal(b.chase_style, 'guard');
    // SOMET-279: NULL, not 25. This assertion read `25` until now and had
    // been failing silently ever since migration 1714440173000 nulled the
    // column -- silently because the whole file is DB-gated and a bare
    // `npm test` skips it. The tick computes a hit as
    // `(bh.damageOverride ?? c.damage)`, so any value here shadows the
    // per-instance world_creatures.damage every level-scaled village guard
    // now carries and puts every guard in every world back on a flat 25 (=
    // the applyDamage floor of 1 against a level-50 hostile). GUARD_DAMAGE
    // survives as villages.js's level-1 base damage, not as a catalog column.
    assert.equal(b.damage_override, null,
      'creature_behaviors.Guard.damage_override must be NULL, or every level-scaled guard is '
      + 'shadowed back to a flat hit');
  });

  await t.test('every chase style value has at least one profile using it', async () => {
    const r = await pool.query('SELECT DISTINCT chase_style FROM creature_behaviors');
    const styles = r.rows.map((x) => x.chase_style).sort();
    assert.deepEqual(styles, ['ambush', 'charge', 'guard', 'hold', 'kite', 'skirmish', 'skittish']);
  });

  await t.test('the chase_style CHECK rejects an unknown value', async () => {
    await assert.rejects(
      () => pool.query(
        `INSERT INTO creature_behaviors
           (name, aggro_radius, leash_radius, chase_style)
         VALUES ('zzbadstyle',400,800,'teleport')`),
      /creature_behaviors_chase_style_check/,
    );
  });

  await t.test('re-seeding preserves a hand-tuned field the seed entry omits', async () => {
    try {
      await pool.query(
        `INSERT INTO creature_behaviors
           (name, aggro_radius, leash_radius, chase_style, damage_override)
         VALUES ('zzTuned',400,800,'charge',99)`);
      // The seed entry has no damage_override, so the hand-set 99 must survive.
      await seedOneBehavior(pool, {
        name: 'zzTuned', aggro_radius: 400, leash_radius: 810, chase_style: 'charge',
      });
      const r = await pool.query('SELECT * FROM creature_behaviors WHERE name = $1', ['zzTuned']);
      assert.equal(r.rows[0].damage_override, 99, 'omitted field must be preserved');
      assert.equal(r.rows[0].leash_radius, 810, 'specified field must be overwritten');
    } finally {
      // By name, unconditionally.
      await pool.query('DELETE FROM creature_behaviors WHERE name = $1', ['zzTuned']);
      await pool.query('DELETE FROM creature_behaviors WHERE name = $1', ['zzbadstyle']);
    }
  });

  await t.test('every existing creature type is backfilled to a behaviour', async () => {
    const r = await pool.query(`
      SELECT e.name, e.faction, b.name AS behavior
      FROM entity_types e LEFT JOIN creature_behaviors b ON b.id = e.behavior_id
      WHERE e.is_creature = true
    `);
    assert.ok(r.rowCount > 0, 'no creature types found');
    // Guard-faction creatures always resolve to the 'Guard' profile -- that
    // half of the claim stays exact. Non-guard creatures used to be checked
    // against a hardcoded 'Line' too, back when Skeleton/Bat/Slime/Wolf (all
    // Line) were the entire hostile catalog. SOMET-250 (P4) seeded 288
    // creatures spanning all 9 rungs, so "every hostile creature is Line" is
    // no longer true by design -- Tundra Caster is correctly Caster, not a
    // bug. What this test still protects, and must keep protecting, is the
    // ORIGINAL defect it was written for: a creature restored by the seeder
    // silently getting NO behaviour at all (behavior_id left NULL).
    for (const row of r.rows) {
      assert.ok(row.behavior, `${row.name} has no behaviour profile`);
      if (row.faction === 'guard') {
        assert.equal(row.behavior, 'Guard', `${row.name} (faction guard) got the wrong profile`);
      }
    }
  });

  await t.test('a profile still in use cannot be deleted', async () => {
    // Self-contained zz-prefixed fixtures, never the real Line/Guard rows:
    // this subtest previously deleted the real 'Line' row when it ran before
    // the FK existed (see the fix-round section of the task report).
    try {
      await pool.query(
        `INSERT INTO creature_behaviors
           (name, aggro_radius, leash_radius, chase_style)
         VALUES ('zzInUse',400,800,'charge')`);
      // is_creature = false: the FK on behavior_id does not care whether the
      // row is a creature, and true would make this fixture visible to
      // creature_drops_db.test.js's "every creature type has a drop rule"
      // catalog-wide invariant while it briefly exists.
      await pool.query(
        `INSERT INTO entity_types (name, color, is_creature, behavior_id)
         VALUES ('zzInUseCreature','#fff',false,
           (SELECT id FROM creature_behaviors WHERE name = 'zzInUse'))`);
      await assert.rejects(
        () => pool.query('DELETE FROM creature_behaviors WHERE name = $1', ['zzInUse']),
        /foreign key|violates/i,
      );
    } finally {
      // Entity type first (it holds the FK), then the profile. Both by name,
      // unconditionally.
      await pool.query('DELETE FROM entity_types WHERE name = $1', ['zzInUseCreature']);
      await pool.query('DELETE FROM creature_behaviors WHERE name = $1', ['zzInUse']);
    }
  });

  await t.test('attack_element defaults to physical and rejects an unknown element', async () => {
    try {
      // is_creature = false: attack_element lives on entity_types regardless
      // of creature-hood, and a false fixture is invisible to the
      // creature-only catalog invariants other test files run (e.g.
      // creature_drops_db.test.js's "every creature type has a drop rule").
      await pool.query(
        `INSERT INTO entity_types (name, color, is_creature) VALUES ('zzElem','#fff',false)`);
      const r = await pool.query('SELECT attack_element FROM entity_types WHERE name = $1', ['zzElem']);
      assert.equal(r.rows[0].attack_element, 'physical');
      await assert.rejects(
        () => pool.query(`UPDATE entity_types SET attack_element = 'holy' WHERE name = 'zzElem'`),
        /entity_types_attack_element_check/,
      );
    } finally {
      await pool.query('DELETE FROM entity_types WHERE name = $1', ['zzElem']);
    }
  });
});
