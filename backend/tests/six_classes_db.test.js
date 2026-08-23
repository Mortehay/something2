// SOMET-471 (Progression B1) -- the six-class catalog, as it exists in the
// database.
//
// Every expected number below is written out by hand. Reading them from
// seeds/data/entityTypes.js or from the migration's exported NEW_CLASSES (the
// two places the data is authored) would pass against a seeder or a migration
// that writes nothing at all -- the exact failure shape playable_classes_db
// .test.js already documents for the Wolf row.

const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

test('six playable classes', { skip: !url ? 'no database URL' : false }, async (t) => {
  const pool = new Pool({ connectionString: url });
  t.after(() => pool.end());

  await t.test('exactly six classes are playable, each with its main stat', async () => {
    const r = await pool.query(
      `SELECT name, main_stat FROM entity_types
        WHERE is_playable = true ORDER BY name`);
    assert.deepEqual(
      r.rows.map((x) => `${x.name}:${x.main_stat}`),
      [
        'Archer:dexterity',
        'Cultist:constitution',
        'Druid:charisma',
        'Mage:intelligence',
        'Monk:wisdom',
        'Warrior:strength',
      ]);
  });

  await t.test('the six main stats are the six stat columns, one each', async () => {
    // Stated as a property as well as a list: the tree has exactly six sectors
    // and each start node sits in one of them, so two classes sharing a main
    // stat would leave one sector with no class and one with two.
    const r = await pool.query(
      'SELECT DISTINCT main_stat FROM entity_types WHERE is_playable = true ORDER BY main_stat');
    assert.deepEqual(r.rows.map((x) => x.main_stat),
      ['charisma', 'constitution', 'dexterity', 'intelligence', 'strength', 'wisdom']);
  });

  await t.test('Ranger is kept, demoted, and NOT renamed', async () => {
    const r = await pool.query(
      `SELECT is_playable, main_stat, hp, max_hp, mana, max_mana, dexterity
         FROM entity_types WHERE name = 'Ranger'`);
    assert.equal(r.rows.length, 1,
      'the Ranger row must still exist: live characters.entity_type_id values point at it');
    assert.equal(r.rows[0].is_playable, false);
    assert.equal(r.rows[0].main_stat, null,
      'a not-playable row has no tree start position');
    // Unchanged from 1714440091000 and 1714440509000. A demotion must not
    // retune the row -- an existing Ranger keeps playing exactly as before.
    assert.equal(Number(r.rows[0].hp), 85);
    assert.equal(Number(r.rows[0].max_hp), 85);
    assert.equal(Number(r.rows[0].mana), 115);
    assert.equal(Number(r.rows[0].max_mana), 115);
    assert.equal(Number(r.rows[0].dexterity), 12);
  });

  await t.test('Archer did not steal the Ranger row', async () => {
    // The rename this epic refused, asserted directly: two DISTINCT rows with
    // two DISTINCT ids. A rename would leave one row answering to both names
    // in a reader's head and to neither in the database.
    const r = await pool.query(
      "SELECT name, id FROM entity_types WHERE name IN ('Ranger', 'Archer') ORDER BY name");
    assert.deepEqual(r.rows.map((x) => x.name), ['Archer', 'Ranger']);
    assert.notEqual(r.rows[0].id, r.rows[1].id);
  });

  // Adding four rows must not move the two that already exist. Asserted
  // against literals, and against every column that could drift.
  await t.test('Warrior and Mage keep the stats and pools they already had', async () => {
    const r = await pool.query(
      `SELECT name, strength, dexterity, constitution, intelligence, wisdom, charisma,
              hp, max_hp, mana, max_mana, hp_regen_rate, mana_regen_rate
         FROM entity_types WHERE name IN ('Warrior', 'Mage')`);
    const by = new Map(r.rows.map((x) => [x.name, x]));
    const shape = (n) => ({
      str: Number(by.get(n).strength), dex: Number(by.get(n).dexterity),
      con: Number(by.get(n).constitution), int: Number(by.get(n).intelligence),
      wis: Number(by.get(n).wisdom), cha: Number(by.get(n).charisma),
      hp: Number(by.get(n).hp), maxHp: Number(by.get(n).max_hp),
      mana: Number(by.get(n).mana), maxMana: Number(by.get(n).max_mana),
      hpRegen: Number(by.get(n).hp_regen_rate), manaRegen: Number(by.get(n).mana_regen_rate),
    });
    assert.deepEqual(shape('Warrior'), {
      str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10,
      hp: 100, maxHp: 100, mana: 100, maxMana: 100, hpRegen: 1, manaRegen: 0.5,
    });
    assert.deepEqual(shape('Mage'), {
      str: 10, dex: 10, con: 10, int: 12, wis: 10, cha: 10,
      hp: 75, maxHp: 75, mana: 150, maxMana: 150, hpRegen: 1, manaRegen: 0.5,
    });
  });

  await t.test('the four new classes carry their own literal stats and pools', async () => {
    const r = await pool.query(
      `SELECT name, hp, max_hp, mana, max_mana,
              strength, dexterity, constitution, intelligence, wisdom, charisma
         FROM entity_types WHERE name IN ('Monk', 'Cultist', 'Archer', 'Druid')`);
    const by = new Map(r.rows.map((x) => [x.name, x]));
    const pools = (n) => ({
      hp: Number(by.get(n).hp), maxHp: Number(by.get(n).max_hp),
      mana: Number(by.get(n).mana), maxMana: Number(by.get(n).max_mana),
    });
    // hp and max_hp are asserted separately, not assumed equal: these rows are
    // templates and a template whose current pool disagrees with its max is
    // the trap 1714440509000's header names.
    assert.deepEqual(pools('Monk'), { hp: 90, maxHp: 90, mana: 110, maxMana: 110 });
    assert.deepEqual(pools('Cultist'), { hp: 110, maxHp: 110, mana: 90, maxMana: 90 });
    assert.deepEqual(pools('Archer'), { hp: 85, maxHp: 85, mana: 115, maxMana: 115 });
    assert.deepEqual(pools('Druid'), { hp: 90, maxHp: 90, mana: 135, maxMana: 135 });

    // Each new class raises its own main stat to 12 and nothing else. These
    // columns are display-only for a player (createCharacter snapshots every
    // class at BASE_STAT, contract 6.1), so the assertion is that they SAY the
    // right thing, not that they do anything.
    const stats = (n) => [
      Number(by.get(n).strength), Number(by.get(n).dexterity), Number(by.get(n).constitution),
      Number(by.get(n).intelligence), Number(by.get(n).wisdom), Number(by.get(n).charisma),
    ];
    assert.deepEqual(stats('Monk'), [10, 10, 10, 10, 12, 10]);
    assert.deepEqual(stats('Cultist'), [10, 10, 12, 10, 10, 10]);
    assert.deepEqual(stats('Archer'), [10, 12, 10, 10, 10, 10]);
    assert.deepEqual(stats('Druid'), [10, 10, 10, 10, 10, 12]);
  });

  await t.test('the six budgets are the ones the migration header justifies', async () => {
    // The rule from contract 6.11 / migration 1714440509000, restated as a
    // property: a class trades HP for mana at par on a 200-point budget, and
    // only a class gated on SPENDING mana gets the +25. Written as a total so
    // a future retune that moves one pool without moving the other fails here
    // with the budget named, rather than only failing the literal above with
    // no explanation of what the number meant.
    const r = await pool.query(
      'SELECT name, max_hp + max_mana AS budget FROM entity_types WHERE is_playable = true ORDER BY name');
    assert.deepEqual(
      r.rows.map((x) => [x.name, Number(x.budget)]),
      [['Archer', 200], ['Cultist', 200], ['Druid', 225], ['Mage', 225],
        ['Monk', 200], ['Warrior', 200]]);
  });

  await t.test('no two classes join with the same pools', async () => {
    // Identical pools across classes is exactly the state SOMET-486 found the
    // game in (100/100 for everybody) and is invisible in every other
    // assertion here, each of which would still pass.
    const r = await pool.query(
      'SELECT max_hp, max_mana FROM entity_types WHERE is_playable = true');
    const seen = r.rows.map((x) => `${x.max_hp}/${x.max_mana}`);
    assert.equal(new Set(seen).size, 6, `six distinct pool pairs, got ${seen.join(', ')}`);
  });

  await t.test('every new class has a loadout resolved to real item types', async () => {
    // The JOIN is the point. class_loadouts rows are inserted by a guarded
    // cross-join on NAMES, so a typo'd item name inserts nothing at all and
    // leaves the class with empty hands; counting rows in class_loadouts would
    // not notice, and neither would a LEFT JOIN.
    const r = await pool.query(
      `SELECT e.name AS class, i.name AS item, l.quantity
         FROM class_loadouts l
         JOIN entity_types e ON e.id = l.entity_type_id
         JOIN item_types  i ON i.id = l.item_type_id
        WHERE e.name IN ('Monk', 'Cultist', 'Archer', 'Druid')
        ORDER BY e.name, i.name`);
    assert.deepEqual(r.rows.map((x) => `${x.class}:${x.item}x${x.quantity}`), [
      'Archer:arrowx20',
      'Archer:bowx1',
      'Archer:leather-vestx1',
      'Cultist:apprentice staffx1',
      'Cultist:leather-vestx1',
      'Druid:clubx1',
      'Druid:leather-vestx1',
      'Monk:leather-vestx1',
      'Monk:stickx1',
    ]);
  });

  await t.test('no playable class has an empty loadout', async () => {
    // The literal above covers the four new rows; this covers all six, so a
    // seventh class added later without gear cannot slip through.
    const r = await pool.query(
      `SELECT e.name FROM entity_types e
        WHERE e.is_playable = true
          AND NOT EXISTS (SELECT 1 FROM class_loadouts l WHERE l.entity_type_id = e.id)
        ORDER BY e.name`);
    assert.deepEqual(r.rows.map((x) => x.name), []);
  });

  await t.test('every loadout row resolves to a real item type', async () => {
    // The guarded-join invariant, stated over the whole table: a class_loadouts
    // row whose item_type_id points at nothing is a starting item that silently
    // never arrives.
    const r = await pool.query(
      `SELECT l.entity_type_id, l.item_type_id FROM class_loadouts l
        WHERE NOT EXISTS (SELECT 1 FROM item_types i WHERE i.id = l.item_type_id)
           OR NOT EXISTS (SELECT 1 FROM entity_types e WHERE e.id = l.entity_type_id)`);
    assert.deepEqual(r.rows, []);
  });

  await t.test('main_stat rejects a value that is not one of the six stats', async () => {
    // Scoped to a single UPDATE that the CHECK must refuse. It cannot leave a
    // changed row behind: a rejected statement changes nothing.
    await assert.rejects(
      () => pool.query("UPDATE entity_types SET main_stat = 'luck' WHERE name = 'Monk'"),
      /entity_types_main_stat_check/);
  });

  await t.test('a not-playable row is not required to carry a main_stat', async () => {
    // The other half of the CHECK: NULL stays legal, which is what lets the
    // 289 creature rows, the legacy 'Player' row and the demoted Ranger exist.
    const r = await pool.query(
      `SELECT count(*)::int AS n FROM entity_types
        WHERE is_playable = false AND main_stat IS NOT NULL`);
    assert.equal(r.rows[0].n, 0,
      'only a playable class has a tree start position');
  });
});
