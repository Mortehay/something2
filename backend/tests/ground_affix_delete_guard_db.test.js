// SOMET-501. Deleting a catalog affix while an item carrying it lies on the
// GROUND used to make that item permanently unpickable.
//
// world_items (migration 1714440507000) carries a denormalised `affixes` jsonb
// whose entries are a bare `affixTypeId` with NO foreign key, and the admin
// DELETE guard probed only `player_item_affixes`. So the delete succeeded,
// claimItem's `aff` CTE then INSERTed a player_item_affixes row naming a row
// that no longer exists, and the FK raised 23503 -- for the whole 180-second
// ground lifetime the player saw an item they could not pick up.
//
// Every case below goes through the REAL admin route (supertest against the
// real router) and the REAL claimItem, against real rows in a real database.
// A helper-level test would prove nothing about either: the guard's SQL and
// the claim's CTE are the two things that can be wrong.
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { Pool } = require('pg');
const { adminToken, withAuth } = require('./helpers/auth.js');
const { World } = require('../src/authority/world.js');
const { loadItemTypes, loadInventory } = require('../src/authority/items.js');
const { dropItem, claimItem } = require('../src/authority/loot.js');

const { app, __setPool } = require('../src/index.js');

const AUTH = ['Authorization', `Bearer ${adminToken()}`];
const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

// Unrepresentable in float4 on purpose: 3.13 comes back as 3.130000114440918
// from a `real` column, so an assertion on this value fails loudly if the
// carry path ever loses its double precision. `deepStrictEqual` (never
// `assert.equal`) throughout, because 12 == '12' has passed a test in this
// repo before.
const DOOMED_VALUE = 3.13;
const SURVIVOR_VALUE = 7.77;

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
  return `s501-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Every row here is created by THIS file and torn down by THIS file, including
// the affix types -- nothing below ever deletes a SEEDED catalog affix, so a
// concurrent test file's items are never in the blast radius.
async function fixture(pool, tag) {
  const u = await pool.query(
    "INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'player') RETURNING id",
    [uniq(`u-${tag}`)],
  );
  const userId = u.rows[0].id;
  const c = await pool.query(
    `INSERT INTO characters (user_id, slot, name, entity_type_id)
     SELECT $1, 1, $2, e.id FROM entity_types e WHERE e.is_playable = true
      ORDER BY e.id LIMIT 1 RETURNING id`,
    [userId, uniq(`c-${tag}`)],
  );
  const w = await pool.query(
    `INSERT INTO worlds (name, width, height, chunk_size, seed)
     VALUES ($1, 64, 64, 16, 1) RETURNING id`,
    [uniq(`w-${tag}`)],
  );
  return {
    userId, characterId: c.rows[0].id, worldId: w.rows[0].id, affixIds: [],
  };
}

async function cleanup(pool, fx) {
  if (!fx) return;
  await pool.query('DELETE FROM world_items WHERE world_id = $1', [fx.worldId]).catch(() => {});
  await pool.query('DELETE FROM player_items WHERE character_id = $1', [fx.characterId]).catch(() => {});
  await pool.query('DELETE FROM characters WHERE id = $1', [fx.characterId]).catch(() => {});
  await pool.query('DELETE FROM worlds WHERE id = $1', [fx.worldId]).catch(() => {});
  await pool.query('DELETE FROM users WHERE id = $1', [fx.userId]).catch(() => {});
  for (const id of fx.affixIds) {
    await pool.query('DELETE FROM affix_types WHERE id = $1', [id]).catch(() => {});
  }
}

// A catalog affix owned by this test. Deleting a SEEDED one would be a
// destructive experiment against a shared catalog; this one exists only for
// the few seconds the case needs it.
async function makeAffix(pool, fx, tag) {
  const r = await pool.query(
    `INSERT INTO affix_types (key, label, kind, effect, min_value, max_value,
                              min_item_level, allowed_slots, min_rarity, weight)
     VALUES ($1, $2, 'buff', '{"type":"stat","stat":"wisdom"}'::jsonb, 1, 99, 1, '{}'::text[], 'blue', 100)
     RETURNING id`,
    [uniq(`affix-${tag}`), `of Probe ${tag}`],
  );
  fx.affixIds.push(r.rows[0].id);
  return r.rows[0].id;
}

// A world entry shaped the way server.js builds one, with a stub map: nothing
// on the drop/claim path reads terrain.
async function armEntry(pool, fx) {
  const itemTypes = await loadItemTypes(pool);
  const map = {
    chunkSize: 16, isWalkable: () => true, speedAt: () => 1, getChunk: () => [],
  };
  const world = new World(map, itemTypes, null, 16);
  const entry = { worldId: fx.worldId, world, claiming: new Set(), creatureTypeIds: new Map() };
  const inv = await loadInventory(pool, fx.characterId);
  world.addPlayer(String(fx.userId), { x: 100, y: 100 }, inv, { x: 100, y: 100 }, 0, undefined, fx.characterId);
  return entry;
}

// Grants the character one crude-blade carrying the given [affixTypeId, value]
// pairs, then DROPS it through the real dropItem. Returns the ground row id.
async function itemOnTheGround(pool, fx, entry, affixes) {
  const typeRow = await pool.query("SELECT id FROM item_types WHERE name = 'crude-blade'");
  assert.strictEqual(typeRow.rowCount, 1, 'the T11 gear ladder must be seeded');
  const item = await pool.query(
    `INSERT INTO player_items (character_id, item_type_id, quantity, rarity, item_level)
     VALUES ($1, $2, 1, 'foxy', 77) RETURNING id`,
    [fx.characterId, typeRow.rows[0].id],
  );
  const itemId = item.rows[0].id;
  for (let i = 0; i < affixes.length; i += 1) {
    await pool.query(
      'INSERT INTO player_item_affixes (player_item_id, idx, affix_type_id, value) VALUES ($1,$2,$3,$4)',
      [itemId, i, affixes[i][0], affixes[i][1]],
    );
  }
  // Reload so the in-memory player carries the item dropItem is about to look
  // for -- dropItem reads p.inv, not the database, to find it.
  entry.world.getPlayer(String(fx.userId)).inv = await loadInventory(pool, fx.characterId);
  const dropped = await dropItem(pool, entry, String(fx.userId), fx.characterId, itemId, { ttlMs: 600000 });
  assert.strictEqual(dropped.ok, true, dropped.reason);
  return dropped.item.id;
}

async function affixRows(pool, playerItemId) {
  const r = await pool.query(
    'SELECT idx, affix_type_id, value FROM player_item_affixes WHERE player_item_id = $1 ORDER BY idx',
    [playerItemId],
  );
  return r.rows.map((x) => ({ idx: x.idx, affixTypeId: x.affix_type_id, value: x.value }));
}

// --- AC1 + AC2 -------------------------------------------------------------
// The admin route refuses, and the item stays pickable with its rolls intact.
test('SOMET-501: DELETE /api/affix-types is refused while a GROUND item carries the affix', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  t.after(async () => { await cleanup(pool, fx); await pool.end().catch(() => {}); });
  __setPool({ query: withAuth((sql, params) => pool.query(sql, params)) });

  fx = await fixture(pool, 'guard');
  const affixId = await makeAffix(pool, fx, 'guard');
  const entry = await armEntry(pool, fx);
  const groundId = await itemOnTheGround(pool, fx, entry, [[affixId, DOOMED_VALUE]]);

  // Precondition: the ground row really carries the snapshot, by value. If the
  // drop stopped carrying affixes this whole case would pass vacuously.
  const ground = await pool.query('SELECT affixes FROM world_items WHERE id = $1', [groundId]);
  assert.deepStrictEqual(ground.rows[0].affixes, [{ affixTypeId: affixId, value: DOOMED_VALUE }]);
  // ... and NOTHING holds it, so the FK cannot be what refuses the delete --
  // only the widened guard can.
  const held = await pool.query('SELECT 1 FROM player_item_affixes WHERE affix_type_id = $1', [affixId]);
  assert.strictEqual(held.rowCount, 0, 'the ground row must be the ONLY carrier, or the FK would refuse anyway');

  const del = await request(app).delete(`/api/affix-types/${affixId}`).set(...AUTH);
  assert.strictEqual(del.status, 409, JSON.stringify(del.body));
  assert.match(del.body.error, /ground/i);

  const still = await pool.query('SELECT 1 FROM affix_types WHERE id = $1', [affixId]);
  assert.strictEqual(still.rowCount, 1, 'the refused delete must leave the catalog row alone');

  // AC2: the ordinary pickup is unchanged, asserted BY VALUE on the roll.
  const got = await claimItem(pool, entry, String(fx.userId), fx.characterId, groundId);
  assert.ok(got && got.id, 'the item must be pickable');
  assert.deepStrictEqual(
    await affixRows(pool, got.id),
    [{ idx: 0, affixTypeId: affixId, value: DOOMED_VALUE }],
    'the pickup must restore the affix with its exact double-precision value',
  );
  // The hydrated in-memory copy too -- equipRequirements reads THAT, not the
  // database, so an item granted without it is live in the schema and inert in
  // play.
  const inMem = entry.world.getPlayer(String(fx.userId)).inv.items.find((i) => i.id === got.id);
  assert.deepStrictEqual(
    inMem.affixes.map((a) => ({ affixTypeId: a.affixTypeId, value: a.value })),
    [{ affixTypeId: affixId, value: DOOMED_VALUE }],
  );
});

// --- AC1, the half the guard cannot cover ----------------------------------
// The guard is a pre-check with no foreign key behind it, so it can still lose
// a race -- and each world caches its affix pool for up to one 60s item sweep,
// so a kill can roll an already-deleted affix onto the ground AFTER a delete
// the guard rightly allowed. claimItem must never fail on 23503 because of it.
test('SOMET-501: a ground item naming a deleted affix is still pickable, and says so loudly', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  const errors = [];
  const realError = console.error;
  t.after(async () => {
    console.error = realError;
    await cleanup(pool, fx); await pool.end().catch(() => {});
  });

  fx = await fixture(pool, 'tolerant');
  const doomedId = await makeAffix(pool, fx, 'doomed');
  const survivorId = await makeAffix(pool, fx, 'survivor');
  const entry = await armEntry(pool, fx);
  const groundId = await itemOnTheGround(pool, fx, entry, [
    [doomedId, DOOMED_VALUE], [survivorId, SURVIVOR_VALUE],
  ]);

  // Straight SQL, deliberately: this is the state the guard is NOT what
  // produces -- a race, or a world sim that rolled from its cached pool after
  // the catalog row went. Nothing holds the affix (the item is on the ground),
  // so the ON DELETE RESTRICT has nothing to bite on and this DELETE succeeds
  // exactly as it would in production.
  const gone = await pool.query('DELETE FROM affix_types WHERE id = $1 RETURNING id', [doomedId]);
  assert.strictEqual(gone.rowCount, 1, 'the setup must actually remove the catalog row');

  console.error = (...args) => { errors.push(args.join(' ')); };
  const got = await claimItem(pool, entry, String(fx.userId), fx.characterId, groundId);
  console.error = realError;

  assert.ok(got && got.id, 'the item must still be pickable -- not a 23503');
  // The survivor comes back untouched, by value; only the dead affix is lost.
  assert.deepStrictEqual(
    await affixRows(pool, got.id),
    [{ idx: 1, affixTypeId: survivorId, value: SURVIVOR_VALUE }],
    'the surviving affix must be restored at its original index with its exact value',
  );
  const wi = await pool.query('SELECT 1 FROM world_items WHERE id = $1', [groundId]);
  assert.strictEqual(wi.rowCount, 0, 'the ground row must be consumed by the successful claim');

  // LOUD, not silent. SOMET-481 shipped a feature that skipped quietly and was
  // dead for weeks; a tolerance nobody can see is the same shape.
  const shout = errors.find((e) => e.includes('SOMET-501'));
  assert.ok(shout, `expected a loud console.error; got ${JSON.stringify(errors)}`);
  assert.ok(shout.includes(String(groundId)), 'the log must name the ground item it came off');
  // Parsed out of the message rather than substring-matched against the whole
  // line: the ground item id is a UUID, so `includes('15')` is satisfied by
  // hex digits that have nothing to do with an affix id, and an assertion that
  // loose would pass for a log that named the WRONG affix.
  const listed = /affix type\(s\) ([\d, ]+) that are no longer/.exec(shout);
  assert.ok(listed, `the log must list the missing affix ids; got: ${shout}`);
  assert.deepStrictEqual(
    listed[1].split(',').map((s) => Number(s.trim())), [doomedId],
    'the log must name the affix that vanished and only that one',
  );
});

// --- AC3 -------------------------------------------------------------------
// The widened guard must not have traded away the protection it was widening.
test('SOMET-501: held gear still blocks the delete, at the route AND at the foreign key', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) { t.skip(pool.unreachable); return; }
  let fx = null;
  t.after(async () => { await cleanup(pool, fx); await pool.end().catch(() => {}); });
  __setPool({ query: withAuth((sql, params) => pool.query(sql, params)) });

  fx = await fixture(pool, 'held');
  const affixId = await makeAffix(pool, fx, 'held');
  const typeRow = await pool.query("SELECT id FROM item_types WHERE name = 'crude-blade'");
  const item = await pool.query(
    `INSERT INTO player_items (character_id, item_type_id, quantity, rarity, item_level)
     VALUES ($1, $2, 1, 'blue', 20) RETURNING id`,
    [fx.characterId, typeRow.rows[0].id],
  );
  await pool.query(
    'INSERT INTO player_item_affixes (player_item_id, idx, affix_type_id, value) VALUES ($1,0,$2,$3)',
    [item.rows[0].id, affixId, DOOMED_VALUE],
  );
  // Nothing on the ground: the ONLY thing that can refuse this is the original
  // held-gear probe, so a guard that lost it would show up here.
  const onGround = await pool.query(
    'SELECT 1 FROM world_items WHERE affixes @> $1::jsonb', [JSON.stringify([{ affixTypeId: affixId }])],
  );
  assert.strictEqual(onGround.rowCount, 0);

  const del = await request(app).delete(`/api/affix-types/${affixId}`).set(...AUTH);
  assert.strictEqual(del.status, 409, JSON.stringify(del.body));
  assert.match(del.body.error, /players own/);

  // And the FK, which is the real enforcement, is untouched.
  await assert.rejects(
    pool.query('DELETE FROM affix_types WHERE id = $1', [affixId]),
    (err) => err.code === '23503',
    'ON DELETE RESTRICT must still refuse at the database level',
  );
});
