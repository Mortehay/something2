const { Client } = require('pg');
const { setEntryWorld } = require('../../src/services/entryWorld.js');

// Any fixed integer; it only has to be the same in every process.
const ENTRY_LOCK_KEY = 626526517;
const LOCK_WAIT_MS = 30000;

// Save whichever world is currently is_entry, run fn, restore it -- and hold a
// Postgres advisory lock for the whole window so no other test process can be
// inside its own save/restore at the same time.
//
// ONE implementation, shared. There were two copies -- seed_map_db.test.js and
// seed_map_vault_chests_db.test.js -- and two copies of this particular helper
// is not a style problem, it is the bug:
//
//   node --test runs FILES IN PARALLEL, and SIX of them apply a map spec, which
//   moves is_entry to the spec's own entry world. Interleave them and file B
//   snapshots the entry world while file A has it pointed at file A's throwaway
//   world. File A restores the real one and then DELETES its throwaway in
//   cleanup. File B then "restores" to that now-deleted id -- and the old
//   restore statement cleared every is_entry row and set none, because the
//   target no longer existed. Result: ZERO entry worlds, permanently, and
//   auto-join silently dead for every player with no last world.
//
// THE SNAPSHOT ITSELF IS THE REMAINING HOLE, and guarding the restore does not
// close it. applyMapSpec CLEARS is_entry globally before setting the spec's
// own, so there is a real window in which the true entry world is simply not
// recorded anywhere. A second file that snapshots inside that window reads
// null, treats it as "nothing to preserve", and its restore correctly no-ops
// -- while its own apply has meanwhile pointed is_entry at a throwaway world
// that its cleanup then deletes. Zero entry worlds again, from two helpers
// both behaving exactly as written.
//
// Measured, not theorised: after the seed_map_db.test.js wrapping fix
// (b4f6d2e), a full `npm test` against the real dev database STILL ended with
// `SELECT count(*) FROM worlds WHERE is_entry` = 0. That fix was necessary and
// insufficient.
//
// So the save/restore pair is made mutually exclusive across processes. The
// lock is session-scoped and taken on its OWN connection, which matters twice:
// the callers' pools are `max: 2` and holding one of their connections for the
// duration of fn() would starve them, and a session-scoped lock is released
// automatically when the connection drops, so a crashed test cannot wedge the
// suite.
//
// The restore goes through services/entryWorld.js, whose UPDATE is guarded by
// an EXISTS on the target. A vanished target is a NO-OP rather than a wipe.
async function withEntryPreserved(pool, fn) {
  // Same database as the caller's pool, separate session. If the pool was not
  // built from a connectionString there is nothing to connect with, so fall
  // back to running unlocked rather than failing the caller's test outright.
  const connectionString = pool.options && pool.options.connectionString;
  const locker = connectionString ? new Client({ connectionString }) : null;
  let locked = false;

  if (locker) {
    await locker.connect();
    // try-in-a-loop rather than a blocking pg_advisory_lock: a plain blocking
    // acquire turns "another test is slow" into "the suite hangs until its
    // timeout". Past the deadline this proceeds WITHOUT the lock -- degraded
    // to the old behaviour, and loud about it -- because a wrong entry world
    // is recoverable and a hung suite is not.
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (Date.now() < deadline) {
      const r = await locker.query('SELECT pg_try_advisory_lock($1) AS got', [ENTRY_LOCK_KEY]);
      if (r.rows[0].got) { locked = true; break; }
      await new Promise((res) => { setTimeout(res, 50); });
    }
    if (!locked) {
      console.error(
        `withEntryPreserved: could not take the entry-world lock in ${LOCK_WAIT_MS}ms -- `
        + 'running unguarded; is_entry may be left wrong. Check '
        + 'SELECT count(*) FROM worlds WHERE is_entry after this run.',
      );
    }
  }

  try {
    const before = await pool.query('SELECT id FROM worlds WHERE is_entry = true');
    const beforeId = before.rows[0] ? before.rows[0].id : null;
    try {
      return await fn();
    } finally {
      // beforeId === null means there was nothing to preserve, and setEntryWorld
      // no-ops on it -- deliberately NOT "clear everything", which is what the
      // old COALESCE(id = $1, false) form did and is the failure being removed.
      // Under the lock, null now genuinely means "the database had no entry
      // world when we started" rather than "we looked during someone else's
      // apply".
      if (beforeId != null) await setEntryWorld(pool, beforeId);
    }
  } finally {
    if (locker) {
      if (locked) await locker.query('SELECT pg_advisory_unlock($1)', [ENTRY_LOCK_KEY]).catch(() => {});
      await locker.end().catch(() => {});
    }
  }
}

module.exports = { withEntryPreserved, ENTRY_LOCK_KEY };
