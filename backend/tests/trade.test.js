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

// SOMET-484 route shapes, named once so a statement that changes wording in
// trade.js fails in ONE place rather than silently stopping matching in a
// dozen `pool.seen.some(...)` negative assertions.
//
// SELL_LOCK replaced a `DELETE FROM player_items`: the sale no longer destroys
// the instance, it HANDS it to the merchant (SELL_HANDOVER). Several tests
// below used to assert `!seen.some(/DELETE FROM player_items/)` to mean "the
// item was not taken from the player". That string matches nothing at all now,
// so those assertions would pass no matter what the code did -- each one has
// been re-pointed at SELL_HANDOVER, which is the statement that actually takes
// it.
const SELL_LOCK = /SELECT item_type_id, quantity, soulbound FROM player_items WHERE id = \$1 AND character_id = \$2 FOR UPDATE/i;
const SELL_EQUIPPED = /SELECT 1 FROM player_equipment WHERE item_id/i;
const SELL_HANDOVER = /UPDATE player_items SET character_id = NULL, merchant_stock_id/i;
const BUY_HANDOVER = /UPDATE player_items SET character_id = \$2, merchant_stock_id = NULL/i;
const BUY_AFFIXES = /FROM player_item_affixes/i;

// The buy path's two new statements, for the cases where the stock row holds
// NO instance (base catalog, and every buyback row sold before the migration):
// the handover matches nothing, so buyStock falls back to the original INSERT.
const BUY_NO_INSTANCE = [
  [BUY_HANDOVER, () => ({ rowCount: 0, rows: [] })],
  [BUY_AFFIXES, () => ({ rowCount: 0, rows: [] })],
];

test('buyStock debits gold, grants the item, and leaves a base-catalog row in place', async () => {
  const p = PLAYER();
  const pool = mkPool([
    [/FROM merchant_stock WHERE id/i, () => ({ rows: [{ id: 's1', item_type_id: 3, price: 20, seller_user_id: null, village_id: 'v1' }] })],
    [/UPDATE users SET gold = gold - /i, (sql) => { assert.match(sql, /gold >= /, 'debit must be overdraft-safe'); return { rowCount: 1, rows: [{ gold: 80 }] }; }],
    ...BUY_NO_INSTANCE,
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

// SOMET-280 changed this fixture's seller from 7 to 1: a buyback row is now
// only buyable by the account that sold it, and the buying userId here is 1.
// With the old seller the case would be testing the refusal path instead of
// the consume-on-buy path it is named for.
// SOMET-484 rewrote what this row IS: a buyback row now HOLDS the instance
// that was sold, so the buy moves that row back to the buyer instead of
// minting a new one. Both halves are pinned -- the handover, and the DELETE
// that must follow it (deleting first would CASCADE the instance away, which
// is the one ordering mistake this design can make).
test('buying a buyback row hands back the held instance and then deletes the row', async () => {
  const p = PLAYER();
  const order = [];
  const pool = mkPool([
    // NOTE: DELETE is checked before the generic SELECT match below, since
    // "DELETE FROM merchant_stock WHERE id = $1" also matches
    // /FROM merchant_stock WHERE id/i and would otherwise be misrouted.
    [/DELETE FROM merchant_stock/i, () => { order.push('delete-stock'); return { rowCount: 1 }; }],
    [/FROM merchant_stock WHERE id/i, () => ({ rows: [{ id: 's2', item_type_id: 3, price: 5, seller_user_id: 1, village_id: 'v1' }] })],
    [/UPDATE users SET gold = gold - /i, (sql, params) => {
      assert.strictEqual(params[1], 5, 'the seller buys back at the price they were paid');
      return { rowCount: 1, rows: [{ gold: 95 }] };
    }],
    [BUY_HANDOVER, (sql, params) => {
      order.push('handover');
      assert.deepStrictEqual(params, ['s2', 31], 'the held instance must move to the BUYING character');
      return { rowCount: 1, rows: [{ id: 'held2', item_type_id: 3, quantity: 1, rarity: 'foxy', item_level: 71, soulbound: false }] };
    }],
    [BUY_AFFIXES, () => ({ rowCount: 1, rows: [{ affix_type_id: 4, key: 'flaming', value: 12.25, effect: { type: 'damage', element: 'fire' } }] })],
    [/INSERT INTO player_items/i, () => { assert.fail('must NOT mint a new instance when the stock row holds one'); }],
  ]);
  const r = await buyStock(pool, mkEntry(p), 1, 31, 's2');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.item.id, 'held2', 'the buyer gets the very instance that was sold');
  assert.strictEqual(r.item.rarity, 'foxy', 'and its rarity');
  assert.strictEqual(r.item.itemLevel, 71, 'and its item level');
  assert.deepStrictEqual(r.item.affixes, [
    { affixTypeId: 4, key: 'flaming', value: 12.25, effect: { type: 'damage', element: 'fire' } },
  ], 'and every affix, by VALUE, with the effect payload the equip path reads');
  assert.deepStrictEqual(order, ['handover', 'delete-stock'],
    'the instance must be detached BEFORE the stock row is deleted -- the FK CASCADEs');
  assert.strictEqual(pool.committed, true);
  assert.strictEqual(pool.rolledBack, false);
});

// SOMET-280: buyback belongs to the account that sold the item. fetchShop no
// longer LISTS someone else's row, but a `buy` frame carries a raw stockId and
// never goes near fetchShop -- the list filter stops an honest client, this
// check stops a crafted one. mkPool ignores bind parameters, so the refusal
// below is decided by the code reading the locked row, not by a mock that was
// told the answer in advance.
test("buyStock REFUSES another player's buyback row even when handed its correct id", async () => {
  const p = PLAYER();
  const pool = mkPool([
    [/DELETE FROM merchant_stock/i, () => { assert.fail('must not consume a row it refused to sell'); }],
    // seller 7 vs buyer 1: the row exists, is unexpired, and is in the right
    // village and world -- every other guard in buyStock passes it.
    [/FROM merchant_stock WHERE id/i, () => ({ rows: [{ id: 's2', item_type_id: 3, price: 5, seller_user_id: 7, village_id: 'v1' }] })],
    [/UPDATE users SET gold = gold - /i, () => { assert.fail('must not debit gold for a row the buyer cannot buy'); }],
    [/INSERT INTO player_items/i, () => { assert.fail("must not grant another player's item"); }],
  ]);
  const r = await buyStock(pool, mkEntry(p), 1, 31, 's2');
  assert.equal(r.ok, false);
  assert.match(r.reason, /no longer for sale/i,
    'wording must not confirm to a prober that the id names a live row someone else owns');
  assert.equal(p.gold, 100, 'wallet untouched');
  assert.equal(p.inv.items.length, 1, 'inventory unchanged');
  assert.equal(pool.committed, false, 'must not commit');
  assert.equal(pool.rolledBack, true, 'must roll back the transaction it opened');
});

// A seller_user_id arriving as a string (pg returns bigints/numerics as text;
// integer columns come back as numbers today, but nothing in this file
// guarantees the column type never widens) must still match its owner. A ===
// comparison would silently refuse every seller their own row.
test("buyStock matches the seller by value, not by type, so the owner is never locked out", async () => {
  const p = PLAYER();
  const pool = mkPool([
    [/DELETE FROM merchant_stock/i, () => ({ rowCount: 1 })],
    [/FROM merchant_stock WHERE id/i, () => ({ rows: [{ id: 's2', item_type_id: 3, price: 5, seller_user_id: '1', village_id: 'v1' }] })],
    [/UPDATE users SET gold = gold - /i, () => ({ rowCount: 1, rows: [{ gold: 95 }] })],
    ...BUY_NO_INSTANCE,
    [/INSERT INTO player_items/i, () => ({ rows: [{ id: 'new2', item_type_id: 3, quantity: 1 }] })],
  ]);
  const r = await buyStock(pool, mkEntry(p), 1, 31, 's2');
  assert.equal(r.ok, true);
});

test('buyStock locks the stock row FOR UPDATE to prevent a concurrent double-sell', async () => {
  const p = PLAYER();
  let selectSql = null;
  const pool = mkPool([
    [/FROM merchant_stock WHERE id/i, (sql) => { selectSql = sql; return { rows: [{ id: 's1', item_type_id: 3, price: 20, seller_user_id: null, village_id: 'v1' }] }; }],
    [/UPDATE users SET gold = gold - /i, () => ({ rowCount: 1, rows: [{ gold: 80 }] })],
    ...BUY_NO_INSTANCE,
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
    // seller_user_id 1 === the buying userId (SOMET-280): this case is about
    // losing the race for a row the buyer IS allowed to buy.
    [/FROM merchant_stock WHERE id/i, () => ({ rows: [{ id: 's2', item_type_id: 3, price: 5, seller_user_id: 1, village_id: 'v1' }] })],
    [/UPDATE users SET gold = gold - /i, () => ({ rowCount: 1, rows: [{ gold: 95 }] })],
    ...BUY_NO_INSTANCE,
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

test('sellItem hands the item to the merchant, credits gold, and inserts a buyback row', async () => {
  const p = PLAYER();
  const order = [];
  const pool = mkPool([
    [/SELECT 1 FROM stone_instances si\s+JOIN player_items pi/i, () => ({ rowCount: 0, rows: [] })],
    [SELL_LOCK, (sql) => { assert.match(sql, /character_id = \$2/, 'ownership enforced in SQL'); return { rowCount: 1, rows: [{ item_type_id: 3, quantity: 1 }] }; }],
    [SELL_EQUIPPED, () => ({ rowCount: 0, rows: [] })],
    [/UPDATE stone_instances SET socketed_into_id = NULL/i, () => ({ rowCount: 0 })],
    [/SELECT value FROM item_types/i, () => ({ rows: [{ value: 20 }] })],
    [/UPDATE users SET gold = gold \+ /i, () => ({ rowCount: 1, rows: [{ gold: 110 }] })],
    [/INSERT INTO merchant_stock/i, () => { order.push('stock'); return { rows: [{ id: 'b1' }] }; }],
    [SELL_HANDOVER, (sql, params) => {
      order.push('handover');
      assert.deepStrictEqual(params, ['i1', 'b1', 31],
        'the instance must be attached to the buyback row that was just created, and only for its owner');
      return { rowCount: 1 };
    }],
  ]);
  const r = await sellItem(pool, mkEntry(p), 1, 31, 'v1', 'i1');
  assert.equal(r.ok, true);
  // SOMET-484: the buyback row has to exist before anything can point at it --
  // player_items_one_holder_check forbids an instance with no holder at all,
  // so there is no ordering in which the item is briefly ownerless.
  assert.deepStrictEqual(order, ['stock', 'handover'],
    'the buyback row must exist before the instance is attached to it');
  assert.ok(!pool.seen.some((s) => /DELETE FROM player_items/i.test(s)),
    'the instance must be MOVED, never destroyed -- destroying it is the SOMET-484 bug');
  assert.equal(r.price, 10, 'sell price is half of value 20');
  assert.equal(r.gold, 110);
  assert.equal(p.gold, 110);
  assert.ok(!p.inv.items.some((it) => it.id === 'i1'), 'item removed from in-memory inventory');
  assert.equal(pool.committed, true, 'transaction committed on success');
  assert.equal(pool.rolledBack, false);
  assert.match(pool.seen[0], /^BEGIN$/i);
  assert.match(pool.seen[pool.seen.length - 1], /^COMMIT$/i);
});

// SOMET-245 Task 4b, and SOMET-484 made it LOAD-BEARING rather than belt and
// suspenders. stone_instances.socketed_into_id used to be cleaned up for free
// by its own ON DELETE SET NULL FK when the host's player_items row was
// deleted. The sale no longer deletes that row, so nothing cascades and this
// explicit call is now the only thing parting a socketed stone from a sold
// weapon: without it the stone -- which stays with the seller -- would keep
// pointing at an item on a merchant's shelf. It must run on the SAME checked-
// out client, after ownership is confirmed (rowCount === 1) and before COMMIT,
// keyed on the host's itemId.
test('sellItem ejects a stone socketed into the sold item, in the same transaction as the handover', async () => {
  const p = PLAYER();
  const seenOrder = [];
  const pool = mkPool([
    [/SELECT 1 FROM stone_instances si\s+JOIN player_items pi/i, () => ({ rowCount: 0, rows: [] })],
    [SELL_LOCK, () => { seenOrder.push('lock'); return { rowCount: 1, rows: [{ item_type_id: 3, quantity: 1 }] }; }],
    [SELL_EQUIPPED, () => ({ rowCount: 0, rows: [] })],
    [/UPDATE stone_instances SET socketed_into_id = NULL/i, (sql, params) => {
      seenOrder.push('eject');
      assert.deepStrictEqual(params, ['i1'], 'eject must target the sold item as the host');
      return { rowCount: 1 };
    }],
    [/SELECT value FROM item_types/i, () => ({ rows: [{ value: 20 }] })],
    [/UPDATE users SET gold = gold \+ /i, () => ({ rowCount: 1, rows: [{ gold: 110 }] })],
    [/INSERT INTO merchant_stock/i, () => ({ rows: [{ id: 'b1' }] })],
    [SELL_HANDOVER, () => { seenOrder.push('handover'); return { rowCount: 1 }; }],
  ]);
  const r = await sellItem(pool, mkEntry(p), 1, 31, 'v1', 'i1');
  assert.equal(r.ok, true);
  assert.deepStrictEqual(seenOrder, ['lock', 'eject', 'handover'],
    'eject must run after ownership is confirmed and before the item changes hands, all inside the transaction');
  assert.equal(pool.committed, true, 'eject must be committed as part of the same transaction as the handover');
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
    [SELL_LOCK, () => ({ rowCount: 1, rows: [{ item_type_id: 3, quantity: 5 }] })],
    [SELL_EQUIPPED, () => ({ rowCount: 0, rows: [] })],
    // The eject runs (same transaction, right after ownership is confirmed)
    // before the stack check rolls everything back -- both undone together, so
    // this must still be routed rather than throwing "unexpected".
    [/UPDATE stone_instances SET socketed_into_id = NULL/i, () => ({ rowCount: 0 })],
  ]);
  const r = await sellItem(pool, mkEntry(p), 1, 31, 'v1', 'i1');
  assert.equal(r.ok, false);
  assert.match(r.reason, /stack/i);
  assert.ok(!pool.seen.some((s) => /SELECT value FROM item_types/i.test(s)), 'must not price a stack it refuses to sell');
  assert.ok(!pool.seen.some((s) => /UPDATE users SET gold \+/i.test(s)), 'no credit on refusal');
  assert.ok(!pool.seen.some((s) => /INSERT INTO merchant_stock/i.test(s)), 'no buyback row on refusal');
  assert.ok(!pool.seen.some((s) => SELL_HANDOVER.test(s)), 'the stack must not change hands');
  assert.equal(pool.committed, false);
  assert.equal(pool.rolledBack, true, 'the eject must be rolled back — the stack must survive intact, not be half-destroyed');
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
    [SELL_LOCK, () => ({ rowCount: 0, rows: [] })],
  ]);
  const r = await sellItem(pool, mkEntry(p), 1, 31, 'v1', 'nope');
  assert.equal(r.ok, false);
  assert.match(r.reason, /own/i);
  assert.ok(!pool.seen.some((s) => /UPDATE users SET gold = gold \+ /i.test(s)), 'no credit on rejection');
  assert.ok(!pool.seen.some((s) => /INSERT INTO merchant_stock/i.test(s)), 'no buyback row on rejection');
  assert.ok(!pool.seen.some((s) => SELL_HANDOVER.test(s)), 'nothing changes hands on rejection');
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
    // SOMET-484: the sale takes the item with SELL_HANDOVER now, not a DELETE.
    // Tripping on the old string would make this route dead -- it can never
    // match -- so the guard would pass whatever the code did.
    [SELL_HANDOVER, () => { throw new Error('must never hand a refused stone to the merchant'); }],
  ]);
  const r = await sellItem(pool, mkEntry(p), 1, 31, 'v1', 'stone1');
  assert.equal(r.ok, false);
  assert.match(r.reason, /unsocket/i, 'must give a clear, specific reason');
  assert.ok(!pool.seen.some((s) => SELL_HANDOVER.test(s)), 'must never hand the stone\'s row to the merchant');
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
    // SOMET-484: the sale takes the item with SELL_HANDOVER now, not a DELETE.
    // Tripping on the old string would make this route dead -- it can never
    // match -- so the guard would pass whatever the code did.
    [SELL_HANDOVER, () => { throw new Error('must never hand a refused stone to the merchant'); }],
  ]);
  const r = await sellItem(pool, mkEntry(p), 1, 31, 'v1', 'stone1');
  assert.equal(r.ok, false);
  assert.match(r.reason, /unsocket/i);
  assert.ok(!pool.seen.some((s) => SELL_HANDOVER.test(s)));
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
    // SOMET-484: the sale takes the item with SELL_HANDOVER now, not a DELETE.
    // Tripping on the old string would make this route dead -- it can never
    // match -- so the guard would pass whatever the code did.
    [SELL_HANDOVER, () => { throw new Error('must never hand a refused stone to the merchant'); }],
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
    ...BUY_NO_INSTANCE,
    [/INSERT INTO player_items/i, () => ({ rows: [{ id: 'new1', item_type_id: 3, quantity: 1 }] })],
  ]);
  const r = await buyStock(pool, mkEntry(p, 'world-1'), 1, 31, 's1', 'village-a');
  assert.equal(r.ok, true);
  assert.deepEqual(sawParams, ['s1', 'village-a', 'world-1']);
});
