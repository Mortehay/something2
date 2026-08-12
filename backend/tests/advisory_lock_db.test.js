const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { withAdvisoryLock } = require('./helpers/advisoryLock.js');

// SOMET-255: withAdvisoryLock is the primitive entryWorld.js's
// withEntryPreserved is now built on, and that seed_catalogs_db.test.js /
// creature_drops_db.test.js also use directly to serialize their
// catalog-touching sections against each other. Nothing exercised the LOCK
// itself before this file -- entry_world.test.js and p5_restore_entry.test.js
// both test withEntryPreserved's save/restore behaviour, never that two
// overlapping callers actually take turns. This proves the one property the
// whole SOMET-255 fix depends on: same key serializes, different key does not.
//
// Gated exactly like the other *_db.test.js files: a real Postgres connection
// is required to take a real advisory lock, so this skips cleanly without
// TEST_DATABASE_URL and fails loudly under CI instead.
const DB_URL = process.env.TEST_DATABASE_URL
  || 'postgres://user:password@localhost:15432/game_db';

async function openPool() {
  const pool = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 2000, max: 4 });
  try { await pool.query('SELECT 1'); return pool; }
  catch (err) { await pool.end().catch(() => {}); return { unreachable: err.message }; }
}

function requireTestDb(t, why) {
  if (!process.env.TEST_DATABASE_URL) {
    const msg = `TEST_DATABASE_URL not set -- skipping to avoid mutating a real database (${why})`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return false;
  }
  return true;
}

function sleep(ms) { return new Promise((res) => { setTimeout(res, ms); }); }

test('two withAdvisoryLock calls with the SAME key never run their critical sections concurrently', async (t) => {
  if (!requireTestDb(t, 'takes a real pg_try_advisory_lock')) return;
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} (${pool.unreachable}) — lock serialization is UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  // A fixed integer distinct from every lock key used by real test files
  // (ENTRY_LOCK_KEY 626526517, CATALOG_LOCK_KEY 748213905) so this test can
  // never collide with -- or be serialized by -- production test locks.
  const KEY = 913054228;
  const events = [];
  try {
    const a = withAdvisoryLock(pool, KEY, async () => {
      events.push('A-start');
      await sleep(150);
      events.push('A-end');
    });
    // Give A a head start so it is the one holding the lock when B tries.
    await sleep(20);
    const b = withAdvisoryLock(pool, KEY, async () => {
      events.push('B-start');
      await sleep(150);
      events.push('B-end');
    });
    await Promise.all([a, b]);

    // If the lock actually serialized the two sections, whichever ran first
    // must fully finish (its -end) before the other's -start appears. An
    // interleaved order (e.g. A-start, B-start, A-end, B-end) is exactly the
    // race the lock exists to prevent.
    const first = events[0].split('-')[0];
    const second = first === 'A' ? 'B' : 'A';
    assert.deepEqual(events, [`${first}-start`, `${first}-end`, `${second}-start`, `${second}-end`],
      `same-key calls interleaved instead of serializing: ${events.join(', ')}`);
  } finally {
    await pool.end();
  }
});

test('two withAdvisoryLock calls with DIFFERENT keys do not block each other', async (t) => {
  if (!requireTestDb(t, 'takes a real pg_try_advisory_lock')) return;
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} (${pool.unreachable}) — lock independence is UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  const KEY_A = 913054229;
  const KEY_B = 913054230;
  const events = [];
  try {
    const a = withAdvisoryLock(pool, KEY_A, async () => {
      events.push('A-start');
      await sleep(150);
      events.push('A-end');
    });
    await sleep(20);
    const b = withAdvisoryLock(pool, KEY_B, async () => {
      events.push('B-start');
      await sleep(150);
      events.push('B-end');
    });
    await Promise.all([a, b]);

    // Unlocked-by-each-other means B starts (and A is still mid-sleep, not
    // yet ended) before A ends -- the two run concurrently.
    const bStart = events.indexOf('B-start');
    const aEnd = events.indexOf('A-end');
    assert.ok(bStart < aEnd,
      `different-key calls serialized instead of running concurrently: ${events.join(', ')}`);
  } finally {
    await pool.end();
  }
});
