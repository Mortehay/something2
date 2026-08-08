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
// The caller must capture the previous entry's name BEFORE running
// `make seed-map SPEC=p5-descent` -- seed-map clears it, so it cannot be
// read back afterward.
async function restoreEntry(pool, worldName) {
  await pool.query('UPDATE worlds SET is_entry = false WHERE is_entry = true');
  const result = await pool.query('UPDATE worlds SET is_entry = true WHERE name = $1', [worldName]);
  if (result.rowCount === 0) {
    throw new Error(`restore-entry: world "${worldName}" not found -- is_entry was cleared but not restored`);
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
