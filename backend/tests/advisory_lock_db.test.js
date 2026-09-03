const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { withAdvisoryLock, readingUnderLock } = require('./helpers/advisoryLock.js');

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

// ---------------------------------------------------------------------------
// SOMET-532: readingUnderLock -- a reader must REFUSE, never degrade.
//
// withAdvisoryLock proceeds unguarded past its deadline, which is right for a
// writer and silently wrong for a reader asserting a whole-database invariant:
// unguarded means reading in exactly the mid-mutation window the lock exists to
// exclude, then reporting a defect that does not exist.
//
// These take a REAL lock on a REAL second connection and let the deadline
// actually expire. A version using a stub lock would prove nothing about the
// primitive, which is the whole subject here.
// ---------------------------------------------------------------------------

// Holds `key` on its own connection until the returned release() is called, so
// the caller under test genuinely cannot acquire it.
async function holdKey(pool, key) {
  const client = await pool.connect();
  await client.query('SELECT pg_advisory_lock($1)', [key]);
  return async () => {
    await client.query('SELECT pg_advisory_unlock($1)', [key]).catch(() => {});
    client.release();
  };
}

test('readingUnderLock SKIPS its body when the key is held, rather than reading unguarded', async (t) => {
  if (!requireTestDb(t, 'takes a real pg_try_advisory_lock')) return;
  const pool = await openPool();
  if (pool.unreachable) { t.skip(`no database: ${pool.unreachable}`); return; }
  const KEY = 918273645;
  const release = await holdKey(pool, KEY);
  try {
    let ran = false;
    const skips = [];
    const fakeT = { skip: (m) => skips.push(m) };
    const out = await readingUnderLock(pool, KEY, fakeT, async () => { ran = true; return 'asserted'; },
      { waitMs: 300 });

    assert.equal(ran, false,
      'the reader body RAN while a peer held the key -- that is the unguarded read this exists to prevent');
    assert.equal(out, undefined, 'a refused read must not return a value that looks like a result');
    assert.equal(skips.length, 1, `expected exactly one skip, got ${skips.length}`);
    assert.match(skips[0], /could not take advisory lock 918273645/,
      'the skip must name the key, so a run that loses this coverage says which one');
  } finally {
    await release();
    await pool.end().catch(() => {});
  }
});

test('readingUnderLock runs its body normally when the key is free', async (t) => {
  if (!requireTestDb(t, 'takes a real pg_try_advisory_lock')) return;
  const pool = await openPool();
  if (pool.unreachable) { t.skip(`no database: ${pool.unreachable}`); return; }
  const KEY = 918273646;
  // The control. Without it the test above passes just as well against a
  // readingUnderLock that skips unconditionally, which would silently delete
  // the invariant it is supposed to protect.
  const skips = [];
  const fakeT = { skip: (m) => skips.push(m) };
  try {
    const out = await readingUnderLock(pool, KEY, fakeT, async () => 'asserted', { waitMs: 300 });
    assert.equal(out, 'asserted', 'an uncontended reader must actually run and return its result');
    assert.deepEqual(skips, [], 'an uncontended reader must not skip');
  } finally {
    await pool.end().catch(() => {});
  }
});
