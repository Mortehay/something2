const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

// Every expected value below is written out literally rather than imported
// from seeds/data/entityTypes.js. A test that reads the same file the seeder
// reads passes against a seeder that writes nothing at all.
test('playable classes', { skip: !url ? 'no database URL' : false }, async (t) => {
  const pool = new Pool({ connectionString: url });
  t.after(() => pool.end());

  // SOMET-486 removed mana/max_mana from this list. Warrior's mana is no
  // longer Player's: the legacy Player row says 50, the game has always given
  // 100, and Warrior is now authored at the 100 the game plays with. Every
  // other column still has to match, because 1714440092000's backfill put
  // every pre-existing player on a Warrior character and a drift in a STAT
  // still rebalances all of them.
  const STAT_COLUMNS = [
    'strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma',
    'hp', 'max_hp', 'hp_regen_rate', 'mana_regen_rate',
  ];

  await t.test('Warrior is an exact stat clone of Player, pools aside', async () => {
    const r = await pool.query(
      `SELECT name, ${STAT_COLUMNS.join(', ')}, mana, max_mana FROM entity_types
        WHERE name IN ('Player', 'Warrior')`);
    const by = new Map(r.rows.map((x) => [x.name, x]));
    assert.ok(by.get('Player'), 'the Player entity type must still exist');
    assert.ok(by.get('Warrior'), 'Warrior must exist');
    for (const col of STAT_COLUMNS) {
      assert.equal(
        Number(by.get('Warrior')[col]), Number(by.get('Player')[col]),
        `Warrior.${col} must equal Player.${col} -- a drift here rebalances every backfilled character`);
    }
    // The divergence is asserted, not merely permitted: dropping mana from
    // STAT_COLUMNS above would otherwise let Warrior's mana be ANY value, and
    // 486's whole point is that this one is pinned.
    assert.equal(Number(by.get('Warrior').max_mana), 100,
      'Warrior mana is FROZEN at 100 (SOMET-486) -- every live character is a Warrior with 100 mana');
  });

  // Every class's base pools, written out literally. These are the numbers the
  // authority hands a joining character (playerStats.js's classPools) AND the
  // numbers character select advertises -- one pair of columns, two readers,
  // which is the split SOMET-486 closed.
  //
  // The query is NOT filtered on is_playable, deliberately: SOMET-471 demoted
  // Ranger, and Ranger's pools must go on being asserted precisely because
  // characters are still playing it. Filtering would have made Ranger vanish
  // from this check the moment it stopped being rollable.
  await t.test('each class carries its authored base pools', async () => {
    const r = await pool.query(
      `SELECT name, max_hp, max_mana FROM entity_types
        WHERE name IN ('Warrior', 'Ranger', 'Mage', 'Monk', 'Cultist', 'Archer', 'Druid')`);
    const by = new Map(r.rows.map((x) => [x.name, x]));
    const expected = {
      Warrior: { hp: 100, mana: 100 },
      Ranger: { hp: 85, mana: 115 },
      Mage: { hp: 75, mana: 150 },
      Monk: { hp: 90, mana: 110 },
      Cultist: { hp: 110, mana: 90 },
      Archer: { hp: 85, mana: 115 },
      Druid: { hp: 90, mana: 135 },
    };
    for (const [name, want] of Object.entries(expected)) {
      assert.ok(by.get(name), `${name} must exist`);
      assert.deepEqual(
        { hp: Number(by.get(name).max_hp), mana: Number(by.get(name).max_mana) }, want,
        `${name}'s base pools`);
    }
    // A Mage with less mana than a Warrior is the shape of the dead pre-486
    // data (Mage 70 vs Warrior 50-that-was-really-100). Asserted as a property
    // as well as a literal so a future retune cannot quietly reinstate it.
    assert.ok(Number(by.get('Mage').max_mana) > Number(by.get('Warrior').max_mana),
      'a Mage must have MORE mana than a Warrior');
  });

  await t.test('Ranger and Mage carry their own literal stats', async () => {
    const r = await pool.query(
      `SELECT name, hp, max_hp, dexterity, intelligence, mana, max_mana
         FROM entity_types WHERE name IN ('Ranger', 'Mage')`);
    const by = new Map(r.rows.map((x) => [x.name, x]));
    assert.deepEqual(
      { hp: Number(by.get('Ranger').hp), dex: Number(by.get('Ranger').dexterity) },
      { hp: 85, dex: 12 });
    assert.deepEqual(
      { hp: Number(by.get('Mage').hp), int: Number(by.get('Mage').intelligence), mana: Number(by.get('Mage').max_mana) },
      { hp: 75, int: 12, mana: 150 });
  });

  // SOMET-471 demoted Ranger and added four classes. Ranger is deliberately
  // absent from this list and deliberately still present in the table -- see
  // six_classes_db.test.js, which asserts the row survived the demotion
  // unrenamed and with its numbers untouched.
  await t.test('exactly the six classes are playable', async () => {
    const r = await pool.query(
      'SELECT name FROM entity_types WHERE is_playable = true ORDER BY name');
    assert.deepEqual(r.rows.map((x) => x.name),
      ['Archer', 'Cultist', 'Druid', 'Mage', 'Monk', 'Warrior']);
  });

  await t.test('the legacy Player row is not playable', async () => {
    const r = await pool.query(
      "SELECT is_playable FROM entity_types WHERE name = 'Player'");
    assert.equal(r.rows[0].is_playable, false);
  });

  await t.test('each class has its loadout, resolved to real item types', async () => {
    const r = await pool.query(
      `SELECT e.name AS class, i.name AS item, l.quantity
         FROM class_loadouts l
         JOIN entity_types e ON e.id = l.entity_type_id
         JOIN item_types  i ON i.id = l.item_type_id
        ORDER BY e.name, i.name`);
    const got = r.rows.map((x) => `${x.class}:${x.item}x${x.quantity}`);
    // Ranger is still here after SOMET-471's demotion: characters are wearing
    // this gear, and a rebuilt volume that restored the class without it would
    // leave them with nothing.
    assert.deepEqual(got, [
      'Archer:arrowx20',
      'Archer:bowx1',
      'Archer:leather-vestx1',
      'Cultist:apprentice staffx1',
      'Cultist:leather-vestx1',
      'Druid:clubx1',
      'Druid:leather-vestx1',
      'Mage:apprentice staffx1',
      'Mage:arcane-wardx1',
      'Monk:leather-vestx1',
      'Monk:stickx1',
      'Ranger:arrowx20',
      'Ranger:bowx1',
      'Ranger:leather-vestx1',
      'Warrior:leather-vestx1',
      'Warrior:short swordx1',
    ]);
  });

  // The Wolf lesson (see seeds/data/entityTypes.js's header): an entity type
  // the repo cannot rebuild disappears when the Postgres volume is rebuilt,
  // and characters.entity_type_id will carry a foreign key to these rows.
  //
  // This test DELETES the three class rows and proves the seeder puts them
  // back. That deletion is deliberate and is what makes the test mean
  // anything: the seeder upserts ON CONFLICT (name) DO NOTHING, so asserting
  // against rows the migration already created would pass against a seeder
  // that knows nothing about classes at all.
  //
  // It is safe because the blast radius is exactly the rows this epic created
  // minutes ago -- no pre-existing catalog row is touched, the class_loadouts
  // rows cascade with them, and the finally block re-seeds unconditionally so
  // even a mid-test failure leaves the catalog whole.
  await t.test('a class a character is playing cannot be deleted out from under it', async () => {
    // characters.entity_type_id is a plain reference with no ON DELETE, and
    // that is deliberate: deleting a class must not silently orphan or destroy
    // the characters playing it. Discovered the hard way -- the first version
    // of the restore test below tried to DELETE Warrior and was refused by
    // this constraint, which is the constraint doing its job.
    const inUse = await pool.query(
      `SELECT e.name FROM entity_types e
        WHERE e.is_playable = true
          AND EXISTS (SELECT 1 FROM characters c WHERE c.entity_type_id = e.id)
        LIMIT 1`);
    if (!inUse.rows.length) {
      // Nothing is playing any class on this database, so there is no
      // protection to demonstrate. Say so rather than pass vacuously.
      t.diagnostic('no character is playing any class here; FK protection not exercised');
      return;
    }
    await assert.rejects(
      () => pool.query('DELETE FROM entity_types WHERE name = $1', [inUse.rows[0].name]),
      /characters_entity_type_id_fkey/);
  });

  await t.test('seed-catalogs rebuilds a class that has gone missing', async () => {
    // The Wolf lesson: an entity type the repo cannot rebuild disappears when
    // the volume is rebuilt. Asserting against rows the migration already
    // created would pass against a seeder that knows nothing about classes at
    // all (it upserts ON CONFLICT DO NOTHING), so a class really is deleted
    // here and the seeder really does have to put it back.
    //
    // The class is chosen at runtime as one NO character is playing -- the FK
    // above makes any other choice impossible, and hardcoding a name would
    // turn this test red the first time someone rolls that class.
    const { seedCatalogs } = require('../scripts/seed-catalogs.js');
    const free = await pool.query(
      `SELECT e.name FROM entity_types e
        WHERE e.is_playable = true
          AND NOT EXISTS (SELECT 1 FROM characters c WHERE c.entity_type_id = e.id)
        ORDER BY e.name LIMIT 1`);
    if (!free.rows.length) {
      t.diagnostic('every class is in use; cannot safely delete one to test the restore');
      return;
    }
    const victim = free.rows[0].name;
    // Ranger cannot be the victim: the query above selects only is_playable
    // rows and SOMET-471 demoted it. It is left out rather than kept "just in
    // case", because the restore assertion below requires is_playable = true
    // and a demoted Ranger would fail it for the wrong reason.
    const expectedHp = {
      Warrior: 100, Mage: 75, Monk: 90, Cultist: 110, Archer: 85, Druid: 90,
    }[victim];
    const expectedLoadout = {
      Warrior: ['leather-vestx1', 'short swordx1'],
      Mage: ['apprentice staffx1', 'arcane-wardx1'],
      Monk: ['leather-vestx1', 'stickx1'],
      Cultist: ['apprentice staffx1', 'leather-vestx1'],
      Archer: ['arrowx20', 'bowx1', 'leather-vestx1'],
      Druid: ['clubx1', 'leather-vestx1'],
    }[victim];
    const expectedMainStat = {
      Warrior: 'strength', Mage: 'intelligence', Monk: 'wisdom',
      Cultist: 'constitution', Archer: 'dexterity', Druid: 'charisma',
    }[victim];
    assert.ok(expectedHp !== undefined && expectedLoadout !== undefined
      && expectedMainStat !== undefined,
      `no expectation is written for ${victim}; a new class must be added here or this test passes vacuously`);

    try {
      await pool.query('DELETE FROM entity_types WHERE name = $1', [victim]);

      // Prove the wipe happened; otherwise the restore assertions could pass
      // simply because nothing was ever removed.
      const gone = await pool.query(
        'SELECT count(*)::int AS n FROM entity_types WHERE name = $1', [victim]);
      assert.equal(gone.rows[0].n, 0, 'the wipe must actually remove the class');

      await seedCatalogs(pool);

      const back = await pool.query(
        'SELECT name, is_playable, main_stat, hp, max_hp, max_mana FROM entity_types WHERE name = $1',
        [victim]);
      assert.equal(back.rows.length, 1, `${victim} must be restored by the seeder`);
      assert.equal(back.rows[0].is_playable, true,
        'a restored class that is not playable is invisible to character creation');
      assert.equal(Number(back.rows[0].hp), expectedHp);
      assert.equal(Number(back.rows[0].max_hp), expectedHp);
      // SOMET-471. main_stat is the column most likely to come back NULL: the
      // seeder INSERT has to name it, and a restored class without it has no
      // passive-tree sector while still looking correct in the picker.
      assert.equal(back.rows[0].main_stat, expectedMainStat,
        `${victim} must be restored WITH its main stat, or it has no tree sector`);

      const loadout = await pool.query(
        `SELECT i.name AS item, l.quantity
           FROM class_loadouts l
           JOIN entity_types e ON e.id = l.entity_type_id
           JOIN item_types  i ON i.id = l.item_type_id
          WHERE e.name = $1 ORDER BY i.name`, [victim]);
      assert.deepEqual(
        loadout.rows.map((x) => `${x.item}x${x.quantity}`), expectedLoadout,
        'the loadout must come back too, or a rebuilt volume leaves the class with no gear');

      // Idempotent: a second run must not stack duplicate loadout rows.
      await seedCatalogs(pool);
      const after = await pool.query('SELECT count(*)::int AS n FROM class_loadouts');
      // 16 = Warrior 2 + Ranger 3 + Mage 2 + Monk 2 + Cultist 2 + Archer 3
      // + Druid 2. Ranger's three rows are still seeded: it is not playable
      // any more, but characters are still wearing that gear.
      assert.equal(after.rows[0].n, 16, 'a repeat run must not duplicate loadout rows');
    } finally {
      await seedCatalogs(pool);
    }
  });
});
