const test = require('node:test');
const assert = require('node:assert');
const { Client } = require('pg');
const MigrationBuilder = require('node-pg-migrate/dist/migration-builder').default;
const migStoneType = require('../migrations/1714440165000_stone_item_type.js');
const migStoneInstances = require('../migrations/1714440166000_stone_instances.js');
const {
  loadItemTypes, loadInventory, socketStone, unsocketStone,
} = require('../src/authority/items.js');
const { World } = require('../src/authority/world.js');
const { dropItem } = require('../src/authority/loot.js');
const { sellItem } = require('../src/authority/trade.js');
const { awardStoneXp, STONE_XP_PER_HIT } = require('../src/authority/stoneXp.js');
const { withStoneBonuses, socketedBuffStones } = require('../src/services/stoneBonuses.js');
const { derivePlayerStats, DEFAULT_PROGRESSION } = require('../src/services/playerStats.js');
const { HP_PER_CON } = require('../src/services/progressionConstants.js');

// Task 8 (SOMET-245): end-to-end, real-Postgres integration coverage for the
// whole magic-stones-and-sockets feature, plus stress cases. This branch's
// three migrations (1714440165000/166000/167000) have NOT been applied to
// the shared dev DB (by design -- see migration_convert_magic_weapons_db
// .test.js's own header comment, which this file follows for the schema
// half of the same problem). Only 165000 (the 'stone' category + buff-stone
// columns/constraints on item_types) and 166000 (the stone_instances table +
// its partial unique index) are applied here: this file never runs 167000
// (the existing-magic-weapon conversion) because nothing below depends on
// pre-existing magic weapons being converted -- every fixture below creates
// its own zz-prefixed weapon/stone catalog rows directly, the same way
// authority_socket_stone_integration.test.js's mock-pool fixtures do.
// Applying 167000 here would additionally be a real, DB-wide rewrite of
// every actual magic-weapon owner's row in the shared dev DB (rolled back,
// per migration_convert_magic_weapons_db.test.js's own reasoning, but with
// zero benefit to what THIS file asserts) -- narrower blast radius for equal
// coverage, so it is left out.
//
// Everything below -- fixture setup, the real socketStone/unsocketStone/
// loadItemTypes/loadInventory calls, awardStoneXp, and every assertion --
// runs inside ONE Postgres transaction on a single dedicated client, and
// that transaction is ALWAYS rolled back in `finally`, pass or fail, exactly
// like migration_convert_magic_weapons_db.test.js. Nothing here is ever
// committed.
//
// A NEW wrinkle this file has that migration_convert_magic_weapons_db.test.js
// does not: socketStone/unsocketStone are real application code that call
// `pool.connect()` and then issue their OWN literal `client.query('BEGIN')`
// / `'COMMIT'` / `'ROLLBACK')` (items.js, read in full before writing this).
// A second literal BEGIN on a connection that already has our own outer
// transaction open is a Postgres no-op-with-a-warning, and the matching
// COMMIT would therefore really commit everything since our OWN outer BEGIN
// -- including the schema DDL from migStoneType/migStoneInstances -- for
// real, onto the shared dev DB. That is exactly what this project's safety
// rules forbid. `savepointPool` below is the fix: it hands socketStone/
// unsocketStone a pool-shaped object whose `.query('BEGIN'|'COMMIT'|
// 'ROLLBACK')` is translated into SAVEPOINT / RELEASE SAVEPOINT / ROLLBACK
// TO SAVEPOINT against the SAME already-open outer transaction, instead of
// being passed through literally. This is the standard "transactional test"
// technique (Django's TestCase, Rails' transactional fixtures) applied to
// raw node-postgres: nested BEGIN/COMMIT pairs become nested savepoints, and
// our own single, real, final ROLLBACK (in `finally`, on the raw client,
// never going through this translation) discards every savepoint along with
// everything else -- a socketStone call that internally "commits" only ever
// releases a savepoint, which is not durable until the enclosing transaction
// itself commits, which it never does here.
const DB_URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://user:password@localhost:15432/game_db';

async function applyMigration(client, migModule, direction) {
  const pgm = new MigrationBuilder({}, {}, false, { debug() {}, info() {}, warn() {}, error() {} });
  migModule[direction](pgm);
  for (const sql of pgm.getSqlSteps()) {
    await client.query(sql);
  }
}

// See the header comment above for why this exists. Only 'BEGIN'/'COMMIT'/
// 'ROLLBACK' (matched by EXACT string, same as items.js issues them -- no
// trailing semicolon, no extra whitespace beyond a trim) are intercepted;
// every other query passes straight through to the real client. Calls are
// driven sequentially by this file (no test awaits two socketStone/
// unsocketStone calls truly in parallel except the one stress case below
// that deliberately does, and that stress case's own comment explains why a
// single real connection makes that "concurrent-looking" rather than truly
// concurrent).
function savepointPool(client) {
  let counter = 0;
  const stack = [];
  async function query(sql, params) {
    const s = typeof sql === 'string' ? sql.trim() : sql;
    if (s === 'BEGIN') {
      const name = `zz_sp_${++counter}`;
      stack.push(name);
      return client.query(`SAVEPOINT ${name}`);
    }
    if (s === 'COMMIT') {
      const name = stack.pop();
      return client.query(`RELEASE SAVEPOINT ${name}`);
    }
    if (s === 'ROLLBACK') {
      const name = stack.pop();
      return client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    }
    return client.query(sql, params);
  }
  return { query, connect: async () => ({ query, release: () => {} }) };
}

async function openTxClient(t) {
  const client = new Client({ connectionString: DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
  } catch (err) {
    const msg = `NO DATABASE at ${DB_URL} (${err.message}) — the stones integration/stress flow is UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return null;
  }
  await client.query('BEGIN');
  await applyMigration(client, migStoneType, 'up');
  await applyMigration(client, migStoneInstances, 'up');
  return client;
}

function uniqueTag() { return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`; }

async function createZzCharacter(client, tag) {
  const user = await client.query(
    `INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'player') RETURNING id`,
    [`zz-stones-int-user-${tag}`],
  );
  const userId = user.rows[0].id;
  const entityType = await client.query(`SELECT id FROM entity_types WHERE name = 'Warrior'`);
  assert.equal(entityType.rowCount, 1, 'setup: the Warrior entity type must exist');
  const character = await client.query(
    `INSERT INTO characters (user_id, slot, name, entity_type_id) VALUES ($1, 1, $2, $3) RETURNING id`,
    [userId, `zz-stones-int-char-${tag}`, entityType.rows[0].id],
  );
  return character.rows[0].id;
}

async function insertItemType(client, fields) {
  const cols = Object.keys(fields);
  const vals = Object.values(fields);
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  const r = await client.query(
    `INSERT INTO item_types (${cols.join(', ')}) VALUES (${placeholders}) RETURNING id`,
    vals,
  );
  return r.rows[0].id;
}

async function grantItem(client, characterId, itemTypeId) {
  const r = await client.query(
    `INSERT INTO player_items (id, character_id, item_type_id, quantity) VALUES (gen_random_uuid(), $1, $2, 1) RETURNING id`,
    [characterId, itemTypeId],
  );
  return r.rows[0].id;
}

// A loose (unsocketed) stone instance -- what owning a stone that hasn't
// been socketed yet looks like at the schema level: a stone_instances row
// with socketed_into_id NULL (the column's default).
async function makeLooseStoneInstance(client, stonePlayerItemId) {
  await client.query('INSERT INTO stone_instances (player_item_id) VALUES ($1)', [stonePlayerItemId]);
}

function stubMap() {
  return {
    chunkSize: 64, isWalkable: () => true, speedAt: () => 1, getChunk: () => [],
  };
}

// Same reach/arc/position numbers as authority_world_combat.test.js's own
// "attack is cooldown-gated and kills an adjacent creature" test (read in
// full before writing this): player spawned at (100,100) [center (132,132)],
// creature at (150,108), aim (1,0) (due east) -- already proven to land in
// that file, reused here rather than re-deriving new geometry.
function addTargetCreature(world, id, hp = 200) {
  world.creatures.addCreatures([{
    id, type: 'Wolf', x: 150, y: 108, hp, facing: 'S', color: '#c00',
  }]);
}

test('end-to-end: socket a spell stone, combat reads it, XP accrues on a landed hit, unsocket survive then destroy, buff stone overlays stats', async (t) => {
  const client = await openTxClient(t);
  if (!client) return;
  const pool = savepointPool(client);
  const tag = uniqueTag();

  try {
    const characterId = await createZzCharacter(client, tag);

    const weaponTypeId = await insertItemType(client, {
      name: `zz-stones-wand-${tag}`, category: 'weapon', kind: 'melee',
      damage: 8, cooldown: 0.3, reach: 80, arc_width: 0.6, mana_cost: 0, element: null, stackable: false,
    });
    const spellStoneTypeId = await insertItemType(client, {
      name: `stone_of_zz_${tag}`, category: 'stone', element: 'fire',
      mana_cost: 0, damage: 20, cooldown: 0.5, stackable: false,
    });
    const armorTypeId = await insertItemType(client, {
      name: `zz-stones-armor-${tag}`, category: 'armor', slot: 'chest', damage: 0, cooldown: 0, defense: 3, stackable: false,
    });
    const buffStoneTypeId = await insertItemType(client, {
      name: `stone_of_zz_vigor_${tag}`, category: 'stone', stat_bonus_stat: 'constitution', stat_bonus_amount: 2, damage: 0, cooldown: 0, stackable: false,
    });

    const weaponItemId = await grantItem(client, characterId, weaponTypeId);
    const spellStoneItemId = await grantItem(client, characterId, spellStoneTypeId);
    const armorItemId = await grantItem(client, characterId, armorTypeId);
    const buffStoneItemId = await grantItem(client, characterId, buffStoneTypeId);
    await makeLooseStoneInstance(client, spellStoneItemId);
    await makeLooseStoneInstance(client, buffStoneItemId);

    const itemTypes = await loadItemTypes(pool);
    const inv = await loadInventory(pool, characterId);
    inv.equipment.main_hand = weaponItemId;

    // --- socket the spell stone into the weapon (real socketStone) ---
    const socketResult = await socketStone(pool, characterId, inv, spellStoneItemId, weaponItemId, itemTypes);
    assert.equal(socketResult.ok, true, socketResult.reason);
    const hostAfterSocket = inv.items.find((i) => i.id === weaponItemId);
    assert.equal(hostAfterSocket.socketedStoneTypeId, spellStoneTypeId, 'in-memory cache must reflect the socketing');
    assert.equal(hostAfterSocket.socketedStoneItemId, spellStoneItemId);

    const socketedRow = await client.query('SELECT socketed_into_id FROM stone_instances WHERE player_item_id = $1', [spellStoneItemId]);
    assert.equal(socketedRow.rows[0].socketed_into_id, weaponItemId, 'the real DB row must be socketed too');

    // --- combat resolution picks up the socketed stone (real World.attack,
    // not a WS round trip -- the brief's own instruction) ---
    const world = new World(stubMap(), itemTypes, weaponTypeId, 64);
    world.addPlayer(characterId, { x: 100, y: 100 }, inv);
    addTargetCreature(world, 'zz-target-1');

    const attackResult = world.attack(characterId, 1, 0);
    assert.equal(attackResult.attacks.length, 1);
    assert.equal(attackResult.attacks[0].hit, true, 'the swing must land on the target creature');
    assert.ok(attackResult.stoneHit, 'a landed swing with a socketed spell stone must report stoneHit');
    assert.equal(attackResult.stoneHit.stoneItemId, spellStoneItemId, 'stoneHit must carry the STONE\'s own instance id');

    // --- land a hit -> stone XP increases, via the exact call server.js's
    // onStoneHit makes ---
    const award = await awardStoneXp(pool, attackResult.stoneHit.stoneItemId, STONE_XP_PER_HIT);
    assert.ok(award, 'award must not be null -- the stone row must exist and be awardable');
    assert.equal(award.xp, STONE_XP_PER_HIT);
    const xpRow = await client.query('SELECT xp, level FROM stone_instances WHERE player_item_id = $1', [spellStoneItemId]);
    assert.equal(Number(xpRow.rows[0].xp), STONE_XP_PER_HIT, 'the real DB xp column must reflect the award');

    // --- unsocket with a forced-SURVIVE roll: stone stays owned, XP intact ---
    const surviveResult = await unsocketStone(pool, characterId, inv, spellStoneItemId, { confirm: true, rng: () => 0.99 });
    assert.equal(surviveResult.ok, true, surviveResult.reason);
    assert.equal(surviveResult.destroyed, false);

    const afterSurvive = await client.query('SELECT socketed_into_id, xp FROM stone_instances WHERE player_item_id = $1', [spellStoneItemId]);
    assert.equal(afterSurvive.rowCount, 1, 'the survived stone\'s stone_instances row must still exist');
    assert.equal(afterSurvive.rows[0].socketed_into_id, null, 'ejected from the host, not deleted');
    assert.equal(Number(afterSurvive.rows[0].xp), STONE_XP_PER_HIT, 'xp must be untouched by an unsocket');
    assert.ok(inv.items.some((i) => i.id === spellStoneItemId), 'the stone must still be present in loose inventory (in-memory)');
    const stillOwned = await client.query('SELECT 1 FROM player_items WHERE id = $1 AND character_id = $2', [spellStoneItemId, characterId]);
    assert.equal(stillOwned.rowCount, 1, 'the stone must still be owned in the real DB too');
    assert.equal(inv.items.find((i) => i.id === weaponItemId).socketedStoneTypeId, undefined, 'the host\'s in-memory cache must be cleared');

    // --- re-socket the SAME stone, then unsocket with a forced-DESTROY roll:
    // stone and its stone_instances row are both gone ---
    const resocket = await socketStone(pool, characterId, inv, spellStoneItemId, weaponItemId, itemTypes);
    assert.equal(resocket.ok, true, resocket.reason);

    const destroyResult = await unsocketStone(pool, characterId, inv, spellStoneItemId, { confirm: true, rng: () => 0 });
    assert.equal(destroyResult.ok, true, destroyResult.reason);
    assert.equal(destroyResult.destroyed, true);

    const stoneItemGone = await client.query('SELECT 1 FROM player_items WHERE id = $1', [spellStoneItemId]);
    assert.equal(stoneItemGone.rowCount, 0, 'the destroyed stone\'s player_items row must be gone');
    const stoneInstanceGone = await client.query('SELECT 1 FROM stone_instances WHERE player_item_id = $1', [spellStoneItemId]);
    assert.equal(stoneInstanceGone.rowCount, 0, 'the destroyed stone\'s stone_instances row must be gone too (cascaded)');
    assert.ok(!inv.items.some((i) => i.id === spellStoneItemId), 'the in-memory inv must also drop the destroyed stone');

    // --- buff stone: socket into armor, confirm the real stat overlay ---
    // Important #4 fix (SOMET-245 final review): socketedBuffStones now only
    // counts a stone socketed into an item that is ALSO currently equipped
    // (see stoneBonuses.js) -- the armor must actually be worn, not merely
    // owned, for its buff to count.
    inv.equipment.chest = armorItemId;
    const buffSocket = await socketStone(pool, characterId, inv, buffStoneItemId, armorItemId, itemTypes);
    assert.equal(buffSocket.ok, true, buffSocket.reason);

    const buffs = socketedBuffStones(inv, itemTypes);
    assert.deepEqual(buffs, [{ stat_bonus_stat: 'constitution', stat_bonus_amount: 2 }]);

    const baseline = derivePlayerStats(DEFAULT_PROGRESSION);
    const buffed = derivePlayerStats(withStoneBonuses(DEFAULT_PROGRESSION, buffs));
    assert.equal(buffed.maxHp, baseline.maxHp + 2 * HP_PER_CON, 'the buff stone\'s +2 constitution must raise maxHp by 2*HP_PER_CON via the real derivePlayerStats/withStoneBonuses pipeline');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end().catch(() => {});
  }
});

// --- Stress cases (Task 8 Step 2) --------------------------------------

test('stress: two concurrent-looking socketStone calls for the same host -- only one succeeds, backstopped by the partial unique index', async (t) => {
  const client = await openTxClient(t);
  if (!client) return;
  const pool = savepointPool(client);
  const tag = uniqueTag();

  try {
    const characterId = await createZzCharacter(client, tag);
    const weaponTypeId = await insertItemType(client, {
      name: `zz-stones-host-${tag}`, category: 'weapon', kind: 'melee', damage: 8, cooldown: 0.3, reach: 80, arc_width: 0.6, stackable: false,
    });
    const stoneAType = await insertItemType(client, {
      name: `stone_of_zz_a_${tag}`, category: 'stone', element: 'fire', damage: 0, cooldown: 0, stackable: false,
    });
    const stoneBType = await insertItemType(client, {
      name: `stone_of_zz_b_${tag}`, category: 'stone', element: 'ice', damage: 0, cooldown: 0, stackable: false,
    });
    const weaponItemId = await grantItem(client, characterId, weaponTypeId);
    const stoneAItemId = await grantItem(client, characterId, stoneAType);
    const stoneBItemId = await grantItem(client, characterId, stoneBType);
    await makeLooseStoneInstance(client, stoneAItemId);
    await makeLooseStoneInstance(client, stoneBItemId);

    const itemTypes = await loadItemTypes(pool);
    const inv = await loadInventory(pool, characterId);

    // NOTE ON "CONCURRENT-LOOKING" (a real dead end, documented rather than
    // silently avoided): this whole file runs on ONE real Postgres
    // connection (see the header comment -- a second connection could not
    // see our uncommitted schema/fixtures at all). A first attempt at this
    // test called both socketStone(...)s via Promise.all/allSettled with no
    // await between them, on the theory that Node's event loop would still
    // interleave their awaited round trips enough to race the DB-level
    // check genuinely. It DID race -- but the outcome was corrupted, not
    // merely "one throws": occupancy ended up 0, not 1. Root cause, traced
    // by hand: Postgres SAVEPOINTs are a real stack. Call A's BEGIN opens
    // sp_1; while sp_1 is still open, call B's BEGIN opens sp_2 NESTED
    // inside it. `RELEASE SAVEPOINT sp_1` (A's eventual COMMIT) releases sp_1
    // AND every savepoint opened after it -- including B's still-in-use
    // sp_2 -- as a documented side effect of Postgres's own RELEASE
    // SAVEPOINT semantics. When B's own UPDATE then loses the race and its
    // catch block tries `ROLLBACK TO SAVEPOINT sp_2`, sp_2 no longer exists,
    // that command itself errors, and the connection is left in an aborted
    // transaction state that poisons every subsequent query on this shared
    // session -- corrupting the rest of THIS test too. Two independently-
    // committing logical transactions cannot be safely interleaved via
    // savepoints on a single physical connection unless they happen to
    // complete in strict reverse-of-creation (LIFO) order, which a genuine
    // race does not guarantee. There is no fix for this within "one real
    // connection, never commit the schema" -- it is a hard limit of the
    // technique, not a bug in this test or in socketStone.
    //
    // So this stress case instead proves the SAME two claims the brief asks
    // for -- "only one succeeds" and "backstopped by the partial unique
    // index" -- without relying on unsafe interleaving: a clean SEQUENTIAL
    // double-attempt (still two real socketStone calls against the same
    // real host, still asserting the second is refused) for the
    // application-level guard, and a raw-SQL bypass of that guard for the
    // DB-level backstop specifically.
    const r1 = await socketStone(pool, characterId, inv, stoneAItemId, weaponItemId, itemTypes);
    assert.equal(r1.ok, true, r1.reason);
    const r2 = await socketStone(pool, characterId, inv, stoneBItemId, weaponItemId, itemTypes);
    assert.equal(r2.ok, false, 'a second socket attempt at an already-occupied host must be refused');
    assert.match(r2.reason, /already has a socketed stone/i);

    const occupancy = await client.query('SELECT count(*)::int AS n FROM stone_instances WHERE socketed_into_id = $1', [weaponItemId]);
    assert.equal(occupancy.rows[0].n, 1, 'the host must end up with exactly one socketed stone, never two');

    // Direct proof of the DB-level backstop: bypass socketStone's own
    // occupancy check entirely and try to point the LOSING stone's row at
    // the same already-occupied host via a raw UPDATE. The partial unique
    // index (stone_instances_socketed_into_unique, 1714440166000) must
    // refuse this regardless of any application-level guard -- this is what
    // actually protects a real concurrent race across two real connections
    // in production, even though this single-connection test file cannot
    // safely simulate that race directly (see above).
    await assert.rejects(
      client.query('UPDATE stone_instances SET socketed_into_id = $1 WHERE player_item_id = $2', [weaponItemId, stoneBItemId]),
      /duplicate key value violates unique constraint/i,
      'the partial unique index must refuse a second stone pointed at an already-occupied host, independent of any application-level check',
    );
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end().catch(() => {});
  }
});

test('stress: unsocketing without confirm is refused before any DB write, re-confirmed against a real socketed row', async (t) => {
  const client = await openTxClient(t);
  if (!client) return;
  const pool = savepointPool(client);
  const tag = uniqueTag();

  try {
    const characterId = await createZzCharacter(client, tag);
    const weaponTypeId = await insertItemType(client, {
      name: `zz-stones-noconfirm-${tag}`, category: 'weapon', kind: 'melee', damage: 8, cooldown: 0.3, reach: 80, arc_width: 0.6, stackable: false,
    });
    const stoneTypeId = await insertItemType(client, {
      name: `stone_of_zz_noconfirm_${tag}`, category: 'stone', element: 'fire', damage: 0, cooldown: 0, stackable: false,
    });
    const weaponItemId = await grantItem(client, characterId, weaponTypeId);
    const stoneItemId = await grantItem(client, characterId, stoneTypeId);
    await makeLooseStoneInstance(client, stoneItemId);

    const itemTypes = await loadItemTypes(pool);
    const inv = await loadInventory(pool, characterId);
    const socketResult = await socketStone(pool, characterId, inv, stoneItemId, weaponItemId, itemTypes);
    assert.equal(socketResult.ok, true, socketResult.reason);

    const result = await unsocketStone(pool, characterId, inv, stoneItemId, { confirm: false });
    assert.equal(result.ok, false);
    assert.match(result.reason, /confirm/i);

    const stillSocketed = await client.query('SELECT socketed_into_id FROM stone_instances WHERE player_item_id = $1', [stoneItemId]);
    assert.equal(stillSocketed.rows[0].socketed_into_id, weaponItemId, 'a confirm-less unsocket must leave the real DB row untouched');
    assert.equal(inv.items.find((i) => i.id === weaponItemId).socketedStoneTypeId, stoneTypeId, 'and the in-memory cache untouched too');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end().catch(() => {});
  }
});

test('stress: socketing a spell stone into armor is refused as incompatible', async (t) => {
  const client = await openTxClient(t);
  if (!client) return;
  const pool = savepointPool(client);
  const tag = uniqueTag();

  try {
    const characterId = await createZzCharacter(client, tag);
    const armorTypeId = await insertItemType(client, {
      name: `zz-stones-badhost-${tag}`, category: 'armor', slot: 'chest', damage: 0, cooldown: 0, defense: 1, stackable: false,
    });
    const stoneTypeId = await insertItemType(client, {
      name: `stone_of_zz_badhost_${tag}`, category: 'stone', element: 'fire', damage: 0, cooldown: 0, stackable: false,
    });
    const armorItemId = await grantItem(client, characterId, armorTypeId);
    const stoneItemId = await grantItem(client, characterId, stoneTypeId);
    await makeLooseStoneInstance(client, stoneItemId);

    const itemTypes = await loadItemTypes(pool);
    const inv = await loadInventory(pool, characterId);

    const result = await socketStone(pool, characterId, inv, stoneItemId, armorItemId, itemTypes);
    assert.equal(result.ok, false);
    assert.match(result.reason, /compatib/i);

    const stillLoose = await client.query('SELECT socketed_into_id FROM stone_instances WHERE player_item_id = $1', [stoneItemId]);
    assert.equal(stillLoose.rows[0].socketed_into_id, null, 'a refused socket must leave the stone loose in the real DB');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end().catch(() => {});
  }
});

test('stress: socketing a stone not owned by the requesting character is refused', async (t) => {
  const client = await openTxClient(t);
  if (!client) return;
  const pool = savepointPool(client);
  const tag = uniqueTag();

  try {
    const ownerCharacterId = await createZzCharacter(client, `${tag}-owner`);
    const requesterCharacterId = await createZzCharacter(client, `${tag}-requester`);
    const weaponTypeId = await insertItemType(client, {
      name: `zz-stones-notmine-${tag}`, category: 'weapon', kind: 'melee', damage: 8, cooldown: 0.3, reach: 80, arc_width: 0.6, stackable: false,
    });
    const stoneTypeId = await insertItemType(client, {
      name: `stone_of_zz_notmine_${tag}`, category: 'stone', element: 'fire', damage: 0, cooldown: 0, stackable: false,
    });
    // The weapon belongs to the REQUESTER; the stone belongs to the OWNER --
    // a different character entirely.
    const weaponItemId = await grantItem(client, requesterCharacterId, weaponTypeId);
    const stoneItemId = await grantItem(client, ownerCharacterId, stoneTypeId);
    await makeLooseStoneInstance(client, stoneItemId);

    const itemTypes = await loadItemTypes(pool);
    const inv = await loadInventory(pool, requesterCharacterId);

    const result = await socketStone(pool, requesterCharacterId, inv, stoneItemId, weaponItemId, itemTypes);
    assert.equal(result.ok, false);
    assert.match(result.reason, /not found/i, 'ownership is enforced by the character_id predicate, not surfaced as a distinct "not yours" reason');

    const stillLoose = await client.query('SELECT socketed_into_id FROM stone_instances WHERE player_item_id = $1', [stoneItemId]);
    assert.equal(stillLoose.rows[0].socketed_into_id, null);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end().catch(() => {});
  }
});

test('stress: attacking with a weapon whose socketed stone was removed mid-session reflects the removal without a reload', async (t) => {
  const client = await openTxClient(t);
  if (!client) return;
  const pool = savepointPool(client);
  const tag = uniqueTag();

  try {
    const characterId = await createZzCharacter(client, tag);
    const weaponTypeId = await insertItemType(client, {
      name: `zz-stones-cache-${tag}`, category: 'weapon', kind: 'melee', damage: 8, cooldown: 0.3, reach: 80, arc_width: 0.6, mana_cost: 0, stackable: false,
    });
    const stoneTypeId = await insertItemType(client, {
      name: `stone_of_zz_cache_${tag}`, category: 'stone', element: 'fire', damage: 20, cooldown: 0.5, mana_cost: 0, stackable: false,
    });
    const weaponItemId = await grantItem(client, characterId, weaponTypeId);
    const stoneItemId = await grantItem(client, characterId, stoneTypeId);
    await makeLooseStoneInstance(client, stoneItemId);

    const itemTypes = await loadItemTypes(pool);
    const inv = await loadInventory(pool, characterId);
    inv.equipment.main_hand = weaponItemId;

    const sock = await socketStone(pool, characterId, inv, stoneItemId, weaponItemId, itemTypes);
    assert.equal(sock.ok, true, sock.reason);

    const world = new World(stubMap(), itemTypes, weaponTypeId, 64);
    world.addPlayer(characterId, { x: 100, y: 100 }, inv);
    addTargetCreature(world, 'zz-target-cache-1');

    const before = world.attack(characterId, 1, 0);
    assert.ok(before.stoneHit, 'the socketed spell stone must be picked up on the first swing');
    assert.equal(before.stoneHit.stoneItemId, stoneItemId);

    // Bypass the cooldown so a second swing is legal immediately -- this
    // test is about cache sync across an unsocket, not cooldown timing
    // (covered elsewhere, e.g. authority_world_combat.test.js).
    world.getPlayer(characterId)._attackCd = 0;

    const un = await unsocketStone(pool, characterId, inv, stoneItemId, { confirm: true, rng: () => 0.99 });
    assert.equal(un.ok, true, un.reason);
    assert.equal(un.destroyed, false);

    addTargetCreature(world, 'zz-target-cache-2');
    const after = world.attack(characterId, 1, 0);
    assert.equal(after.attacks[0].hit, true, 'the swing must still land physically -- only the spell is gone');
    assert.equal(after.stoneHit, null, 'the removed stone must no longer earn XP -- combat reads the LIVE in-memory cache, not a stale snapshot from before the unsocket');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end().catch(() => {});
  }
});

// Critical #1 + #2 fix (SOMET-245 final review), proven end-to-end against a
// real database: dropItem and sellItem must refuse a stone (both loose and
// currently socketed into a weapon) rather than CASCADE-deleting its
// stone_instances row -- and because the refusal happens before any DELETE,
// the host's in-memory socket cache (socketedStoneTypeId/socketedStoneItemId)
// can never go stale either (Critical #2 is closed as a direct consequence
// of Critical #1's guard, not a separate fix).
test('dropItem and sellItem both refuse a stone -- loose and socketed -- leaving the real DB row and the in-memory cache untouched', async (t) => {
  const client = await openTxClient(t);
  if (!client) return;
  const pool = savepointPool(client);
  const tag = uniqueTag();

  try {
    const characterId = await createZzCharacter(client, tag);

    const weaponTypeId = await insertItemType(client, {
      name: `zz-stones-dropsell-wand-${tag}`, category: 'weapon', kind: 'melee',
      damage: 8, cooldown: 0.3, reach: 80, arc_width: 0.6, mana_cost: 0, element: null, stackable: false,
    });
    const spellStoneTypeId = await insertItemType(client, {
      name: `stone_of_zz_dropsell_${tag}`, category: 'stone', element: 'fire',
      mana_cost: 0, damage: 20, cooldown: 0.5, stackable: false,
    });

    const weaponItemId = await grantItem(client, characterId, weaponTypeId);
    const looseStoneItemId = await grantItem(client, characterId, spellStoneTypeId);
    const socketedStoneItemId = await grantItem(client, characterId, spellStoneTypeId);
    await makeLooseStoneInstance(client, looseStoneItemId);
    await makeLooseStoneInstance(client, socketedStoneItemId);

    const itemTypes = await loadItemTypes(pool);
    const inv = await loadInventory(pool, characterId);
    inv.equipment.main_hand = weaponItemId;

    const sock = await socketStone(pool, characterId, inv, socketedStoneItemId, weaponItemId, itemTypes);
    assert.equal(sock.ok, true, sock.reason);
    const hostBefore = inv.items.find((i) => i.id === weaponItemId);
    assert.equal(hostBefore.socketedStoneTypeId, spellStoneTypeId, 'setup: host cache reflects the live socket');
    assert.equal(hostBefore.socketedStoneItemId, socketedStoneItemId);

    const entry = { worldId: 'w1', world: new World(stubMap(), itemTypes, weaponTypeId, 64) };
    entry.world.addPlayer(characterId, { x: 100, y: 100 }, inv);

    // --- dropItem refuses both the loose stone and the socketed one ---
    const dropLoose = await dropItem(pool, entry, characterId, characterId, looseStoneItemId, { ttlMs: 1000 });
    assert.equal(dropLoose.ok, false);
    assert.match(dropLoose.reason, /unsocket/i);

    const dropSocketed = await dropItem(pool, entry, characterId, characterId, socketedStoneItemId, { ttlMs: 1000 });
    assert.equal(dropSocketed.ok, false);
    assert.match(dropSocketed.reason, /unsocket/i);

    // --- sellItem refuses both the same way ---
    const sellLoose = await sellItem(pool, entry, characterId, characterId, 'zz-village-1', looseStoneItemId);
    assert.equal(sellLoose.ok, false);
    assert.match(sellLoose.reason, /unsocket/i);

    const sellSocketed = await sellItem(pool, entry, characterId, characterId, 'zz-village-1', socketedStoneItemId);
    assert.equal(sellSocketed.ok, false);
    assert.match(sellSocketed.reason, /unsocket/i);

    // --- the real DB rows survived every refused attempt ---
    const looseRow = await client.query('SELECT 1 FROM player_items WHERE id = $1', [looseStoneItemId]);
    assert.equal(looseRow.rowCount, 1, 'the loose stone\'s player_items row must still exist');
    const looseInstance = await client.query('SELECT 1 FROM stone_instances WHERE player_item_id = $1', [looseStoneItemId]);
    assert.equal(looseInstance.rowCount, 1, 'the loose stone\'s stone_instances row (xp/level) must still exist');

    const socketedRow = await client.query('SELECT 1 FROM player_items WHERE id = $1', [socketedStoneItemId]);
    assert.equal(socketedRow.rowCount, 1, 'the socketed stone\'s player_items row must still exist');
    const socketedInstance = await client.query(
      'SELECT socketed_into_id FROM stone_instances WHERE player_item_id = $1', [socketedStoneItemId],
    );
    assert.equal(socketedInstance.rowCount, 1, 'the socketed stone\'s stone_instances row must still exist');
    assert.equal(socketedInstance.rows[0].socketed_into_id, weaponItemId, 'must still be socketed into the SAME host -- never ejected by a refused drop/sell');

    // --- Critical #2: the host's in-memory cache is untouched by any of
    // the four refused attempts above ---
    const hostAfter = inv.items.find((i) => i.id === weaponItemId);
    assert.equal(hostAfter.socketedStoneTypeId, spellStoneTypeId, 'host cache TYPE must survive every refused drop/sell of its socketed stone');
    assert.equal(hostAfter.socketedStoneItemId, socketedStoneItemId, 'host cache INSTANCE id must survive every refused drop/sell of its socketed stone');

    // --- combat still reads the (unchanged, still-socketed) stone correctly ---
    addTargetCreature(entry.world, 'zz-target-dropsell-1');
    const attack = entry.world.attack(characterId, 1, 0);
    assert.ok(attack.stoneHit, 'the socketed stone must still be live for combat -- none of the refused calls above ejected it');
    assert.equal(attack.stoneHit.stoneItemId, socketedStoneItemId);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await client.end().catch(() => {});
  }
});
