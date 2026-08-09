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

  const STAT_COLUMNS = [
    'strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma',
    'hp', 'max_hp', 'hp_regen_rate', 'mana', 'max_mana', 'mana_regen_rate',
  ];

  await t.test('Warrior is an exact stat clone of Player', async () => {
    const r = await pool.query(
      `SELECT name, ${STAT_COLUMNS.join(', ')} FROM entity_types
        WHERE name IN ('Player', 'Warrior')`);
    const by = new Map(r.rows.map((x) => [x.name, x]));
    assert.ok(by.get('Player'), 'the Player entity type must still exist');
    assert.ok(by.get('Warrior'), 'Warrior must exist');
    for (const col of STAT_COLUMNS) {
      assert.equal(
        Number(by.get('Warrior')[col]), Number(by.get('Player')[col]),
        `Warrior.${col} must equal Player.${col} -- a drift here rebalances every backfilled character`);
    }
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
      { hp: 75, int: 12, mana: 70 });
  });

  await t.test('exactly the three classes are playable', async () => {
    const r = await pool.query(
      'SELECT name FROM entity_types WHERE is_playable = true ORDER BY name');
    assert.deepEqual(r.rows.map((x) => x.name), ['Mage', 'Ranger', 'Warrior']);
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
    assert.deepEqual(got, [
      'Mage:apprentice staffx1',
      'Mage:arcane-wardx1',
      'Ranger:arrowx20',
      'Ranger:bowx1',
      'Ranger:leather-vestx1',
      'Warrior:leather-vestx1',
      'Warrior:short swordx1',
    ]);
  });
});
