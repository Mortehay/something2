const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { loadItemTypes, grantStartingLoadout } = require('../src/authority/items.js');
const { sellItem } = require('../src/authority/trade.js');
const { dropItem, claimItem } = require('../src/authority/loot.js');

// SOMET-277 (P0) regression suite, against a REAL database.
//
// The faucet: the starting loadout is granted once per CHARACTER, but gold
// lives on the ACCOUNT (users.gold). Create a Warrior, sell the granted short
// sword + leather vest for +24, DELETE the character, create another, repeat.
// characters.starting_loadout_granted_at cannot see this -- it is destroyed
// along with the character while the gold survives.
//
// The fix marks the granted INSTANCES soulbound and refuses to turn them back
// into gold. The half of this suite that actually proves the fix is right (as
// opposed to merely present) is the LOOTED TWIN: a second player_items row of
// the SAME item_type_id, owned by the same character, differing ONLY in
// soulbound. It must still sell for full price. A blunt per-type ban (zeroing
// item_types.value, or refusing to sell item type 10) would pass every
// "granted item cannot be sold" assertion here and fail that one -- which is
// exactly why a mocked pool cannot stand in for this file: a mock decides for
// itself what `soulbound` a row has, so it can only ever confirm that the code
// reads the field it was told to read, never that the DB, the grant and the
// sell path agree about which physical row is bound.
//
// Skip-if-unreachable discipline matches authority_items_loadout_db.test.js.
const DB_URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://user:password@localhost:15432/game_db';

async function openPool() {
  const pool = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 2000, max: 4 });
  try {
    await pool.query('SELECT 1');
  } catch (err) {
    await pool.end().catch(() => {});
    return { unreachable: `NO DATABASE at ${DB_URL} (${err.message})` };
  }
  // Deliberately an ASSERTION, not a skip gate (the neighbouring db suites use
  // a skip here). Those gate on migrations that landed in OTHER branches, so
  // "not applied yet" is a legitimate state for them. 1714440174000 ships in
  // the same change as the code under test: a database that answers SELECT 1
  // but has no soulbound column means this fix is half-deployed, and reporting
  // that as "unverified" would hide the one condition that makes the guard
  // silently inert.
  const col = await pool.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_name = 'player_items' AND column_name = 'soulbound'`,
  );
  assert.equal(col.rowCount, 1,
    'player_items.soulbound is missing -- apply migration 1714440174000_soulbound_items.js');
  return pool;
}

function skipMsg(what, reason) {
  return `${reason} — ${what} is UNVERIFIED on this run`;
}

// A village and its world, needed for real FKs: sellItem writes a buyback row
// into merchant_stock, whose world_id/village_id both reference real tables.
async function anyVillage(pool) {
  const r = await pool.query('SELECT id, world_id FROM villages LIMIT 1');
  return r.rowCount ? { villageId: r.rows[0].id, worldId: r.rows[0].world_id } : null;
}

async function createFixture(pool, tag, className = 'Warrior') {
  const username = `soulbound-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const u = await pool.query(
    "INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'player') RETURNING id, gold",
    [username],
  );
  const userId = u.rows[0].id;
  const c = await pool.query(
    `INSERT INTO characters (user_id, slot, name, entity_type_id)
     SELECT $1, 1, $2, e.id FROM entity_types e WHERE e.name = $3
     RETURNING id, entity_type_id`,
    [userId, `soulbound-char-${tag}-${process.pid}-${Date.now()}`, className],
  );
  assert.equal(c.rowCount, 1, `no ${className} entity type to build a fixture character from`);
  return { userId, gold: Number(u.rows[0].gold) || 0, character: { id: c.rows[0].id, entityTypeId: c.rows[0].entity_type_id } };
}

async function cleanup(pool, userId) {
  // Only rows this test created, and only via the user it created. Never a
  // catalog table.
  await pool.query('DELETE FROM merchant_stock WHERE seller_user_id = $1', [userId]).catch(() => {});
  await pool.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
}

// The granted instance worth the most gold (the short sword, for a Warrior),
// read out of the catalog rather than hardcoded so this states "the valuable
// piece of the class's loadout" instead of "item type 10".
async function grantedSellable(pool, characterId) {
  const r = await pool.query(
    `SELECT pi.id, pi.item_type_id, pi.soulbound, it.value
       FROM player_items pi JOIN item_types it ON it.id = pi.item_type_id
      WHERE pi.character_id = $1 AND pi.quantity = 1 AND it.value > 0
      ORDER BY it.value DESC, pi.id ASC LIMIT 1`,
    [characterId],
  );
  assert.equal(r.rowCount, 1, 'the class loadout granted no single-quantity item with a value');
  return r.rows[0];
}

// The control instance: same character, same item_type_id, acquired the way a
// creature drop or a merchant purchase acquires one -- a plain INSERT that
// names no soulbound, so it takes the column default.
async function lootedTwin(pool, characterId, itemTypeId) {
  const r = await pool.query(
    'INSERT INTO player_items (character_id, item_type_id, quantity) VALUES ($1, $2, 1) RETURNING id, soulbound',
    [characterId, itemTypeId],
  );
  assert.equal(r.rows[0].soulbound, false, 'a normally-acquired instance must default to NOT soulbound');
  return r.rows[0];
}

function mkPlayer(userId, items) {
  return {
    userId, gold: 0, x: 100, y: 100, width: 64, height: 64,
    inv: { items, equipment: {} },
    stats: { priceMult: 0.5 },
    dropGrace: new Map(),
  };
}

// `claiming` and groundItems.remove exist because SOMET-480 makes the bound
// item DROPPABLE, so this file now also drives the pickup half of the round
// trip through the real claimItem.
function mkEntry(worldId, player) {
  return {
    worldId,
    claiming: new Set(),
    world: {
      getPlayer: () => player,
      // `weapons` is the catalog claimItem's capacity pre-check passes to
      // hasFreeSlot; an empty Map means "no row is currency", which is right
      // for the two gear instances this file creates.
      weapons: new Map(),
      groundItems: { add: () => {}, remove: () => {} },
    },
  };
}

async function goldOf(pool, userId) {
  const r = await pool.query('SELECT gold FROM users WHERE id = $1', [userId]);
  return Number(r.rows[0].gold) || 0;
}

async function itemExists(pool, itemId) {
  const r = await pool.query('SELECT 1 FROM player_items WHERE id = $1', [itemId]);
  return r.rowCount === 1;
}

// SOMET-484: a sale no longer DESTROYS the instance, it hands it to the
// merchant (player_items.merchant_stock_id). "The seller no longer has it" is
// therefore the question this file actually cares about, and itemExists can no
// longer answer it -- after a successful sale the row is still there, owned by
// nobody. Asserting itemExists === false would now fail on a correct sale;
// asserting itemExists === true would pass on a REFUSED one too, and the
// refusal case above is the whole point of the test, so the two need different
// questions.
async function ownedByCharacter(pool, itemId, characterId) {
  const r = await pool.query(
    'SELECT 1 FROM player_items WHERE id = $1 AND character_id = $2', [itemId, characterId],
  );
  return r.rowCount === 1;
}

test('SOMET-277: a GRANTED starting-loadout instance cannot be sold, and the identical LOOTED instance can', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = skipMsg('the SOMET-277 gold-faucet fix', pool.unreachable);
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  const village = await anyVillage(pool);
  if (!village) {
    await pool.end();
    const msg = skipMsg('the SOMET-277 gold-faucet fix', 'NO VILLAGE rows to sell against');
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }

  let userId = null;
  try {
    const fx = await createFixture(pool, 'sell');
    userId = fx.userId;
    const itemTypes = await loadItemTypes(pool);

    assert.equal(await grantStartingLoadout(pool, fx.character, itemTypes), true, 'grant must succeed');

    const granted = await grantedSellable(pool, fx.character.id);
    assert.equal(granted.soulbound, true,
      'grantStartingLoadout must mark the instances it creates soulbound -- without this the guard has nothing to refuse');
    const looted = await lootedTwin(pool, fx.character.id, granted.item_type_id);

    const items = [
      { id: granted.id, typeId: granted.item_type_id, quantity: 1 },
      { id: looted.id, typeId: granted.item_type_id, quantity: 1 },
    ];
    const player = mkPlayer(fx.userId, items);
    const entry = mkEntry(village.worldId, player);
    const goldBefore = await goldOf(pool, fx.userId);

    // --- the faucet itself: the granted instance must not become gold ---
    const refused = await sellItem(pool, entry, fx.userId, fx.character.id, village.villageId, granted.id);
    assert.equal(refused.ok, false, 'selling granted starting gear must be refused');
    assert.match(refused.reason, /cannot be sold/i, 'the refusal must be a clear, player-readable reason');
    assert.equal(await goldOf(pool, fx.userId), goldBefore, 'no gold may be credited for a refused sale');
    assert.strictEqual(await ownedByCharacter(pool, granted.id, fx.character.id), true,
      'the refusal must ROLL BACK -- the seller must still OWN the item, not merely have a row somewhere');
    assert.ok(player.inv.items.some((it) => it.id === granted.id), 'in-memory inventory keeps the item too');

    // --- the control: same item TYPE, same character, unbound instance ---
    const sold = await sellItem(pool, entry, fx.userId, fx.character.id, village.villageId, looted.id);
    assert.equal(sold.ok, true,
      `an ordinary instance of the SAME item type must still sell (got: ${sold.reason}) -- `
      + 'a per-TYPE ban would make every looted copy worthless');
    assert.ok(sold.price > 0, 'the looted twin must pay its normal price, not zero');
    assert.equal(await goldOf(pool, fx.userId), goldBefore + sold.price, 'the legitimate sale is credited');
    assert.strictEqual(await ownedByCharacter(pool, looted.id, fx.character.id), false,
      'the seller must no longer own the sold instance');
    assert.strictEqual(await itemExists(pool, looted.id), true,
      'SOMET-484: and it must still EXIST -- the merchant is holding it, so buying it back returns it intact');
  } finally {
    if (userId != null) await cleanup(pool, userId);
    await pool.end();
  }
});

test('SOMET-277/SOMET-480: a GRANTED instance survives a drop-and-repick still BOUND', async (t) => {
  // SOMET-277 closed this hole by REFUSING the drop outright, and its own
  // comment said why that was the shape chosen: "world_items carries no
  // soulbound column ... claimItem then INSERTs a BRAND NEW player_items row
  // which takes the default false. Drop, pick back up, sell -- the whole
  // faucet, reopened in two keystrokes."
  //
  // SOMET-480 (T12) adds world_items.soulbound, so the flag now RIDES the
  // ground row and the drop no longer has to be refused. The invariant is
  // unchanged and is what this test asserts: a granted instance can never
  // become a sellable one. Only the mechanism moved -- from a refusal to a
  // carried flag -- and the item became droppable, which it should always
  // have been.
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = skipMsg('the SOMET-277 drop guard', pool.unreachable);
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  const village = await anyVillage(pool);
  if (!village) {
    await pool.end();
    const msg = skipMsg('the SOMET-277 drop guard', 'NO WORLD rows to drop into');
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }

  let userId = null;
  let groundItemId = null;
  try {
    const fx = await createFixture(pool, 'drop');
    userId = fx.userId;
    const itemTypes = await loadItemTypes(pool);
    assert.equal(await grantStartingLoadout(pool, fx.character, itemTypes), true, 'grant must succeed');

    const granted = await grantedSellable(pool, fx.character.id);
    const looted = await lootedTwin(pool, fx.character.id, granted.item_type_id);
    const items = [
      { id: granted.id, typeId: granted.item_type_id, quantity: 1 },
      { id: looted.id, typeId: granted.item_type_id, quantity: 1 },
    ];
    const player = mkPlayer(fx.userId, items);
    const entry = mkEntry(village.worldId, player);

    const droppedBound = await dropItem(pool, entry, fx.userId, fx.character.id, granted.id, { ttlMs: 60000 });
    assert.equal(droppedBound.ok, true,
      `granted gear is now droppable, not refused (got: ${droppedBound.reason})`);
    groundItemId = droppedBound.item.id;
    const ground = await pool.query('SELECT soulbound FROM world_items WHERE id = $1', [groundItemId]);
    assert.equal(ground.rows[0].soulbound, true,
      'the ground row must carry the flag -- without it the drop IS the laundering exploit');

    // THE INVARIANT: picked back up, it is still bound, so it still cannot be
    // sold. Asserting the flag alone would not prove that; asserting the
    // refusal is what makes this test about the exploit rather than a column.
    const back = await claimItem(pool, entry, fx.userId, fx.character.id, groundItemId);
    assert.ok(back && back.id, 'the dropped bound item must be re-claimable');
    groundItemId = null; // consumed by the claim
    const reBound = await pool.query('SELECT soulbound FROM player_items WHERE id = $1', [back.id]);
    assert.equal(reBound.rows[0].soulbound, true,
      'drop-then-pick-up must NOT launder a bound instance into an unbound one');
    const resold = await sellItem(pool, entry, fx.userId, fx.character.id, village.villageId, back.id);
    assert.equal(resold.ok, false, 'the laundered instance must still refuse to become gold');
    assert.match(resold.reason, /cannot be sold/i);

    const dropped = await dropItem(pool, entry, fx.userId, fx.character.id, looted.id, { ttlMs: 60000 });
    assert.equal(dropped.ok, true,
      `an ordinary instance of the SAME item type must still be droppable (got: ${dropped.reason})`);
    groundItemId = dropped.item.id;
    assert.equal(await itemExists(pool, looted.id), false, 'the dropped instance left the inventory');
  } finally {
    if (groundItemId != null) await pool.query('DELETE FROM world_items WHERE id = $1', [groundItemId]).catch(() => {});
    if (userId != null) await cleanup(pool, userId);
    await pool.end();
  }
});
