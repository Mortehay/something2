const test = require('node:test');
const assert = require('node:assert');
const { usedSlots, capacityOf, freeSlots, hasFreeSlot, DEFAULT_INVENTORY_SLOTS } = require('../src/authority/items');
const { claimItem } = require('../src/authority/loot');

const TYPES = new Map([
  [1, { id: 1, name: 'short sword', category: 'weapon' }],
  [2, { id: 2, name: 'arrow', category: 'ammo' }],
  [3, { id: 3, name: 'gold', category: 'currency' }],
]);

function inv(items, capacity) {
  return { items, equipment: {}, capacity };
}

test('usedSlots counts stacks, not quantities', () => {
  const i = inv([{ id: 'a', typeId: 2, quantity: 40 }, { id: 'b', typeId: 2, quantity: 40 }], 48);
  assert.strictEqual(usedSlots(i, TYPES), 2);
});

test('usedSlots ignores currency', () => {
  const i = inv([{ id: 'g', typeId: 3, quantity: 9999 }, { id: 'a', typeId: 1, quantity: 1 }], 48);
  assert.strictEqual(usedSlots(i, TYPES), 1);
});

test('usedSlots counts an item whose type is not in the catalog', () => {
  assert.strictEqual(usedSlots(inv([{ id: 'x', typeId: 99, quantity: 1 }], 48), TYPES), 1);
});

test('capacityOf falls back to the default for a missing or nonsense value', () => {
  assert.strictEqual(capacityOf(inv([], null)), DEFAULT_INVENTORY_SLOTS);
  assert.strictEqual(capacityOf(inv([], 0)), DEFAULT_INVENTORY_SLOTS);
  assert.strictEqual(capacityOf(inv([], -3)), DEFAULT_INVENTORY_SLOTS);
  assert.strictEqual(capacityOf(inv([], 96)), 96);
});

test('freeSlots never goes negative', () => {
  const items = [];
  for (let n = 0; n < 5; n += 1) items.push({ id: `i${n}`, typeId: 1, quantity: 1 });
  assert.strictEqual(freeSlots(inv(items, 2), TYPES), 0);
  assert.strictEqual(hasFreeSlot(inv(items, 2), TYPES), false);
  assert.strictEqual(hasFreeSlot(inv(items, 6), TYPES), true);
});

// claimItem with a stub pool that THROWS on any query: a full inventory must
// not reach the database at all, because the claim statement DELETEs the world
// row as it grants. "Refuses without querying" is therefore an assertion, not
// a claim in a comment.
function stubEntry(items, capacity) {
  const player = { userId: 'u1', characterId: 7, inv: inv(items, capacity) };
  return {
    claiming: new Set(),
    claimRetryAt: new Map(),
    world: {
      weapons: TYPES,
      getPlayer: () => player,
      groundItems: { remove() {} },
    },
    _player: player,
  };
}

test('claimItem refuses a full inventory without querying', async () => {
  const items = [];
  for (let n = 0; n < 3; n += 1) items.push({ id: `i${n}`, typeId: 1, quantity: 1 });
  const entry = stubEntry(items, 3);
  let queried = false;
  const pool = { query: async () => { queried = true; throw new Error('must not query'); } };

  const r = await claimItem(pool, entry, 'u1', 7, 'ground-1');

  assert.deepStrictEqual(r, { full: true });
  assert.strictEqual(queried, false);
  assert.strictEqual(entry._player.inv.items.length, 3);
});

test('claimItem grants when there is room', async () => {
  const entry = stubEntry([], 3);
  const pool = { query: async () => ({ rowCount: 1, rows: [{ id: 'new-1', item_type_id: 1, quantity: 1 }] }) };

  const r = await claimItem(pool, entry, 'u1', 7, 'ground-1');

  assert.strictEqual(r.id, 'new-1');
  assert.strictEqual(entry._player.inv.items.length, 1);
});

test('claimItem still grants the last free slot', async () => {
  const entry = stubEntry([{ id: 'i0', typeId: 1, quantity: 1 }], 2);
  const pool = { query: async () => ({ rowCount: 1, rows: [{ id: 'new-2', item_type_id: 1, quantity: 1 }] }) };

  const r = await claimItem(pool, entry, 'u1', 7, 'ground-2');

  assert.strictEqual(r.id, 'new-2');
  assert.strictEqual(entry._player.inv.items.length, 2);
});

// The auto-loot sweep fires one claimItem per ground item in the same tick, BEFORE any of
// them has finished and pushed into p.inv.items. A capacity check that only counts what is
// already in the inventory passes for every one of them, so one free slot took the whole pile.
test('claimItem: concurrent claims never take more than the free slots', async () => {
  const entry = stubEntry([{ id: 'i0', typeId: 1, quantity: 1 }], 2); // exactly 1 free slot
  let n = 0;
  const pool = {
    query: async () => {
      await new Promise((r) => setTimeout(r, 5)); // the round trip the real claim awaits
      n += 1;
      return { rowCount: 1, rows: [{ id: `new-${n}`, item_type_id: 1, quantity: 1 }] };
    },
  };

  const results = await Promise.all(
    ['g1', 'g2', 'g3', 'g4'].map((g) => claimItem(pool, entry, 'u1', 7, g)),
  );

  assert.strictEqual(results.filter((r) => r && r.id).length, 1, 'only one item fits');
  assert.strictEqual(results.filter((r) => r && r.full).length, 3, 'the rest are told the bag is full');
  assert.strictEqual(entry._player.inv.items.length, 2, 'never over capacity');
});

test('claimItem: a failed claim gives its reserved slot back', async () => {
  const entry = stubEntry([], 1);
  const failing = { query: async () => { throw new Error('db down'); } };
  await assert.rejects(() => claimItem(failing, entry, 'u1', 7, 'g1'), /db down/);

  const ok = { query: async () => ({ rowCount: 1, rows: [{ id: 'n1', item_type_id: 1, quantity: 1 }] }) };
  // g1 is in its retry backoff, so a different item must still find the slot free.
  const r = await claimItem(ok, entry, 'u1', 7, 'g2');
  assert.strictEqual(r.id, 'n1');
});

test('claimItem: a lost race gives its reserved slot back', async () => {
  const entry = stubEntry([], 1);
  const lost = { query: async () => ({ rowCount: 0, rows: [] }) };
  assert.strictEqual(await claimItem(lost, entry, 'u1', 7, 'g1'), null);

  const ok = { query: async () => ({ rowCount: 1, rows: [{ id: 'n1', item_type_id: 1, quantity: 1 }] }) };
  const r = await claimItem(ok, entry, 'u1', 7, 'g2');
  assert.strictEqual(r.id, 'n1');
});
