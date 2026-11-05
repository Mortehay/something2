'use strict';

// SOMET-727. The one transaction that moves items and gold between two characters.
//
// The rows MOVE: rarity, level and affixes are never read for writing and never
// copied, so no carry path exists that could be incomplete (SOMET-498). Refusals
// are decided from rows this transaction has locked. The live mirror is consulted
// only for capacity, because that is what every other carry check reads; it never
// decides ownership or gold. Live updates are the caller's, after the commit.
//
// LOCK ORDER: users ORDER BY id, then player_items ORDER BY id.
//
//   * Users FOR NO KEY UPDATE, not FOR UPDATE. depositItem holds the item and then
//     inserts account_items, whose foreign key takes a KEY SHARE on the user. A full
//     FOR UPDATE here would conflict with that, while this transaction waits on the
//     item the deposit holds: a deadlock. Writing users.gold needs no stronger lock.
//   * Items FOR UPDATE, so the foreign-key KEY SHARE taken by a concurrent equip or
//     socket blocks until this commits, rather than slipping in after the checks.
//   * The worn and stone checks run in a statement AFTER the lock. A SELECT that
//     waited on a row re-reads that row but keeps its old snapshot for every other
//     table, so a join in the locking statement would miss an equip that committed
//     during the wait.

const { usedSlots, capacityOf } = require('../authority/items');
const { loadAffixes } = require('./accountChest');

// Lowercase on purpose: Postgres prints this spelling, and the uppercase one names
// the same row under a different string, which would let one item sit in a stash twice.
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isItemId = (id) => typeof id === 'string' && CANONICAL_UUID.test(id);

const ITEM_COLUMNS = 'id, character_id, item_type_id, quantity, soulbound, rarity, item_level, enchant_level';

// Both players are frozen while this runs and a rejoin waits for it, so nothing in it
// may wait without end. A hold elsewhere makes the settlement fail, not hang: the caller
// ends the session and nothing has moved.
const LOCK_WAIT_MS = 5000;
// A query that stalls for any other reason ends in `trade failed` too, not in a session stuck settling.
const STATEMENT_MS = 10000;
const CONNECTION_WAIT_MS = 5000;

const refuse = (reason) => ({ ok: false, reason });
const noLongerHas = (side) => refuse(`${side.name} no longer has an offered item`);

// Everything the refusal rules read besides the item row. Unscoped by character:
// any row naming the instance must block, not merely one of the offerer's.
async function loadItemFacts(db, rows) {
  const ids = rows.map((r) => r.id);
  const types = await db.query(
    'SELECT id, category FROM item_types WHERE id = ANY($1::int[])',
    [[...new Set(rows.map((r) => r.item_type_id))]],
  );
  const worn = await db.query('SELECT item_id FROM player_equipment WHERE item_id = ANY($1::uuid[])', [ids]);
  const stones = await db.query(
    `SELECT player_item_id, socketed_into_id FROM stone_instances
      WHERE player_item_id = ANY($1::uuid[]) OR socketed_into_id = ANY($1::uuid[])`,
    [ids],
  );
  return {
    types: new Map(types.rows.map((t) => [t.id, t])),
    worn: new Set(worn.rows.map((r) => r.item_id)),
    stones: new Set(stones.rows.map((r) => r.player_item_id)),
    hosts: new Set(stones.rows.map((r) => r.socketed_into_id)),
  };
}

// The rule both the offer and the settlement apply, ownership aside: their words
// for that differ, and each has already proven or refused it.
function refusalFor(row, facts) {
  const type = facts.types.get(row.item_type_id);
  const category = type ? type.category : null;
  if (facts.worn.has(row.id)) return 'unequip it first';
  // Both ways of being a stone: the schema does not tie the row to the category.
  if (facts.stones.has(row.id) || category === 'stone') return 'stones cannot be traded';
  if (facts.hosts.has(row.id)) return 'unsocket the stone first';
  // SOMET-277: routing starting gear through a second account reopens the faucet.
  if (row.soulbound === true) return 'starting gear cannot be traded';
  if (category === 'currency') return 'currency cannot be traded';
  return null;
}

// The shape loadInventory produces, so the live copy and a reconnect are one object.
async function liveItem(db, row) {
  return {
    id: row.id,
    typeId: row.item_type_id,
    quantity: Number(row.quantity ?? 1),
    soulbound: row.soulbound === true,
    rarity: row.rarity || 'white',
    itemLevel: Number(row.item_level ?? 1),
    enchantLevel: Number(row.enchant_level ?? 0),
    affixes: await loadAffixes(db, row.id),
  };
}

// Unlocked: a hint for the stash, re-decided by settlement.
async function validateOffer(db, characterId, itemId) {
  const owned = 'you do not own that item';
  if (!isItemId(itemId)) return refuse(owned);
  const r = await db.query(
    `SELECT ${ITEM_COLUMNS} FROM player_items WHERE id = $1 AND character_id = $2`,
    [itemId, characterId],
  );
  if (r.rowCount !== 1) return refuse(owned);
  const reason = refusalFor(r.rows[0], await loadItemFacts(db, r.rows));
  if (reason) return refuse(reason);
  return { ok: true, item: await liveItem(db, r.rows[0]) };
}

// `used` and `capacity` of one side's character. Live when that very character is
// online, since the player may have reconnected on another one of the account, whose
// bag says nothing about this character. Goes through usedSlots either way, so there
// is one definition of "how full".
async function slotsOf(client, entry, side, slots) {
  const p = entry.world.getPlayer(side.userId);
  if (p && p.inv && Number(p.characterId) === Number(side.characterId)) {
    return { used: usedSlots(p.inv, entry.world.weapons), capacity: capacityOf(p.inv) };
  }
  const r = await client.query(
    `SELECT pi.item_type_id, t.category FROM player_items pi
       JOIN item_types t ON t.id = pi.item_type_id
      WHERE pi.character_id = $1`,
    [side.characterId],
  );
  const types = new Map(r.rows.map((row) => [row.item_type_id, row]));
  const inv = { items: r.rows.map((row) => ({ typeId: row.item_type_id })), capacity: slots };
  return { used: usedSlots(inv, types), capacity: capacityOf(inv) };
}

// `given` and `received` are locked rows, counted by the same usedSlots.
async function hasRoom(client, entry, side, slots, given, received, facts) {
  const count = (rows) => usedSlots({ items: rows.map((r) => ({ typeId: r.item_type_id })) }, facts.types);
  const { used, capacity } = await slotsOf(client, entry, side, slots);
  const change = count(received) - count(given);
  // A side that does not grow is never refused: a character already over its cap
  // must stay able to give things away.
  return change <= 0 || used + change <= capacity;
}

// The net movement, payer first so a refusal has written nothing. Guarded in the
// statement rather than from the row read above, and cast because int4 is the
// column but an offer may be larger. Returns the new balances, or a refusal.
async function moveGold(client, a, b, balances) {
  const net = b.gold - a.gold; // what a gains
  if (net === 0) return { a: balances.get(Number(a.userId)), b: balances.get(Number(b.userId)) };
  const [payer, payee] = net < 0 ? [a, b] : [b, a];
  const amount = Math.abs(net);
  const debit = await client.query(
    'UPDATE users SET gold = gold - $2::bigint WHERE id = $1 AND gold >= $2::bigint RETURNING gold',
    [payer.userId, amount],
  );
  if (debit.rowCount !== 1) return refuse('not enough gold');
  const credit = await client.query(
    'UPDATE users SET gold = gold + $2::bigint WHERE id = $1 AND gold + $2::bigint <= 2147483647 RETURNING gold',
    [payee.userId, amount],
  );
  if (credit.rowCount !== 1) return refuse(`${payee.name} cannot hold that much gold`);
  const paid = Number(debit.rows[0].gold);
  const got = Number(credit.rows[0].gold);
  return net < 0 ? { a: paid, b: got } : { a: got, b: paid };
}

// The transaction's body. Any result without ok: true rolls back in settleTrade,
// including one returned after gold has moved.
async function settleLocked(client, entry, session) {
  const { a, b } = session;

  // 1. Locks, in the one global order.
  const users = await client.query(
    'SELECT id, gold FROM users WHERE id = ANY($1::int[]) ORDER BY id FOR NO KEY UPDATE',
    [[a.userId, b.userId]],
  );
  if (users.rowCount !== 2) return refuse('a player is no longer available');
  const locked = await client.query(
    `SELECT ${ITEM_COLUMNS} FROM player_items WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
    [[...a.itemIds, ...b.itemIds]],
  );
  const rowById = new Map(locked.rows.map((r) => [r.id, r]));

  // 2. Every item, as it stands under the lock.
  const facts = await loadItemFacts(client, locked.rows);
  for (const side of [a, b]) {
    for (const id of side.itemIds) {
      const row = rowById.get(id);
      if (!row || row.character_id !== Number(side.characterId)) return noLongerHas(side);
      const reason = refusalFor(row, facts);
      if (reason) return refuse(reason);
    }
  }

  // 3. Capacity. The characters are read here so a deleted one, or one of another
  // account, is a refusal rather than a foreign-key error at the move.
  const chars = await client.query(
    'SELECT id, user_id, inventory_slots FROM characters WHERE id = ANY($1::int[])',
    [[a.characterId, b.characterId]],
  );
  const charById = new Map(chars.rows.map((c) => [c.id, c]));
  const rowsOf = (side) => side.itemIds.map((id) => rowById.get(id));
  for (const [side, other] of [[a, b], [b, a]]) {
    const c = charById.get(Number(side.characterId));
    if (!c || c.user_id !== Number(side.userId)) return refuse(`${side.name} is no longer available`);
    const room = await hasRoom(client, entry, side, c.inventory_slots, rowsOf(side), rowsOf(other), facts);
    if (!room) return refuse(`${side.name} has no room`);
  }

  // 4. Gold.
  const balances = new Map(users.rows.map((u) => [u.id, Number(u.gold)]));
  const gold = await moveGold(client, a, b, balances);
  if (gold.ok === false) return gold;

  // 5. The move. The ownership predicate is untested defence in depth: step 2 has
  // already refused a row its offerer does not hold, so no test reaches it. Only the
  // rowCount check on a duplicated id is exercised here.
  for (const [side, other] of [[a, b], [b, a]]) {
    if (side.itemIds.length === 0) continue;
    const moved = await client.query(
      'UPDATE player_items SET character_id = $1 WHERE id = ANY($2::uuid[]) AND character_id = $3',
      [other.characterId, side.itemIds, side.characterId],
    );
    if (moved.rowCount !== side.itemIds.length) return noLongerHas(side);
  }

  const outcome = async (side, other, balance) => {
    const addedItems = [];
    for (const row of rowsOf(other)) addedItems.push(await liveItem(client, row));
    return { characterId: Number(side.characterId), removedItemIds: [...side.itemIds], addedItems, gold: balance };
  };
  return { ok: true, a: await outcome(a, b, gold.a), b: await outcome(b, a, gold.b) };
}

// pg's pool has no wait limit of its own unless it was built with one, and the request
// cannot be withdrawn: a client handed over after the deadline goes straight back.
function connectWithin(pool, ms) {
  return new Promise((resolve, reject) => {
    let late = false;
    const timer = setTimeout(() => {
      late = true;
      reject(new Error(`trade settlement: no database connection within ${ms} ms`));
    }, ms);
    pool.connect().then(
      (client) => {
        clearTimeout(timer);
        if (late) client.release();
        else resolve(client);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// A database error (a deadlock or a lock wait past the limit included) rolls back and is
// rethrown, never reported as a refusal: nothing has moved either way, and the
// caller ends the session on it.
async function settleTrade(pool, entry, session) {
  const { a, b } = session;
  // Before a connection: nothing past here can trust these to reach SQL intact.
  for (const side of [a, b]) {
    if (!Number.isSafeInteger(side.gold) || side.gold < 0) return refuse('invalid gold');
    if (!side.itemIds.every(isItemId)) return noLongerHas(side);
  }

  const client = await connectWithin(pool, CONNECTION_WAIT_MS);
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '${LOCK_WAIT_MS}ms'`);
    await client.query(`SET LOCAL statement_timeout = '${STATEMENT_MS}ms'`);
    const result = await settleLocked(client, entry, session);
    await client.query(result.ok ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Idempotent by item id, and looked up fresh: either player may have reconnected.
// Gold is the account's, so it lands whichever character is being played; the items
// are one character's, and another character's bag must not gain or lose them.
function applyOutcomeToLive(entry, userId, outcome) {
  const p = entry.world.getPlayer(userId);
  if (!p) return;
  p.gold = outcome.gold;
  if (!p.inv || Number(p.characterId) !== outcome.characterId) return;
  const removed = new Set(outcome.removedItemIds);
  p.inv.items = p.inv.items.filter((it) => !removed.has(it.id));
  for (const item of outcome.addedItems) {
    if (!p.inv.items.some((it) => it.id === item.id)) p.inv.items.push(item);
  }
}

module.exports = { validateOffer, settleTrade, applyOutcomeToLive };
