// SOMET-155 (defect 2): claimGold must back off after a failed claim, exactly
// as claimItem does.
//
// The auto-loot sweep in server.js re-issues a claim for every ground item in
// pickup range on EVERY tick (20 Hz) for as long as the item is in range and
// still in the sim. claimGold used to be a bare try/finally that always released
// `entry.claiming`, so a DB failure was retried ~20 times a second per player —
// the exact storm SOMET-96's CLAIM_BACKOFF_MS was added to stop, applied to the
// item path but never to the currency path.
//
// These assert on OBSERVED QUERY TRAFFIC (how many times the pool is actually
// hit while the DB is down), not on SQL text or on internal bookkeeping fields.
const test = require('node:test');
const assert = require('node:assert');
const { claimItem, claimGold } = require('../src/authority/loot');

// A minimal world entry, deliberately WITHOUT a claimRetryAt map: that mirrors
// every hand-built entry in this repo (tests and server.js's own world entries),
// so the lazily-created map is exercised rather than handed to the code.
function entryWith(player = { gold: 0 }) {
  const removed = [];
  return {
    claiming: new Set(),
    world: {
      groundItems: { remove: (id) => removed.push(id) },
      getPlayer: () => player,
    },
    _removed: removed,
  };
}

// A pool whose behaviour is switchable, counting every query it receives.
function countingPool() {
  const p = {
    calls: 0,
    fail: true,
    result: { rowCount: 1, rows: [{ gold: 15 }] },
    query: async () => {
      p.calls += 1;
      if (p.fail) throw new Error('ECONNREFUSED: database is unreachable');
      return p.result;
    },
  };
  return p;
}

// Replays what the 20 Hz auto-loot sweep does: one claim attempt per tick, on
// the same ground item, for `ticks` ticks of 50 ms each.
async function sweep(claim, ticks, startMs) {
  let t = startMs;
  let attempted = 0;
  for (let i = 0; i < ticks; i++) {
    attempted += 1;
    try {
      await claim(() => t);
    } catch {
      // The auto-loot caller catches and logs; that is not what's under test.
    }
    t += 50;
  }
  return { attempted, endMs: t };
}

test('a failing claimGold is retried once per second, not once per tick', async () => {
  const pool = countingPool();
  const entry = entryWith();
  const start = 1_000_000;

  // Two full seconds of a player standing on a coin pile with auto-loot on
  // while the database is down.
  const { attempted } = await sweep(
    (now) => claimGold(pool, entry, 'u1', 'g1', { now }), 40, start,
  );

  assert.equal(attempted, 40, 'the sweep itself must issue one call per tick — otherwise this proves nothing');
  assert.ok(pool.calls <= 3,
    `claimGold hit the database ${pool.calls} times across 2s of failing ticks; `
    + 'the 1s backoff allows at most ~3 (the initial attempt plus one per elapsed second)');
  assert.ok(pool.calls >= 2, `only ${pool.calls} queries in 2s — the backoff must EXPIRE, not latch forever`);
});

test('claimGold backs off no harder than claimItem does over the same failing ticks', async () => {
  // The requirement is parity with the item path, so measure both under an
  // identical sweep instead of hard-coding an expected count for one of them.
  const goldPool = countingPool();
  const itemPool = countingPool();
  const goldEntry = entryWith();
  const itemEntry = entryWith();
  const start = 5_000_000;

  await sweep((now) => claimGold(goldPool, goldEntry, 'u1', 'g1', { now }), 40, start);
  await sweep((now) => claimItem(itemPool, itemEntry, 'u1', 'c1', 'i1', { now }), 40, start);

  assert.equal(goldPool.calls, itemPool.calls,
    `gold path issued ${goldPool.calls} queries where the item path issued ${itemPool.calls} `
    + 'over identical failing ticks — the two claim paths must share one backoff discipline');
});

test('the backoff blocks only until it expires — the next attempt goes through and credits the wallet', async () => {
  const pool = countingPool();
  const player = { gold: 10 };
  const entry = entryWith(player);
  const t0 = 2_000_000;

  await assert.rejects(() => claimGold(pool, entry, 'u1', 'g1', { now: () => t0 }));
  assert.equal(pool.calls, 1);

  // Inside the cooldown: refused without touching the database, and reported as
  // "nothing claimed" rather than as another failure.
  assert.equal(await claimGold(pool, entry, 'u1', 'g1', { now: () => t0 + 999 }), null);
  assert.equal(pool.calls, 1, 'a claim inside the cooldown must not reach the database');

  // Cooldown served, and the database is healthy again.
  pool.fail = false;
  const got = await claimGold(pool, entry, 'u1', 'g1', { now: () => t0 + 1000 });
  assert.deepEqual(got, { gold: 15 }, 'the claim after the cooldown must actually run and credit the wallet');
  assert.equal(pool.calls, 2);
  assert.equal(player.gold, 15, 'in-memory wallet mirrors the DB');
  assert.deepEqual(entry._removed, ['g1'], 'ground item evicted from the sim on success');
});

test('a successful claim leaves no backoff or in-flight mark behind for the next pile', async () => {
  const pool = countingPool();
  pool.fail = false;
  const entry = entryWith();
  const now = () => 3_000_000;

  assert.deepEqual(await claimGold(pool, entry, 'u1', 'g1', { now }), { gold: 15 });
  // A second, different pile in the very next tick must not be blocked by the
  // first one's bookkeeping.
  assert.deepEqual(await claimGold(pool, entry, 'u1', 'g2', { now }), { gold: 15 });
  assert.equal(pool.calls, 2, 'both piles must be claimed; neither may be starved by a stale mark');
});

test('a lost race (row already gone) is not treated as a failure and starts no backoff', async () => {
  const pool = countingPool();
  pool.fail = false;
  pool.result = { rowCount: 0, rows: [] };
  const entry = entryWith();
  const now = () => 4_000_000;

  assert.equal(await claimGold(pool, entry, 'u1', 'g1', { now }), null);
  assert.deepEqual(entry._removed, ['g1'], 'the stale sim row must still be evicted');
  // Same id again: a lost race must clear the mark outright (the row is gone
  // from the sim anyway), so nothing is left latched.
  assert.equal(await claimGold(pool, entry, 'u1', 'g1', { now }), null);
  assert.equal(pool.calls, 2, 'a lost race must not install a cooldown');
});
