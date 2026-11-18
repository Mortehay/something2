#!/usr/bin/env node
// SOMET-773: give every eligible world its ruins (bounded, not "Boss Arena: *",
// not "*: Hub"). Idempotent -- valid stored ruins are kept byte-identical and a
// world that does not change keeps its chunk cache.
//
//   node scripts/seed-structures.js [--dry-run] [--world "<name>"] [--regenerate] [--invalidate]
//
// --dry-run runs everything inside a transaction and rolls it back.
// --invalidate clears world_chunks for every eligible world even when its
// ruins did not change: a backend still running pre-ruin code re-caches
// chunks WITHOUT the ruins, and an unchanged world would otherwise keep them.
// Run it once after deploying, then restart the backend.
// After a real run RESTART THE BACKEND: the authority holds each live world's
// map in memory and keeps serving the old ground until it reloads.
const { Pool } = require('pg');
const { ensureStructures } = require('../src/services/worldStructures');
const { loadDecorationDefs } = require('../src/services/decorationDefs');

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
}

async function main() {
  const dry = process.argv.includes('--dry-run');
  const regenerate = process.argv.includes('--regenerate');
  const invalidate = process.argv.includes('--invalidate');
  const only = argValue('--world');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const totals = { worlds: 0, changed: 0, skipped: 0, ruins: 0, dropped: 0 };
  // ONE TRANSACTION PER WORLD (review I3). A single run-long transaction kept
  // every world's chunk DELETE invisible for ~2 minutes, so a live backend's
  // /chunk cache miss could regenerate a ruin-less chunk from the old row and
  // cache it after the commit -- invisible walls once the authority reloads.
  try {
    const decorationDefs = await loadDecorationDefs(pool);
    const { rows } = await pool.query(
      `SELECT id, name FROM worlds WHERE width IS NOT NULL AND height IS NOT NULL
        ${only ? 'AND name = $1' : ''} ORDER BY name`, only ? [only] : []);
    for (const w of rows) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const r = await ensureStructures(client, w.id, { decorationDefs, regenerate });
        if (!r.changed && !r.skipped && invalidate) await client.query('DELETE FROM world_chunks WHERE world_id = $1', [w.id]);
        await client.query(dry ? 'ROLLBACK' : 'COMMIT');
        totals.worlds++;
        if (r.skipped) { totals.skipped++; continue; }
        if (r.changed) totals.changed++;
        totals.ruins += r.kept + r.added;
        totals.dropped += r.dropped;
        console.log(`${r.changed ? '*' : ' '} ${w.name}: ${r.kept + r.added} ruins (kept ${r.kept}, added ${r.added}, dropped ${r.dropped})`);
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.end();
  }
  console.log(`${dry ? '[dry run, rolled back] ' : ''}${totals.worlds} worlds, ${totals.skipped} skipped, `
    + `${totals.changed} changed, ${totals.ruins} ruins, ${totals.dropped} dropped`);
  if (!dry && totals.changed) console.log('NOTE: restart the backend -- the authority caches each live world\'s map.');
}

main().catch((e) => { console.error(e); process.exit(1); });
