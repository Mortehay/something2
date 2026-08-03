const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const {
  loadProgression, awardXp, allocateStat, respec, applyDeath, XP_SOURCES,
} = require('../src/services/progressionStore.js');
const C = require('../src/services/progressionConstants.js');

// Same skip-if-unreachable idiom as progression_migration.test.js and the
// authority_*_db.test.js suite: gated on TEST_DATABASE_URL alone (no
// DATABASE_URL fallback), so a bare `npm test` on a machine with a working
// dev database can never reach this file.
const DB_URL = process.env.TEST_DATABASE_URL
  || 'postgres://user:password@localhost:15432/game_db';

function requireTestDb(t, why) {
  if (!process.env.TEST_DATABASE_URL) {
    const msg = `TEST_DATABASE_URL not set -- skipping to avoid mutating a real database (${why})`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return false;
  }
  return true;
}

async function openPool() {
  const pool = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 2000, max: 4 });
  try { await pool.query('SELECT 1'); return pool; } catch (err) {
    await pool.end().catch(() => {});
    return { unreachable: err.message };
  }
}

// This suite writes to `users` and `player_progression`. There is no way to
// wrap every case in a single uncommitted transaction that a later ROLLBACK
// undoes: `respec` opens its OWN client via pool.connect() and the
// concurrent-allocation test needs two REAL, independent backend connections
// to observe the fixture at the same time -- an uncommitted row on one
// connection is invisible to any other connection under Postgres's default
// read-committed isolation. So instead of a rolled-back transaction, every
// test follows this repo's other real-database suites (see
// authority_items_loadout_db.test.js, authority_ammo_db.test.js): create one
// throwaway user per test with a unique, tagged username, then unconditionally
// delete it in a `finally` block. ON DELETE CASCADE from player_progression
// to users means the delete also removes whatever progression row the test
// created, even if the test failed partway through. Nothing outlives the
// test and no real account is ever touched.
async function createTestUser(pool, tag) {
  const username = `progression-store-test-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const r = await pool.query(
    `INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'player') RETURNING id`,
    [username],
  );
  return r.rows[0].id;
}

async function dropUser(pool, userId) {
  if (userId != null) await pool.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
}

function skipMsg(what) {
  return `NO DATABASE at ${DB_URL} -- ${what} is UNVERIFIED on this run`;
}

test('loadProgression creates a base row on first call and is idempotent', async (t) => {
  if (!requireTestDb(t, 'this test creates a throwaway user and a player_progression row')) return;
  const pool = await openPool();
  if (pool.unreachable) { const m = skipMsg('lazy row creation'); if (process.env.CI) assert.fail(m); t.skip(m); return; }
  let user;
  try {
    user = await createTestUser(pool, 'lazy');

    const first = await loadProgression(pool, user);
    const second = await loadProgression(pool, user);

    assert.deepEqual(first, second, 'two calls must return an identical row');
    assert.equal(first.level, 1);
    assert.equal(first.experience, 0);
    assert.equal(first.stat_points, 0);
    for (const k of C.STAT_KEYS) assert.equal(first[k], C.BASE_STAT, `${k} must start at the base stat`);

    const count = await pool.query('SELECT count(*)::int AS n FROM player_progression WHERE user_id = $1', [user]);
    assert.equal(count.rows[0].n, 1, 'exactly one row must exist after two lazy-create calls');
  } finally {
    await dropUser(pool, user);
    await pool.end().catch(() => {});
  }
});

test('awardXp levels up and grants the documented points', async (t) => {
  if (!requireTestDb(t, 'this test creates a throwaway user and awards XP')) return;
  const pool = await openPool();
  if (pool.unreachable) { const m = skipMsg('awardXp leveling'); if (process.env.CI) assert.fail(m); t.skip(m); return; }
  let user;
  try {
    user = await createTestUser(pool, 'xp-250');
    await loadProgression(pool, user); // start from level 1 / 0 xp

    // from level 1 / 0 xp, +250 xp -> level 2 (floor 100), not level 3 (floor 300)
    const r = await awardXp(pool, user, 250, 'kill');
    assert.equal(r.leveledUp, true);
    assert.equal(r.newLevel, 2);
    assert.equal(r.pointsGained, 3);
    // A NUMBER, not a string: experience is bigint and node-postgres returns
    // bigint as a string, but mapRow normalises it once at the boundary so no
    // caller can accidentally compute "0" + 10 === "010".
    assert.equal(r.progression.experience, 250);
    assert.strictEqual(typeof r.progression.experience, 'number');
  } finally {
    await dropUser(pool, user);
    await pool.end().catch(() => {});
  }
});

test('awardXp can cross more than one level at once', async (t) => {
  if (!requireTestDb(t, 'this test creates a throwaway user and awards a large XP grant')) return;
  const pool = await openPool();
  if (pool.unreachable) { const m = skipMsg('awardXp multi-level crossing'); if (process.env.CI) assert.fail(m); t.skip(m); return; }
  let user;
  try {
    user = await createTestUser(pool, 'xp-600');
    await loadProgression(pool, user); // start from level 1 / 0 xp

    // +600 from scratch -> level 4, 9 points (3 levels x 3)
    const r = await awardXp(pool, user, 600, 'kill');
    assert.equal(r.leveledUp, true);
    assert.equal(r.newLevel, 4);
    assert.equal(r.pointsGained, 9);
    assert.equal(r.progression.experience, 600);
  } finally {
    await dropUser(pool, user);
    await pool.end().catch(() => {});
  }
});

test('awardXp rejects an unknown source and writes nothing', async (t) => {
  if (!requireTestDb(t, 'this test creates a throwaway user and calls awardXp with a bogus source')) return;
  const pool = await openPool();
  if (pool.unreachable) { const m = skipMsg('unknown-source rejection'); if (process.env.CI) assert.fail(m); t.skip(m); return; }
  let user;
  try {
    user = await createTestUser(pool, 'xp-bogus-source');
    const before = await loadProgression(pool, user);
    const r = await awardXp(pool, user, 100, 'nonsense');
    assert.equal(r.awarded, 0);
    const after = await loadProgression(pool, user);
    assert.equal(after.experience, before.experience);
    assert.equal(after.level, before.level);
    assert.equal(after.stat_points, before.stat_points);
  } finally {
    await dropUser(pool, user);
    await pool.end().catch(() => {});
  }
});

test('awardXp ignores a non-positive amount', async (t) => {
  if (!requireTestDb(t, 'this test creates a throwaway user and awards zero/negative XP')) return;
  const pool = await openPool();
  if (pool.unreachable) { const m = skipMsg('non-positive amount rejection'); if (process.env.CI) assert.fail(m); t.skip(m); return; }
  let user;
  try {
    user = await createTestUser(pool, 'xp-nonpositive');
    const before = await loadProgression(pool, user);

    const zero = await awardXp(pool, user, 0, 'kill');
    assert.equal(zero.awarded, 0);
    assert.equal(zero.leveledUp, false);

    const negative = await awardXp(pool, user, -50, 'kill');
    assert.equal(negative.awarded, 0);
    assert.equal(negative.leveledUp, false);

    const after = await loadProgression(pool, user);
    assert.equal(after.experience, before.experience, 'a non-positive amount must write nothing');
  } finally {
    await dropUser(pool, user);
    await pool.end().catch(() => {});
  }
});

// Hazard #3: awardXp takes `db`, not `pool`, specifically so the kill path
// (Task 6) can call it INSIDE its own transaction and have the XP award
// stand or fall with the rest of that transaction. Prove it by running
// awardXp against a client mid-transaction, then rolling that transaction
// back, and showing the award never reached the table -- the only way that
// can happen is if awardXp really executed on the SAME session/transaction
// it was handed, rather than opening one of its own.
test('awardXp is callable inside the caller\'s own transaction and rolls back with it', async (t) => {
  if (!requireTestDb(t, 'this test creates a throwaway user and runs awardXp inside a caller-managed transaction')) return;
  const pool = await openPool();
  if (pool.unreachable) { const m = skipMsg('awardXp transactional callability'); if (process.env.CI) assert.fail(m); t.skip(m); return; }
  let user;
  const client = await pool.connect();
  try {
    user = await createTestUser(pool, 'xp-in-caller-txn');

    await client.query('BEGIN');
    const r = await awardXp(client, user, 300, 'kill');
    assert.equal(r.leveledUp, true, 'sanity: this grant does level the fresh row up');
    // Read back on the SAME client, inside the still-open transaction: the
    // write must be visible here even though nothing has committed yet.
    const midTxn = await client.query('SELECT experience FROM player_progression WHERE user_id = $1', [user]);
    assert.equal(Number(midTxn.rows[0].experience), 300);
    await client.query('ROLLBACK');

    // A fresh connection must see NOTHING: no row at all, because the lazy
    // INSERT that loadProgression issued was also part of the rolled-back
    // transaction.
    const after = await pool.query('SELECT count(*)::int AS n FROM player_progression WHERE user_id = $1', [user]);
    assert.equal(after.rows[0].n, 0, 'the award (and the lazy row it created) must not have survived the rollback');
  } finally {
    client.release();
    await dropUser(pool, user);
    await pool.end().catch(() => {});
  }
});

test('allocateStat spends points atomically', async (t) => {
  if (!requireTestDb(t, 'this test creates a throwaway user and races two concurrent allocations')) return;
  const pool = await openPool();
  if (pool.unreachable) { const m = skipMsg('atomic allocation'); if (process.env.CI) assert.fail(m); t.skip(m); return; }
  let user;
  try {
    user = await createTestUser(pool, 'allocate-race');
    await loadProgression(pool, user);
    await pool.query('UPDATE player_progression SET stat_points = 3 WHERE user_id = $1', [user]);

    // Fire TWO allocations of 2 CONCURRENTLY, via Promise.all against the
    // shared pool (max: 4 above) -- NOT awaited one after the other. `pool`
    // is passed directly to both calls, exactly as allocateStat's own
    // signature expects, so node-postgres checks each call out onto its own
    // idle physical connection and both UPDATEs are in flight at once. A
    // sequential pair (await one, then the other) would pass even with no
    // atomicity at all -- that exact vacuous shape has shipped on this repo
    // before (see authority_items_loadout_db.test.js's own note on this).
    const [a, b] = await Promise.all([
      allocateStat(pool, user, 'strength', 2),
      allocateStat(pool, user, 'strength', 2),
    ]);
    assert.equal([a.ok, b.ok].filter(Boolean).length, 1, 'exactly one must win');
    const after = await loadProgression(pool, user);
    assert.equal(after.stat_points, 1);
    assert.equal(after.strength, 7);
  } finally {
    await dropUser(pool, user);
    await pool.end().catch(() => {});
  }
});

test('allocateStat refuses an unknown stat key', async (t) => {
  if (!requireTestDb(t, 'this test creates a throwaway user and calls allocateStat with a bogus key')) return;
  const pool = await openPool();
  if (pool.unreachable) { const m = skipMsg('unknown stat key rejection'); if (process.env.CI) assert.fail(m); t.skip(m); return; }
  let user;
  try {
    user = await createTestUser(pool, 'allocate-badkey');
    await loadProgression(pool, user);
    await pool.query('UPDATE player_progression SET stat_points = 5 WHERE user_id = $1', [user]);

    const r = await allocateStat(pool, user, 'luck', 1);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'unknown stat');

    // A statKey that would be catastrophic if ever string-interpolated into
    // the UPDATE's column list. This must be refused by the whitelist
    // exactly like any other unknown key, and MUST NOT reach Postgres as
    // part of the SQL text.
    const injected = await allocateStat(pool, user, 'strength; DROP TABLE users; --', 1);
    assert.equal(injected.ok, false);
    assert.equal(injected.reason, 'unknown stat');

    const after = await loadProgression(pool, user);
    assert.equal(after.stat_points, 5, 'no points may be spent on a rejected key');
    // Prove the table survived, i.e. the injection attempt never ran as SQL.
    const stillThere = await pool.query('SELECT count(*)::int AS n FROM users WHERE id = $1', [user]);
    assert.equal(stillThere.rows[0].n, 1);
  } finally {
    await dropUser(pool, user);
    await pool.end().catch(() => {});
  }
});

test('allocateStat refuses a non-positive or non-integer count', async (t) => {
  if (!requireTestDb(t, 'this test creates a throwaway user and calls allocateStat with bad counts')) return;
  const pool = await openPool();
  if (pool.unreachable) { const m = skipMsg('invalid count rejection'); if (process.env.CI) assert.fail(m); t.skip(m); return; }
  let user;
  try {
    user = await createTestUser(pool, 'allocate-badcount');
    await loadProgression(pool, user);
    await pool.query('UPDATE player_progression SET stat_points = 5 WHERE user_id = $1', [user]);

    for (const bad of [0, -1, 1.5, NaN]) {
      const r = await allocateStat(pool, user, 'strength', bad);
      assert.equal(r.ok, false, `count ${bad} must be refused`);
      assert.equal(r.reason, 'invalid count');
    }

    const after = await loadProgression(pool, user);
    assert.equal(after.stat_points, 5, 'no points may be spent on any rejected count');
    assert.equal(after.strength, C.BASE_STAT);
  } finally {
    await dropUser(pool, user);
    await pool.end().catch(() => {});
  }
});

// Shared setup for both respec tests: a level-4 character (9 points granted
// by leveling) who has spent 5 of them into strength, leaving stat_points 4
// and strength 10. level is only ever raised by awardXp, so it's seeded
// directly here by UPDATE rather than by grinding XP through the API (per
// the task's ambiguity resolution). Cost is RESPEC_BASE * 4 = 200.
async function seedRespecCharacter(pool, user, gold) {
  await loadProgression(pool, user);
  await pool.query(
    'UPDATE player_progression SET level = 4, strength = 10, stat_points = 4 WHERE user_id = $1',
    [user],
  );
  await pool.query('UPDATE users SET gold = $2 WHERE id = $1', [user, gold]);
}

test('respec moves the gold and resets the stats in one transaction', async (t) => {
  if (!requireTestDb(t, 'this test creates a throwaway user, seeds a level-4 character and respecs it')) return;
  const pool = await openPool();
  if (pool.unreachable) { const m = skipMsg('successful respec'); if (process.env.CI) assert.fail(m); t.skip(m); return; }
  let user;
  try {
    user = await createTestUser(pool, 'respec-ok');
    await seedRespecCharacter(pool, user, 250);

    const r = await respec(pool, user);
    assert.equal(r.ok, true);
    assert.equal(r.cost, 200);
    assert.equal(r.gold, 50);
    assert.equal(r.progression.strength, 5);
    assert.equal(r.progression.stat_points, 9); // the 4 unspent plus the 5 refunded
    for (const k of C.STAT_KEYS) assert.equal(r.progression[k], C.BASE_STAT, `${k} must reset to base`);

    const g = await pool.query('SELECT gold FROM users WHERE id = $1', [user]);
    assert.equal(Number(g.rows[0].gold), 50, 'gold in the database must match the returned gold');
  } finally {
    await dropUser(pool, user);
    await pool.end().catch(() => {});
  }
});

test('respec with insufficient gold changes nothing at all', async (t) => {
  if (!requireTestDb(t, 'this test creates a throwaway user, seeds a level-4 character short on gold and attempts a respec')) return;
  const pool = await openPool();
  if (pool.unreachable) { const m = skipMsg('failed respec'); if (process.env.CI) assert.fail(m); t.skip(m); return; }
  let user;
  try {
    user = await createTestUser(pool, 'respec-poor');
    // same character, but 199 gold against a cost of 200
    await seedRespecCharacter(pool, user, 199);

    const r = await respec(pool, user);
    assert.equal(r.ok, false);
    assert.equal(r.cost, 200);

    const after = await loadProgression(pool, user);
    assert.equal(after.strength, 10, 'a failed payment must not yield a free respec');
    assert.equal(after.stat_points, 4, 'the points must not be refunded either');

    const g = await pool.query('SELECT gold FROM users WHERE id = $1', [user]);
    assert.equal(Number(g.rows[0].gold), 199, 'gold must not move');
  } finally {
    await dropUser(pool, user);
    await pool.end().catch(() => {});
  }
});

test('applyDeath never de-levels and persists the loss', async (t) => {
  if (!requireTestDb(t, 'this test creates a throwaway user, seeds progress into a level, and applies a death')) return;
  const pool = await openPool();
  if (pool.unreachable) { const m = skipMsg('death penalty application'); if (process.env.CI) assert.fail(m); t.skip(m); return; }
  let user;
  try {
    user = await createTestUser(pool, 'death-loss');
    await loadProgression(pool, user);
    // level 3 floor is 300 (XP_BASE * (3-1) * 3 / 2 = 300); 50 xp of progress
    // into the level. DEATH_PENALTY (0.25) * 50 = 12.5 -> floor 12 lost.
    await pool.query(
      'UPDATE player_progression SET level = 3, experience = 350 WHERE user_id = $1',
      [user],
    );

    const r = await applyDeath(pool, user);
    assert.equal(r.lost, 12);
    assert.equal(r.progression.experience, 338);
    assert.equal(r.progression.level, 3, 'death must never change level directly');
    assert.ok(r.progression.experience >= 300, 'the loss must never cross back below the level floor');
  } finally {
    await dropUser(pool, user);
    await pool.end().catch(() => {});
  }
});

test('applyDeath is a no-op at the very start of a level (zero progress to lose)', async (t) => {
  if (!requireTestDb(t, 'this test creates a throwaway user sitting exactly on a level floor and applies a death')) return;
  const pool = await openPool();
  if (pool.unreachable) { const m = skipMsg('zero-loss death penalty'); if (process.env.CI) assert.fail(m); t.skip(m); return; }
  let user;
  try {
    user = await createTestUser(pool, 'death-noloss');
    const before = await loadProgression(pool, user); // level 1, xp 0 -- exactly on the floor

    const r = await applyDeath(pool, user);
    assert.equal(r.lost, 0);
    assert.deepEqual(r.progression, before, 'nothing to lose means nothing changes');
  } finally {
    await dropUser(pool, user);
    await pool.end().catch(() => {});
  }
});

// Sanity check on the constants the store consumes, not on the store itself
// -- catches a silent drift between the brief's documented XP_SOURCES and
// what progressionStore.js actually exports.
test('XP_SOURCES matches the documented set', () => {
  assert.deepEqual(XP_SOURCES, ['kill', 'chest', 'dungeon_clear']);
});
