#!/usr/bin/env node
// Re-run the base gear ladder upsert against an already-migrated database.
// Idempotent: upsertGearLadder never overwrites an existing name, so this only
// ever ADDS families/tiers that were authored after the migration ran.
//
// Run via `npm run seed:gear` from backend/. Set DATABASE_URL first; there is
// no default, deliberately -- a script that silently defaulted would be one
// typo away from writing to the shared dev database.
//
// DELIBERATELY DOES NOT LOAD .env, unlike scripts/seed-catalogs.js. dotenv
// writes into process.env, so `dotenv.config(); if (!process.env.DATABASE_URL)`
// is a guard that can never fire -- .env carries a DATABASE_URL pointing at the
// shared dev database, so the "refusing to guess" branch would be dead code and
// the script would quietly seed game_db. Reading only what the caller exported
// is what makes the refusal real.
const { Pool } = require('pg');
const { generateGearLadder, upsertGearLadder } = require('../seeds/generateGearLadder.js');
const { GEAR_TIERS, GEAR_FAMILIES } = require('../seeds/data/gearLadder.js');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set; refusing to guess a database.');
    console.error('Example: DATABASE_URL=postgres://user:password@localhost:15432/game_db npm run seed:gear');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const rows = generateGearLadder({ tiers: GEAR_TIERS, families: GEAR_FAMILIES });
    const { inserted, skipped } = await upsertGearLadder(pool, rows);
    console.log(`gear ladder: ${inserted} inserted, ${skipped} already present (${rows.length} total)`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
