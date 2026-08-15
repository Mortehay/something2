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
// SOMET-275: was 30000. `npm test` runs every file with a per-file
// --test-timeout, so a single acquisition that used the full old budget
// already guaranteed the file blew its own timeout -- the "give up and run
// unguarded, loudly" fallback below could never actually fire; the test runner
// killed the file first. seed_map_db.test.js alone calls withEntryPreserved
// (this lock) NINE times in one run, sharing ENTRY_LOCK_KEY with
// entry_world.test.js, chests_integration_db.test.js, seed_map_portals.test.js,
// and seed_map_vault_chests_db.test.js -- under full-suite parallel load (218
// files) that is enough serialized queueing on one global key to eat a whole
// per-file budget well before any single wait reaches 30s. 6s keeps any one
// acquisition from being able to consume the entire per-file timeout by
// itself, so degrade-to-unguarded gets a real chance to run instead of the
// file just dying.
//
// SOMET-345 raised that per-file budget from 20000 to 60000 (bcrypt at cost 12
// is ~547ms a hash, and auth_routes.test.js makes 17 auth calls, so it took
// >20s under heavy parallel load). 6000 is deliberately NOT re-derived from the
// new number: nine sequential waits of 6s is 54s, which would fill even the
// larger budget, and the value's real job is to bound ONE acquisition well
// below whatever the budget is. It is stated as an absolute here rather than a
// fraction so that reading this file tells you what it does without having to
// go and look up package.json.
const LOCK_WAIT_MS = 6000;
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
