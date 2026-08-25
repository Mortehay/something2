// SOMET-498. The account-chest round trip, through the REAL deposit and
// withdraw paths.
//
// Every test here calls services/accountChest.js's depositItem and withdrawItem
// against a real database with real rows. That is deliberate and not
// negotiable: this epic has now shipped a long series of features that were
// live in the schema, drawn in the UI and completely inert in play, each with a
// fully green suite, because what was tested was a pure helper round-tripping a
// JS object rather than the path a player actually walks.
//
// Affix rolls are asserted BY VALUE with deepStrictEqual, never by count and
// never by key set: a `.length` check or a key comparison passes just as
// happily with every rolled number zeroed, which is most of what SOMET-498
// destroyed. 3.13 is not representable in float4, so a carry path that lost
// precision would show here and nowhere in a count check.
//
// The sibling file account_chest.test.js covers the SQL predicates and the
// statement orderings against an in-memory fake. This one covers the things
// only a real database can answer: the CHECK constraints, the CASCADEs, and
// whether a rolled item actually survives.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { World } = require('../src/authority/world.js');
const { loadItemTypes, loadInventory } = require('../src/authority/items.js');
const { depositItem, withdrawItem, fetchChest } = require('../src/services/accountChest.js');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

async function openPool() {
  if (!DB_URL) return { unreachable: 'no TEST_DATABASE_URL / DATABASE_URL' };
  const pool = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 2000, max: 4 });
  try { await pool.query('SELECT 1'); } catch (err) {
    await pool.end().catch(() => {});
    return { unreachable: `NO DATABASE at ${DB_URL} (${err.message})` };
  }
  return pool;
}

function uniq(tag) {
  return `${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Every row is created by THIS test and torn down by THIS test. Nothing here
// touches a pre-existing user, character, world or item type.
async function fixture(pool, tag) {
  const u = await pool.query(
    `INSERT INTO users (username, password_hash, role, gold)
     VALUES ($1, 'x', 'player', 1000) RETURNING id`,
    [uniq(`s498-${tag}`)],
  );
  const userId = u.rows[0].id;
  const c = await pool.query(
    `INSERT INTO characters (user_id, slot, name, entity_type_id)
     SELECT $1, 1, $2, e.id FROM entity_types e WHERE e.is_playable = true
      ORDER BY e.id LIMIT 1 RETURNING id`,
    [userId, uniq(`s498-char-${tag}`)],
  );
  const w = await pool.query(
    `INSERT INTO worlds (name, width, height, chunk_size, seed)
     VALUES ($1, 64, 64, 16, 1) RETURNING id`,
    [uniq(`s498-world-${tag}`)],
  );
  return { userId, characterId: c.rows[0].id, worldId: w.rows[0].id };
}

async function cleanup(pool, fx) {
  if (!fx) return;
  // account_items FIRST: player_items.account_item_id is ON DELETE CASCADE, so
  // this also removes any instance still sitting in the chest.
  await pool.query('DELETE FROM account_items WHERE user_id = $1', [fx.userId]).catch(() => {});
  await pool.query('DELETE FROM player_items WHERE character_id = $1', [fx.characterId]).catch(() => {});
  if (fx.characterId2) {
    await pool.query('DELETE FROM player_items WHERE character_id = $1', [fx.characterId2]).catch(() => {});
    await pool.query('DELETE FROM characters WHERE id = $1', [fx.characterId2]).catch(() => {});
  }
  await pool.query('DELETE FROM characters WHERE id = $1', [fx.characterId]).catch(() => {});
  await pool.query('DELETE FROM worlds WHERE id = $1', [fx.worldId]).catch(() => {});
  await pool.query('DELETE FROM users WHERE id = $1', [fx.userId]).catch(() => {});
  if (fx.itemTypeId) {
    await pool.query('DELETE FROM item_types WHERE id = $1', [fx.itemTypeId]).catch(() => {});
  }
}

// A world entry shaped the way server.js builds one, with a stub map: nothing
// on the chest path reads terrain.
async function armEntry(pool, fx, characterId = null) {
  const itemTypes = await loadItemTypes(pool);
  const map = {
    chunkSize: 16, isWalkable: () => true, speedAt: () => 1, getChunk: () => [],
  };
  const world = new World(map, itemTypes, null, 16);
  const entry = { worldId: fx.worldId, world, claiming: new Set() };
  const cid = characterId || fx.characterId;
  const inv = await loadInventory(pool, cid);
  world.addPlayer(String(fx.userId), { x: 100, y: 100 }, inv, { x: 100, y: 100 }, 0, undefined, cid);
  return { entry, itemTypes, p: world.getPlayer(String(fx.userId)) };
}

// A private item type, so no test here can be perturbed by (or perturb) the
// shared catalog, and so the catalog-deletion test has something it is allowed
// to delete.
async function ownType(pool, fx, tag) {
  const r = await pool.query(
    `INSERT INTO item_types (name, category, slot, damage, cooldown, defense, value)
     VALUES ($1, 'armor', 'chest', 0, 0, 3, 40) RETURNING id`,
    [uniq(`s498-type-${tag}`)],
  );
  fx.itemTypeId = r.rows[0].id;
  return r.rows[0].id;
}

// Two affixes with values chosen to be awkward on purpose: a two-decimal
// fraction that float4 cannot represent, and a half. A carry path that rounds,
// truncates or zeroes shows up here and nowhere in a count check.
const ROLLS = [3.13, 11.5];

async function affixedItem(pool, fx, itemTypeId, { rarity = 'foxy', itemLevel = 88 } = {}) {
  const it = await pool.query(
    `INSERT INTO player_items (character_id, item_type_id, quantity, rarity, item_level)
     VALUES ($1, $2, 1, $3, $4) RETURNING id`,
    [fx.characterId, itemTypeId, rarity, itemLevel],
  );
  const itemId = it.rows[0].id;
  const at = await pool.query('SELECT id FROM affix_types ORDER BY id LIMIT 2');
  assert.strictEqual(at.rowCount, 2, 'the affix catalog must be seeded for this test to mean anything');
  const affixTypeIds = at.rows.map((r) => r.id);
  for (let i = 0; i < 2; i += 1) {
    await pool.query(
      'INSERT INTO player_item_affixes (player_item_id, idx, affix_type_id, value) VALUES ($1,$2,$3,$4)',
      [itemId, i, affixTypeIds[i], ROLLS[i]],
    );
  }
  return { itemId, affixTypeIds };
}

// The affix rows AS ROWS: idx, type and value, in idx order. This is the
// comparison the whole ticket turns on -- the same numbers, not merely the same
// affix keys.
async function affixRows(pool, itemId) {
  const r = await pool.query(
    `SELECT idx, affix_type_id, value FROM player_item_affixes
      WHERE player_item_id = $1 ORDER BY idx`,
    [itemId],
  );
  return r.rows.map((x) => ({ idx: Number(x.idx), affixTypeId: x.affix_type_id, value: Number(x.value) }));
}

// The holder columns of one instance, as a plain object. `null` for a missing
// row so a destroyed instance and an ownerless one read differently.
async function holderOf(pool, itemId) {
  const r = await pool.query(
    'SELECT character_id, merchant_stock_id, account_item_id FROM player_items WHERE id = $1',
    [itemId],
  );
  if (r.rowCount === 0) return null;
  return {
    character_id: r.rows[0].character_id,
    merchant_stock_id: r.rows[0].merchant_stock_id,
    account_item_id: r.rows[0].account_item_id,
  };
}

function carry(p, itemId, typeId, quantity = 1) {
  p.inv.items.push({ id: itemId, typeId, quantity });
}

// ---------------------------------------------------------------- AC1

test('SOMET-498: an affixed item survives deposit-and-withdraw with identical rarity, item level and affix VALUES, under the SAME instance id', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  t.after(async () => { await cleanup(pool, fx); await pool.end().catch(() => {}); });

  fx = await fixture(pool, 'roundtrip');
  const typeId = await ownType(pool, fx, 'roundtrip');
  const { itemId, affixTypeIds } = await affixedItem(pool, fx, typeId);
  const before = await affixRows(pool, itemId);
  assert.deepStrictEqual(before, [
    { idx: 0, affixTypeId: affixTypeIds[0], value: 3.13 },
    { idx: 1, affixTypeId: affixTypeIds[1], value: 11.5 },
  ], 'precondition: the item starts with two rolled affixes');

  const { entry, p } = await armEntry(pool, fx);
  carry(p, itemId, typeId);

  const dep = await depositItem(pool, entry, String(fx.userId), fx.characterId, itemId);
  assert.strictEqual(dep.ok, true, `an affixed item must be depositable (got: ${dep.reason})`);

  // WHILE STORED: the same row, owned by no character, held by the chest, with
  // its affix rows untouched -- and invisible to the character's inventory.
  assert.deepStrictEqual(await holderOf(pool, itemId), {
    character_id: null, merchant_stock_id: null, account_item_id: dep.stored.id,
  }, 'the deposit must MOVE the instance to the chest, not destroy it');
  assert.deepStrictEqual(await affixRows(pool, itemId), before,
    'its affix rows must be untouched while it sits in the chest');
  const invWhileStored = await loadInventory(pool, fx.characterId);
  assert.strictEqual(invWhileStored.items.some((i) => i.id === itemId), false,
    'a stored item must not still load into the depositing character inventory');

  const wd = await withdrawItem(pool, entry, String(fx.userId), fx.characterId, dep.stored.id);
  assert.strictEqual(wd.ok, true, `the withdrawal must succeed (got: ${wd.reason})`);

  // BY CONSTRUCTION: the same id. If this holds there is no carry path at all
  // and no future column can be forgotten from one.
  assert.strictEqual(wd.item.id, itemId, 'the player must get back the very instance they deposited');

  const back = await pool.query(
    'SELECT character_id, account_item_id, item_type_id, rarity, item_level FROM player_items WHERE id = $1',
    [itemId],
  );
  assert.strictEqual(back.rowCount, 1, 'the withdrawn item must exist');
  assert.strictEqual(back.rows[0].character_id, fx.characterId, 'and be owned by the withdrawing character');
  assert.strictEqual(back.rows[0].account_item_id, null, 'and no longer be held by the chest');
  assert.strictEqual(back.rows[0].item_type_id, typeId);
  assert.strictEqual(back.rows[0].rarity, 'foxy', 'rarity must survive the round trip');
  assert.strictEqual(Number(back.rows[0].item_level), 88, 'item level must survive the round trip');
  assert.deepStrictEqual(await affixRows(pool, itemId), before,
    'every affix must come back with the SAME index, type and rolled VALUE');

  // And the container is gone, with nothing left behind.
  assert.deepStrictEqual((await fetchChest(pool, fx.userId)).items, [],
    'the chest slot must be freed by the withdrawal');
});

// The mutant this exists for: DB right, `p.inv` affix-less. The in-memory
// mirror is what equipRequirements#gearStatGrants reads on the equip path --
// NOT the database -- so an item that is perfect in Postgres and bare in
// p.inv.items grants nothing until the player reconnects.
test('SOMET-498: the withdrawn item carries its rarity and affix values in the LIVE inventory, not just the DB', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  t.after(async () => { await cleanup(pool, fx); await pool.end().catch(() => {}); });

  fx = await fixture(pool, 'inmem');
  const typeId = await ownType(pool, fx, 'inmem');
  const { itemId, affixTypeIds } = await affixedItem(pool, fx, typeId, { rarity: 'yellow', itemLevel: 44 });
  const { entry, p } = await armEntry(pool, fx);
  carry(p, itemId, typeId);

  const dep = await depositItem(pool, entry, String(fx.userId), fx.characterId, itemId);
  assert.strictEqual(dep.ok, true, dep.reason);
  assert.strictEqual(p.inv.items.some((i) => i.id === itemId), false,
    'the deposit must drop the item from the live inventory too');

  const wd = await withdrawItem(pool, entry, String(fx.userId), fx.characterId, dep.stored.id);
  assert.strictEqual(wd.ok, true, wd.reason);

  const live = p.inv.items.find((i) => i.id === itemId);
  assert.ok(live, 'the withdrawn item must be pushed into the live inventory');
  assert.strictEqual(live.rarity, 'yellow', 'the live copy must carry the rarity');
  assert.strictEqual(live.itemLevel, 44, 'the live copy must carry the item level');
  assert.deepStrictEqual(
    live.affixes.map((a) => ({ affixTypeId: a.affixTypeId, value: a.value })),
    [
      { affixTypeId: affixTypeIds[0], value: 3.13 },
      { affixTypeId: affixTypeIds[1], value: 11.5 },
    ],
    'the live copy must carry every affix, in order, with its rolled VALUE',
  );
  // key/effect come from the affix_types join and are what the equip path
  // actually reads -- an id-only list would grant nothing.
  for (const a of live.affixes) {
    assert.ok(a.key, 'every live affix must carry its catalog key');
    assert.ok(a.label, 'every live affix must carry its catalog label');
    assert.ok(a.effect && typeof a.effect === 'object', 'every live affix must carry its effect payload');
  }

  // And the same thing on a fresh join, so the two loaders agree -- key for
  // key, value for value, not merely "both non-empty".
  const reloaded = await loadInventory(pool, fx.characterId);
  const fromDb = reloaded.items.find((i) => i.id === itemId);
  assert.ok(fromDb, 'the withdrawn item must reload on the next join');
  assert.strictEqual(fromDb.rarity, 'yellow');
  assert.strictEqual(fromDb.itemLevel, 44);
  assert.deepStrictEqual(fromDb.affixes, live.affixes,
    'the live copy and the reloaded copy must be the SAME affix objects');
});

// The chest is account-scoped: that is the entire feature. A helmet the first
// character deposits must come out on the second one, whole.
test('SOMET-498: a rolled item deposited by one character comes out WHOLE on another character of the same account', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  t.after(async () => { await cleanup(pool, fx); await pool.end().catch(() => {}); });

  fx = await fixture(pool, 'crosschar');
  const typeId = await ownType(pool, fx, 'crosschar');
  const { itemId } = await affixedItem(pool, fx, typeId);
  const before = await affixRows(pool, itemId);

  const { entry: e1, p: p1 } = await armEntry(pool, fx);
  carry(p1, itemId, typeId);
  const dep = await depositItem(pool, e1, String(fx.userId), fx.characterId, itemId);
  assert.strictEqual(dep.ok, true, dep.reason);

  const c2 = await pool.query(
    `INSERT INTO characters (user_id, slot, name, entity_type_id)
     SELECT $1, 2, $2, e.id FROM entity_types e WHERE e.is_playable = true
      ORDER BY e.id LIMIT 1 RETURNING id`,
    [fx.userId, uniq('s498-char2')],
  );
  fx.characterId2 = c2.rows[0].id;

  const { entry: e2, p: p2 } = await armEntry(pool, fx, fx.characterId2);
  const wd = await withdrawItem(pool, e2, String(fx.userId), fx.characterId2, dep.stored.id);
  assert.strictEqual(wd.ok, true, wd.reason);
  assert.strictEqual(wd.item.id, itemId, 'the same instance crosses between characters');
  assert.strictEqual(wd.item.rarity, 'foxy');
  assert.strictEqual(wd.item.itemLevel, 88);
  assert.deepStrictEqual(await affixRows(pool, itemId), before, 'with the same rolls');
  assert.deepStrictEqual(await holderOf(pool, itemId), {
    character_id: fx.characterId2, merchant_stock_id: null, account_item_id: null,
  });
  assert.strictEqual(p2.inv.items.some((i) => i.id === itemId), true,
    'and it lands in the SECOND character live inventory');
});

// ---------------------------------------------------------------- AC2

test('SOMET-498 AC2: an unaffixed stack keeps its quantity and stays one row across the round trip', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  t.after(async () => { await cleanup(pool, fx); await pool.end().catch(() => {}); });

  fx = await fixture(pool, 'stack');
  const typeId = await ownType(pool, fx, 'stack');
  const it = await pool.query(
    `INSERT INTO player_items (character_id, item_type_id, quantity)
     VALUES ($1, $2, 24) RETURNING id`,
    [fx.characterId, typeId],
  );
  const itemId = it.rows[0].id;
  const { entry, p } = await armEntry(pool, fx);
  carry(p, itemId, typeId, 24);

  const dep = await depositItem(pool, entry, String(fx.userId), fx.characterId, itemId);
  assert.strictEqual(dep.ok, true, `a stack must still be storable (got: ${dep.reason})`);
  assert.strictEqual(dep.stored.quantity, 24, 'the chest row must show the whole stack');

  const wd = await withdrawItem(pool, entry, String(fx.userId), fx.characterId, dep.stored.id);
  assert.strictEqual(wd.ok, true, wd.reason);
  assert.strictEqual(wd.item.quantity, 24, 'every unit must come back');
  assert.strictEqual(wd.item.id, itemId, 'as ONE row, not a rebuilt one');

  const rows = await pool.query(
    'SELECT quantity FROM player_items WHERE character_id = $1', [fx.characterId],
  );
  assert.deepStrictEqual(rows.rows.map((r) => Number(r.quantity)), [24],
    'and the character holds exactly one row of 24, never 24 rows or a row of 1');
});

// The stacking DECISION, enforced in the schema rather than in the caller:
// instance-held chest rows are NOT pinned to quantity 1 (the move preserves a
// stack by construction), so what is pinned instead is that a stack never
// carries rolled identity and an affixed row is never a stack. Both are
// table-level; neither is reachable by a caller getting it right.
test('SOMET-498: the schema refuses a stacked row with rolled identity, and refuses stacking an affixed row', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  t.after(async () => { await cleanup(pool, fx); await pool.end().catch(() => {}); });

  fx = await fixture(pool, 'stackrule');
  const typeId = await ownType(pool, fx, 'stackrule');

  await assert.rejects(
    () => pool.query(
      `INSERT INTO player_items (character_id, item_type_id, quantity, rarity, item_level)
       VALUES ($1, $2, 5, 'foxy', 88)`,
      [fx.characterId, typeId],
    ),
    /player_items_stack_is_plain_check/,
    'a stack must not be allowed to carry a rarity or an item level',
  );

  // A WHITE, level-1 affixed row: the plain-stack CHECK cannot fire on it, so
  // this isolates the composite foreign key.
  const plain = await pool.query(
    `INSERT INTO player_items (character_id, item_type_id, quantity, rarity, item_level)
     VALUES ($1, $2, 1, 'white', 1) RETURNING id`,
    [fx.characterId, typeId],
  );
  const affixTypeId = (await pool.query('SELECT id FROM affix_types ORDER BY id LIMIT 1')).rows[0].id;
  await pool.query(
    'INSERT INTO player_item_affixes (player_item_id, idx, affix_type_id, value) VALUES ($1,0,$2,3.13)',
    [plain.rows[0].id, affixTypeId],
  );
  await assert.rejects(
    () => pool.query('UPDATE player_items SET quantity = 5 WHERE id = $1', [plain.rows[0].id]),
    /player_item_affixes_host_is_single/,
    'an affixed instance must not be turnable into a stack',
  );

  // ...and the same rule from the other side: an affix cannot be attached to a
  // row that is already a stack.
  const stack = await pool.query(
    `INSERT INTO player_items (character_id, item_type_id, quantity) VALUES ($1, $2, 5) RETURNING id`,
    [fx.characterId, typeId],
  );
  await assert.rejects(
    () => pool.query(
      'INSERT INTO player_item_affixes (player_item_id, idx, affix_type_id, value) VALUES ($1,0,$2,3.13)',
      [stack.rows[0].id, affixTypeId],
    ),
    /player_item_affixes_host_is_single/,
    'a stack must not be affixable',
  );
});

// ---------------------------------------------------------------- AC3

test('SOMET-498 AC3: soulbound survives the round trip unchanged, and a bound item is not laundered', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  t.after(async () => { await cleanup(pool, fx); await pool.end().catch(() => {}); });

  fx = await fixture(pool, 'bound');
  const typeId = await ownType(pool, fx, 'bound');
  const it = await pool.query(
    `INSERT INTO player_items (character_id, item_type_id, quantity, soulbound, rarity, item_level)
     VALUES ($1, $2, 1, true, 'blue', 12) RETURNING id`,
    [fx.characterId, typeId],
  );
  const itemId = it.rows[0].id;
  const { entry, p } = await armEntry(pool, fx);
  carry(p, itemId, typeId);

  const dep = await depositItem(pool, entry, String(fx.userId), fx.characterId, itemId);
  assert.strictEqual(dep.ok, true, `storing a bound item is allowed (got: ${dep.reason})`);
  assert.strictEqual(dep.stored.soulbound, true, 'the chest row must keep the flag');

  const wd = await withdrawItem(pool, entry, String(fx.userId), fx.characterId, dep.stored.id);
  assert.strictEqual(wd.ok, true, wd.reason);
  // On the WIRE (SOMET-316): the panel must still show `bound`.
  assert.strictEqual(wd.item.soulbound, true, 'the withdrawn item must still be bound on the wire');
  // And in the ROW, which is what trade.js's sellItem actually reads. If the
  // round trip cleared it, SOMET-277's gold faucet reopens through the chest.
  const row = await pool.query('SELECT soulbound FROM player_items WHERE id = $1', [itemId]);
  assert.strictEqual(row.rows[0].soulbound, true, 'and bound in the row the sale guard reads');
  // The rest of the identity is unchanged too -- soulbound is not the only
  // thing that has to survive a bound item's trip.
  assert.strictEqual(wd.item.rarity, 'blue');
  assert.strictEqual(wd.item.itemLevel, 12);
});

test('SOMET-498: an unbound item is not INVENTED bound by the round trip', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  t.after(async () => { await cleanup(pool, fx); await pool.end().catch(() => {}); });

  fx = await fixture(pool, 'unbound');
  const typeId = await ownType(pool, fx, 'unbound');
  const { itemId } = await affixedItem(pool, fx, typeId);
  const { entry, p } = await armEntry(pool, fx);
  carry(p, itemId, typeId);

  const dep = await depositItem(pool, entry, String(fx.userId), fx.characterId, itemId);
  assert.strictEqual(dep.ok, true, dep.reason);
  assert.strictEqual(dep.stored.soulbound, false);
  const wd = await withdrawItem(pool, entry, String(fx.userId), fx.characterId, dep.stored.id);
  assert.strictEqual(wd.ok, true, wd.reason);
  assert.strictEqual(wd.item.soulbound, false, 'the flag is carried, never defaulted in either direction');
});

// ---------------------------------------------------------------- AC4

test('SOMET-498 AC4: deleting the base type takes the chest row AND the instance it held, leaving nothing ownerless', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  t.after(async () => { await cleanup(pool, fx); await pool.end().catch(() => {}); });

  fx = await fixture(pool, 'typegone');
  const typeId = await ownType(pool, fx, 'typegone');
  const { itemId } = await affixedItem(pool, fx, typeId);
  const { entry, p } = await armEntry(pool, fx);
  carry(p, itemId, typeId);

  const dep = await depositItem(pool, entry, String(fx.userId), fx.characterId, itemId);
  assert.strictEqual(dep.ok, true, dep.reason);
  const accountItemId = dep.stored.id;

  await pool.query('DELETE FROM item_types WHERE id = $1', [typeId]);
  fx.itemTypeId = null;

  const chestRow = await pool.query('SELECT count(*)::int AS n FROM account_items WHERE id = $1', [accountItemId]);
  assert.strictEqual(chestRow.rows[0].n, 0, 'the chest row must go with its item type');
  assert.strictEqual(await holderOf(pool, itemId), null, 'the held instance must not survive as an orphan');
  const aff = await pool.query(
    'SELECT count(*)::int AS n FROM player_item_affixes WHERE player_item_id = $1', [itemId],
  );
  assert.strictEqual(aff.rows[0].n, 0, 'and neither must its affix rows');

  const wd = await withdrawItem(pool, entry, String(fx.userId), fx.characterId, accountItemId);
  assert.strictEqual(wd.ok, false, 'the withdrawal must be refused, not throw and not half-succeed');
  assert.match(wd.reason, /not in your chest/);
  const made = await pool.query(
    'SELECT count(*)::int AS n FROM player_items WHERE character_id = $1', [fx.characterId],
  );
  assert.strictEqual(made.rows[0].n, 0, 'a refused withdrawal must mint no instance');
});

// The self-cleaning half of the design: `account_items.user_id -> users ON
// DELETE CASCADE` is a deletion path no code site can hook, and it is exactly
// why the pointer is on player_items instead of on account_items.
test('SOMET-498: deleting the ACCOUNT takes its stored instances with it', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  t.after(async () => { await cleanup(pool, fx); await pool.end().catch(() => {}); });

  fx = await fixture(pool, 'usergone');
  const typeId = await ownType(pool, fx, 'usergone');
  const { itemId } = await affixedItem(pool, fx, typeId);
  const { entry, p } = await armEntry(pool, fx);
  carry(p, itemId, typeId);
  const dep = await depositItem(pool, entry, String(fx.userId), fx.characterId, itemId);
  assert.strictEqual(dep.ok, true, dep.reason);

  await pool.query('DELETE FROM users WHERE id = $1', [fx.userId]);

  assert.strictEqual(await holderOf(pool, itemId), null,
    'a deleted account must not leave an instance held by a chest row that no longer exists');
  const aff = await pool.query(
    'SELECT count(*)::int AS n FROM player_item_affixes WHERE player_item_id = $1', [itemId],
  );
  assert.strictEqual(aff.rows[0].n, 0);
});

// A stored instance belongs to NO character, so deleting the character that
// deposited it must not reach it -- the chest is the account's, not the
// character's, and that is the whole point of the feature.
test('SOMET-498: a stored instance outlives the character that deposited it', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  t.after(async () => { await cleanup(pool, fx); await pool.end().catch(() => {}); });

  fx = await fixture(pool, 'charGone');
  const typeId = await ownType(pool, fx, 'charGone');
  const { itemId } = await affixedItem(pool, fx, typeId);
  const before = await affixRows(pool, itemId);
  const { entry, p } = await armEntry(pool, fx);
  carry(p, itemId, typeId);
  const dep = await depositItem(pool, entry, String(fx.userId), fx.characterId, itemId);
  assert.strictEqual(dep.ok, true, dep.reason);

  await pool.query('DELETE FROM characters WHERE id = $1', [fx.characterId]);

  const still = await holderOf(pool, itemId);
  assert.deepStrictEqual(still, {
    character_id: null, merchant_stock_id: null, account_item_id: dep.stored.id,
  }, 'deleting the depositing character must not take the stored item');
  assert.deepStrictEqual(await affixRows(pool, itemId), before, 'and its rolls must be intact');

  // A second character on the same account can still take it out.
  const c2 = await pool.query(
    `INSERT INTO characters (user_id, slot, name, entity_type_id)
     SELECT $1, 2, $2, e.id FROM entity_types e WHERE e.is_playable = true
      ORDER BY e.id LIMIT 1 RETURNING id`,
    [fx.userId, uniq('s498-char2')],
  );
  fx.characterId2 = c2.rows[0].id;
  const { entry: e2 } = await armEntry(pool, fx, fx.characterId2);
  const wd = await withdrawItem(pool, e2, String(fx.userId), fx.characterId2, dep.stored.id);
  assert.strictEqual(wd.ok, true, `the account must still be able to reclaim it (got: ${wd.reason})`);
  assert.strictEqual(wd.item.id, itemId);
  assert.deepStrictEqual(await affixRows(pool, itemId), before, 'with the same rolls');
});

// ---------------------------------------------------------------- AC5

test('SOMET-498 AC5: an instance can never be held by two holders at once, and never by none -- as a table CHECK', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  t.after(async () => { await cleanup(pool, fx); await pool.end().catch(() => {}); });

  fx = await fixture(pool, 'holder');
  const typeId = await ownType(pool, fx, 'holder');
  const ai = await pool.query(
    `INSERT INTO account_items (user_id, slot, item_type_id, quantity)
     VALUES ($1, 1, $2, 1) RETURNING id`,
    [fx.userId, typeId],
  );
  const accountItemId = ai.rows[0].id;

  // Character AND chest.
  await assert.rejects(
    () => pool.query(
      `INSERT INTO player_items (character_id, item_type_id, quantity, account_item_id)
       VALUES ($1, $2, 1, $3)`,
      [fx.characterId, typeId, accountItemId],
    ),
    /player_items_one_holder_check/,
    'an item held by the chest must not also be held by a character',
  );

  // Merchant AND chest. A three-way `<>` chain would ALLOW all-three-set, which
  // is why the constraint counts non-nulls instead.
  const v = await pool.query(
    `INSERT INTO villages (world_id, min_row, min_col, width, height, gate_edge, spawn_x, spawn_y)
     VALUES ($1, 1, 1, 8, 8, 'N', 100, 100) RETURNING id`,
    [fx.worldId],
  );
  const ms = await pool.query(
    `INSERT INTO merchant_stock (world_id, village_id, item_type_id, price)
     VALUES ($1, $2, $3, 10) RETURNING id`,
    [fx.worldId, v.rows[0].id, typeId],
  );
  await assert.rejects(
    () => pool.query(
      `INSERT INTO player_items (item_type_id, quantity, merchant_stock_id, account_item_id)
       VALUES ($1, 1, $2, $3)`,
      [typeId, ms.rows[0].id, accountItemId],
    ),
    /player_items_one_holder_check/,
    'an item held by the chest must not also be on a merchant shelf',
  );
  await assert.rejects(
    () => pool.query(
      `INSERT INTO player_items (character_id, item_type_id, quantity, merchant_stock_id, account_item_id)
       VALUES ($1, $2, 1, $3, $4)`,
      [fx.characterId, typeId, ms.rows[0].id, accountItemId],
    ),
    /player_items_one_holder_check/,
    'all three holders at once must be rejected -- the case an XOR chain would admit',
  );

  // And no holder at all.
  await assert.rejects(
    () => pool.query('INSERT INTO player_items (item_type_id, quantity) VALUES ($1, 1)', [typeId]),
    /player_items_one_holder_check/,
    'an ownerless instance must be unrepresentable',
  );

  // One chest slot holds at most ONE instance.
  await pool.query(
    `INSERT INTO player_items (item_type_id, quantity, account_item_id) VALUES ($1, 1, $2)`,
    [typeId, accountItemId],
  );
  await assert.rejects(
    () => pool.query(
      `INSERT INTO player_items (item_type_id, quantity, account_item_id) VALUES ($1, 1, $2)`,
      [typeId, accountItemId],
    ),
    /player_items_account_item_unique/,
    'a chest slot must not be able to hold two instances',
  );

  await pool.query('DELETE FROM merchant_stock WHERE id = $1', [ms.rows[0].id]).catch(() => {});
  await pool.query('DELETE FROM villages WHERE world_id = $1', [fx.worldId]).catch(() => {});
});

// ------------------------------------------------- guards that rested on the DELETE

// Pre-498 the DELETE cascaded player_equipment away, so a missed case merely
// unequipped the character silently. An UPDATE cascades nothing: without this
// refusal a paper-doll row would point at an item sitting in the chest, worn by
// a character who does not own it.
test('SOMET-498: an EQUIPPED item is refused, and the paper-doll row survives', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  t.after(async () => { await cleanup(pool, fx); await pool.end().catch(() => {}); });

  fx = await fixture(pool, 'equipped');
  const typeId = await ownType(pool, fx, 'equipped');
  const { itemId } = await affixedItem(pool, fx, typeId);
  await pool.query(
    'INSERT INTO player_equipment (character_id, slot, item_id) VALUES ($1, $2, $3)',
    [fx.characterId, 'chest', itemId],
  );
  const { entry, p } = await armEntry(pool, fx);
  carry(p, itemId, typeId);

  const dep = await depositItem(pool, entry, String(fx.userId), fx.characterId, itemId);
  assert.strictEqual(dep.ok, false, 'an equipped item must be refused');
  assert.strictEqual(dep.reason, 'unequip it first');

  assert.deepStrictEqual(await holderOf(pool, itemId), {
    character_id: fx.characterId, merchant_stock_id: null, account_item_id: null,
  }, 'the refused item must still belong to its character');
  const eq = await pool.query(
    'SELECT count(*)::int AS n FROM player_equipment WHERE item_id = $1', [itemId],
  );
  assert.strictEqual(eq.rows[0].n, 1, 'and must still be equipped -- nothing cascades it away now');
  assert.deepStrictEqual((await fetchChest(pool, fx.userId)).items, [],
    'a refused deposit must create no chest row');
  assert.strictEqual(p.inv.items.some((i) => i.id === itemId), true,
    'and must not be dropped from the live inventory');
});

// Pre-498 stone_instances.socketed_into_id ON DELETE SET NULL popped the stone
// out when the host was deleted, so this refusal was tidiness. An UPDATE fires
// no SET NULL, so it is now the only thing stopping a stone from staying
// socketed into a weapon that lives in the bank.
test('SOMET-498: a SOCKETED weapon is refused, and the socket is left intact', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  t.after(async () => { await cleanup(pool, fx); await pool.end().catch(() => {}); });

  fx = await fixture(pool, 'socketed');
  const typeId = await ownType(pool, fx, 'socketed');
  const { itemId: hostId } = await affixedItem(pool, fx, typeId);
  const stone = await pool.query(
    `INSERT INTO player_items (character_id, item_type_id, quantity) VALUES ($1, $2, 1) RETURNING id`,
    [fx.characterId, typeId],
  );
  const stoneId = stone.rows[0].id;
  await pool.query(
    'INSERT INTO stone_instances (player_item_id, socketed_into_id) VALUES ($1, $2)',
    [stoneId, hostId],
  );
  const { entry, p } = await armEntry(pool, fx);
  carry(p, hostId, typeId);
  carry(p, stoneId, typeId);

  const dep = await depositItem(pool, entry, String(fx.userId), fx.characterId, hostId);
  assert.strictEqual(dep.ok, false, 'a socketed host must be refused');
  assert.strictEqual(dep.reason, 'unsocket the stone first');
  assert.deepStrictEqual(await holderOf(pool, hostId), {
    character_id: fx.characterId, merchant_stock_id: null, account_item_id: null,
  });
  const si = await pool.query(
    'SELECT socketed_into_id FROM stone_instances WHERE player_item_id = $1', [stoneId],
  );
  assert.strictEqual(si.rows[0].socketed_into_id, hostId,
    'the socket must be untouched -- nothing pops the stone out any more');

  // And the stone itself is refused too, so its stone_instances row can never
  // end up in the chest by the other door.
  const depStone = await depositItem(pool, entry, String(fx.userId), fx.characterId, stoneId);
  assert.strictEqual(depStone.ok, false);
  assert.strictEqual(depStone.reason, 'stones cannot be stored');
  assert.deepStrictEqual((await fetchChest(pool, fx.userId)).items, []);
});

// ---------------------------------------------------------------- container/instance agreement

// mapAccountItem reads the CONTAINER's columns while the instance is the source
// of truth for everything else. That is only safe because deposit writes them
// from the instance and nothing ever updates them -- so it is asserted, not
// assumed. It is also what the 1714440513000 down() reverts the schema by.
test('SOMET-498: chest rows mirror the instance they hold', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  t.after(async () => { await cleanup(pool, fx); await pool.end().catch(() => {}); });

  fx = await fixture(pool, 'mirror');
  const typeId = await ownType(pool, fx, 'mirror');
  const it = await pool.query(
    `INSERT INTO player_items (character_id, item_type_id, quantity, soulbound)
     VALUES ($1, $2, 9, true) RETURNING id`,
    [fx.characterId, typeId],
  );
  const { entry, p } = await armEntry(pool, fx);
  carry(p, it.rows[0].id, typeId, 9);
  const dep = await depositItem(pool, entry, String(fx.userId), fx.characterId, it.rows[0].id);
  assert.strictEqual(dep.ok, true, dep.reason);

  const pair = await pool.query(
    `SELECT a.item_type_id AS a_type, a.quantity AS a_qty, a.soulbound AS a_sb,
            pi.item_type_id AS p_type, pi.quantity AS p_qty, pi.soulbound AS p_sb
       FROM account_items a JOIN player_items pi ON pi.account_item_id = a.id
      WHERE a.id = $1`,
    [dep.stored.id],
  );
  assert.strictEqual(pair.rowCount, 1, 'every chest row must hold exactly one instance');
  const r = pair.rows[0];
  assert.deepStrictEqual(
    { type: r.a_type, qty: Number(r.a_qty), sb: r.a_sb },
    { type: r.p_type, qty: Number(r.p_qty), sb: r.p_sb },
    'the container columns must mirror the instance exactly',
  );
});

// A chest row holding no instance is unreachable after the 1714440513000
// backfill. withdrawItem REFUSES it rather than minting a white replacement
// from item_type_id -- which is precisely the pre-498 bug -- and the ROLLBACK
// leaves the container intact so nothing is lost.
test('SOMET-498: an instance-less chest row is refused, never rebuilt from the type', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  t.after(async () => { await cleanup(pool, fx); await pool.end().catch(() => {}); });

  fx = await fixture(pool, 'noinstance');
  const typeId = await ownType(pool, fx, 'noinstance');
  const ai = await pool.query(
    `INSERT INTO account_items (user_id, slot, item_type_id, quantity, soulbound)
     VALUES ($1, 1, $2, 1, false) RETURNING id`,
    [fx.userId, typeId],
  );
  const { entry, p } = await armEntry(pool, fx);

  const wd = await withdrawItem(pool, entry, String(fx.userId), fx.characterId, ai.rows[0].id);
  assert.strictEqual(wd.ok, false, 'an instance-less chest row must not mint a replacement');
  assert.match(wd.reason, /cannot be withdrawn/);
  const still = await pool.query('SELECT count(*)::int AS n FROM account_items WHERE id = $1', [ai.rows[0].id]);
  assert.strictEqual(still.rows[0].n, 1, 'and the container must survive the refusal');
  const made = await pool.query(
    'SELECT count(*)::int AS n FROM player_items WHERE character_id = $1', [fx.characterId],
  );
  assert.strictEqual(made.rows[0].n, 0, 'with no instance conjured on the way out');
  assert.deepStrictEqual(p.inv.items, [], 'and nothing pushed into the live inventory');
});

// Another account naming the row id directly. The user_id predicate is the
// authorization, not a listing filter -- and a refusal must not cascade the
// held instance away.
test('SOMET-498: another account cannot withdraw a stored instance', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  let other = null;
  t.after(async () => {
    await cleanup(pool, fx);
    await cleanup(pool, other);
    await pool.end().catch(() => {});
  });

  fx = await fixture(pool, 'victim');
  other = await fixture(pool, 'thief');
  const typeId = await ownType(pool, fx, 'victim');
  const { itemId } = await affixedItem(pool, fx, typeId);
  const before = await affixRows(pool, itemId);
  const { entry, p } = await armEntry(pool, fx);
  carry(p, itemId, typeId);
  const dep = await depositItem(pool, entry, String(fx.userId), fx.characterId, itemId);
  assert.strictEqual(dep.ok, true, dep.reason);

  const { entry: thiefEntry } = await armEntry(pool, other);
  const wd = await withdrawItem(
    pool, thiefEntry, String(other.userId), other.characterId, dep.stored.id,
  );
  assert.strictEqual(wd.ok, false, 'a second account must not be able to take it');
  assert.match(wd.reason, /not in your chest/);
  assert.deepStrictEqual(await holderOf(pool, itemId), {
    character_id: null, merchant_stock_id: null, account_item_id: dep.stored.id,
  }, 'the item must still be in its owner chest');
  assert.deepStrictEqual(await affixRows(pool, itemId), before, 'with its rolls intact');
  assert.deepStrictEqual((await fetchChest(pool, other.userId)).items, [],
    'and it must not appear in the other account chest');
});
