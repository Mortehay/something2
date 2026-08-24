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
      `SELECT e.name AS class, i.name AS item, l.quantity, l.equip_slot, h.name AS socket_into
         FROM class_loadouts l
         JOIN entity_types e ON e.id = l.entity_type_id
         JOIN item_types  i ON i.id = l.item_type_id
         LEFT JOIN item_types h ON h.id = l.socket_into_item_type_id
        ORDER BY e.name, i.name`);
    // SOMET-492: the wear directives are part of the expectation, not a
    // separate optional check. A list that only names items would go green
    // again the moment the Cultist's staff stopped being worn or its stone
    // stopped being socketed -- which is exactly the state this item fixed.
    const got = r.rows.map((x) => `${x.class}:${x.item}x${x.quantity}`
      + (x.equip_slot ? `@${x.equip_slot}` : '')
      + (x.socket_into ? `>${x.socket_into}` : ''));
    // Ranger is still here after SOMET-471's demotion: characters are wearing
    // this gear, and a rebuilt volume that restored the class without it would
    // leave them with nothing.
    assert.deepEqual(got, [
      'Archer:arrowx20',
      'Archer:bowx1',
      'Archer:leather-vestx1',
      'Cultist:apprentice staffx1@main_hand',
      'Cultist:leather-vestx1',
      'Cultist:stone_of_apprentice staffx1>apprentice staff',
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
  // SOMET-491: the deletion is now made INSIDE A TRANSACTION THAT IS ALWAYS
  // ROLLED BACK, so it is never visible outside this file's own connection.
  // See the long note on the restore test below for why a committed delete
  // plus a "re-seed in a finally block" cleanup was not safe at all.
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
    // SOMET-491 -- WHY THIS RUNS IN A TRANSACTION THAT IS ROLLED BACK.
    //
    // The delete used to be COMMITTED, with a `finally { seedCatalogs(pool) }`
    // putting the class back afterwards. `node --test` runs test FILES as
    // concurrent processes against ONE database, so for the ~1s that
    // seedCatalogs takes to reach its class block, every other process saw a
    // catalog with a class missing. Measured on a freshly seeded scratch
    // database, running only the four class files together failed 10 runs out
    // of 10: with no characters present the victim query below always picks
    // Archer, and that window reliably swallowed class_pools_db.test.js's
    // opening listPlayableClasses() and characters_routes.test.js's
    // GET /api/characters/classes.
    //
    // An advisory lock cannot fix this and was tried and reverted: it would
    // only work if the READERS took it too, and the readers here are the real
    // HTTP route and the real authority join path, which obviously do not.
    // Weakening the readers to tolerate a missing class was rejected outright
    // -- "the catalog offers exactly six classes" is the assertion those files
    // exist to make.
    //
    // A transaction removes the window instead of shrinking it. Under READ
    // COMMITTED no other session can observe an uncommitted DELETE at all, so
    // there is no interleaving left to lose: the class is missing only on this
    // connection, and only until ROLLBACK. Everything the subtest proved
    // before is proved unchanged -- the real seedCatalogs entry point still
    // has to rebuild the row, its main_stat and its loadout, and still has to
    // be idempotent -- because a transaction reads its own writes.
    //
    // ROLLBACK is also a strictly better cleanup than the old finally block,
    // which asked the code under test to repair the damage the test did: if
    // the seeder were broken in exactly the way this test exists to catch, the
    // cleanup was broken too. And the committed delete cascaded further than
    // the seeder restores -- sprite_sets.entity_type_id is ON DELETE SET NULL
    // and creature_drops is ON DELETE CASCADE, neither of which seedCatalogs
    // puts back for a class -- so on a long-lived database it was quietly
    // destructive. A rollback restores the row with its original id and every
    // dependent row intact.
    //
    // The class is chosen at runtime as one NO character is playing -- the FK
    // above makes any other choice impossible, and hardcoding a name would
    // turn this test red the first time someone rolls that class.
    const { seedCatalogs } = require('../scripts/seed-catalogs.js');
    const free = await pool.query(
      `SELECT e.id, e.name FROM entity_types e
        WHERE e.is_playable = true
          AND NOT EXISTS (SELECT 1 FROM characters c WHERE c.entity_type_id = e.id)
        ORDER BY e.name LIMIT 1`);
    if (!free.rows.length) {
      t.diagnostic('every class is in use; cannot safely delete one to test the restore');
      return;
    }
    const victim = free.rows[0].name;
    const victimId = free.rows[0].id;
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
      // SOMET-492/SOMET-335: the directives are in the expectation because a
      // re-seed is exactly where they would be silently lost. The migration
      // authored them; only seeds/data/entityTypes.js can restore them.
      Cultist: ['apprentice staffx1@main_hand', 'leather-vestx1',
        'stone_of_apprentice staffx1>apprentice staff'],
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

    // ONE connection for the whole delete-and-restore, because a transaction
    // lives on a connection: issuing these through `pool` would scatter them
    // across the pool's clients and leave the DELETE stranded in an open
    // transaction on one of them while the assertions read a different,
    // still-intact connection -- green, and proving nothing.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM entity_types WHERE name = $1', [victim]);

      // Prove the wipe happened; otherwise the restore assertions could pass
      // simply because nothing was ever removed.
      const gone = await client.query(
        'SELECT count(*)::int AS n FROM entity_types WHERE name = $1', [victim]);
      assert.equal(gone.rows[0].n, 0, 'the wipe must actually remove the class');

      // ...and prove it is invisible to everyone else, which is the property
      // that makes the transaction a fix rather than a smaller window. This
      // read goes through `pool`, i.e. a DIFFERENT connection, exactly as a
      // concurrently running test file would. Without the BEGIN above it
      // returns 0 and this assertion fails, so the guard cannot be removed
      // and leave the file green.
      const peer = await pool.query(
        'SELECT count(*)::int AS n FROM entity_types WHERE name = $1 AND is_playable = true',
        [victim]);
      assert.equal(peer.rows[0].n, 1,
        `a concurrent reader must still see ${victim}: the wipe must never be committed`);

      await seedCatalogs(client);

      const back = await client.query(
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

      const loadout = await client.query(
        `SELECT i.name AS item, l.quantity, l.equip_slot, h.name AS socket_into
           FROM class_loadouts l
           JOIN entity_types e ON e.id = l.entity_type_id
           JOIN item_types  i ON i.id = l.item_type_id
           LEFT JOIN item_types h ON h.id = l.socket_into_item_type_id
          WHERE e.name = $1 ORDER BY i.name`, [victim]);
      assert.deepEqual(
        loadout.rows.map((x) => `${x.item}x${x.quantity}`
          + (x.equip_slot ? `@${x.equip_slot}` : '')
          + (x.socket_into ? `>${x.socket_into}` : '')), expectedLoadout,
        'the loadout must come back too, or a rebuilt volume leaves the class with no gear');

      // Idempotent: a second run must not stack duplicate loadout rows.
      await seedCatalogs(client);
      const after = await client.query('SELECT count(*)::int AS n FROM class_loadouts');
      // 17 = Warrior 2 + Ranger 3 + Mage 2 + Monk 2 + Cultist 3 + Archer 3
      // + Druid 2. Ranger's three rows are still seeded: it is not playable
      // any more, but characters are still wearing that gear. The Cultist's
      // third row is its spell stone (SOMET-492).
      assert.equal(after.rows[0].n, 17, 'a repeat run must not duplicate loadout rows');
    } finally {
      // Unconditional, and unconditionally sufficient. A failed assertion, a
      // thrown seeder, a crashed process -- every one of them ends with the
      // catalog byte-for-byte as it was, because an uncommitted transaction is
      // discarded either by this statement or by the backend dropping the
      // connection. That is the part the old `seedCatalogs(pool)` cleanup
      // could not promise: it had to run, and it had to work, and a broken
      // seeder failed both.
      let rollbackFailed = false;
      try {
        await client.query('ROLLBACK');
      } catch {
        rollbackFailed = true;
      }
      // A client whose ROLLBACK did not land is not safe to hand back: its
      // connection is in an unknown state and the next borrower inherits it,
      // including the `restored` check immediately below. release(true)
      // destroys it and the pool opens a clean one.
      client.release(rollbackFailed);
    }

    // Belt and braces, on a connection that is NOT the one that held the
    // transaction: the class is present, playable, and carries the id it had
    // before this subtest ran.
    const restored = await pool.query(
      'SELECT id, is_playable FROM entity_types WHERE name = $1', [victim]);
    assert.equal(restored.rows.length, 1, `${victim} must survive this subtest`);
    assert.equal(restored.rows[0].is_playable, true);
    assert.equal(restored.rows[0].id, victimId,
      `${victim} must keep its original id -- a re-created row breaks every FK that pointed at it`);
  });
});
