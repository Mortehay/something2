// The single writer for worlds.is_entry (SOMET-265).
//
// WHY THIS EXISTS. "Exactly one world is the entry" was enforced by three
// separate clear-then-set pairs, and a clear-then-set has a window in which
// ZERO worlds are the entry. That is not theoretical: the dev database has lost
// its entry world at least twice, and losing it is close to invisible --
// pickEntryWorld returns null, autoJoinTarget returns null, and a player with
// no last world simply sits on the world list with nothing to explain why.
//
// The worst offender was PUT /api/worlds/:id, which cleared every entry world
// and then did ~30 lines of other work (chunk deletes, guard-spawn rewrites)
// before setting the new one. Anything throwing in between left zero. Worse, an
// id that does not exist cleared every entry world and then updated nothing --
// a guaranteed loss, no error required. restore-entry.js had the same shape and
// said so in its own failure message: "is_entry was cleared but not restored".
//
// One statement, so there is no window at all, and guarded by EXISTS so a
// target that is not there changes NOTHING rather than clearing what is.

// Point is_entry at `worldId`, atomically.
//
// Returns the number of rows changed. ZERO means the target world does not
// exist and nothing was touched -- the previous entry world is still intact.
// Callers should treat 0 as an error, but they do not have to clean up after
// it, which is the whole point.
async function setEntryWorld(db, worldId) {
  const r = await db.query(
    // is_entry = (id = $1) sets the target true and every other current entry
    // false in the same statement. The WHERE narrows it to just those rows, and
    // the EXISTS makes the whole thing a no-op for an unknown id -- without it,
    // a bad id matches only the `is_entry = true` rows and sets them all to
    // false, which is exactly the loss this module exists to prevent.
    `UPDATE worlds SET is_entry = (id = $1)
      WHERE (is_entry = true OR id = $1)
        AND EXISTS (SELECT 1 FROM worlds target WHERE target.id = $1)`,
    [worldId],
  );
  return r.rowCount;
}

// Same, by name. Used by restore-entry.js, whose caller only has the name it
// captured before a seed. Resolving first is safe: if the name is unknown we
// never issue the UPDATE, so nothing is cleared.
async function setEntryWorldByName(db, name) {
  const found = await db.query('SELECT id FROM worlds WHERE name = $1', [name]);
  if (found.rows.length === 0) return 0;
  return setEntryWorld(db, found.rows[0].id);
}

module.exports = { setEntryWorld, setEntryWorldByName };
