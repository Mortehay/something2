#!/usr/bin/env node
// List available map specs and what is currently seeded. Run via `make list-maps`.
//
// Printing the spec list must not depend on Postgres being reachable: a
// developer picking a SPEC for `make seed-map` (or deciding whether
// `make clear-maps` is safe to run) needs the spec list even when the
// database is down. Only the second half -- what's actually in `worlds`
// right now -- needs a connection, so an unreachable database degrades to a
// warning there, not a crash of the whole command.
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const { Pool } = require('pg');

function listSpecs() {
  const dir = path.resolve(__dirname, '../seeds/maps');
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.map.json'))
    .map((f) => {
      const spec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      return { file: f, name: spec.name, topology: spec.topology, worlds: spec.worlds.length };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { listSpecs };

if (require.main === module) {
  (async () => {
    const specs = listSpecs();
    console.log('Available specs (backend/seeds/maps/*.map.json):');
    for (const s of specs) {
      console.log(`  ${s.name}  (topology: ${s.topology}, ${s.worlds} worlds)  -- make seed-map SPEC=${s.name}`);
    }

    const env = dotenv.config({ path: path.resolve(__dirname, '../../.env') }).parsed || {};
    const url = process.env.DATABASE_URL || env.DATABASE_URL;
    if (!url) {
      console.log('\nDATABASE_URL is not set in .env -- cannot show worlds currently in the database.');
      return;
    }

    const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 2000 });
    try {
      const { rows } = await pool.query('SELECT name, is_entry FROM worlds ORDER BY name');
      console.log(`\nWorlds currently in the database (${rows.length}):`);
      if (rows.length === 0) console.log('  (none)');
      for (const r of rows) {
        console.log(`  ${r.name}${r.is_entry ? '  [entry]' : ''}`);
      }
    } catch (err) {
      console.log(`\nWARNING: could not reach the database at ${url.replace(/:[^:@]*@/, ':***@')} (${err.message}).`);
      console.log('Worlds currently in the database are UNKNOWN -- the spec list above is unaffected.');
    } finally {
      await pool.end().catch(() => {});
    }
  })();
}
