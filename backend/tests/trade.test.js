// backend/tests/trade.test.js
const test = require('node:test');
const assert = require('node:assert');
const { buyStock, sellItem } = require('../src/authority/trade');

function mkEntry(player, worldId = 'w1') {
  return { worldId, world: { getPlayer: () => player } };
}
// stats.priceMult 0.5 is the pre-A2 SELL_FRACTION default (a base-charisma
// character's derivePlayerStats output) -- p.stats is never optional past
// world.js's addPlayer (see its comment there), and sellItem now reads
// p.stats.priceMult, so this fixture must carry it like a real live player
// would.
const PLAYER = () => ({ userId: 1, gold: 100, x: 0, y: 0, width: 64, height: 64,
  inv: { items: [{ id: 'i1', typeId: 3, quantity: 1 }], equipment: {} },
  stats: { priceMult: 0.5 } });

// Builds a mock pool whose `connect()` returns a fake client that records
// BEGIN/COMMIT/ROLLBACK alongside the statements routed to `handlers`.
function mkPool(handlers) {
  const seen = [];
  let committed = false;
  let rolledBack = false;
  const client = {
    query: async (sql, params) => {
      seen.push(sql);
      if (/^BEGIN$/i.test(sql.trim())) return {};
      if (/^COMMIT$/i.test(sql.trim())) { committed = true; return {}; }
      if (/^ROLLBACK$/i.test(sql.trim())) { rolledBack = true; return {}; }
      for (const [re, fn] of handlers) {
        if (re.test(sql)) return fn(sql, params);
      }
      throw new Error('unexpected ' + sql);
    },
    release: () => {},
  };
  const pool = {
    connect: async () => client,
    seen,
    get committed() { return committed; },
    get rolledBack() { return rolledBack; },
  };
  return pool;
}

test('buyStock debits gold, grants the item, and leaves a base-catalog row in place', async () => {
  const p = PLAYER();
  const pool = mkPool([
    [/FROM merchant_stock WHERE id/i, () => ({ rows: [{ id: 's1', item_type_id: 3, price: 20, seller_user_id: null, village_id: 'v1' }] })],
    [/UPDATE users SET gold = gold - /i, (sql) => { assert.match(sql, /gold >= /, 'debit must be overdraft-safe'); return { rowCount: 1, rows: [{ gold: 80 }] }; }],
    [/INSERT INTO player_items/i, () => ({ rows: [{ id: 'new1', item_type_id: 3, quantity: 1 }] })],
  ]);
  const r = await buyStock(pool, mkEntry(p), 1, 31, 's1');
  assert.equal(r.ok, true);
  assert.equal(r.gold, 80);
  assert.equal(p.gold, 80, 'in-memory wallet mirrors');
  assert.ok(p.inv.items.some((it) => it.id === 'new1'), 'item added to in-memory inventory');
  assert.ok(!pool.seen.some((s) => /DELETE FROM merchant_stock/i.test(s)), 'base-catalog row is NOT consumed');
  assert.equal(pool.committed, true, 'transaction committed on success');
  assert.equal(pool.rolledBack, false);
  // BEGIN before any business query, COMMIT after the last one.
  assert.match(pool.seen[0], /^BEGIN$/i);
  assert.match(pool.seen[pool.seen.length - 1], /^COMMIT$/i);
});

test('buying a buyback row deletes it', async () => {
  const p = PLAYER();
  let deleted = false;
  const pool = mkPool([
    // NOTE: DELETE is checked before the generic SELECT match below, since
    // "DELETE FROM merchant_stock WHERE id = $1" also matches
    // /FROM merchant_stock WHERE id/i and would otherwise be misrouted.
    [/DELETE FROM merchant_stock/i, () => { deleted = true; return { rowCount: 1 }; }],
    [/FROM merchant_stock WHERE id/i, () => ({ rows: [{ id: 's2', item_type_id: 3, price: 5, seller_user_id: 7, village_id: 'v1' }] })],
    [/UPDATE users SET gold = gold - /i, () => ({ rowCount: 1, rows: [{ gold: 95 }] })],
    [/INSERT INTO player_items/i, () => ({ rows: [{ id: 'new2', item_type_id: 3, quantity: 1 }] })],
  ]);
  const r = await buyStock(pool, mkEntry(p), 1, 31, 's2');
  assert.equal(r.ok, true);
  assert.equal(deleted, true, 'buyback rows are one-off and must be removed');
  assert.equal(pool.committed, true);
  assert.equal(pool.rolledBack, false);
});

test('buyStock locks the stock row FOR UPDATE to prevent a concurrent double-sell', async () => {
  const p = PLAYER();
  let selectSql = null;
  const pool = mkPool([
    [/FROM merchant_stock WHERE id/i, (sql) => { selectSql = sql; return { rows: [{ id: 's1', item_type_id: 3, price: 20, seller_user_id: null, village_id: 'v1' }] }; }],
    [/UPDATE users SET gold = gold - /i, () => ({ rowCount: 1, rows: [{ gold: 80 }] })],
    [/INSERT INTO player_items/i, () => ({ rows: [{ id: 'new1', item_type_id: 3, quantity: 1 }] })],
  ]);
  const r = await buyStock(pool, mkEntry(p), 1, 31, 's1');
  assert.equal(r.ok, true);
  assert.match(selectSql, /FOR UPDATE/i, 'stock row must be locked to serialize concurrent buyers');
});

test('a buyback whose row vanishes out from under the DELETE (lost race) rolls back and grants nothing', async () => {
  const p = PLAYER();
  const pool = mkPool([
    // Row still visible to this transaction's SELECT ... FOR UPDATE (it had to
    // wait for the winner's lock, then re-read), but by the time this tx's
    // DELETE runs the row is already gone — defensive rowCount check catches it.
    [/DELETE FROM merchant_stock/i, () => ({ rowCount: 0 })],
    [/FROM merchant_stock WHERE id/i, () => ({ rows: [{ id: 's2', item_type_id: 3, price: 5, seller_user_id: 7, village_id: 'v1' }] })],
    [/UPDATE users SET gold = gold - /i, () => ({ rowCount: 1, rows: [{ gold: 95 }] })],
    [/INSERT INTO player_items/i, () => ({ rows: [{ id: 'new2', item_type_id: 3, quantity: 1 }] })],
  ]);
  const r = await buyStock(pool, mkEntry(p), 1, 31, 's2');
  assert.equal(r.ok, false);
  assert.match(r.reason, /no longer for sale/i);
  assert.equal(pool.rolledBack, true, 'must roll back when the buyback row is already gone');
  assert.equal(pool.committed, false, 'must not commit a grant for a row that no longer exists');
  assert.equal(p.gold, 100, 'wallet must be untouched — no debit persisted in memory');
  assert.ok(!p.inv.items.some((it) => it.id === 'new2'), 'no item granted');
  assert.equal(p.inv.items.length, 1, 'inventory unchanged from initial state');
});

test('buyStock with insufficient gold errors, grants nothing, and rolls back', async () => {
  const p = PLAYER();
  const pool = mkPool([
    [/FROM merchant_stock WHERE id/i, () => ({ rows: [{ id: 's1', item_type_id: 3, price: 500, seller_user_id: null, village_id: 'v1' }] })],
    [/UPDATE users SET gold = gold - /i, () => ({ rowCount: 0, rows: [] })], // guard rejected
  ]);
  const r = await buyStock(pool, mkEntry(p), 1, 31, 's1');
  assert.equal(r.ok, false);
  assert.match(r.reason, /gold/i);
  assert.equal(p.gold, 100, 'wallet untouched');
  assert.ok(!pool.seen.some((s) => /INSERT INTO player_items/i.test(s)), 'no item granted');
  assert.equal(pool.committed, false, 'must not commit on rejection');
  assert.equal(pool.rolledBack, true, 'must roll back on rejection');
});

test('sellItem removes the item, credits gold, and inserts a buyback row', async () => {
  const p = PLAYER();
  const pool = mkPool([
    [/SELECT 1 FROM stone_instances si\s+JOIN player_items pi/i, () => ({ rowCount: 0, rows: [] })],
    [/DELETE FROM player_items/i, (sql) => { assert.match(sql, /character_id = \$2/, 'ownership enforced in SQL'); return { rowCount: 1, rows: [{ item_type_id: 3, quantity: 1 }] }; }],
    [/UPDATE stone_instances SET socketed_into_id = NULL/i, () => ({ rowCount: 0 })],
    [/SELECT value FROM item_types/i, () => ({ rows: [{ value: 20 }] })],
    [/UPDATE users SET gold = gold \+ /i, () => ({ rowCount: 1, rows: [{ gold: 110 }] })],
    [/INSERT INTO merchant_stock/i, () => ({ rows: [{ id: 'b1' }] })],
  ]);
  const r = await sellItem(pool, mkEntry(p), 1, 31, 'v1', 'i1');
  assert.equal(r.ok, true);
  assert.equal(r.price, 10, 'sell price is half of value 20');
  assert.equal(r.gold, 110);
  assert.equal(p.gold, 110);
  assert.ok(!p.inv.items.some((it) => it.id === 'i1'), 'item removed from in-memory inventory');
  assert.equal(pool.committed, true, 'transaction committed on success');
  assert.equal(pool.rolledBack, false);
  assert.match(pool.seen[0], /^BEGIN$/i);
  assert.match(pool.seen[pool.seen.length - 1], /^COMMIT$/i);
});

// SOMET-245 Task 4b: stone_instances.socketed_into_id has its own
// ON DELETE SET NULL FK back to player_items, so the DB already ejects a
// socketed stone the instant its host's row is deleted -- this test pins
// the SAME-TRANSACTION explicit call sellItem now also makes (belt and
// suspenders, and load-bearing if that FK is ever altered): the eject must
// run on the SAME checked-out client, after the DELETE is confirmed
// (rowCount === 1) and before COMMIT, keyed on the host's itemId.
test('sellItem ejects a stone socketed into the sold item, in the same transaction as the delete', async () => {
  const p = PLAYER();
  const seenOrder = [];
  const pool = mkPool([
    [/SELECT 1 FROM stone_instances si\s+JOIN player_items pi/i, () => ({ rowCount: 0, rows: [] })],
    [/DELETE FROM player_items/i, () => { seenOrder.push('delete'); return { rowCount: 1, rows: [{ item_type_id: 3, quantity: 1 }] }; }],
    [/UPDATE stone_instances SET socketed_into_id = NULL/i, (sql, params) => {
      seenOrder.push('eject');
      assert.deepStrictEqual(params, ['i1'], 'eject must target the sold item as the host');
      return { rowCount: 1 };
    }],
    [/SELECT value FROM item_types/i, () => ({ rows: [{ value: 20 }] })],
    [/UPDATE users SET gold = gold \+ /i, () => ({ rowCount: 1, rows: [{ gold: 110 }] })],
    [/INSERT INTO merchant_stock/i, () => ({ rows: [{ id: 'b1' }] })],
  ]);
  const r = await sellItem(pool, mkEntry(p), 1, 31, 'v1', 'i1');
  assert.equal(r.ok, true);
  assert.deepStrictEqual(seenOrder, ['delete', 'eject'], 'eject must run after the delete is confirmed, both inside the transaction');
  assert.equal(pool.committed, true, 'eject must be committed as part of the same transaction as the delete');
  assert.match(pool.seen[0], /^BEGIN$/i, 'eject must be inside BEGIN...COMMIT, not before it');
  assert.match(pool.seen[pool.seen.length - 1], /^COMMIT$/i, 'eject must be inside BEGIN...COMMIT, not after it');
});

// F-022 (SOMET-202): player_items.quantity is read and preserved by every
// writer/reader in the tree but never written above 1 by any of them —
// confirmed by grep across the whole repo (trade.js's own INSERT is
// hardcoded to 1, items.js/index.js's grants omit quantity and take the
// column default of 1, and loot.js's claimItem only ever copies quantity
// from a world_items row that spawnDrops itself always inserts as 1). If a
// stack >1 ever DID appear (e.g. a future write path), sellItem as written
// would silently destroy every unit but one: it DELETEs the whole row and
// pays for exactly ONE unit. Rather than try to make the whole stack
// concept real end-to-end (merchant_stock's own buyback quantity has the
// same unaddressed generality), sellItem refuses a stacked row outright —
// loud and rolled-back beats silent data loss.
test('sellItem refuses to sell a stacked item (quantity > 1) and rolls back instead of destroying units (F-022)', async () => {
  const p = PLAYER(); p.inv.items = [{ id: 'i1', typeId: 3, quantity: 5 }];
  const pool = mkPool([
    [/SELECT 1 FROM stone_instances si\s+JOIN player_items pi/i, () => ({ rowCount: 0, rows: [] })],
    [/DELETE FROM player_items/i, () => ({ rowCount: 1, rows: [{ item_type_id: 3, quantity: 5 }] })],
    // The eject runs (same transaction, right after the DELETE) before the
    // stack check rolls everything back -- both undone together, so this
    // must still be routed rather than throwing "unexpected".
    [/UPDATE stone_instances SET socketed_into_id = NULL/i, () => ({ rowCount: 0 })],
  ]);
  const r = await sellItem(pool, mkEntry(p), 1, 31, 'v1', 'i1');
  assert.equal(r.ok, false);
  assert.match(r.reason, /stack/i);
  assert.ok(!pool.seen.some((s) => /SELECT value FROM item_types/i.test(s)), 'must not price a stack it refuses to sell');
  assert.ok(!pool.seen.some((s) => /UPDATE users SET gold \+/i.test(s)), 'no credit on refusal');
  assert.ok(!pool.seen.some((s) => /INSERT INTO merchant_stock/i.test(s)), 'no buyback row on refusal');
  assert.equal(pool.committed, false);
  assert.equal(pool.rolledBack, true, 'the DELETE must be rolled back — the stack must survive intact, not be half-destroyed');
  assert.equal(p.gold, 100, 'wallet untouched');
  assert.equal(p.inv.items.length, 1, 'item not removed from in-memory inventory — the sale never happened');
});

test('sellItem refuses an equipped item, mutates nothing, and never opens a transaction', async () => {
  const p = PLAYER(); p.inv.equipment = { main_hand: 'i1' };
  const pool = {
    connect: async () => { throw new Error('must not connect: equipped-item guard must reject before DB work'); },
  };
  const r = await sellItem(pool, mkEntry(p), 1, 31, 'v1', 'i1');
  assert.equal(r.ok, false);
  assert.match(r.reason, /unequip/i);
});

test('sellItem refuses an item the player does not own and rolls back', async () => {
  const p = PLAYER();
  const pool = mkPool([
    [/SELECT 1 FROM stone_instances si\s+JOIN player_items pi/i, () => ({ rowCount: 0, rows: [] })],
    [/DELETE FROM player_items/i, () => ({ rowCount: 0, rows: [] })],
  ]);
  const r = await sellItem(pool, mkEntry(p), 1, 31, 'v1', 'nope');
  assert.equal(r.ok, false);
  assert.match(r.reason, /own/i);
  assert.ok(!pool.seen.some((s) => /UPDATE users SET gold = gold \+ /i.test(s)), 'no credit on rejection');
  assert.ok(!pool.seen.some((s) => /INSERT INTO merchant_stock/i.test(s)), 'no buyback row on rejection');
  assert.equal(pool.committed, false, 'must not commit on rejection');
  assert.equal(pool.rolledBack, true, 'must roll back on rejection');
});

// Critical #1 fix (SOMET-245 final review): stone_instances.player_item_id
// is ON DELETE CASCADE and no acquisition path (buyStock included) ever
// recreates one -- selling a stone (loose OR socketed) would permanently
// destroy its xp/level and make a buyback-and-repurchase of the exact same
// item unsocketable forever. sellItem must refuse before ever deleting the
// row, with a clear, specific reason (not the generic "you do not own that
// item").
test('sellItem refuses a LOOSE (unsocketed) stone, deletes nothing, and rolls back', async () => {
  const p = PLAYER(); p.inv.items = [{ id: 'stone1', typeId: 9, quantity: 1 }];
  const pool = mkPool([
    [/SELECT 1 FROM stone_instances si\s+JOIN player_items pi/i, () => ({ rowCount: 1, rows: [{ '?column?': 1 }] })], // IS a stone
    [/DELETE FROM player_items/i, () => { throw new Error('must never delete a refused stone'); }],
  ]);
  const r = await sellItem(pool, mkEntry(p), 1, 31, 'v1', 'stone1');
  assert.equal(r.ok, false);
  assert.match(r.reason, /unsocket/i, 'must give a clear, specific reason');
  assert.ok(!pool.seen.some((s) => /DELETE FROM player_items/i.test(s)), 'must never delete the stone\'s row');
  assert.equal(pool.committed, false);
  assert.equal(pool.rolledBack, true, 'must roll back rather than leave the transaction open');
  assert.equal(p.gold, 100, 'wallet untouched');
  assert.equal(p.inv.items.length, 1, 'the stone remains in in-memory inventory -- the sale never happened');
});

test('sellItem refuses a SOCKETED stone the same way as a loose one', async () => {
  // Same guard, same query shape as the loose case -- the check is purely
  // "does this player_items row have a stone_instances row", irrespective
  // of socketed_into_id. Pinned separately per the finding's own
  // requirement that BOTH cases be covered.
  const p = PLAYER(); p.inv.items = [{ id: 'stone1', typeId: 9, quantity: 1 }];
  const pool = mkPool([
    [/SELECT 1 FROM stone_instances si\s+JOIN player_items pi/i, () => ({ rowCount: 1, rows: [{ '?column?': 1 }] })],
    [/DELETE FROM player_items/i, () => { throw new Error('must never delete a refused stone'); }],
  ]);
  const r = await sellItem(pool, mkEntry(p), 1, 31, 'v1', 'stone1');
  assert.equal(r.ok, false);
  assert.match(r.reason, /unsocket/i);
  assert.ok(!pool.seen.some((s) => /DELETE FROM player_items/i.test(s)));
});

// Critical #2 (SOMET-245 final review): verifies Critical #1's fix actually
// closes the stale-cache scenario for the sellItem path -- attempting to
// sell a SOCKETED stone must be refused before the host's in-memory
// socketedStoneTypeId/socketedStoneItemId cache (activeWeaponType/
// socketedBuffStones both read this) could ever go stale. Sets up a host
// weapon whose cache already reflects a live socket (the same shape
// items.js's socketStone/loadInventory write), attempts to sell the STONE
// itself, and asserts the host's cache is completely untouched by the
// refusal.
test('sellItem refusing a socketed stone leaves the HOST item\'s in-memory socket cache untouched (Critical #2 closure)', async () => {
  const p = PLAYER();
  p.inv.items = [
    { id: 'weapon1', typeId: 3, quantity: 1, socketedStoneTypeId: 9, socketedStoneItemId: 'stone1' },
    { id: 'stone1', typeId: 9, quantity: 1 },
  ];
  const pool = mkPool([
    [/SELECT 1 FROM stone_instances si\s+JOIN player_items pi/i, () => ({ rowCount: 1, rows: [{ '?column?': 1 }] })],
    [/DELETE FROM player_items/i, () => { throw new Error('must never delete a refused stone'); }],
  ]);
  const r = await sellItem(pool, mkEntry(p), 1, 31, 'v1', 'stone1');
  assert.equal(r.ok, false);
  const host = p.inv.items.find((it) => it.id === 'weapon1');
  assert.equal(host.socketedStoneTypeId, 9, 'the host\'s cached stone TYPE must survive a refused sell of the stone');
  assert.equal(host.socketedStoneItemId, 'stone1', 'the host\'s cached stone INSTANCE id must survive a refused sell of the stone');
  assert.ok(p.inv.items.some((it) => it.id === 'stone1'), 'the stone itself must still be owned');
});

test('buyStock requires an inventory (fails loud like sellItem, not silently)', async () => {
  const p = PLAYER(); delete p.inv;
  const pool = { connect: async () => { throw new Error('must not connect: missing-inv guard must reject before DB work'); } };
  const r = await buyStock(pool, mkEntry(p), 1, 31, 's1');
  assert.equal(r.ok, false);
  assert.match(r.reason, /no player/i);
});

test('buyStock refuses a stock row that does not belong to the village the player is standing at (F-019)', async () => {
  const p = PLAYER();
  // Mimics the real predicate: the row exists (village A's buyback listing)
  // but the caller is standing at village B, so the locked read must come
  // back empty rather than handing the row over regardless of location.
  const pool = mkPool([
    [/FROM merchant_stock WHERE id/i, (sql, params) => {
      assert.match(sql, /village_id\s*=\s*\$2/i, 'the locked read must filter by the village the player is at');
      const [, villageId] = params;
      if (villageId !== 'village-a') return { rows: [] };
      return { rows: [{ id: 's1', item_type_id: 3, price: 20, seller_user_id: 7, village_id: 'village-a' }] };
    }],
  ]);
  // Player is standing at village B but sends village A's stockId.
  const r = await buyStock(pool, mkEntry(p), 1, 31, 's1', 'village-b');
  assert.equal(r.ok, false);
  assert.match(r.reason, /no longer for sale/i);
  assert.equal(pool.rolledBack, true, 'must roll back — no gold debited, no item granted');
  assert.equal(pool.committed, false);
  assert.equal(p.gold, 100, 'wallet untouched');
  assert.equal(p.inv.items.length, 1, 'inventory unchanged');
});

test('buyStock scopes the locked read to the village and world the player is at', async () => {
  const p = PLAYER();
  let sawParams = null;
  const pool = mkPool([
    [/FROM merchant_stock WHERE id/i, (sql, params) => {
      sawParams = params;
      return { rows: [{ id: 's1', item_type_id: 3, price: 20, seller_user_id: null, village_id: 'village-a' }] };
    }],
    [/UPDATE users SET gold = gold - /i, () => ({ rowCount: 1, rows: [{ gold: 80 }] })],
    [/INSERT INTO player_items/i, () => ({ rows: [{ id: 'new1', item_type_id: 3, quantity: 1 }] })],
  ]);
  const r = await buyStock(pool, mkEntry(p, 'world-1'), 1, 31, 's1', 'village-a');
  assert.equal(r.ok, true);
  assert.deepEqual(sawParams, ['s1', 'village-a', 'world-1']);
});
