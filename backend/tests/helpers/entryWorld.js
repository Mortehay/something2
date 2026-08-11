const { setEntryWorld } = require('../../src/services/entryWorld.js');

// Save whichever world is currently is_entry, run fn, restore it.
//
// ONE implementation, shared. There were two copies -- seed_map_db.test.js and
// seed_map_vault_chests_db.test.js -- and two copies of this particular helper
// is not a style problem, it is the bug:
//
//   node --test runs FILES IN PARALLEL, and both files apply a map spec, which
//   moves is_entry to the spec's own entry world. Interleave them and file B
//   snapshots the entry world while file A has it pointed at file A's throwaway
//   world. File A restores the real one and then DELETES its throwaway in
//   cleanup. File B then "restores" to that now-deleted id -- and the old
//   restore statement cleared every is_entry row and set none, because the
//   target no longer existed. Result: ZERO entry worlds, permanently, and
//   auto-join silently dead for every player with no last world.
//
// That is the most plausible account of SOMET-265, and it matches the
// intermittency: it needs two spec-applying files to interleave, which only
// became possible when the chests work added a second one.
//
// The restore goes through services/entryWorld.js, whose UPDATE is guarded by
// an EXISTS on the target. A vanished target is now a NO-OP rather than a
// wipe, so the worst case of losing this race is "someone else's entry world
// stays set" instead of "nobody's does".
async function withEntryPreserved(pool, fn) {
  const before = await pool.query('SELECT id FROM worlds WHERE is_entry = true');
  const beforeId = before.rows[0] ? before.rows[0].id : null;
  try {
    return await fn();
  } finally {
    // beforeId === null means there was nothing to preserve, and setEntryWorld
    // no-ops on it -- deliberately NOT "clear everything", which is what the
    // old COALESCE(id = $1, false) form did and is the failure being removed.
    if (beforeId != null) await setEntryWorld(pool, beforeId);
  }
}

module.exports = { withEntryPreserved };
