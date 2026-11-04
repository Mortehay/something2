'use strict';

// SOMET-727. The transaction that moves items and gold between two characters,
// against a real database: the CHECK constraints, the row locks and the rollbacks
// are the things under test, and a fake answers none of them.
//
// A refusal is asserted against a whole snapshot (every row of both characters,
// both balances), not against a field, and always with a VALID item and gold in
// the same offer, so "nothing moved" cannot pass because nothing was going to.

const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { World } = require('../src/authority/world.js');
const { loadItemTypes, loadInventory } = require('../src/authority/items.js');
const {
  validateOffer, settleTrade, applyOutcomeToLive,
} = require('../src/services/tradeSettlement.js');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const INT4_MAX = 2147483647;
const DEADLOCK_BOUND_MS = 5000;

async function openPool() {
  if (!DB_URL) return { unreachable: 'no TEST_DATABASE_URL / DATABASE_URL' };
  const pool = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 2000, max: 8 });
  try { await pool.query('SELECT 1'); } catch (err) {
    await pool.end().catch(() => {});
    return { unreachable: `NO DATABASE at ${DB_URL} (${err.message})` };
  }
  return pool;
}

function uniq(tag) {
  return `zzTest-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// One test's world: its own users, characters and item types, removed in t.after
// whatever the test did to them.
async function harness(t) {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return null; }
  const h = { pool, parties: [], typeIds: [] };
  t.after(async () => {
    for (const q of h.parties) {
      await pool.query('DELETE FROM account_items WHERE user_id = $1', [q.userId]).catch(() => {});
      await pool.query('DELETE FROM player_items WHERE character_id = ANY($1::int[])', [q.characterIds]).catch(() => {});
      await pool.query('DELETE FROM characters WHERE user_id = $1', [q.userId]).catch(() => {});
      await pool.query('DELETE FROM users WHERE id = $1', [q.userId]).catch(() => {});
    }
    for (const id of h.typeIds) await pool.query('DELETE FROM item_types WHERE id = $1', [id]).catch(() => {});
    await pool.end().catch(() => {});
  });
  return h;
}

async function party(h, name, { gold = 1000, slots = 48 } = {}) {
  const u = await h.pool.query(
    `INSERT INTO users (username, password_hash, role, gold) VALUES ($1, 'x', 'player', $2) RETURNING id`,
    [uniq(`u-${name}`), gold],
  );
  const userId = u.rows[0].id;
  const q = { userId, name, characterIds: [] };
  h.parties.push(q);
  q.characterId = await character(h, q, 1, slots);
  return q;
}

async function character(h, q, slot, slots = 48) {
  const c = await h.pool.query(
    `INSERT INTO characters (user_id, slot, name, entity_type_id, inventory_slots)
     SELECT $1, $2, $3, e.id, $4 FROM entity_types e WHERE e.is_playable = true
      ORDER BY e.id LIMIT 1 RETURNING id`,
    [q.userId, slot, uniq(`c-${q.name}`), slots],
  );
  q.characterIds.push(c.rows[0].id);
  return c.rows[0].id;
}

async function ownType(h, category = 'armor') {
  const r = await h.pool.query(
    `INSERT INTO item_types (name, category, slot, damage, cooldown, defense, value, element)
     VALUES ($1, $2, $3, 0, 0, 3, 40, $4) RETURNING id`,
    [uniq('type'), category, category === 'armor' ? 'chest' : null, category === 'stone' ? 'arcane' : null],
  );
  h.typeIds.push(r.rows[0].id);
  return r.rows[0].id;
}

async function give(h, characterId, typeId, cols = {}) {
  const r = await h.pool.query(
    `INSERT INTO player_items (character_id, item_type_id, quantity, soulbound, rarity, item_level, enchant_level)
     VALUES ($1, $2, $7, $3, $4, $5, $6) RETURNING id`,
    [characterId, typeId, cols.soulbound === true, cols.rarity || 'white', cols.itemLevel || 1, cols.enchantLevel || 0, cols.quantity || 1],
  );
  return r.rows[0].id;
}

// Awkward on purpose: float4 cannot represent 3.13, so a carry that copied it would show.
async function rolledItem(h, characterId, typeId) {
  const itemId = await give(h, characterId, typeId, { rarity: 'foxy', itemLevel: 88, enchantLevel: 3 });
  const at = await h.pool.query('SELECT id FROM affix_types ORDER BY id LIMIT 2');
  assert.strictEqual(at.rowCount, 2, 'the affix catalog must be seeded for this test to mean anything');
  await h.pool.query(
    'INSERT INTO player_item_affixes (player_item_id, idx, affix_type_id, value) VALUES ($1,0,$2,3.13), ($1,1,$3,11.5)',
    [itemId, at.rows[0].id, at.rows[1].id],
  );
  return itemId;
}

const side = (q, itemIds = [], gold = 0) => ({
  userId: String(q.userId),
  characterId: q.characterId,
  name: q.name,
  itemIds,
  gold,
  locked: true,
  confirmed: true,
});
const session = (a, b) => ({ id: 't1', worldId: 1, a, b, phase: 'settling', secondOkAt: 0 });

// A world entry shaped the way server.js builds one. `online` players join on
// their character with inv.capacity attached, exactly as the join handler does.
async function makeEntry(h, online = []) {
  const itemTypes = await loadItemTypes(h.pool);
  const map = { chunkSize: 16, isWalkable: () => true, speedAt: () => 1, getChunk: () => [] };
  const world = new World(map, itemTypes, null, 16);
  const entry = { worldId: 1, world, claiming: new Set() };
  for (const q of online) await join(h, entry, q);
  return entry;
}

async function join(h, entry, q, characterId = q.characterId) {
  const inv = await loadInventory(h.pool, characterId);
  const c = await h.pool.query('SELECT inventory_slots FROM characters WHERE id = $1', [characterId]);
  inv.capacity = c.rows[0].inventory_slots;
  const g = await h.pool.query('SELECT gold FROM users WHERE id = $1', [q.userId]);
  entry.world.addPlayer(String(q.userId), { x: 100, y: 100 }, inv, { x: 100, y: 100 }, g.rows[0].gold, undefined, characterId);
  return entry.world.getPlayer(String(q.userId));
}

// Every row a settlement could touch, for both parties.
async function snapshot(h, ...qs) {
  const characterIds = qs.flatMap((q) => q.characterIds);
  const items = await h.pool.query(
    'SELECT * FROM player_items WHERE character_id = ANY($1::int[]) ORDER BY id', [characterIds],
  );
  const ids = items.rows.map((r) => r.id);
  const affixes = await h.pool.query(
    'SELECT * FROM player_item_affixes WHERE player_item_id = ANY($1::uuid[]) ORDER BY player_item_id, idx', [ids],
  );
  const worn = await h.pool.query(
    'SELECT * FROM player_equipment WHERE character_id = ANY($1::int[]) ORDER BY item_id', [characterIds],
  );
  const stones = await h.pool.query(
    'SELECT * FROM stone_instances WHERE player_item_id = ANY($1::uuid[]) ORDER BY player_item_id', [ids],
  );
  const gold = await h.pool.query(
    'SELECT id, gold FROM users WHERE id = ANY($1::int[]) ORDER BY id', [qs.map((q) => q.userId)],
  );
  return { items: items.rows, affixes: affixes.rows, worn: worn.rows, stones: stones.rows, gold: gold.rows };
}

const goldOf = async (h, q) => (await h.pool.query('SELECT gold FROM users WHERE id = $1', [q.userId])).rows[0].gold;
const ownerOf = async (h, itemId) => {
  const r = await h.pool.query('SELECT character_id FROM player_items WHERE id = $1', [itemId]);
  return r.rowCount ? r.rows[0].character_id : null;
};

// A client released inside an open BEGIN keeps its locks for the next borrower,
// so a refusal must be seen to have let go of the rows it locked.
async function assertNothingLocked(h, q, itemIds) {
  const c = await h.pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT id FROM users WHERE id = $1 FOR UPDATE NOWAIT', [q.userId]);
    await c.query('SELECT id FROM player_items WHERE id = ANY($1::uuid[]) FOR UPDATE NOWAIT', [itemIds]);
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}

// Fails rather than passes when the wanted contention never formed: a test of a
// lock race whose race did not happen proves nothing.
async function waitForLockWaiters(h, n) {
  const deadline = Date.now() + 3000;
  for (;;) {
    const r = await h.pool.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ~ 'FOR (NO KEY )?UPDATE'`,
    );
    if (r.rows[0].n >= n) return;
    if (Date.now() > deadline) throw new Error(`expected ${n} settlements waiting on a lock, saw ${r.rows[0].n}`);
    await new Promise((res) => { setTimeout(res, 20); });
  }
}

// Both must END inside the bound and neither may THROW: a real deadlock surfaces
// here as code 40P01, which settleTrade rethrows rather than dressing up as a refusal.
async function bothResolve(promises) {
  let timer;
  const bound = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`not resolved inside ${DEADLOCK_BOUND_MS} ms`)), DEADLOCK_BOUND_MS);
  });
  const settled = await Promise.race([Promise.allSettled(promises), bound]).finally(() => clearTimeout(timer));
  for (const s of settled) {
    assert.strictEqual(s.status, 'fulfilled', `settlement threw: ${s.reason && (s.reason.code || '')} ${s.reason && s.reason.message}`);
  }
  return settled.map((s) => s.value);
}

// ---------------------------------------------------------------- moves

test('swap moves the same rows with identity intact', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const A = await party(h, 'zzA');
  const B = await party(h, 'zzB');
  const typeId = await ownType(h);
  const rolled = await rolledItem(h, A.characterId, typeId);
  const plain = await give(h, B.characterId, typeId);
  const before = await snapshot(h, A, B);
  const entry = await makeEntry(h);

  const r = await settleTrade(h.pool, entry, session(side(A, [rolled]), side(B, [plain])));
  assert.strictEqual(r.ok, true, r.reason);

  const after = await snapshot(h, A, B);
  const expected = before.items.map((row) => ({
    ...row,
    character_id: row.id === rolled ? B.characterId : A.characterId,
  }));
  assert.deepStrictEqual(after.items, expected, 'same ids, new holders, and every other column untouched');
  assert.deepStrictEqual(after.affixes, before.affixes, 'the affix rows are never read for writing, never copied');
  const moved = after.items.find((row) => row.id === rolled);
  assert.strictEqual(moved.rarity, 'foxy');
  assert.strictEqual(moved.item_level, 88);
  assert.strictEqual(moved.enchant_level, 3);
  assert.deepStrictEqual(after.affixes.map((a) => Number(a.value)), [3.13, 11.5]);

  assert.deepStrictEqual(r.a.removedItemIds, [rolled]);
  assert.deepStrictEqual(r.b.removedItemIds, [plain]);
  assert.deepStrictEqual(r.a.addedItems.map((i) => i.id), [plain]);
  assert.deepStrictEqual(r.b.addedItems.map((i) => i.id), [rolled]);
});

// A stack must be plain and can hold no affix rows (player_items_stack_is_plain_check,
// player_item_affixes_host_is_single), so quantity is what this has to carry intact.
test('swap moves a stack whole, and the live copy is what a reconnect loads', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const A = await party(h, 'zzA');
  const B = await party(h, 'zzB');
  const typeId = await ownType(h);
  const stack = await give(h, A.characterId, typeId, { quantity: 24 });
  const single = await give(h, B.characterId, typeId);
  const before = await snapshot(h, A, B);
  assert.deepStrictEqual(before.affixes, [], 'precondition: a stack has no affix rows');
  const entry = await makeEntry(h);

  const r = await settleTrade(h.pool, entry, session(side(A, [stack]), side(B, [single])));
  assert.strictEqual(r.ok, true, r.reason);

  const row = (await snapshot(h, A, B)).items.find((i) => i.id === stack);
  assert.strictEqual(row.character_id, B.characterId);
  assert.strictEqual(row.quantity, 24, 'one row of 24, not 24 rows and not a row of 1');
  const added = r.b.addedItems.find((i) => i.id === stack);
  assert.strictEqual(added.quantity, 24);
  const reloaded = (await loadInventory(h.pool, B.characterId)).items.find((i) => i.id === stack);
  assert.deepStrictEqual(added, reloaded, 'every field, quantity included');
});

test('gold moves net: A offers 100, B offers 30, A -70, B +70', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const A = await party(h, 'zzA', { gold: 1000 });
  const B = await party(h, 'zzB', { gold: 500 });
  const entry = await makeEntry(h);

  const r = await settleTrade(h.pool, entry, session(side(A, [], 100), side(B, [], 30)));
  assert.strictEqual(r.ok, true, r.reason);
  assert.strictEqual(await goldOf(h, A), 930);
  assert.strictEqual(await goldOf(h, B), 570);
  assert.strictEqual(r.a.gold, 930, 'the outcome carries the balance, which is what the wallet shows');
  assert.strictEqual(r.b.gold, 570);
});

test('gold moves net when the party who pays is side b', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const A = await party(h, 'zzA', { gold: 1000 });
  const B = await party(h, 'zzB', { gold: 500 });
  const entry = await makeEntry(h);

  const r = await settleTrade(h.pool, entry, session(side(A, [], 30), side(B, [], 100)));
  assert.strictEqual(r.ok, true, r.reason);
  assert.strictEqual(await goldOf(h, A), 1070);
  assert.strictEqual(await goldOf(h, B), 430);
  assert.strictEqual(r.a.gold, 1070);
  assert.strictEqual(r.b.gold, 430);
});

test('equal gold offers leave both balances where they were and report them', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const A = await party(h, 'zzA', { gold: 1000 });
  const B = await party(h, 'zzB', { gold: 500 });
  const entry = await makeEntry(h);

  const r = await settleTrade(h.pool, entry, session(side(A, [], 40), side(B, [], 40)));
  assert.strictEqual(r.ok, true, r.reason);
  assert.strictEqual(await goldOf(h, A), 1000);
  assert.strictEqual(await goldOf(h, B), 500);
  assert.strictEqual(r.a.gold, 1000);
  assert.strictEqual(r.b.gold, 500);
});

test('one-sided gift works: an item for nothing, and gold for nothing', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const A = await party(h, 'zzA', { gold: 1000 });
  const B = await party(h, 'zzB', { gold: 0 });
  const typeId = await ownType(h);
  const gift = await give(h, A.characterId, typeId);
  const entry = await makeEntry(h);

  const r1 = await settleTrade(h.pool, entry, session(side(A, [gift]), side(B)));
  assert.strictEqual(r1.ok, true, r1.reason);
  assert.strictEqual(await ownerOf(h, gift), B.characterId);
  assert.deepStrictEqual(r1.a.addedItems, []);
  assert.deepStrictEqual(r1.b.removedItemIds, []);

  const r2 = await settleTrade(h.pool, entry, session(side(A, [], 250), side(B)));
  assert.strictEqual(r2.ok, true, r2.reason);
  assert.strictEqual(await goldOf(h, A), 750);
  assert.strictEqual(await goldOf(h, B), 250);
});

// ---------------------------------------------------------------- refusals

// Each case arranges one thing wrong with `bad`, offered next to a good item and
// gold from both sides. `offerReason` is what validateOffer answers for the same
// row; null where the ownership words differ on purpose.
const ITEM_REFUSALS = [
  {
    name: 'item no longer owned',
    reason: 'zzA no longer has an offered item',
    offerReason: 'you do not own that item',
    async arrange(h, A, B, bad) {
      await h.pool.query('UPDATE player_items SET character_id = $1 WHERE id = $2', [B.characterId, bad]);
    },
  },
  {
    name: 'item sitting in the account chest',
    reason: 'zzA no longer has an offered item',
    offerReason: 'you do not own that item',
    async arrange(h, A, B, bad, typeId) {
      const ai = await h.pool.query(
        `INSERT INTO account_items (user_id, slot, item_type_id, quantity) VALUES ($1, 1, $2, 1) RETURNING id`,
        [A.userId, typeId],
      );
      await h.pool.query(
        'UPDATE player_items SET character_id = NULL, account_item_id = $1 WHERE id = $2', [ai.rows[0].id, bad],
      );
    },
  },
  {
    name: 'worn',
    reason: 'unequip it first',
    offerReason: 'unequip it first',
    async arrange(h, A, B, bad) {
      await h.pool.query(
        `INSERT INTO player_equipment (character_id, slot, item_id) VALUES ($1, 'chest', $2)`, [A.characterId, bad],
      );
    },
  },
  {
    // The lookup is unscoped on purpose: any paper-doll row naming the instance blocks.
    name: 'worn, with the equipment row under a different character',
    reason: 'unequip it first',
    offerReason: 'unequip it first',
    async arrange(h, A, B, bad) {
      await h.pool.query(
        `INSERT INTO player_equipment (character_id, slot, item_id) VALUES ($1, 'chest', $2)`, [B.characterId, bad],
      );
    },
  },
  {
    name: 'stone instance',
    reason: 'stones cannot be traded',
    offerReason: 'stones cannot be traded',
    async arrange(h, A, B, bad) {
      await h.pool.query('INSERT INTO stone_instances (player_item_id) VALUES ($1)', [bad]);
    },
  },
  {
    name: 'stone category with no instance row',
    reason: 'stones cannot be traded',
    offerReason: 'stones cannot be traded',
    async arrange(h, A, B, bad) {
      const stoneType = await ownType(h, 'stone');
      await h.pool.query('UPDATE player_items SET item_type_id = $1 WHERE id = $2', [stoneType, bad]);
    },
  },
  {
    name: 'stone host',
    reason: 'unsocket the stone first',
    offerReason: 'unsocket the stone first',
    async arrange(h, A, B, bad, typeId) {
      const stone = await give(h, A.characterId, typeId);
      await h.pool.query(
        'INSERT INTO stone_instances (player_item_id, socketed_into_id) VALUES ($1, $2)', [stone, bad],
      );
    },
  },
  {
    name: 'soulbound',
    reason: 'starting gear cannot be traded',
    offerReason: 'starting gear cannot be traded',
    async arrange(h, A, B, bad) {
      await h.pool.query('UPDATE player_items SET soulbound = true WHERE id = $1', [bad]);
    },
  },
  {
    name: 'currency row',
    reason: 'currency cannot be traded',
    offerReason: 'currency cannot be traded',
    async arrange(h, A, B, bad) {
      const currency = await ownType(h, 'currency');
      await h.pool.query('UPDATE player_items SET item_type_id = $1 WHERE id = $2', [currency, bad]);
    },
  },
];

for (const c of ITEM_REFUSALS) {
  test(`refused, nothing moves: ${c.name}`, async (t) => {
    const h = await harness(t);
    if (!h) return;
    const A = await party(h, 'zzA');
    const B = await party(h, 'zzB');
    const typeId = await ownType(h);
    const good = await give(h, A.characterId, typeId);
    const theirs = await give(h, B.characterId, typeId);
    const bad = await give(h, A.characterId, typeId);
    await c.arrange(h, A, B, bad, typeId);
    const entry = await makeEntry(h);
    const before = await snapshot(h, A, B);

    const r = await settleTrade(h.pool, entry, session(side(A, [good, bad], 100), side(B, [theirs], 5)));
    assert.deepStrictEqual(r, { ok: false, reason: c.reason });
    assert.deepStrictEqual(await snapshot(h, A, B), before, 'every row and both balances unchanged');
    await assertNothingLocked(h, A, [good, theirs, bad]);

    const offer = await validateOffer(h.pool, A.characterId, bad);
    assert.deepStrictEqual(offer, { ok: false, reason: c.offerReason }, 'the offer check uses the same rule');
    assert.deepStrictEqual(await snapshot(h, A, B), before, 'and an offer check writes nothing');
  });
}

test('refused, nothing moves: the refused item is on side b', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const A = await party(h, 'zzA');
  const B = await party(h, 'zzB');
  const typeId = await ownType(h);
  const mine = await give(h, A.characterId, typeId);
  const bad = await give(h, B.characterId, typeId, { soulbound: true });
  const entry = await makeEntry(h);
  const before = await snapshot(h, A, B);

  const r = await settleTrade(h.pool, entry, session(side(A, [mine]), side(B, [bad])));
  assert.deepStrictEqual(r, { ok: false, reason: 'starting gear cannot be traded' });
  assert.deepStrictEqual(await snapshot(h, A, B), before);
});

test('refused, nothing moves: one item offered by both sides', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const A = await party(h, 'zzA');
  const B = await party(h, 'zzB');
  const typeId = await ownType(h);
  const item = await give(h, A.characterId, typeId);
  const entry = await makeEntry(h);
  const before = await snapshot(h, A, B);

  const r = await settleTrade(h.pool, entry, session(side(A, [item]), side(B, [item])));
  assert.deepStrictEqual(r, { ok: false, reason: 'zzB no longer has an offered item' });
  assert.deepStrictEqual(await snapshot(h, A, B), before);
});

// The one refusal that comes AFTER a write: gold has been debited by the time the
// moving statement's rowCount disagrees, so this is what proves the ROLLBACK.
test('a count mismatch at the move rolls the gold back too', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const A = await party(h, 'zzA');
  const B = await party(h, 'zzB');
  const typeId = await ownType(h);
  const item = await give(h, A.characterId, typeId);
  const entry = await makeEntry(h);
  const before = await snapshot(h, A, B);

  const r = await settleTrade(h.pool, entry, session(side(A, [item, item], 100), side(B)));
  assert.deepStrictEqual(r, { ok: false, reason: 'zzA no longer has an offered item' });
  assert.deepStrictEqual(await snapshot(h, A, B), before);
  await assertNothingLocked(h, A, [item]);
});

test('malformed or non-canonical ids are refused, not a database error', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const A = await party(h, 'zzA');
  const B = await party(h, 'zzB');
  const typeId = await ownType(h);
  const item = await give(h, A.characterId, typeId);
  const entry = await makeEntry(h);
  const before = await snapshot(h, A, B);

  // The uppercase spelling names the SAME row, and would let one item sit in a stash twice.
  for (const id of ['nope', '', item.toUpperCase(), 42, null]) {
    const offer = await validateOffer(h.pool, A.characterId, id);
    assert.deepStrictEqual(offer, { ok: false, reason: 'you do not own that item' }, `offer of ${id}`);
    const r = await settleTrade(h.pool, entry, session(side(A, [item, id]), side(B)));
    assert.deepStrictEqual(r, { ok: false, reason: 'zzA no longer has an offered item' }, `settle with ${id}`);
  }
  assert.deepStrictEqual(await snapshot(h, A, B), before);
});

test('refused, nothing moves: not enough gold at settlement', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const A = await party(h, 'zzA', { gold: 50 });
  const B = await party(h, 'zzB', { gold: 500 });
  const typeId = await ownType(h);
  const item = await give(h, A.characterId, typeId);
  const theirs = await give(h, B.characterId, typeId);
  // A live mirror saying the balance is plenty must not count: gold is decided from the locked row.
  const entry = await makeEntry(h, [A]);
  entry.world.getPlayer(String(A.userId)).gold = 100000;
  const before = await snapshot(h, A, B);

  const r = await settleTrade(h.pool, entry, session(side(A, [item], 100), side(B, [theirs], 10)));
  assert.deepStrictEqual(r, { ok: false, reason: 'not enough gold' });
  assert.deepStrictEqual(await snapshot(h, A, B), before);
  await assertNothingLocked(h, A, [item, theirs]);
});

test('the balance needed is the net, so a seller short of their own offer still settles when covered', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const A = await party(h, 'zzA', { gold: 50 });
  const B = await party(h, 'zzB', { gold: 500 });
  const entry = await makeEntry(h);

  const r = await settleTrade(h.pool, entry, session(side(A, [], 100), side(B, [], 80)));
  assert.strictEqual(r.ok, true, r.reason);
  assert.strictEqual(await goldOf(h, A), 30);
  assert.strictEqual(await goldOf(h, B), 520);
});

test('refused, nothing moves: a credit past what the gold column holds', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const A = await party(h, 'zzA', { gold: 1000 });
  const B = await party(h, 'zzB', { gold: INT4_MAX - 10 });
  const entry = await makeEntry(h);
  const before = await snapshot(h, A, B);

  const r = await settleTrade(h.pool, entry, session(side(A, [], 11), side(B)));
  assert.deepStrictEqual(r, { ok: false, reason: 'zzB cannot hold that much gold' });
  assert.deepStrictEqual(await snapshot(h, A, B), before);

  const exact = await settleTrade(h.pool, entry, session(side(A, [], 10), side(B)));
  assert.strictEqual(exact.ok, true, exact.reason);
  assert.strictEqual(await goldOf(h, B), INT4_MAX);
});

test('refused, nothing moves: a gold offer the column could never hold, or that is not a whole amount', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const A = await party(h, 'zzA');
  const B = await party(h, 'zzB');
  const entry = await makeEntry(h);
  const before = await snapshot(h, A, B);

  const huge = await settleTrade(h.pool, entry, session(side(A, [], 3e9), side(B)));
  assert.deepStrictEqual(huge, { ok: false, reason: 'not enough gold' }, 'past int4 is still just more than A has');
  for (const gold of [-5, 1.5, NaN, Infinity, '10', null, 2 ** 60]) {
    const r = await settleTrade(h.pool, entry, session(side(A, [], gold), side(B)));
    assert.deepStrictEqual(r, { ok: false, reason: 'invalid gold' }, `gold ${gold}`);
  }
  assert.deepStrictEqual(await snapshot(h, A, B), before, 'a negative offer must not pull gold out of the partner');
});

test('refused, nothing moves: a party whose character was deleted', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const A = await party(h, 'zzA');
  const B = await party(h, 'zzB');
  const typeId = await ownType(h);
  const item = await give(h, A.characterId, typeId);
  const entry = await makeEntry(h);
  await h.pool.query('DELETE FROM characters WHERE id = $1', [B.characterId]);
  const before = await snapshot(h, A, B);

  const r = await settleTrade(h.pool, entry, session(side(A, [item], 5), side(B)));
  assert.deepStrictEqual(r, { ok: false, reason: 'zzB is no longer available' });
  assert.deepStrictEqual(await snapshot(h, A, B), before);
});

test('refused, nothing moves: a side naming a character of another account', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const A = await party(h, 'zzA');
  const B = await party(h, 'zzB');
  const C = await party(h, 'zzC');
  const typeId = await ownType(h);
  const item = await give(h, A.characterId, typeId);
  const entry = await makeEntry(h);
  const before = await snapshot(h, A, B, C);

  const wrong = { ...side(B), characterId: C.characterId };
  const r = await settleTrade(h.pool, entry, session(side(A, [item]), wrong));
  assert.deepStrictEqual(r, { ok: false, reason: 'zzB is no longer available' });
  assert.deepStrictEqual(await snapshot(h, A, B, C), before);
});

test('refused, nothing moves: both sides are one account', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const A = await party(h, 'zzA');
  const second = await character(h, A, 2);
  const typeId = await ownType(h);
  const item = await give(h, A.characterId, typeId);
  const entry = await makeEntry(h);
  const before = await snapshot(h, A);

  const r = await settleTrade(h.pool, entry, session(side(A, [item], 5), { ...side(A), characterId: second }));
  assert.deepStrictEqual(r, { ok: false, reason: 'a player is no longer available' });
  assert.deepStrictEqual(await snapshot(h, A), before);
});

// ---------------------------------------------------------------- capacity

test('refused, nothing moves: receiver offline with no capacity, by inventory_slots', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const A = await party(h, 'zzA');
  const B = await party(h, 'zzB', { slots: 2 });
  const typeId = await ownType(h);
  const gift = await give(h, A.characterId, typeId);
  await give(h, B.characterId, typeId);
  await give(h, B.characterId, typeId);
  const entry = await makeEntry(h);
  const before = await snapshot(h, A, B);

  const r = await settleTrade(h.pool, entry, session(side(A, [gift], 5), side(B)));
  assert.deepStrictEqual(r, { ok: false, reason: 'zzB has no room' });
  assert.deepStrictEqual(await snapshot(h, A, B), before);
  await assertNothingLocked(h, A, [gift]);
});

test('capacity names the side that has no room when that side is a', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const A = await party(h, 'zzA', { slots: 1 });
  const B = await party(h, 'zzB');
  const typeId = await ownType(h);
  await give(h, A.characterId, typeId);
  const gift = await give(h, B.characterId, typeId);
  const entry = await makeEntry(h);

  const r = await settleTrade(h.pool, entry, session(side(A), side(B, [gift])));
  assert.deepStrictEqual(r, { ok: false, reason: 'zzA has no room' });
});

test('a receiver online is measured by the live inventory, not the row count', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const A = await party(h, 'zzA');
  const B = await party(h, 'zzB', { slots: 48 });
  const typeId = await ownType(h);
  const gift = await give(h, A.characterId, typeId);
  const entry = await makeEntry(h, [B]);
  const p = entry.world.getPlayer(String(B.userId));
  p.inv.capacity = 1;
  p.inv.items.push({ id: 'live-only', typeId, quantity: 1 });
  const before = await snapshot(h, A, B);

  const r = await settleTrade(h.pool, entry, session(side(A, [gift]), side(B)));
  assert.deepStrictEqual(r, { ok: false, reason: 'zzB has no room' });
  assert.deepStrictEqual(await snapshot(h, A, B), before);
});

test('a receiver playing ANOTHER character on the account is measured from the database', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const A = await party(h, 'zzA');
  const B = await party(h, 'zzB', { slots: 1 });
  const typeId = await ownType(h);
  const gift = await give(h, A.characterId, typeId);
  await give(h, B.characterId, typeId);
  const other = await character(h, B, 2, 48);
  const entry = await makeEntry(h);
  await join(h, entry, B, other); // this character's bag is empty and has 48 slots

  const r = await settleTrade(h.pool, entry, session(side(A, [gift]), side(B)));
  assert.deepStrictEqual(r, { ok: false, reason: 'zzB has no room' });
});

test('capacity counts what the receiver gives away', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const A = await party(h, 'zzA', { slots: 1 });
  const B = await party(h, 'zzB', { slots: 1 });
  const typeId = await ownType(h);
  const mine = await give(h, A.characterId, typeId);
  const theirs = await give(h, B.characterId, typeId);

  const offline = await settleTrade(h.pool, await makeEntry(h), session(side(A, [mine]), side(B, [theirs])));
  assert.strictEqual(offline.ok, true, offline.reason);
  assert.strictEqual(await ownerOf(h, mine), B.characterId);
  assert.strictEqual(await ownerOf(h, theirs), A.characterId);

  // The same swap back, both online.
  const live = await settleTrade(h.pool, await makeEntry(h, [A, B]), session(side(A, [theirs]), side(B, [mine])));
  assert.strictEqual(live.ok, true, live.reason);
  assert.strictEqual(await ownerOf(h, mine), A.characterId);
});

test('a currency row takes no slot, offline and online', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const A = await party(h, 'zzA');
  const B = await party(h, 'zzB', { slots: 1 });
  const typeId = await ownType(h);
  const currency = await ownType(h, 'currency');
  await give(h, B.characterId, currency);
  const first = await give(h, A.characterId, typeId);
  const second = await give(h, A.characterId, typeId);

  const offline = await settleTrade(h.pool, await makeEntry(h), session(side(A, [first]), side(B)));
  assert.strictEqual(offline.ok, true, offline.reason);
  // Now really full, by the one non-currency row, and the live path must say so too.
  const live = await settleTrade(h.pool, await makeEntry(h, [B]), session(side(A, [second]), side(B)));
  assert.deepStrictEqual(live, { ok: false, reason: 'zzB has no room' });

  await h.pool.query('UPDATE player_items SET character_id = $1 WHERE id = $2', [A.characterId, first]);
  const liveRoom = await settleTrade(h.pool, await makeEntry(h, [B]), session(side(A, [first]), side(B)));
  assert.strictEqual(liveRoom.ok, true, liveRoom.reason);
});

test('a worn item and a socketed stone do take a slot, as usedSlots counts them', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const A = await party(h, 'zzA');
  const B = await party(h, 'zzB', { slots: 2 });
  const typeId = await ownType(h);
  const gift = await give(h, A.characterId, typeId);
  const wornHost = await give(h, B.characterId, typeId);
  const stone = await give(h, B.characterId, typeId);
  await h.pool.query(`INSERT INTO player_equipment (character_id, slot, item_id) VALUES ($1, 'chest', $2)`, [B.characterId, wornHost]);
  await h.pool.query('INSERT INTO stone_instances (player_item_id, socketed_into_id) VALUES ($1, $2)', [stone, wornHost]);

  const r = await settleTrade(h.pool, await makeEntry(h), session(side(A, [gift]), side(B)));
  assert.deepStrictEqual(r, { ok: false, reason: 'zzB has no room' });
});

// A character whose cap sits below what it carries must be able to get rid of things.
test('a side already over capacity can still give, since it does not grow', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const A = await party(h, 'zzA', { slots: 1 });
  const B = await party(h, 'zzB');
  const typeId = await ownType(h);
  const gift = await give(h, A.characterId, typeId);
  await give(h, A.characterId, typeId);
  await give(h, A.characterId, typeId);

  const r = await settleTrade(h.pool, await makeEntry(h), session(side(A, [gift]), side(B)));
  assert.strictEqual(r.ok, true, r.reason);
  assert.strictEqual(await ownerOf(h, gift), B.characterId);
});

// ---------------------------------------------------------------- concurrency

// The same pair, sides and item lists reversed. A blocker on one user makes both
// settlements queue up before it is released, so an order that depends on the
// session would interleave every time, not once in a thousand runs.
test('opposite trades do not deadlock', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const A = await party(h, 'zzA', { gold: 1000 });
  const B = await party(h, 'zzB', { gold: 1000 });
  const typeId = await ownType(h);
  const as = [await give(h, A.characterId, typeId), await give(h, A.characterId, typeId)];
  const bs = [await give(h, B.characterId, typeId), await give(h, B.characterId, typeId)];
  const entry = await makeEntry(h);

  const blocker = await h.pool.connect();
  let results;
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [A.userId]);
    const first = settleTrade(h.pool, entry, session(side(A, as, 100), side(B, bs, 7)));
    const second = settleTrade(
      h.pool, entry, session(side(B, [...bs].reverse(), 7), side(A, [...as].reverse(), 100)),
    );
    try {
      await waitForLockWaiters(h, 2);
    } finally {
      await blocker.query('COMMIT');
    }
    results = await bothResolve([first, second]);
  } finally {
    blocker.release();
  }

  assert.strictEqual(results.filter((r) => r.ok).length, 1, `exactly one wins: ${JSON.stringify(results)}`);
  const loser = results.find((r) => !r.ok);
  assert.match(loser.reason, /no longer has an offered item/);
  for (const id of as) assert.strictEqual(await ownerOf(h, id), B.characterId);
  for (const id of bs) assert.strictEqual(await ownerOf(h, id), A.characterId);
  assert.strictEqual(await goldOf(h, A), 907, 'the gold moved once');
  assert.strictEqual(await goldOf(h, B), 1093);
});

// Users serialize any two trades sharing a party, so the item order only matters
// between trades with no party in common. Here both name the same rows.
test('trades with no party in common, naming the same rows in opposite orders, do not deadlock', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const A = await party(h, 'zzA');
  const B = await party(h, 'zzB');
  const C = await party(h, 'zzC');
  const D = await party(h, 'zzD');
  const typeId = await ownType(h);
  const x = await give(h, A.characterId, typeId);
  const y = await give(h, A.characterId, typeId);
  const entry = await makeEntry(h);

  const lowest = [x, y].sort()[0];
  const blocker = await h.pool.connect();
  let results;
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM player_items WHERE id = $1 FOR UPDATE', [lowest]);
    const first = settleTrade(h.pool, entry, session(side(A, [x, y]), side(B)));
    const second = settleTrade(h.pool, entry, session(side(C, [y, x]), side(D)));
    try {
      await waitForLockWaiters(h, 2);
    } finally {
      await blocker.query('COMMIT');
    }
    results = await bothResolve([first, second]);
  } finally {
    blocker.release();
  }
  assert.deepStrictEqual(results[1], { ok: false, reason: 'zzC no longer has an offered item' });
  assert.strictEqual(results[0].ok, true, results[0].reason);
  assert.strictEqual(await ownerOf(h, x), B.characterId);
  assert.strictEqual(await ownerOf(h, y), B.characterId);
});

// depositItem locks the item, then inserts account_items, whose foreign key wants
// a KEY SHARE on the user. A settlement that took the user FOR UPDATE and then
// waited on the item would close that cycle.
test('a chest deposit already holding the item finishes, and settlement then refuses', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const A = await party(h, 'zzA');
  const B = await party(h, 'zzB');
  const typeId = await ownType(h);
  const item = await give(h, A.characterId, typeId);
  const entry = await makeEntry(h);

  const depositor = await h.pool.connect();
  let settling;
  try {
    await depositor.query('BEGIN');
    await depositor.query('SET LOCAL lock_timeout = 2000');
    await depositor.query('SELECT id FROM player_items WHERE id = $1 FOR UPDATE', [item]);
    settling = settleTrade(h.pool, entry, session(side(A, [item], 3), side(B)));
    await waitForLockWaiters(h, 1);
    const ai = await depositor.query(
      `INSERT INTO account_items (user_id, slot, item_type_id, quantity) VALUES ($1, 1, $2, 1) RETURNING id`,
      [A.userId, typeId],
    );
    await depositor.query(
      'UPDATE player_items SET character_id = NULL, account_item_id = $2 WHERE id = $1', [item, ai.rows[0].id],
    );
    await depositor.query('COMMIT');
  } catch (err) {
    await depositor.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    depositor.release();
  }
  const [r] = await bothResolve([settling]);
  assert.deepStrictEqual(r, { ok: false, reason: 'zzA no longer has an offered item' });
  assert.strictEqual(await goldOf(h, A), 1000);
});

// Postgres re-reads a blocked row but keeps the statement's OLD snapshot for every
// other table, so the worn/stone checks must run in a statement AFTER the lock.
test('an equip committed while settlement waited on the row is seen', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const A = await party(h, 'zzA');
  const B = await party(h, 'zzB');
  const typeId = await ownType(h);
  const item = await give(h, A.characterId, typeId);
  const entry = await makeEntry(h);

  const equipper = await h.pool.connect();
  let settling;
  try {
    await equipper.query('BEGIN');
    await equipper.query('SELECT id FROM player_items WHERE id = $1 FOR UPDATE', [item]);
    settling = settleTrade(h.pool, entry, session(side(A, [item]), side(B)));
    await waitForLockWaiters(h, 1);
    await equipper.query(
      `INSERT INTO player_equipment (character_id, slot, item_id) VALUES ($1, 'chest', $2)`, [A.characterId, item],
    );
    await equipper.query('COMMIT');
  } catch (err) {
    await equipper.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    equipper.release();
  }
  const [r] = await bothResolve([settling]);
  assert.deepStrictEqual(r, { ok: false, reason: 'unequip it first' });
  assert.strictEqual(await ownerOf(h, item), A.characterId);
});

// ---------------------------------------------------------------- offer

test('validateOffer returns the live display shape for an offerable item, and takes no lock', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const A = await party(h, 'zzA');
  const typeId = await ownType(h);
  const item = await rolledItem(h, A.characterId, typeId);

  const holder = await h.pool.connect();
  let r;
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM player_items WHERE id = $1 FOR UPDATE', [item]);
    r = await validateOffer(h.pool, A.characterId, item); // would hang here if it locked
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
  }
  assert.strictEqual(r.ok, true, r.reason);
  const reloaded = (await loadInventory(h.pool, A.characterId)).items.find((i) => i.id === item);
  assert.deepStrictEqual(r.item, reloaded, 'the same object a reconnect would load');
});

// ---------------------------------------------------------------- live mirror

test('live mirror: added item carries affix effect', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const A = await party(h, 'zzA', { gold: 1000 });
  const B = await party(h, 'zzB', { gold: 500 });
  const typeId = await ownType(h);
  const item = await rolledItem(h, A.characterId, typeId);
  const entry = await makeEntry(h, [A, B]);
  const pa = entry.world.getPlayer(String(A.userId));
  const pb = entry.world.getPlayer(String(B.userId));

  const r = await settleTrade(h.pool, entry, session(side(A, [item]), side(B, [], 40)));
  assert.strictEqual(r.ok, true, r.reason);
  assert.strictEqual(pa.inv.items.some((i) => i.id === item), true, 'settlement itself leaves the mirrors alone');
  assert.strictEqual(pa.gold, 1000);

  applyOutcomeToLive(entry, String(A.userId), r.a);
  applyOutcomeToLive(entry, String(B.userId), r.b);

  assert.strictEqual(pa.inv.items.some((i) => i.id === item), false, 'the giver no longer holds it');
  const live = pb.inv.items.find((i) => i.id === item);
  assert.ok(live, 'the receiver does');
  assert.strictEqual(live.rarity, 'foxy');
  assert.strictEqual(live.itemLevel, 88);
  assert.strictEqual(live.enchantLevel, 3);
  assert.deepStrictEqual(live.affixes.map((a) => a.value), [3.13, 11.5]);
  for (const a of live.affixes) {
    assert.ok(a.key, 'carries the catalog key');
    assert.ok(a.label, 'carries the catalog label');
    assert.ok(a.effect && typeof a.effect === 'object', 'carries the effect the equip path reads');
  }
  const reloaded = (await loadInventory(h.pool, B.characterId)).items.find((i) => i.id === item);
  assert.deepStrictEqual(live, reloaded, 'the live copy and a reconnect are the same object');
  assert.strictEqual(pa.gold, 1040);
  assert.strictEqual(pb.gold, 460);
});

test('applyOutcomeToLive twice leaves one copy', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const A = await party(h, 'zzA');
  const B = await party(h, 'zzB');
  const typeId = await ownType(h);
  const item = await rolledItem(h, A.characterId, typeId);
  const entry = await makeEntry(h, [A, B]);
  const r = await settleTrade(h.pool, entry, session(side(A, [item]), side(B)));
  assert.strictEqual(r.ok, true, r.reason);

  applyOutcomeToLive(entry, String(B.userId), r.b);
  applyOutcomeToLive(entry, String(B.userId), r.b);
  const pb = entry.world.getPlayer(String(B.userId));
  assert.strictEqual(pb.inv.items.filter((i) => i.id === item).length, 1);
});

test('missing player is a no-op, and a reconnected player is found fresh', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const A = await party(h, 'zzA');
  const B = await party(h, 'zzB');
  const typeId = await ownType(h);
  const item = await give(h, A.characterId, typeId);
  const entry = await makeEntry(h);

  const r = await settleTrade(h.pool, entry, session(side(A, [item]), side(B)));
  assert.strictEqual(r.ok, true, r.reason);
  assert.doesNotThrow(() => applyOutcomeToLive(entry, String(A.userId), r.a));

  // B reconnects AFTER the commit: the join's own load already has the item.
  const pb = await join(h, entry, B);
  applyOutcomeToLive(entry, String(B.userId), r.b);
  assert.strictEqual(pb.inv.items.filter((i) => i.id === item).length, 1);
});

// userId owns gold, characterId owns everything else (world.js).
test('a player back on ANOTHER character gets the gold but not the items', async (t) => {
  const h = await harness(t);
  if (!h) return;
  const A = await party(h, 'zzA');
  const B = await party(h, 'zzB');
  const typeId = await ownType(h);
  const item = await give(h, A.characterId, typeId);
  const other = await character(h, A, 2);
  const entry = await makeEntry(h);

  const r = await settleTrade(h.pool, entry, session(side(B, [], 25), side(A, [item])));
  assert.strictEqual(r.ok, true, r.reason);
  const pa = await join(h, entry, A, other);
  pa.inv.items.push({ id: item, typeId, quantity: 1 }); // a stand-in proving the removal is skipped too
  applyOutcomeToLive(entry, String(A.userId), {
    ...r.b,
    addedItems: [{ id: 'for-the-first-character', typeId, quantity: 1 }],
  });
  assert.deepStrictEqual(pa.inv.items.map((i) => i.id), [item], 'this bag is another character\'s');
  assert.strictEqual(pa.gold, r.b.gold, 'gold is account-wide');
});
