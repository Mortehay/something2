const test = require('node:test');
const assert = require('node:assert');
const { loadInventory, grantStartingLoadout } = require('../src/authority/items.js');

// Records queries so we can assert what was written.
function recordingPool(handlers) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      for (const [re, fn] of handlers) if (re.test(sql)) return fn(sql, params);
      return { rows: [], rowCount: 0 };
    },
  };
}

test('loadInventory returns owned instances and the equipment map', async () => {
  const pool = recordingPool([
    [/FROM player_items/i, () => ({ rows: [
      { id: 'i1', item_type_id: 1 },
      { id: 'i2', item_type_id: 5 },
    ] })],
    [/FROM player_equipment/i, () => ({ rows: [
      { slot: 'main_hand', item_id: 'i1' },
    ] })],
  ]);
  const inv = await loadInventory(pool, 'u1');
  assert.deepEqual(inv.items, [{ id: 'i1', typeId: 1, quantity: 1 }, { id: 'i2', typeId: 5, quantity: 1 }]);
  assert.deepEqual(inv.equipment, { main_hand: 'i1' });
});

test('grantStartingLoadout inserts the class loadout for a fresh character (never granted)', async () => {
  const inserts = [];
  const pool = recordingPool([
    // F-013: the gate is a single conditional UPDATE, not a SELECT against
    // player_items — see items.js for why (once per CHARACTER, not once per
    // empty inventory; a re-derived-from-ownership gate is what let
    // sell-and-reconnect / drop-and-reconnect regrant for free). SOMET-258
    // moved the flag from users to characters, because the loadout is
    // class-dependent and a second character must get its own.
    [/UPDATE characters SET starting_loadout_granted_at/i, () => ({ rows: [{ id: 3 }], rowCount: 1 })],
    // The item list comes from class_loadouts keyed by the character's class,
    // not from a hardcoded array.
    [/FROM class_loadouts/i, () => ({ rows: [
      { item_type_id: 1, quantity: 1 },
      { item_type_id: 5, quantity: 1 },
    ] })],
    [/INSERT INTO player_items/i, (sql, p) => { inserts.push(p); return { rows: [{ id: 'new' }] }; }],
  ]);
  const itemTypes = new Map([
    [1, { id: 1, name: 'short sword', category: 'weapon' }],
    [5, { id: 5, name: 'leather-vest', category: 'armor' }],
  ]);
  const granted = await grantStartingLoadout(pool, { id: 3, entityTypeId: 11 }, itemTypes);
  assert.equal(granted, true);
  assert.equal(inserts.length, 2);
  // each insert carries (character_id, item_type_id, quantity)
  assert.deepEqual(inserts.map((p) => p[0]), [3, 3]);
  assert.deepEqual(inserts.map((p) => p[1]).sort(), [1, 5]);
  assert.deepEqual(inserts.map((p) => p[2]), [1, 1]);
});

test('grantStartingLoadout is a no-op when the character already claimed its grant', async () => {
  let inserted = 0;
  const pool = recordingPool([
    // WHERE starting_loadout_granted_at IS NULL excludes the row -> 0 rows
    // affected, regardless of whether player_items is currently empty.
    [/UPDATE characters SET starting_loadout_granted_at/i, () => ({ rows: [], rowCount: 0 })],
    [/FROM class_loadouts/i, () => ({ rows: [{ item_type_id: 1, quantity: 1 }] })],
    [/INSERT INTO player_items/i, () => { inserted++; return { rows: [] }; }],
  ]);
  const granted = await grantStartingLoadout(pool, { id: 3, entityTypeId: 11 },
    new Map([[1, { id: 1, name: 'short sword' }]]));
  assert.equal(granted, false);
  assert.equal(inserted, 0);
});

test('grantStartingLoadout skips loadout entries missing from the catalog (no crash)', async () => {
  const inserts = [];
  const pool = recordingPool([
    [/UPDATE characters SET starting_loadout_granted_at/i, () => ({ rows: [{ id: 3 }], rowCount: 1 })],
    // The class wants two items; the in-memory catalog the world was built
    // from only knows one of them.
    [/FROM class_loadouts/i, () => ({ rows: [
      { item_type_id: 1, quantity: 1 },
      { item_type_id: 99, quantity: 1 },
    ] })],
    [/INSERT INTO player_items/i, (sql, p) => { inserts.push(p); return { rows: [] }; }],
  ]);
  const granted = await grantStartingLoadout(pool, { id: 3, entityTypeId: 11 },
    new Map([[1, { id: 1, name: 'short sword' }]]));
  assert.equal(granted, true);
  assert.equal(inserts.length, 1); // only the short sword existed
});
