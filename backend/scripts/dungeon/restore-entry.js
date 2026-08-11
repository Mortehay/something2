// backend/scripts/dungeon/restore-entry.js
//
// seed-map.js's applyMapSpec clears is_entry globally and sets it on the
// spec's own declared entry world (mapSpec.js requires exactly one per
// spec). Applying p5-descent.map.json will move the game's spawn point
// onto brand-new, art-pending content unless corrected -- this script
// restores whichever world was is_entry before that apply. See
// docs/superpowers/specs/2026-08-08-p5-map-content-design.md's "is_entry
// handling" section.
//
// Usage: node scripts/dungeon/restore-entry.js "<world name>"
const { setEntryWorldByName } = require('../../src/services/entryWorld.js');
// The caller must capture the previous entry's name BEFORE running
// `make seed-map SPEC=p5-descent` -- seed-map clears it, so it cannot be
// read back afterward.
async function restoreEntry(pool, worldName) {
  // Was a clear-then-set pair whose own failure message admitted the hazard:
  // "is_entry was cleared but not restored". A typo in the world name left the
  // game with no entry world at all -- from a script whose entire job is to put
  // one back. setEntryWorldByName resolves first and updates atomically, so an
  // unknown name now changes nothing and this throws with the previous entry
  // world still in place.
  const changed = await setEntryWorldByName(pool, worldName);
  if (changed === 0) {
    throw new Error(`restore-entry: world "${worldName}" not found -- is_entry was left untouched`);
  }
}

module.exports = { restoreEntry };

if (require.main === module) {
  const { Pool } = require('pg');
  const worldName = process.argv[2];
  if (!worldName) {
    console.error('Usage: node scripts/dungeon/restore-entry.js "<world name>"');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  restoreEntry(pool, worldName)
    .then(() => { console.log(`Restored is_entry to "${worldName}".`); return pool.end(); })
    .catch((err) => { console.error(err.message); pool.end(); process.exit(1); });
}
