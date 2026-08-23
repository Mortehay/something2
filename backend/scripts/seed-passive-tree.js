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
const path = require('path');
const dotenv = require('dotenv');
const { Pool } = require('pg');
const { generatePassiveTree } = require('../seeds/generatePassiveTree.js');
const { PASSIVE_TREE_SPEC } = require('../seeds/data/passiveTree.js');

async function seedPassiveTree(db, { force = false, quiet = false } = {}) {
  const log = quiet ? () => {} : (...a) => console.log(...a);
  const { nodes, edges } = generatePassiveTree(PASSIVE_TREE_SPEC);

  for (const n of nodes) {
    await db.query(
      `INSERT INTO passive_nodes (key, sector, ring, x, y, kind, label, grants, start_class)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
       ON CONFLICT (key) DO UPDATE
         SET sector = EXCLUDED.sector,
             ring = EXCLUDED.ring,
             x = EXCLUDED.x,
             y = EXCLUDED.y,
             start_class = EXCLUDED.start_class,
             kind   = CASE WHEN $10 THEN EXCLUDED.kind   ELSE passive_nodes.kind   END,
             label  = CASE WHEN $10 THEN EXCLUDED.label  ELSE passive_nodes.label  END,
             grants = CASE WHEN $10 THEN EXCLUDED.grants ELSE passive_nodes.grants END`,
      [n.key, n.sector, n.ring, n.x, n.y, n.kind, n.label, JSON.stringify(n.grants), n.start_class, force],
    );
  }
  log(`passive_nodes: ${nodes.length} upserted${force ? ' (--force: labels/kinds/grants overwritten)' : ''}`);

  // A node in the database that the generator no longer produces is REPORTED,
  // never deleted: someone may already have spent a point on it.
  const stale = await db.query(
    'SELECT key FROM passive_nodes WHERE key <> ALL($1::text[]) ORDER BY key',
    [nodes.map((n) => n.key)],
  );
  if (stale.rows.length) {
    log(`WARNING: ${stale.rows.length} node(s) exist in the database but not in the spec.`);
    log('They were LEFT IN PLACE (a character may have allocated them). Remove them by hand if that is really what you want:');
    for (const r of stale.rows.slice(0, 20)) log(`  ${r.key}`);
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
