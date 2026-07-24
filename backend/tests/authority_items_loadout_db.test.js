const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { loadItemTypes, grantStartingLoadout, STARTING_LOADOUT } = require('../src/authority/items.js');

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
    return pool;
  } catch (err) {
    await pool.end().catch(() => {});
    return { unreachable: err.message };
  }
}

async function createTestUser(pool, tag) {
  const username = `loadout-db-test-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const r = await pool.query(
    `INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'player') RETURNING id`,
    [username],
  );
  return r.rows[0].id;
}

async function itemCount(pool, userId) {
  const r = await pool.query('SELECT count(*)::int AS n FROM player_items WHERE user_id = $1', [userId]);
  return r.rows[0].n;
}

async function grantedAt(pool, userId) {
  const r = await pool.query('SELECT starting_loadout_granted_at FROM users WHERE id = $1', [userId]);
  return r.rows[0].starting_loadout_granted_at;
}

function skipMsg(what) {
  return `NO DATABASE at ${DB_URL} — ${what} is UNVERIFIED on this run`;
}

test('grantStartingLoadout against a REAL database: first join on a fresh account grants the loadout and stamps the account', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = skipMsg('the F-013 fix');
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  let user;
  try {
    user = await createTestUser(pool, 'fresh');
    assert.equal(await grantedAt(pool, user), null, 'setup: a brand-new account starts unclaimed');

    const itemTypes = await loadItemTypes(pool);
    const granted = await grantStartingLoadout(pool, user, itemTypes);

    assert.equal(granted, true);
    assert.equal(await itemCount(pool, user), STARTING_LOADOUT.length);
    assert.ok(await grantedAt(pool, user) != null, 'starting_loadout_granted_at must be stamped after the grant');
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
    const msg = skipMsg('the F-013 exploit regression');
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  let user;
  try {
    user = await createTestUser(pool, 'sell-reconnect');
    const itemTypes = await loadItemTypes(pool);

    // First join: legitimately granted, as any fresh account would be.
    const firstGrant = await grantStartingLoadout(pool, user, itemTypes);
    assert.equal(firstGrant, true, 'setup: the first join must grant normally');
    assert.equal(await itemCount(pool, user), STARTING_LOADOUT.length);

    // Sell-and-reconnect route: a merchant sale (or dropItem, see below)
    // DELETEs the player_items rows directly, exactly like a real sale/drop
    // does. Simulated here without going through trade.js/loot.js because
    // those are irrelevant to what's under test: the ONLY thing that matters
    // is that player_items is empty again afterward, which is the state the
    // old code keyed the grant on.
    await pool.query('DELETE FROM player_items WHERE user_id = $1', [user]);
    assert.equal(await itemCount(pool, user), 0, 'setup: inventory is empty again, same as after a sale');

    // Reconnect: the join handler's own gate (server.js) is "inventory
    // empty -> try to grant" — call grantStartingLoadout exactly as it does.
    const secondGrant = await grantStartingLoadout(pool, user, itemTypes);

    assert.equal(secondGrant, false,
      'THE EXPLOIT: an emptied-but-previously-granted account must NOT receive a second loadout');
    assert.equal(await itemCount(pool, user), 0,
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
    const msg = skipMsg('the F-013 drop-and-reconnect regression');
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  let user;
  try {
    user = await createTestUser(pool, 'drop-reconnect');
    const itemTypes = await loadItemTypes(pool);

    const firstGrant = await grantStartingLoadout(pool, user, itemTypes);
    assert.equal(firstGrant, true);
    const r = await pool.query('SELECT id FROM player_items WHERE user_id = $1', [user]);
    assert.equal(r.rows.length, STARTING_LOADOUT.length);

    // dropItem (src/authority/loot.js) DELETEs the player_items row per
    // dropped instance and inserts a world_items row instead; the
    // player_items side of that is what matters here.
    for (const row of r.rows) {
      await pool.query('DELETE FROM player_items WHERE id = $1 AND user_id = $2', [row.id, user]);
    }
    assert.equal(await itemCount(pool, user), 0, 'setup: both items dropped, inventory empty');

    const secondGrant = await grantStartingLoadout(pool, user, itemTypes);
    assert.equal(secondGrant, false, 'drop-and-reconnect must not regrant either');
    assert.equal(await itemCount(pool, user), 0);
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
    const msg = skipMsg('the F-013 concurrency guard');
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  let user;
  try {
    user = await createTestUser(pool, 'concurrent');
    const itemTypes = await loadItemTypes(pool);

    const [g1, g2] = await Promise.all([
      grantStartingLoadout(pool, user, itemTypes),
      grantStartingLoadout(pool, user, itemTypes),
    ]);

    // Exactly one loadout's worth of items must exist, regardless of which
    // call reports true.
    assert.equal(await itemCount(pool, user), STARTING_LOADOUT.length,
      `two concurrent joins must grant exactly one loadout (${STARTING_LOADOUT.length} items), `
      + `not ${STARTING_LOADOUT.length * 2}`);
    assert.equal([g1, g2].filter(Boolean).length, 1, 'exactly one of the two racing calls must report granted=true');
  } finally {
    if (user != null) await pool.query('DELETE FROM users WHERE id = $1', [user]).catch(() => {});
    await pool.end().catch(() => {});
  }
});

test('grantStartingLoadout against a REAL database: an account backfilled as already-granted gets nothing on join', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = skipMsg('the F-013 backfill contract');
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  let user;
  try {
    user = await createTestUser(pool, 'backfilled');
    // Simulate what the migration's backfill does to every pre-existing
    // account: stamp the column without ever having inserted player_items
    // rows through grantStartingLoadout itself (an existing account may
    // have obtained its items some other way, or none at all — the backfill
    // doesn't care, it only marks the account as already handled).
    await pool.query('UPDATE users SET starting_loadout_granted_at = now() WHERE id = $1', [user]);
    assert.equal(await itemCount(pool, user), 0, 'setup: backfilled account owns nothing yet');

    const itemTypes = await loadItemTypes(pool);
    const granted = await grantStartingLoadout(pool, user, itemTypes);

    assert.equal(granted, false, 'a backfilled account must not be re-kitted on its next join');
    assert.equal(await itemCount(pool, user), 0);
  } finally {
    if (user != null) await pool.query('DELETE FROM users WHERE id = $1', [user]).catch(() => {});
    await pool.end().catch(() => {});
  }
});
