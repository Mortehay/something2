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

// dir defaults to the real spec directory; overridable so tests can point
// this at a fixture without touching backend/seeds/maps.
//
// One malformed file must not take down the whole command: a hand-edited
// *.map.json with a JSON syntax error is the likeliest real trigger, and the
// developer who broke it still needs to see every OTHER spec plus the
// database listing below, not an unhandled rejection. Each entry is either
// a parsed spec ({file, name, topology, worlds}) or an error record
// ({file, error}) -- callers must check for `.error` before reading `.name`.
function listSpecs(dir = path.resolve(__dirname, '../seeds/maps')) {
  const specs = [];
  const errors = [];
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.map.json'))) {
    try {
      const spec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      specs.push({ file: f, name: spec.name, topology: spec.topology, worlds: spec.worlds.length });
    } catch (err) {
      errors.push({ file: f, error: err.message });
    }
  }
  specs.sort((a, b) => a.name.localeCompare(b.name));
  errors.sort((a, b) => a.file.localeCompare(b.file));
  return [...specs, ...errors];
}

module.exports = { listSpecs };

if (require.main === module) {
  (async () => {
    const specs = listSpecs();
    console.log('Available specs (backend/seeds/maps/*.map.json):');
    for (const s of specs) {
      if (s.error) {
        console.log(`  ${s.file}  -- MALFORMED, skipped (${s.error})`);
      } else {
        console.log(`  ${s.name}  (topology: ${s.topology}, ${s.worlds} worlds)  -- make seed-map SPEC=${s.name}`);
      }
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
  })()
    // Backstop, matching clear-maps.js: listSpecs() is now defensive against
    // a malformed spec (see above), but anything else unexpected -- readdir
    // failing outright, a missing seeds/maps dir -- must still surface as a
    // clean error+exit instead of an unhandled rejection.
    .catch((e) => { console.error(e.message); process.exitCode = 1; });
}
