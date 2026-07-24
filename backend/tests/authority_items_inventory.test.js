const test = require('node:test');
const assert = require('node:assert');
const { loadInventory, grantStartingLoadout, STARTING_LOADOUT } = require('../src/authority/items.js');

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

test('grantStartingLoadout inserts the starter set for a fresh account (never granted)', async () => {
  const inserts = [];
  const pool = recordingPool([
    // F-013: the gate is a single conditional UPDATE against users, not a
    // SELECT against player_items — see items.js for why (once per account,
    // not once per empty inventory; a re-derived-from-ownership gate is what
    // let sell-and-reconnect / drop-and-reconnect regrant for free).
    [/UPDATE users SET starting_loadout_granted_at/i, () => ({ rows: [{ id: 'u1' }], rowCount: 1 })],
    [/INSERT INTO player_items/i, (sql, p) => { inserts.push(p); return { rows: [{ id: 'new' }] }; }],
  ]);
  const itemTypes = new Map([
    [1, { id: 1, name: 'dagger', category: 'weapon' }],
    [5, { id: 5, name: 'leather-vest', category: 'armor' }],
  ]);
  const granted = await grantStartingLoadout(pool, 'u1', itemTypes);
  assert.equal(granted, true);
  assert.equal(inserts.length, STARTING_LOADOUT.length);
  // each insert carries (user_id, item_type_id)
  assert.deepEqual(inserts.map((p) => p[0]), ['u1', 'u1']);
  assert.deepEqual(inserts.map((p) => p[1]).sort(), [1, 5]);
});

test('grantStartingLoadout is a no-op when the account already claimed its grant', async () => {
  let inserted = 0;
  const pool = recordingPool([
    // WHERE starting_loadout_granted_at IS NULL excludes the row -> 0 rows
    // affected, regardless of whether player_items is currently empty.
    [/UPDATE users SET starting_loadout_granted_at/i, () => ({ rows: [], rowCount: 0 })],
    [/INSERT INTO player_items/i, () => { inserted++; return { rows: [] }; }],
  ]);
  const granted = await grantStartingLoadout(pool, 'u1', new Map([[1, { id: 1, name: 'dagger' }]]));
  assert.equal(granted, false);
  assert.equal(inserted, 0);
});

test('grantStartingLoadout skips loadout entries missing from the catalog (no crash)', async () => {
  const inserts = [];
  const pool = recordingPool([
    [/UPDATE users SET starting_loadout_granted_at/i, () => ({ rows: [{ id: 'u1' }], rowCount: 1 })],
    [/INSERT INTO player_items/i, (sql, p) => { inserts.push(p); return { rows: [] }; }],
  ]);
  const granted = await grantStartingLoadout(pool, 'u1', new Map([[1, { id: 1, name: 'dagger' }]]));
  assert.equal(granted, true);
  assert.equal(inserts.length, 1); // only the dagger existed
});
