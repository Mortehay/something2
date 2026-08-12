const { Client } = require('pg');

// The lock primitive extracted out of entryWorld.js's withEntryPreserved
// (SOMET-265) so a second class of shared-state race (SOMET-255: catalog rows
// like entity_types/biomes, touched by seed_catalogs_db.test.js and read by
// creature_drops_db.test.js) can be serialized without duplicating the whole
// mechanism. entryWorld.js keeps its own save/restore logic and its own
// ENTRY_LOCK_KEY -- only the "take an advisory lock with a bounded wait, on my
// own connection" part is shared here.
//
// node --test runs FILES IN PARALLEL. Two files that both mutate the same
// catalog rows (e.g. one deletes+restores the Wolf entity_types row while the
// other asserts "every creature type has a drop rule") can interleave and one
// observes the other's mid-test, half-mutated state. Wrapping each file's
// catalog-touching section in withAdvisoryLock(pool, SAME_KEY, fn) makes those
// two sections mutually exclusive across processes, without serializing the
// whole suite -- unrelated files with no shared key still run fully parallel.
const LOCK_WAIT_MS = 30000;
const POLL_INTERVAL_MS = 50;

// Acquire a Postgres advisory lock keyed by `lockKey`, run fn(), then release.
//
// The lock is taken on a FRESH client, never the caller's own `pool` -- the
// callers here are built with `max: 2`, and holding one of those two
// connections for fn()'s whole duration would starve the caller's own
// queries inside fn(). A session-scoped advisory lock taken on its own
// connection is also released automatically if that connection drops, so a
// crashed test process cannot wedge every other test waiting on the same key.
//
// pg_try_advisory_lock, polled in a loop, rather than a blocking
// pg_advisory_lock: a blocking acquire turns "another test using this key is
// slow" into "the whole suite hangs until the runner's own timeout kills it".
// Past LOCK_WAIT_MS this proceeds WITHOUT the lock -- degraded to unguarded,
// and loud about it -- because a wrong/racy result here is recoverable
// (rerun the suite) and a hung suite is not.
//
// If `pool` was not built from a connectionString there is nothing to open a
// second connection with, so this runs fn() unlocked rather than failing the
// caller's test outright.
async function withAdvisoryLock(pool, lockKey, fn) {
  const connectionString = pool.options && pool.options.connectionString;
  const locker = connectionString ? new Client({ connectionString }) : null;
  let locked = false;

  if (locker) {
    await locker.connect();
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (Date.now() < deadline) {
      const r = await locker.query('SELECT pg_try_advisory_lock($1) AS got', [lockKey]);
      if (r.rows[0].got) { locked = true; break; }
      await new Promise((res) => { setTimeout(res, POLL_INTERVAL_MS); });
    }
    if (!locked) {
      console.error(
        `withAdvisoryLock(${lockKey}): could not take the lock in ${LOCK_WAIT_MS}ms -- `
        + 'running unguarded; the section this lock protects may race with a peer holding it.',
      );
    }
  }

  try {
    return await fn();
  } finally {
    if (locker) {
      if (locked) await locker.query('SELECT pg_advisory_unlock($1)', [lockKey]).catch(() => {});
      await locker.end().catch(() => {});
    }
  }
}

module.exports = { withAdvisoryLock, LOCK_WAIT_MS };
