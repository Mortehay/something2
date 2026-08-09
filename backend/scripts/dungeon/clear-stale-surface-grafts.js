// backend/scripts/dungeon/clear-stale-surface-grafts.js
//
// One-off maintenance script for the SOMET-251 final review's live re-seed
// (Important #3): 8 of the 10 surface worlds' graft points moved when
// pickGraftPoints was restricted to D1+D2. setLink only inserts/retargets a
// link, never deletes one (mapLinks.js), so re-applying the regenerated
// p5-descent.map.json via plain `make seed-map SPEC=p5-descent` would ADD
// the 8 new graft links but leave the 8 OLD ones (16 physical rows counting
// mirrors) live in map_links -- see .claude/skills/map-planner/SKILL.md's
// "Two limitations to know before you seed". Verified by diffing the live
// DB's map_links against the regenerated spec before writing this: exactly
// these 8 surface worlds' single non-portal link differs; the other 2
// (Highlands Reach/Frontier) happen to keep the same attachment and need no
// change.
//
// Deliberately narrow: clears ONLY these 8 specific stale rows (via
// clearLink, which removes a link and its mirror together), touching
// nothing else in the database -- not a blanket clear-maps. Read-only
// verification of exactly what this deletes is printed before each delete.
const { Pool } = require('pg');
const { clearLink } = require('../../src/services/mapLinks.js');

const STALE = [
  ['Verdant Jungle Reach', 'S'],
  ['Verdant Jungle Frontier', 'S'],
  ['Storm Coast Reach', 'S'],
  ['Storm Coast Frontier', 'S'],
  ['Sunken Ruins Reach', 'S'],
  ['Sunken Ruins Frontier', 'S'],
  ['Ashfields Reach', 'W'],
  ['Ashfields Frontier', 'S'],
];

async function clearStaleSurfaceGrafts(pool) {
  const client = await pool.connect();
  const cleared = [];
  try {
    await client.query('BEGIN');
    for (const [name, edge] of STALE) {
      const r = await client.query('SELECT id FROM worlds WHERE name = $1', [name]);
      if (r.rowCount === 0) throw new Error(`world not found: ${name}`);
      const id = r.rows[0].id;
      const before = await client.query(
        'SELECT wt.name FROM map_links ml JOIN worlds wt ON wt.id = ml.to_world_id WHERE ml.from_world_id = $1 AND ml.edge = $2',
        [id, edge],
      );
      if (before.rowCount === 0) throw new Error(`expected a stale ${edge} link from "${name}" but found none`);
      await clearLink(client, id, edge);
      cleared.push({ name, edge, wasTo: before.rows[0].name });
    }
    await client.query('COMMIT');
    return cleared;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { clearStaleSurfaceGrafts, STALE };

if (require.main === module) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  clearStaleSurfaceGrafts(pool)
    .then((cleared) => {
      for (const c of cleared) console.log(`cleared ${c.name}:${c.edge} (was -> ${c.wasTo})`);
      console.log(`done: cleared ${cleared.length} stale surface-graft links`);
    })
    .catch((err) => { console.error(err.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
