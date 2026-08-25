const fs = require('node:fs');
const path = require('node:path');

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

// ---- THE READER SIDE OF THE SAME FLAG (SOMET-505) -------------------------
//
// withEntryPreserved above serializes the WRITERS: the files that borrow
// is_entry onto a world of their own and hand it back. This is for the other
// kind of file -- the live-join suites that need somewhere to put a brand new
// character, and that each found it with
//
//     SELECT id FROM worlds WHERE is_entry = true LIMIT 1
//
// six times over, once per file. That query does not name a world. It names
// whoever holds the flag at that instant, and a peer may then move the flag off
// that world AND delete it, so the id is wrong by the time the join frame goes
// out. Two symptoms, both measured on one scratch database during a full
// `npm test` by logging what class_pools_db.test.js snapshotted and re-reading
// the row afterwards:
//
//   * borrowed onto a THROWAWAY world, which its owner then DELETES. Caught
//     red-handed in two of four traced runs, e.g.
//         SNAPSHOT 20:23:06.992  zz Chest Integration World [18b7d739...]
//         AFTER    20:23:07.564  exists=0
//     chests_integration_db.test.js declares `is_entry: true` on its fixture
//     spec, so applyMapSpec's setEntryWorld (scripts/seed-map.js) moves the
//     flag for the ~200ms its guarded section lasts, and its cleanup then runs
//     DELETE FROM worlds WHERE name = 'zz Chest Integration World'. loadWorld
//     returns null and the authority answers `unknown world`. The same shape
//     was observed from zzLinkA, zzTestAlpha, zzTestMoveVillage,
//     zzTestMultiVillage, zz Vault Chest World and Portal Test Surface, with
//     windows between 0.02s and 1.44s.
//
//   * borrowed onto a REAL world, which survives. seed_map_db.test.js's "every
//     shipped spec applies cleanly" applies every checked-in spec in readdir
//     order, so p5-descent lands before vale-region and `The Catacombs: Entry`
//     holds the flag until vale-region takes it back -- measured at 46 and 47
//     SECONDS of a ~300s run. Nothing is deleted, so loadWorld succeeds and it
//     is joinPolicy that refuses: `not-reachable`, on the wire as `you cannot
//     travel there`.
//
// THE ADVISORY LOCK CANNOT FIX THIS ONE, and that is measured rather than
// argued. withAdvisoryLock gives up after LOCK_WAIT_MS (6s) and runs the body
// unguarded, loudly, because a hung suite is worse than a racy one. The largest
// borrow window is that 47-second one -- eight times the wait -- and it is held
// by a writer that takes ENTRY_LOCK_KEY correctly. A reader that took the same
// key would time out, degrade to unguarded, and read exactly the borrowed row
// it took the lock to avoid. Raising the wait is not the answer either: it is
// bounded precisely so one slow holder cannot eat a whole file's timeout.
//
// So the reference is taken off something no concurrently-running peer can
// move: the checked-in map specs, which are the source of truth for where a
// player may start. entry_world_egress_db.test.js stopped trusting the live
// flag first, for this reason and in almost these words.
//
// `allows_fast_travel` is what makes the JOIN stable, not merely the id.
// joinPolicy's first-join leg is
//
//     if (!facts.hasHistory && (facts.isEntry || facts.allowsFastTravel))
//
// and allows_fast_travel is a PER-WORLD column that no test writes, where
// is_entry is globally exclusive by construction and is borrowed constantly. A
// fresh character is therefore authorized into this world by the REAL policy
// wherever the flag happens to be sitting. That leg is not a loophole opened
// for the tests: joinPolicy.js documents it as existing because is_entry has
// been lost from live data before (SOMET-265) and new characters must stay
// playable when it is. Requiring it here turns what would otherwise be a silent
// timing dependency into a stated precondition that fails with a reason.
const SPEC_DIR = path.join(__dirname, '..', '..', 'seeds', 'maps');

// The NAME of the world a live-join test should put a fresh character in, read
// off the checked-in specs. Exactly one is expected; anything else is a change
// to the shipped maps that a human has to look at, not something to guess past.
function joinableEntryWorldName() {
  const names = [];
  for (const file of fs.readdirSync(SPEC_DIR).filter((f) => f.endsWith('.map.json'))) {
    const spec = JSON.parse(fs.readFileSync(path.join(SPEC_DIR, file), 'utf8'));
    for (const w of spec.worlds || []) {
      if (w.is_entry === true && w.allows_fast_travel === true) names.push(w.name);
    }
  }
  if (names.length !== 1) {
    throw new Error(
      'expected exactly one shipped-spec world declaring BOTH is_entry and '
      + `allows_fast_travel, found ${names.length ? names.join(', ') : 'none'}. `
      + 'That pair is what lets a live-join test name its target world without '
      + 'reading worlds.is_entry, which peer test files borrow and then delete.');
  }
  return names[0];
}

// Resolve that world in the live database. Returns { id, name }.
//
// Throws rather than returning null: every caller is a suite whose whole point
// is that a real character really joins a real world, so "there is nowhere to
// join" must be a loud failure and never a quiet skip.
async function entryWorldForJoin(pool) {
  const name = joinableEntryWorldName();
  const r = await pool.query(
    'SELECT id, name, allows_fast_travel FROM worlds WHERE name = $1', [name]);
  if (r.rows.length !== 1) {
    throw new Error(
      `this database has no world named "${name}", so nothing below was verified. `
      + 'Seed it with `SPEC=p5-descent node scripts/seed-map.js` then '
      + '`SPEC=vale-region node scripts/seed-map.js` (vale-region LAST).');
  }
  const row = r.rows[0];
  if (row.allows_fast_travel !== true) {
    throw new Error(
      `"${name}" declares allows_fast_travel in its spec but the live row has it `
      + 'false, so joinPolicy would have to fall back on is_entry -- which a peer '
      + 'test may be borrowing right now. Re-seed the spec.');
  }
  return { id: row.id, name: row.name };
}

module.exports = {
  withEntryPreserved, ENTRY_LOCK_KEY, entryWorldForJoin, joinableEntryWorldName,
};
