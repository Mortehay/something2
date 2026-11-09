#!/usr/bin/env node
// Prints the passive tree as JSON on stdout: { nodes: [{key, kind, label, grants, startClass}], edges: [[keyA, keyB]] }.
// Node KEYS, never database ids -- they are what the build guides store (ids differ between environments).
//
//   node scripts/dump-passive-tree.js > ../frontend/scripts/build-guides/.tree.json
//
// Read by frontend/scripts/build-guides/generate.mjs, which walks the real graph to lay out each build's
// passive route. Run via `make build-guides`.
const path = require('path');
const dotenv = require('dotenv');
const { Pool } = require('pg');

async function main() {
  const env = dotenv.config({ path: path.resolve(__dirname, '../../.env') }).parsed || {};
  const url = process.env.DATABASE_URL || env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is not set'); process.exit(1); }
  const pool = new Pool({ connectionString: url });
  try {
    const nodes = await pool.query(
      'SELECT id, key, kind, label, grants, start_class FROM passive_nodes ORDER BY key');
    const edges = await pool.query('SELECT a_id, b_id FROM passive_edges');
    const keyOf = new Map(nodes.rows.map((n) => [n.id, n.key]));
    const out = {
      nodes: nodes.rows.map((n) => ({
        key: n.key, kind: n.kind, label: n.label, grants: n.grants || [], startClass: n.start_class || null,
      })),
      edges: edges.rows
        .map((e) => [keyOf.get(e.a_id), keyOf.get(e.b_id)])
        .filter(([a, b]) => a && b)
        .sort((x, y) => (x[0] + x[1]).localeCompare(y[0] + y[1])),
    };
    process.stdout.write(`${JSON.stringify(out)}\n`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
