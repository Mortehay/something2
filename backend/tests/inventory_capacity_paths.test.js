const test = require('node:test');
const assert = require('node:assert');
const { buyStock } = require('../src/authority/trade');
const { withdrawItem } = require('../src/services/accountChest');

const TYPES = new Map([[1, { id: 1, name: 'short sword', category: 'weapon' }]]);

function fullEntry(capacity) {
  const items = [];
  for (let n = 0; n < capacity; n += 1) items.push({ id: `i${n}`, typeId: 1, quantity: 1 });
  const player = { userId: 'u1', characterId: 7, gold: 10000, inv: { items, equipment: {}, capacity } };
  return { worldId: 'w1', world: { getPlayer: () => player, weapons: TYPES }, _player: player };
}

function roomyEntry(capacity) {
  const player = { userId: 'u1', characterId: 7, gold: 10000, inv: { items: [], equipment: {}, capacity } };
  return { worldId: 'w1', world: { getPlayer: () => player, weapons: TYPES }, _player: player };
}

// A pool that fails loudly. A full inventory must be refused before ANY
// statement runs, so reaching the database at all is the bug this catches —
// relying on ROLLBACK to undo a debit is one refactor away from not working.
const forbiddenPool = {
  connect: async () => { throw new Error('must not open a transaction'); },
  query: async () => { throw new Error('must not query'); },
};

test('buying into a full inventory is refused without touching gold', async () => {
  const entry = fullEntry(3);
  const r = await buyStock(forbiddenPool, entry, 'u1', 7, 'stock-1', 'v1');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'Inventory full');
  assert.strictEqual(entry._player.gold, 10000);
});

test('withdrawing into a full inventory is refused without touching the chest', async () => {
  const entry = fullEntry(3);
  const r = await withdrawItem(forbiddenPool, entry, 'u1', 7, 'acct-1');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'Inventory full');
});

// The mirror cases: with room, both must get past the guard and reach the
// database. Without these, a guard that refused unconditionally would pass
// the two tests above.
test('buying with room reaches the database', async () => {
  const entry = roomyEntry(3);
  let connected = false;
  const pool = { connect: async () => { connected = true; throw new Error('reached the db'); } };
  await assert.rejects(buyStock(pool, entry, 'u1', 7, 'stock-1', 'v1'), /reached the db/);
  assert.strictEqual(connected, true);
});

test('withdrawing with room reaches the database', async () => {
  const entry = roomyEntry(3);
  let connected = false;
  const pool = { connect: async () => { connected = true; throw new Error('reached the db'); } };
  await assert.rejects(withdrawItem(pool, entry, 'u1', 7, 'acct-1'), /reached the db/);
  assert.strictEqual(connected, true);
});
