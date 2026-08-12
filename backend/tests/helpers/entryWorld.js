const { setEntryWorld } = require('../../src/services/entryWorld.js');
const { withAdvisoryLock } = require('./advisoryLock.js');

// Any fixed integer; it only has to be the same in every process.
const ENTRY_LOCK_KEY = 626526517;

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
//
// The lock-acquire/release mechanics (own connection, try-in-a-loop with a
// bounded wait, loud degrade-to-unlocked past the deadline) live in
// advisoryLock.js now, shared with SOMET-255's catalog-row lock. Only the
// save/restore behaviour above is specific to this file.
async function withEntryPreserved(pool, fn) {
  return withAdvisoryLock(pool, ENTRY_LOCK_KEY, async () => {
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
  });
}

module.exports = { withEntryPreserved, ENTRY_LOCK_KEY };
