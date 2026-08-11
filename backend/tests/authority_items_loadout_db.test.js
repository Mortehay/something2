const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { loadItemTypes, grantStartingLoadout } = require('../src/authority/items.js');

// F-013 (P0) regression suite, against a REAL database. Every test in
// tests/authority_items_inventory.test.js mocks the pool, which can enforce
// neither Postgres row-locking nor the actual constraint that makes this
// fix work: a mocked pool cannot tell a genuine two-connections-racing
// UPDATE from two sequential calls that happen to be awaited out of order.
// The exploit this closes was confirmed LIVE, twice, against the running
// server (sell-and-reconnect: 0 -> 21 -> 42 gold; drop-and-reconnect: +2
// items per cycle) — only a real database proves the fix holds under the
// same conditions.
//
// Same skip-if-unreachable discipline as authority_ammo_db.test.js: skip
// (loudly) with no DB, fail under CI.
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
  // Magic Stones (SOMET-245) Task 1's migration (1714440165000_stone_item_
  // type.js) adds item_types.stat_bonus_stat/stat_bonus_amount. Task 6's fix
  // to loadItemTypes (src/authority/items.js) now selects both columns on
  // every call, including the loadItemTypes(pool) call every test below
  // makes against a REAL database -- so a DB that IS reachable but hasn't
  // had that migration applied yet fails hard with `column "stat_bonus_stat"
  // does not exist` instead of running. This shared dev DB is exactly that
  // case (confirmed: `SELECT name FROM pgmigrations` stops at
  // 1714440164000), and the project forbids running migrate up/down against
  // it just to make a test pass (migration_convert_magic_weapons_db.test.js
  // hit the identical situation and documents the same rule). Same
  // information_schema.columns precondition-check pattern
  // characters_schema_db.test.js/creature_levels_db.test.js use elsewhere in
  // this repo, reused here as a SKIP gate (not just an assertion) so a stale
  // schema degrades to "unverified", not "broken" -- and folded into the
  // SAME `{ unreachable }` shape the SELECT-1 check above already returns,
  // so every `if (pool.unreachable)` gate below needs no changes at all to
  // pick this up.
  const col = await pool.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_name = 'item_types' AND column_name = 'stat_bonus_stat'`,
  );
  if (col.rowCount === 0) {
    await pool.end().catch(() => {});
    return {
      unreachable: `item_types.stat_bonus_stat is missing on ${DB_URL} `
        + '(migration 1714440165000_stone_item_type.js not applied)',
    };
  }
  return pool;
}

// SOMET-258: grantStartingLoadout takes a CHARACTER ({ id, entityTypeId }),
// stamps characters.starting_loadout_granted_at, and reads the item list from
// class_loadouts keyed by the class -- there is no STARTING_LOADOUT array any
// more. Each test therefore needs a real character of a known class, and the
// expected item count is that class's row count rather than a constant.
async function createTestCharacter(pool, tag, className = 'Warrior') {
  const userId = await createTestUser(pool, tag);
  const r = await pool.query(
    `INSERT INTO characters (user_id, slot, name, entity_type_id)
     SELECT $1, 1, $2, e.id FROM entity_types e WHERE e.name = $3
     RETURNING id, entity_type_id`,
    [userId, `loadout-db-char-${tag}-${process.pid}-${Date.now()}`, className],
  );
  return { userId, character: { id: r.rows[0].id, entityTypeId: r.rows[0].entity_type_id } };
}

// How many item rows that class's loadout should produce. Read from the
// catalog rather than hardcoded so the test states "the class's loadout", not
// "two things" -- but it is a COUNT of rows, independent of the code under
// test, so a grant that writes nothing still fails.
async function loadoutSize(pool, entityTypeId) {
  const r = await pool.query(
    'SELECT count(*)::int AS n FROM class_loadouts WHERE entity_type_id = $1', [entityTypeId]);
  return r.rows[0].n;
}

async function createTestUser(pool, tag) {
  const username = `loadout-db-test-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const r = await pool.query(
    `INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'player') RETURNING id`,
    [username],
  );
  return r.rows[0].id;
}

async function itemCount(pool, characterId) {
  const r = await pool.query('SELECT count(*)::int AS n FROM player_items WHERE character_id = $1', [characterId]);
  return r.rows[0].n;
}

async function grantedAt(pool, characterId) {
  const r = await pool.query('SELECT starting_loadout_granted_at FROM characters WHERE id = $1', [characterId]);
  return r.rows[0].starting_loadout_granted_at;
}

// `reason` is `pool.unreachable` -- either "NO DATABASE at ..." (SELECT 1
// failed) or the stale-schema message above (SELECT 1 succeeded, but the
// stat_bonus_stat column is missing). Both are complete sentences on their
// own; this just appends what specifically went unverified.
function skipMsg(what, reason) {
  return `${reason} — ${what} is UNVERIFIED on this run`;
}

test('grantStartingLoadout against a REAL database: first join on a fresh account grants the loadout and stamps the account', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = skipMsg('the F-013 fix', pool.unreachable);
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  let user;
  let character;
  let expectedItems;
  try {
    ({ userId: user, character } = await createTestCharacter(pool, 'fresh'));
    expectedItems = await loadoutSize(pool, character.entityTypeId);
    assert.equal(await grantedAt(pool, character.id), null, 'setup: a brand-new account starts unclaimed');

    const itemTypes = await loadItemTypes(pool);
    const granted = await grantStartingLoadout(pool, character, itemTypes);

    assert.equal(granted, true);
    assert.equal(await itemCount(pool, character.id), expectedItems);
    assert.ok(await grantedAt(pool, character.id) != null, 'starting_loadout_granted_at must be stamped after the grant');
  } finally {
    if (user != null) await pool.query('DELETE FROM users WHERE id = $1', [user]).catch(() => {});
    await pool.end().catch(() => {});
  }
});

// THE EXPLOIT REGRESSION TEST. This is the exact live exploit: sell (or
// drop) the starting items so player_items goes back to empty, then
// reconnect. Before the fix, grantStartingLoadout re-derived "should I
// grant?" from current ownership and handed out a brand-new set — free gold
// via sell+reconnect, free duplicates via drop+reconnect. This must grant
// NOTHING the second time, because the grant is a fact about the account
// now, not a snapshot of what it currently owns.
test('grantStartingLoadout against a REAL database: a second join after the inventory is emptied grants NOTHING (F-013 exploit regression)', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = skipMsg('the F-013 exploit regression', pool.unreachable);
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  let user;
  let character;
  let expectedItems;
  try {
    ({ userId: user, character } = await createTestCharacter(pool, 'sell-reconnect'));
    expectedItems = await loadoutSize(pool, character.entityTypeId);
    const itemTypes = await loadItemTypes(pool);

    // First join: legitimately granted, as any fresh account would be.
    const firstGrant = await grantStartingLoadout(pool, character, itemTypes);
    assert.equal(firstGrant, true, 'setup: the first join must grant normally');
    assert.equal(await itemCount(pool, character.id), expectedItems);

    // Sell-and-reconnect route: a merchant sale (or dropItem, see below)
    // DELETEs the player_items rows directly, exactly like a real sale/drop
    // does. Simulated here without going through trade.js/loot.js because
    // those are irrelevant to what's under test: the ONLY thing that matters
    // is that player_items is empty again afterward, which is the state the
    // old code keyed the grant on.
    await pool.query('DELETE FROM player_items WHERE character_id = $1', [character.id]);
    assert.equal(await itemCount(pool, character.id), 0, 'setup: inventory is empty again, same as after a sale');

    // Reconnect: the join handler's own gate (server.js) is "inventory
    // empty -> try to grant" — call grantStartingLoadout exactly as it does.
    const secondGrant = await grantStartingLoadout(pool, character, itemTypes);

    assert.equal(secondGrant, false,
      'THE EXPLOIT: an emptied-but-previously-granted account must NOT receive a second loadout');
    assert.equal(await itemCount(pool, character.id), 0,
      'no items must have been inserted on the reconnect that follows a sale');
  } finally {
    if (user != null) await pool.query('DELETE FROM users WHERE id = $1', [user]).catch(() => {});
    await pool.end().catch(() => {});
  }
});

// The second live route to the same exploit: drop (not sell) both items,
// reconnect to get a fresh pair, then walk back and re-claim the originals
// within their TTL — net +2 items per reconnect. Root cause is identical
// (an emptied player_items table), so the same DELETE-then-regrant-attempt
// shape closes it too; this test names the drop path explicitly rather than
// assuming the sell-path test above covers it by similarity.
test('grantStartingLoadout against a REAL database: the drop-and-reconnect route is also closed', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = skipMsg('the F-013 drop-and-reconnect regression', pool.unreachable);
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  let user;
  let character;
  let expectedItems;
  try {
    ({ userId: user, character } = await createTestCharacter(pool, 'drop-reconnect'));
    expectedItems = await loadoutSize(pool, character.entityTypeId);
    const itemTypes = await loadItemTypes(pool);

    const firstGrant = await grantStartingLoadout(pool, character, itemTypes);
    assert.equal(firstGrant, true);
    const r = await pool.query('SELECT id FROM player_items WHERE character_id = $1', [character.id]);
    assert.equal(r.rows.length, expectedItems);

    // dropItem (src/authority/loot.js) DELETEs the player_items row per
    // dropped instance and inserts a world_items row instead; the
    // player_items side of that is what matters here.
    for (const row of r.rows) {
      await pool.query('DELETE FROM player_items WHERE id = $1 AND character_id = $2', [row.id, character.id]);
    }
    assert.equal(await itemCount(pool, character.id), 0, 'setup: both items dropped, inventory empty');

    const secondGrant = await grantStartingLoadout(pool, character, itemTypes);
    assert.equal(secondGrant, false, 'drop-and-reconnect must not regrant either');
    assert.equal(await itemCount(pool, character.id), 0);
  } finally {
    if (user != null) await pool.query('DELETE FROM users WHERE id = $1', [user]).catch(() => {});
    await pool.end().catch(() => {});
  }
});

// Two joins racing on the same fresh account (two sockets, same account,
// both arriving before either has stamped the grant) must not double-grant.
// Assert on the resulting item count, never on which call "won" — that
// ordering is nondeterministic and asserting on it would make the test
// flaky rather than meaningful.
test('grantStartingLoadout against a REAL database: two concurrent joins on a fresh account grant exactly one loadout', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = skipMsg('the F-013 concurrency guard', pool.unreachable);
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  let user;
  let character;
  let expectedItems;
  try {
    ({ userId: user, character } = await createTestCharacter(pool, 'concurrent'));
    expectedItems = await loadoutSize(pool, character.entityTypeId);
    const itemTypes = await loadItemTypes(pool);

    const [g1, g2] = await Promise.all([
      grantStartingLoadout(pool, character, itemTypes),
      grantStartingLoadout(pool, character, itemTypes),
    ]);

    // Exactly one loadout's worth of items must exist, regardless of which
    // call reports true.
    assert.equal(await itemCount(pool, character.id), expectedItems,
      `two concurrent joins must grant exactly one loadout (${expectedItems} items), `
      + `not ${expectedItems * 2}`);
    assert.equal([g1, g2].filter(Boolean).length, 1, 'exactly one of the two racing calls must report granted=true');
  } finally {
    if (user != null) await pool.query('DELETE FROM users WHERE id = $1', [user]).catch(() => {});
    await pool.end().catch(() => {});
  }
});

test('grantStartingLoadout against a REAL database: an account backfilled as already-granted gets nothing on join', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = skipMsg('the F-013 backfill contract', pool.unreachable);
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  let user;
  let character;
  let expectedItems;
  try {
    ({ userId: user, character } = await createTestCharacter(pool, 'backfilled'));
    expectedItems = await loadoutSize(pool, character.entityTypeId);
    // Simulate what the migration's backfill does to every pre-existing
    // account: stamp the column without ever having inserted player_items
    // rows through grantStartingLoadout itself (an existing character may
    // have obtained its items some other way, or none at all — the backfill
    // doesn't care, it only marks it as already handled). The stamp moved from
    // users to characters in SOMET-257 for exactly this reason: the loadout is
    // class-dependent, so it is a fact about the character, not the account.
    await pool.query('UPDATE characters SET starting_loadout_granted_at = now() WHERE id = $1', [character.id]);
    assert.equal(await itemCount(pool, character.id), 0, 'setup: backfilled account owns nothing yet');

    const itemTypes = await loadItemTypes(pool);
    const granted = await grantStartingLoadout(pool, character, itemTypes);

    assert.equal(granted, false, 'a backfilled character must not be re-kitted on its next join');
    void expectedItems;
    assert.equal(await itemCount(pool, character.id), 0);
  } finally {
    if (user != null) await pool.query('DELETE FROM users WHERE id = $1', [user]).catch(() => {});
    await pool.end().catch(() => {});
  }
});
