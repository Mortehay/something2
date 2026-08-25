// SOMET-480 (progression epic T12). The WIRING test.
//
// The pure roller in affixes.test.js proves nothing about whether an affix
// ever reaches the database or survives a drop. D1, D2 and C2 each shipped a
// feature that was completely inert while every unit test stayed green -- a
// column missing from an explicit SELECT list, equippability proven only
// through a pure function. So everything here goes through the REAL path:
// roll with the real roller, persist, drop through dropItem, and pick back up
// through claimItem.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { World } = require('../src/authority/world.js');
const { loadItemTypes, loadInventory } = require('../src/authority/items.js');
const { dropItem, claimItem } = require('../src/authority/loot.js');
const { rollItemInstance } = require('../src/authority/affixes.js');

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

// Every fixture row is created by THIS test and torn down by THIS test. Nothing
// here touches a pre-existing user, character or world.
async function fixture(pool, tag) {
  const u = await pool.query(
    `INSERT INTO users (username, password_hash, role)
     VALUES ($1, 'x', 'player') RETURNING id`,
    [uniq(`affix-${tag}`)],
  );
  const userId = u.rows[0].id;
  const c = await pool.query(
    `INSERT INTO characters (user_id, slot, name, entity_type_id)
     SELECT $1, 1, $2, e.id FROM entity_types e WHERE e.is_playable = true
      ORDER BY e.id LIMIT 1 RETURNING id`,
    [userId, uniq(`affix-char-${tag}`)],
  );
  const w = await pool.query(
    `INSERT INTO worlds (name, width, height, chunk_size, seed)
     VALUES ($1, 64, 64, 16, 1) RETURNING id`,
    [uniq(`affix-world-${tag}`)],
  );
  const worldId = w.rows[0].id;
  // A merchant needs a village to trade at: trade.js scopes every stock row to
  // (world_id, village_id), which is the SOMET-199 fix and not something a
  // test may route around.
  const v = await pool.query(
    `INSERT INTO villages (world_id, min_row, min_col, width, height, gate_edge, spawn_x, spawn_y)
     VALUES ($1, 1, 1, 8, 8, 'N', 100, 100) RETURNING id`,
    [worldId],
  );
  return { userId, characterId: c.rows[0].id, worldId, villageId: v.rows[0].id };
}

async function cleanup(pool, fx) {
  if (!fx) return;
  await pool.query('DELETE FROM merchant_stock WHERE world_id = $1', [fx.worldId]).catch(() => {});
  await pool.query('DELETE FROM villages WHERE world_id = $1', [fx.worldId]).catch(() => {});
  await pool.query('DELETE FROM world_items WHERE world_id = $1', [fx.worldId]).catch(() => {});
  await pool.query('DELETE FROM player_items WHERE character_id = $1', [fx.characterId]).catch(() => {});
  await pool.query('DELETE FROM characters WHERE id = $1', [fx.characterId]).catch(() => {});
  await pool.query('DELETE FROM worlds WHERE id = $1', [fx.worldId]).catch(() => {});
  await pool.query('DELETE FROM users WHERE id = $1', [fx.userId]).catch(() => {});
}

// A world entry shaped the way server.js builds one, with a stub map: nothing
// in the drop/claim path reads terrain.
async function armEntry(pool, fx) {
  const itemTypes = await loadItemTypes(pool);
  const map = {
    chunkSize: 16, isWalkable: () => true, speedAt: () => 1, getChunk: () => [],
  };
  const world = new World(map, itemTypes, null, 16);
  const entry = { worldId: fx.worldId, world, claiming: new Set(), creatureTypeIds: new Map() };
  const inv = await loadInventory(pool, fx.characterId);
  world.addPlayer(String(fx.userId), { x: 100, y: 100 }, inv, { x: 100, y: 100 }, 0, undefined, fx.characterId);
  return { entry, itemTypes };
}

test('the rarity and affix schema exists with the specced shape', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  t.after(async () => { await cleanup(pool, fx); await pool.end().catch(() => {}); });

  const cols = await pool.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE (table_name = 'player_items' AND column_name IN ('rarity','item_level'))
         OR (table_name = 'world_items' AND column_name IN ('rarity','item_level','affixes','soulbound'))
      ORDER BY table_name, column_name`,
  );
  assert.deepStrictEqual(cols.rows.map((r) => `${r.table_name}.${r.column_name}`), [
    'player_items.item_level', 'player_items.rarity',
    'world_items.affixes', 'world_items.item_level', 'world_items.rarity', 'world_items.soulbound',
  ]);

  const tabs = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_name IN ('affix_types','player_item_affixes') ORDER BY table_name`,
  );
  assert.deepStrictEqual(tabs.rows.map((r) => r.table_name), ['affix_types', 'player_item_affixes']);

  // A real, owned instance, so the rejection can only come from the rarity
  // CHECK -- a NULL character_id would trip NOT NULL first and prove nothing.
  fx = await fixture(pool, 'schema');
  await assert.rejects(
    pool.query(
      `INSERT INTO player_items (character_id, item_type_id, rarity)
       SELECT $1, id, 'chartreuse' FROM item_types LIMIT 1`,
      [fx.characterId],
    ),
    /player_items_rarity_check/,
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO player_items (character_id, item_type_id, item_level)
       SELECT $1, id, 151 FROM item_types LIMIT 1`,
      [fx.characterId],
    ),
    /player_items_item_level_check/,
  );
  // The ground row's snapshot must be an ARRAY -- claimItem expands one, and a
  // scalar or object there would make the pickup throw at 20Hz.
  await assert.rejects(
    pool.query(
      `INSERT INTO world_items (world_id, item_type_id, x, y, expires_at, affixes)
       SELECT $1, id, 1, 1, now() + interval '1 minute', '{"a":1}'::jsonb FROM item_types LIMIT 1`,
      [fx.worldId],
    ),
    /world_items_affixes_array_check/,
  );
});

test('the starter affix catalog is seeded and every entry is usable', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  t.after(async () => { await pool.end().catch(() => {}); });

  const r = await pool.query(
    'SELECT key, kind, min_rarity, weight, min_value, max_value, effect FROM affix_types ORDER BY key',
  );
  assert.strictEqual(r.rows.length, 12);
  const debuffs = r.rows.filter((a) => a.kind === 'debuff');
  assert.strictEqual(debuffs.length, 1);
  for (const a of r.rows) {
    assert.ok(['blue', 'yellow', 'foxy'].includes(a.min_rarity), a.key);
    assert.ok(a.weight > 0, a.key);
    assert.ok(a.max_value >= a.min_value, a.key);
  }
  // A debuff authored below foxy is a row whose min_rarity lies about when it
  // can appear -- affixes.js refuses it at roll time, so it would be inert.
  for (const d of debuffs) assert.strictEqual(d.min_rarity, 'foxy', d.key);
  await assert.rejects(
    pool.query(
      `INSERT INTO affix_types (key, label, kind, effect, min_value, max_value, min_rarity)
       VALUES ($1, 'Leaky', 'debuff', '{"type":"status","status":"chill"}'::jsonb, 1, 2, 'blue')`,
      [uniq('leaky')],
    ),
    /affix_types_debuff_is_foxy_check/,
    'the schema must refuse a debuff authored below foxy',
  );
});

test('drop-and-repick round-trips rarity, item level, affixes AND soulbound', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  t.after(async () => { await cleanup(pool, fx); await pool.end().catch(() => {}); });

  fx = await fixture(pool, 'rt');
  const typeRow = await pool.query("SELECT id, slot FROM item_types WHERE name = 'crude-blade'");
  assert.strictEqual(typeRow.rowCount, 1, 'the T11 gear ladder must be seeded');
  const typeId = typeRow.rows[0].id;

  // THE REAL ROLLER, against the REAL catalog -- not a hand-built affix list.
  // A pool read here is what makes this a wiring test: if the catalog query or
  // the roller's column names drifted, `rolled.affixes` comes back empty and
  // every later assertion below is trivially satisfiable, so the length check
  // is asserted first.
  const poolRows = (await pool.query('SELECT * FROM affix_types ORDER BY id')).rows;
  const rolled = rollItemInstance(
    { itemType: { id: typeId, slot: typeRow.rows[0].slot }, itemLevel: 77, rarity: 'foxy', affixPool: poolRows },
    // 0.999 -> 9 wanted; the pool caps it. Then alternating pick/value rolls.
    (() => { const s = [0.999, 0.1, 0.37, 0.5, 0.61, 0.9, 0.23]; let i = 0; return () => s[(i += 1) % s.length]; })(),
  );
  assert.ok(rolled.affixes.length >= 3, `the roller produced ${rolled.affixes.length} affixes`);
  // A rolled value must not be binary-exact by luck; at least one carries real
  // decimals, which is what pins the double-precision column choice.
  assert.ok(rolled.affixes.some((a) => a.value !== Math.round(a.value)),
    'the fixture must include a fractional value, or the round trip proves nothing about precision');

  const item = await pool.query(
    `INSERT INTO player_items (character_id, item_type_id, quantity, rarity, item_level, soulbound)
     VALUES ($1,$2,1,$3,$4,true) RETURNING id`,
    [fx.characterId, typeId, rolled.rarity, rolled.itemLevel],
  );
  const itemId = item.rows[0].id;
  for (let i = 0; i < rolled.affixes.length; i += 1) {
    await pool.query(
      'INSERT INTO player_item_affixes (player_item_id, idx, affix_type_id, value) VALUES ($1,$2,$3,$4)',
      [itemId, i, rolled.affixes[i].affixTypeId, rolled.affixes[i].value],
    );
  }
  // The stored numbers must already equal the rolled ones -- a `real` column
  // silently loses two-decimal values here, before any drop happens.
  const stored = await pool.query(
    'SELECT idx, affix_type_id, value FROM player_item_affixes WHERE player_item_id = $1 ORDER BY idx', [itemId],
  );
  assert.deepStrictEqual(
    stored.rows.map((r) => ({ affixTypeId: r.affix_type_id, value: r.value })),
    rolled.affixes.map((a) => ({ affixTypeId: a.affixTypeId, value: a.value })),
    'the persisted value must be the rolled value, exactly',
  );

  const { entry } = await armEntry(pool, fx);

  // --- the real drop path -------------------------------------------------
  const dropped = await dropItem(pool, entry, String(fx.userId), fx.characterId, itemId, { ttlMs: 60000 });
  assert.strictEqual(dropped.ok, true, dropped.reason);

  const ground = await pool.query(
    'SELECT rarity, item_level, affixes, soulbound FROM world_items WHERE id = $1', [dropped.item.id],
  );
  assert.strictEqual(ground.rows[0].rarity, 'foxy');
  assert.strictEqual(ground.rows[0].item_level, 77);
  assert.strictEqual(ground.rows[0].soulbound, true,
    'soulbound must ride the ground row, or a bound item launders in two keystrokes');
  assert.deepStrictEqual(
    ground.rows[0].affixes,
    rolled.affixes.map((a) => ({ affixTypeId: a.affixTypeId, value: a.value })),
    'the ground snapshot must carry every affix, in order, with its exact value',
  );

  // --- the real pickup path ------------------------------------------------
  const got = await claimItem(pool, entry, String(fx.userId), fx.characterId, dropped.item.id);
  assert.ok(got && got.id, 'the item must be re-claimable');

  const back = await pool.query(
    'SELECT rarity, item_level, soulbound FROM player_items WHERE id = $1', [got.id],
  );
  assert.strictEqual(back.rows[0].rarity, 'foxy');
  assert.strictEqual(back.rows[0].item_level, 77);
  assert.strictEqual(back.rows[0].soulbound, true);

  const backAffixes = await pool.query(
    'SELECT idx, affix_type_id, value FROM player_item_affixes WHERE player_item_id = $1 ORDER BY idx',
    [got.id],
  );
  assert.deepStrictEqual(
    backAffixes.rows,
    rolled.affixes.map((a, i) => ({ idx: i, affix_type_id: a.affixTypeId, value: a.value })),
    'every affix must come back with its own index and its exact rolled value',
  );

  // The IN-MEMORY entry claimItem pushed must already carry the affixes, with
  // no reload. equipRequirements#gearStatGrants reads this object, not the
  // database, so an entry pushed bare would make a just-picked-up item grant
  // nothing until the player reconnects -- live in the schema, inert in play.
  const live = entry.world.getPlayer(String(fx.userId)).inv.items.find((it) => it.id === got.id);
  assert.ok(live, 'claimItem must push the reclaimed instance into the live inventory');
  assert.strictEqual(live.rarity, 'foxy');
  assert.strictEqual(live.itemLevel, 77);
  assert.strictEqual(live.soulbound, true);
  assert.deepStrictEqual(
    live.affixes.map((a) => ({ affixTypeId: a.affixTypeId, value: a.value })),
    rolled.affixes.map((a) => ({ affixTypeId: a.affixTypeId, value: a.value })),
    'the live inventory entry must carry the affixes, without a reload',
  );

  // And a stat affix on it actually moves the numbers gearStatGrants reports
  // -- the equip gate and the character sheet both read THAT one function.
  const { gearStatGrants } = require('../src/authority/equipRequirements.js');
  const statAffix = live.affixes.find((a) => a.effect && a.effect.type === 'stat');
  assert.ok(statAffix, 'the scripted roll must include a stat affix, or this assertion is vacuous');
  const inv = { items: [live], equipment: { main_hand: live.id } };
  const grants = gearStatGrants(inv, await loadItemTypes(pool));
  const expected = live.affixes
    .filter((a) => a.effect && a.effect.type === 'stat' && a.effect.stat === statAffix.effect.stat)
    .reduce((s, a) => s + a.value, 0);
  assert.ok(expected > 0, 'the stat grant must be non-zero');
  assert.strictEqual(grants[statAffix.effect.stat], expected,
    'a rolled stat affix must reach gearStatGrants');
  // A loose (unequipped) copy must grant NOTHING -- the same rule
  // socketedBuffStones follows, or a player stacks every affix they own.
  assert.strictEqual(
    gearStatGrants({ items: [live], equipment: {} }, await loadItemTypes(pool))[statAffix.effect.stat], 0,
    'an unequipped affixed item must grant nothing',
  );

  // And the hydrated in-memory inventory agrees -- the panel and
  // equipRequirements read THIS, not the row.
  const reloaded = await loadInventory(pool, fx.characterId);
  const hydrated = reloaded.items.find((it) => it.id === got.id);
  assert.ok(hydrated, 'the reclaimed instance must load');
  assert.strictEqual(hydrated.rarity, 'foxy');
  assert.strictEqual(hydrated.itemLevel, 77);
  assert.strictEqual(hydrated.soulbound, true);
  assert.deepStrictEqual(
    hydrated.affixes.map((a) => ({ affixTypeId: a.affixTypeId, value: a.value })),
    rolled.affixes.map((a) => ({ affixTypeId: a.affixTypeId, value: a.value })),
    'loadInventory must hydrate affixes, or the feature is inert in memory',
  );
  for (const a of hydrated.affixes) {
    assert.ok(a.key, 'each hydrated affix must carry its catalog key');
    assert.ok(a.effect && a.effect.type, 'each hydrated affix must carry its effect payload');
  }
});

test('a WHITE item still round-trips as white with no affix rows', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  t.after(async () => { await cleanup(pool, fx); await pool.end().catch(() => {}); });

  fx = await fixture(pool, 'white');
  const typeRow = await pool.query("SELECT id FROM item_types WHERE name = 'crude-helm'");
  const item = await pool.query(
    'INSERT INTO player_items (character_id, item_type_id, quantity) VALUES ($1,$2,1) RETURNING id, rarity, item_level, soulbound',
    [fx.characterId, typeRow.rows[0].id],
  );
  // The column defaults are what every pre-existing instance in the live
  // database will read as after this migration.
  assert.strictEqual(item.rows[0].rarity, 'white');
  assert.strictEqual(item.rows[0].item_level, 1);

  const { entry } = await armEntry(pool, fx);
  const dropped = await dropItem(pool, entry, String(fx.userId), fx.characterId, item.rows[0].id, { ttlMs: 60000 });
  assert.strictEqual(dropped.ok, true, dropped.reason);
  const ground = await pool.query('SELECT rarity, affixes, soulbound FROM world_items WHERE id = $1', [dropped.item.id]);
  assert.deepStrictEqual(ground.rows[0].affixes, [], 'an unaffixed item must carry an empty array, not null');
  assert.strictEqual(ground.rows[0].soulbound, false);

  const got = await claimItem(pool, entry, String(fx.userId), fx.characterId, dropped.item.id);
  const back = await pool.query('SELECT rarity, item_level, soulbound FROM player_items WHERE id = $1', [got.id]);
  assert.strictEqual(back.rows[0].rarity, 'white');
  assert.strictEqual(back.rows[0].soulbound, false);
  const n = await pool.query('SELECT count(*)::int AS n FROM player_item_affixes WHERE player_item_id = $1', [got.id]);
  assert.strictEqual(n.rows[0].n, 0);
});

test('a soulbound instance is now DROPPABLE and comes back still bound', async (t) => {
  // SOMET-277 refused this drop outright, for exactly one reason its own
  // comment gave: world_items had nowhere to carry the flag. T12 gives it one,
  // so the item becomes droppable WITHOUT becoming launderable. This test is
  // the replacement for that refusal: it pins the property the refusal was
  // protecting, not the refusal itself.
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  t.after(async () => { await cleanup(pool, fx); await pool.end().catch(() => {}); });

  fx = await fixture(pool, 'bound');
  const typeRow = await pool.query("SELECT id FROM item_types WHERE name = 'crude-blade'");
  const item = await pool.query(
    'INSERT INTO player_items (character_id, item_type_id, quantity, soulbound) VALUES ($1,$2,1,true) RETURNING id',
    [fx.characterId, typeRow.rows[0].id],
  );
  const { entry } = await armEntry(pool, fx);

  const dropped = await dropItem(pool, entry, String(fx.userId), fx.characterId, item.rows[0].id, { ttlMs: 60000 });
  assert.strictEqual(dropped.ok, true, `bound gear must now be droppable (got: ${dropped.reason})`);
  const got = await claimItem(pool, entry, String(fx.userId), fx.characterId, dropped.item.id);
  const back = await pool.query('SELECT soulbound FROM player_items WHERE id = $1', [got.id]);
  assert.strictEqual(back.rows[0].soulbound, true,
    'the laundering hole SOMET-277 closed must stay closed -- the flag rides the round trip');
});

// SOMET-484 changed what this test pins, and deliberately so. It used to
// assert that selling CASCADED the affix rows away -- which was true, and was
// the bug: the instance was destroyed and the buyback rebuilt a white one. The
// sale now hands the instance to the merchant, so the affix rows survive on
// the shelf. What is still asserted is the property the original cared about:
// selling an affixed item works, and the SELLER stops having it.
test('selling an affixed item succeeds and the seller stops holding it', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  t.after(async () => { await cleanup(pool, fx); await pool.end().catch(() => {}); });

  fx = await fixture(pool, 'sell');
  const typeRow = await pool.query("SELECT id FROM item_types WHERE name = 'crude-helm'");
  const item = await pool.query(
    `INSERT INTO player_items (character_id, item_type_id, quantity, rarity, item_level)
     VALUES ($1,$2,1,'yellow',30) RETURNING id`,
    [fx.characterId, typeRow.rows[0].id],
  );
  const affix = await pool.query('SELECT id FROM affix_types ORDER BY id LIMIT 1');
  await pool.query(
    'INSERT INTO player_item_affixes (player_item_id, idx, affix_type_id, value) VALUES ($1,0,$2,4)',
    [item.rows[0].id, affix.rows[0].id],
  );

  // The real sell path, not a bare DELETE: sellItem is what a merchant runs.
  const { sellItem } = require('../src/authority/trade.js');
  const { entry } = await armEntry(pool, fx);
  const player = entry.world.getPlayer(String(fx.userId));
  player.inv.items.push({ id: item.rows[0].id, typeId: typeRow.rows[0].id, quantity: 1 });
  const sold = await sellItem(pool, entry, String(fx.userId), fx.characterId, fx.villageId, item.rows[0].id);
  assert.strictEqual(sold.ok, true, `an affixed item must still be sellable (got: ${sold.reason})`);

  const owned = await pool.query(
    'SELECT character_id, merchant_stock_id FROM player_items WHERE id = $1', [item.rows[0].id],
  );
  assert.strictEqual(owned.rowCount, 1, 'the instance survives the sale -- the merchant holds it now');
  assert.strictEqual(owned.rows[0].character_id, null, 'the seller must no longer own it');
  assert.notStrictEqual(owned.rows[0].merchant_stock_id, null, 'a merchant_stock row must hold it');
  const left = await pool.query(
    'SELECT count(*)::int AS n FROM player_item_affixes WHERE player_item_id = $1', [item.rows[0].id],
  );
  assert.strictEqual(left.rows[0].n, 1, 'and its affix rows ride along with it');
  // The seller's own inventory is what the player sees, and it must be empty.
  const inv = await loadInventory(pool, fx.characterId);
  assert.strictEqual(inv.items.some((i) => i.id === item.rows[0].id), false,
    'a sold item must not still load into the seller inventory');
});

// SOMET-484, FIXED (migration 1714440512000). This test used to pin the
// opposite: T12 deliberately left the loss visible rather than silent, because
// merchant_stock carried only item_type_id and a sold yellow item bought back
// as a plain white one.
//
// The fix did NOT add a second denormalised carry path. The merchant now HOLDS
// the player_items row -- selling moves it off the character, buying moves it
// back -- so rarity, item level and the affix rows are never read, never
// written and never copied. That is why the assertions below flipped from
// "merchant_stock must not carry rarity/item_level/affixes" (which is still
// true, and still asserted) to "the round trip changes nothing".
//
// The exhaustive coverage lives in merchant_buyback_instance_db.test.js --
// legacy stock, base catalog, catalog deletion, expiry, the soulbound guard
// and the seller's character being deleted. This one stays here so the affix
// suite itself still fails if the round trip regresses.
test('SOMET-484: buyback PRESERVES rarity, item level and affix values', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  t.after(async () => { await cleanup(pool, fx); await pool.end().catch(() => {}); });

  // Still true, and load-bearing: the fix works by REFERENCE, so a snapshot
  // column appearing on merchant_stock would mean someone added the rotting
  // carry path this ticket rejected.
  const cols = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'merchant_stock' ORDER BY column_name`,
  );
  const names = cols.rows.map((r) => r.column_name);
  assert.ok(names.includes('item_type_id'), 'merchant_stock keys on the TYPE');
  for (const carried of ['rarity', 'item_level', 'affixes']) {
    assert.strictEqual(names.includes(carried), false,
      `merchant_stock must not SNAPSHOT ${carried} -- SOMET-484 was fixed by holding the instance`);
  }

  fx = await fixture(pool, 'buyback');
  const typeRow = await pool.query("SELECT id FROM item_types WHERE name = 'crude-helm'");
  const item = await pool.query(
    `INSERT INTO player_items (character_id, item_type_id, quantity, rarity, item_level)
     VALUES ($1,$2,1,'yellow',30) RETURNING id`,
    [fx.characterId, typeRow.rows[0].id],
  );
  const affix = await pool.query('SELECT id FROM affix_types ORDER BY id LIMIT 1');
  // 3.13 rather than a round 4: two decimals is not representable in float4,
  // so a value that came back as 3.130000114440918 would prove a precision
  // loss that an integer roll would hide entirely.
  await pool.query(
    'INSERT INTO player_item_affixes (player_item_id, idx, affix_type_id, value) VALUES ($1,0,$2,3.13)',
    [item.rows[0].id, affix.rows[0].id],
  );

  const { sellItem, buyStock } = require('../src/authority/trade.js');
  const { entry } = await armEntry(pool, fx);
  const player = entry.world.getPlayer(String(fx.userId));
  player.inv.items.push({ id: item.rows[0].id, typeId: typeRow.rows[0].id, quantity: 1 });
  const sold = await sellItem(pool, entry, String(fx.userId), fx.characterId, fx.villageId, item.rows[0].id);
  assert.strictEqual(sold.ok, true, sold.reason);

  const stock = await pool.query(
    'SELECT id FROM merchant_stock WHERE seller_user_id = $1 AND item_type_id = $2',
    [fx.userId, typeRow.rows[0].id],
  );
  assert.strictEqual(stock.rowCount, 1, 'the sale must produce a buyback row');

  await pool.query('UPDATE users SET gold = 100000 WHERE id = $1', [fx.userId]);
  entry.world.getPlayer(String(fx.userId)).gold = 100000;
  const bought = await buyStock(pool, entry, String(fx.userId), fx.characterId, stock.rows[0].id, fx.villageId);
  assert.strictEqual(bought.ok, true, `buyback must still work on an affixed item (got: ${bought.reason})`);

  // Same instance, not a rebuilt copy -- that is what makes the round trip
  // lossless by construction rather than by careful copying.
  assert.strictEqual(bought.item.id, item.rows[0].id,
    'SOMET-484: the buyback hands back the very instance that was sold');

  const back = await pool.query(
    'SELECT rarity, item_level FROM player_items WHERE id = $1', [bought.item.id],
  );
  assert.strictEqual(back.rows[0].rarity, 'yellow', 'SOMET-484: the buyback keeps the rarity');
  assert.strictEqual(back.rows[0].item_level, 30, 'SOMET-484: the buyback keeps the item level');
  // BY VALUE, deep-equal: a count check here would pass with the roll zeroed,
  // which is most of what the bug destroyed.
  const aff = await pool.query(
    `SELECT idx, affix_type_id, value FROM player_item_affixes
      WHERE player_item_id = $1 ORDER BY idx`,
    [bought.item.id],
  );
  assert.deepStrictEqual(
    aff.rows.map((r) => ({ idx: Number(r.idx), affixTypeId: r.affix_type_id, value: Number(r.value) })),
    [{ idx: 0, affixTypeId: affix.rows[0].id, value: 3.13 }],
    'SOMET-484: the affix comes back with the same index, type and rolled VALUE',
  );
});
