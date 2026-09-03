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
//
// `waitMs` overrides LOCK_WAIT_MS for ONE call. It exists because 6000 is
// calibrated for a caller whose guarded section is a handful of queries, and
// seedPassiveTree() alone is ~1800 upserts plus a full edge reconcile -- one
// holder legitimately occupies the key for the better part of ten seconds, so
// every peer times out and degrades to unguarded, which is exactly the race
// the key was taken to prevent. A caller that KNOWS its peers are slow says so
// here rather than everyone paying a bigger global default.
async function withAdvisoryLock(pool, lockKey, fn, { waitMs = LOCK_WAIT_MS } = {}) {
  const connectionString = pool.options && pool.options.connectionString;
  const locker = connectionString ? new Client({ connectionString }) : null;
  let locked = false;

  if (locker) {
    await locker.connect();
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const r = await locker.query('SELECT pg_try_advisory_lock($1) AS got', [lockKey]);
      if (r.rows[0].got) { locked = true; break; }
      await new Promise((res) => { setTimeout(res, POLL_INTERVAL_MS); });
    }
    if (!locked) {
      console.error(
        `withAdvisoryLock(${lockKey}): could not take the lock in ${waitMs}ms -- `
        + 'running unguarded; the section this lock protects may race with a peer holding it.',
      );
    }
  }

  try {
    // fn is told WHETHER it is actually guarded (SOMET-357).
    //
    // The degrade above is the right call for a writer -- a racy write is
    // recoverable, a hung suite is not -- but it is silently wrong for a READER
    // that asserts an invariant over the whole database. Such a reader running
    // unguarded can observe another file's mid-apply state and report a defect
    // that does not exist, which is exactly what happened to
    // villageScreenBudget_db.test.js: it saw a throwaway fixture holding
    // is_entry and failed with "the entry world must have exactly one village".
    //
    // Passing `locked` rather than throwing keeps this a decision the CALLER
    // makes, because the two kinds of caller genuinely want opposite things.
    // Every existing caller ignores the argument and keeps the old behaviour.
    return await fn({ locked });
  } finally {
    if (locker) {
      if (locked) await locker.query('SELECT pg_advisory_unlock($1)', [lockKey]).catch(() => {});
      await locker.end().catch(() => {});
    }
  }
}

// SOMET-532. THE READER'S WRAPPER: refuse rather than degrade.
//
// withAdvisoryLock above proceeds UNGUARDED past its deadline, and for a writer
// that is the right call -- a racy write is recoverable, a hung suite is not.
// For a READER asserting an invariant over the whole database it is silently
// wrong: unguarded means reading in exactly the mid-mutation window the lock
// exists to exclude, and then reporting a defect that does not exist.
//
// That is measured, not hypothetical. In the 2594-test run on 2026-08-16 the
// suite logged exactly one `could not take the lock in 6000ms` and that same
// run failed with `the entry world "zzTestWpA" must have exactly one village
// ... got 0` -- zzTestWpA being a peer's fixture, mid-apply. One degrade, one
// false failure, same key. That red was then cited as evidence in SOMET-341
// and sent a reader looking for a bug that was never there.
//
// SKIPPING is the honest verdict, not failing. An unguarded snapshot cannot
// distinguish "the invariant is broken" from "someone else's fixture is halfway
// through being applied", and a red meaning the second is worse than no result
// at all. The skip carries a reason so a run that quietly loses this coverage
// still says so out loud.
//
// Deliberately NOT retried: each acquisition already costs up to LOCK_WAIT_MS,
// and a couple of retries would approach a file's whole timeout on their own.
//
// This lives here rather than in each reader because it was written twice
// before it was written once -- villageScreenBudget_db.test.js carried the only
// copy, and creature_drops_db.test.js (a pure reader over the same catalog
// rows seed_catalogs_db mutates) silently kept the degrading behaviour. Two
// copies of a guard is how one of them gets forgotten.
async function readingUnderLock(pool, lockKey, t, fn, opts = {}) {
  return withAdvisoryLock(pool, lockKey, async ({ locked }) => {
    if (!locked) {
      t.skip(`could not take advisory lock ${lockKey} -- a peer is mid-mutation, `
        + 'so a whole-database invariant cannot be read consistently here');
      return undefined;
    }
    return fn();
  }, opts);
}

// SOMET-477: a third shared-state key, distinct from entryWorld.js's
// ENTRY_LOCK_KEY (626526517) and seed_catalogs_db.test.js's CATALOG_LOCK_KEY
// (748213905). Three files now run seedPassiveTree() against the same
// database in parallel processes, and a --force reseed from one of them
// rewrites the label/kind/grants another one just wrote and is about to
// assert on. Every file that calls seedPassiveTree, or that asserts on a
// label/grants value a reseed could rewrite, takes this key.
//
// Exported from here rather than re-declared per file so the three cannot
// drift onto two different keys and silently stop excluding each other --
// which is the same failure the CATALOG_LOCK_KEY comment in
// creature_drops_db.test.js warns about, restated as a constant.
const PASSIVE_TREE_LOCK_KEY = 471477806;

// One seedPassiveTree() call is ~1800 upserts and a 2142-edge reconcile, and
// the guarded sections wrap several of them, so a holder can occupy this key
// for ~10s. With the 6s default every waiter degraded to unguarded and the
// three files raced anyway -- measured, not assumed. 45s is three holders'
// worth of headroom and still well inside the 60s per-file budget.
const PASSIVE_TREE_LOCK_WAIT_MS = 45000;

// SOMET-540: a fourth shared-state key, for the art_jobs queue.
//
// Two test files exercise that one table and BOTH are writers -- they delete
// rows to start clean, and `claim()` takes ANY queued job, not merely their
// own. Scoping each file's cleanup to its own subject keys would therefore not
// isolate them: file A's claimer would still take file B's jobs mid-test.
// Measured, not assumed -- both files pass alone and fail together.
//
// Exported from here for the same reason the other three are: two files that
// declared the key separately could drift onto different numbers and silently
// stop excluding each other.
const ART_JOBS_LOCK_KEY = 615204773;

module.exports = {
  withAdvisoryLock, readingUnderLock, LOCK_WAIT_MS,
  PASSIVE_TREE_LOCK_KEY, PASSIVE_TREE_LOCK_WAIT_MS, ART_JOBS_LOCK_KEY,
};
