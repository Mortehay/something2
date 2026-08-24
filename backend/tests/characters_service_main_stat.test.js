// SOMET-471 -- main_stat and the class name have to survive the mapping layer.
//
// A pool that records the SQL it was handed and replays a canned result. No
// database: these two functions are shape-mapping, and the shape is what
// downstream code depends on -- CharacterSelect.jsx renders `mainStat`, and
// the authority's join path reads `className`. The DB-level facts (which rows
// exist, what main_stat they carry) are six_classes_db.test.js's job.
//
// The SQL is asserted as well as the returned object, deliberately. Mapping
// `x.main_stat` in JS while forgetting the column in the SELECT yields
// `mainStat: undefined` for every class, silently, and a test that only
// inspected the canned result would pass -- the canned rows carry the column
// whether or not the query asks for it.

const test = require('node:test');
const assert = require('node:assert');
const { listPlayableClasses, ownedCharacter } = require('../src/services/characters.js');

function fakePool(rows) {
  const seen = [];
  return {
    seen,
    query: async (sql) => { seen.push(sql); return { rows }; },
  };
}

test('listPlayableClasses carries main_stat through as mainStat', async () => {
  const pool = fakePool([
    {
      id: 7, name: 'Druid', color: '#2f7d5b', main_stat: 'charisma',
      max_hp: 90, max_mana: 135,
      strength: 10, dexterity: 10, constitution: 10,
      intelligence: 10, wisdom: 10, charisma: 12,
    },
  ]);
  const classes = await listPlayableClasses(pool);
  assert.deepEqual(classes, [{
    id: 7, name: 'Druid', color: '#2f7d5b', mainStat: 'charisma',
    hp: 90, mana: 135,
    strength: 10, dexterity: 10, constitution: 10,
    intelligence: 10, wisdom: 10, charisma: 12,
  }]);
  assert.match(pool.seen[0], /main_stat/,
    'the column has to be SELECTed, or mainStat is undefined for every class');
});

test('listPlayableClasses still orders by id, not by name', async () => {
  // CharacterSelect.jsx defaults the picker to classes[0]. Re-ordering here
  // would silently change which class a player gets by pressing Create without
  // touching the radios -- and adding four classes is exactly the change that
  // would tempt someone to sort them.
  const pool = fakePool([]);
  await listPlayableClasses(pool);
  assert.match(pool.seen[0], /ORDER BY id ASC/);
});

test('ownedCharacter carries the class name and main stat', async () => {
  const pool = fakePool([
    {
      id: 3, entity_type_id: 9, inventory_slots: 24,
      class_name: 'Cultist', main_stat: 'constitution',
      max_hp: 110, max_mana: 90,
    },
  ]);
  const c = await ownedCharacter(pool, 1, 3);
  assert.deepEqual(c, {
    id: 3, entityTypeId: 9, inventorySlots: 24,
    className: 'Cultist', mainStat: 'constitution',
    classPools: { maxHp: 110, maxMana: 90 },
  });
  assert.match(pool.seen[0], /main_stat/);
});

test('ownedCharacter survives a character whose class row has vanished', async () => {
  // The LEFT JOIN case SOMET-486 documented: ownership is a fact about
  // `characters`, so a missing entity_types row must still resolve. className
  // and mainStat come back null rather than throwing, and classPools falls
  // back to nulls so derivePlayerStats substitutes its own bases.
  const pool = fakePool([
    {
      id: 3, entity_type_id: 9, inventory_slots: 24,
      class_name: null, main_stat: null, max_hp: null, max_mana: null,
    },
  ]);
  assert.deepEqual(await ownedCharacter(pool, 1, 3), {
    id: 3, entityTypeId: 9, inventorySlots: 24,
    className: null, mainStat: null,
    classPools: { maxHp: null, maxMana: null },
  });
});

test('ownedCharacter still refuses a non-integer id without querying', async () => {
  const pool = fakePool([]);
  assert.equal(await ownedCharacter(pool, 1, 'nope'), null);
  assert.equal(pool.seen.length, 0);
});
