#!/usr/bin/env node
// backend/scripts/seed-passive-tree.js
//
// Seed passive_nodes + passive_edges from the generated tree. Run via
// `make seed-passive-tree` (add FORCE=1 to overwrite admin edits).
//
// UPSERT BY KEY, NEVER DELETE -- the same rule scripts/seed-catalogs.js
// states in its own header, and here it is load-bearing rather than polite:
// character_passives references passive_nodes.id, so deleting and re-inserting
// a node would either fail on the FK or (with a cascade) silently unspend
// every point a player had put into it.
//
// WHICH COLUMNS A RESEED OVERWRITES. Structural columns (sector, ring, x, y,
// start_class) always: they come from the layout and an admin cannot edit them
// in the UI. Authored columns (kind, label, grants) only under --force: those
// are exactly what the admin node editor writes, and clobbering them on every
// reseed is the failure biomes.js's creature_types CASE expression exists to
// prevent.
//
// ONE CARVE-OUT: A START NODE'S `grants` ARE STRUCTURAL (SOMET-471).
//
// Contract 6.11 makes the six start nodes the place a class's MECHANICAL
// identity is granted -- the Cultist's life-cost affinity, the Druid's charm
// affinity. That is a contract between the tree and the class catalog, not
// tunable content, and it is the ONE grant every character receives whether or
// not they ever open the tree.
//
// Without this carve-out the feature ships INERT on every database that
// already has a tree. C1 seeded all six start nodes with `grants: []` by rule,
// so a non-forced reseed would preserve those empty arrays forever, and the
// only symptom would be six classes that all play identically -- exactly the
// shape of the defect SOMET-486 spent eleven months not noticing. Requiring an
// operator to remember FORCE=1 is not a fix: FORCE=1 also clobbers every
// legitimately hand-tuned minor and notable in the tree, so the safe action
// and the correct action would be in conflict.
//
// The carve-out is safe in the direction that matters: a stored `[]` on a
// start node cannot be an admin edit, because until SOMET-471 an empty array
// was the only legal value. passive_tree_start_grants_db.test.js proves a
// NON-forced reseed really does deliver them.
const path = require('path');
const dotenv = require('dotenv');
const { Pool } = require('pg');
const { generatePassiveTree } = require('../seeds/generatePassiveTree.js');
const { PASSIVE_TREE_SPEC } = require('../seeds/data/passiveTree.js');

async function seedPassiveTree(db, { force = false, quiet = false } = {}) {
  const log = quiet ? () => {} : (...a) => console.log(...a);
  const { nodes, edges } = generatePassiveTree(PASSIVE_TREE_SPEC);

  // ONE round trip for all ~1850 rows, via unnest -- the same shape the edge
  // reconcile below already uses.
  //
  // WHY THIS IS NOT PREMATURE OPTIMISATION (SOMET-529). This ran as one INSERT
  // per node: ~1850 sequential round trips, 3.2s unforced and 6.0s forced on an
  // idle machine. Two test files hold PASSIVE_TREE_LOCK_KEY across several
  // seeds each, so those seconds were the critical section -- and under
  // full-suite parallel load they stretched past the lock helper's bounded
  // wait, which then degraded to "run unguarded" and let a peer's force-reseed
  // land mid-assertion in another file. The fix for a lock held too long is to
  // make the work under it fast, not to wait longer.
  //
  // The ON CONFLICT body is unchanged, including SOMET-471's start-node
  // carve-out; only the number of round trips differs.
  await db.query(
    `INSERT INTO passive_nodes (key, sector, ring, x, y, kind, label, grants, start_class)
     SELECT * FROM unnest(
       $1::text[], $2::text[], $3::int[], $4::real[], $5::real[],
       $6::text[], $7::text[], $8::jsonb[], $9::text[])
     ON CONFLICT (key) DO UPDATE
       SET sector = EXCLUDED.sector,
           ring = EXCLUDED.ring,
           x = EXCLUDED.x,
           y = EXCLUDED.y,
           start_class = EXCLUDED.start_class,
           kind   = CASE WHEN $10 THEN EXCLUDED.kind   ELSE passive_nodes.kind   END,
           label  = CASE WHEN $10 THEN EXCLUDED.label  ELSE passive_nodes.label  END,
           -- $10 is --force. The second arm is SOMET-471's carve-out: a start
           -- node's grants are structural (see the header), so they are
           -- written on every reseed, forced or not. EXCLUDED.kind rather
           -- than passive_nodes.kind, because the row being inserted is the
           -- generator's and that is the authority on what a start node is.
           grants = CASE WHEN $10 OR EXCLUDED.kind = 'start'
                         THEN EXCLUDED.grants ELSE passive_nodes.grants END`,
    [
      nodes.map((n) => n.key),
      nodes.map((n) => n.sector),
      nodes.map((n) => n.ring),
      nodes.map((n) => n.x),
      nodes.map((n) => n.y),
      nodes.map((n) => n.kind),
      nodes.map((n) => n.label),
      nodes.map((n) => JSON.stringify(n.grants)),
      nodes.map((n) => n.start_class),
      force,
    ],
  );
  log(`passive_nodes: ${nodes.length} upserted${force ? ' (--force: labels/kinds/grants overwritten)' : ''}`);

  // A node in the database that the generator no longer produces:
  const stale = await db.query(
    'SELECT id, key FROM passive_nodes WHERE key <> ALL($1::text[]) ORDER BY key',
    [nodes.map((n) => n.key)],
  );
  if (stale.rows.length) {
    if (force) {
      const staleIds = stale.rows.map(r => r.id);
      await db.query('DELETE FROM character_passives WHERE node_id = ANY($1::int[])', [staleIds]);
      await db.query('DELETE FROM passive_edges WHERE a_id = ANY($1::int[]) OR b_id = ANY($1::int[])', [staleIds]);
      await db.query('DELETE FROM passive_nodes WHERE id = ANY($1::int[])', [staleIds]);
      log(`passive_nodes: ${stale.rows.length} stale node(s) pruned from database`);
    } else {
      log(`WARNING: ${stale.rows.length} node(s) exist in the database but not in the spec.`);
      log('They were LEFT IN PLACE (pass --force to prune).');
    }
  }

  // Edges are not admin-editable, so they are reconciled in full. The generator
  // emits KEY pairs; ids are assigned by insertion order, which is not key
  // order, so LEAST/GREATEST is what satisfies the a_id < b_id CHECK.
  const idRows = await db.query('SELECT id, key FROM passive_nodes');
  const idByKey = new Map(idRows.rows.map((r) => [r.key, r.id]));
  const wanted = edges.map(([a, b]) => {
    const ia = idByKey.get(a);
    const ib = idByKey.get(b);
    return ia < ib ? [ia, ib] : [ib, ia];
  });

  await db.query(
    `INSERT INTO passive_edges (a_id, b_id)
     SELECT * FROM unnest($1::int[], $2::int[])
     ON CONFLICT (a_id, b_id) DO NOTHING`,
    [wanted.map((e) => e[0]), wanted.map((e) => e[1])],
  );
  const removed = await db.query(
    `DELETE FROM passive_edges e
      WHERE NOT EXISTS (
        SELECT 1 FROM unnest($1::int[], $2::int[]) AS w(a, b)
         WHERE w.a = e.a_id AND w.b = e.b_id)
      RETURNING a_id`,
    [wanted.map((e) => e[0]), wanted.map((e) => e[1])],
  );
  log(`passive_edges: ${wanted.length} reconciled, ${removed.rowCount} stale edge(s) removed`);
}

async function main() {
  dotenv.config({ path: path.resolve(__dirname, '../.env') });
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await seedPassiveTree(pool, { force: process.argv.includes('--force') });
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { seedPassiveTree };
