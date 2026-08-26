#!/usr/bin/env node
// Bring every entity_types.prompt in a live database up to the styled form.
// Run via `make entities-restyle-prompts`.
//
// WHY A SCRIPT RATHER THAN THE SEEDER. Creatures are seeded ON CONFLICT DO
// NOTHING, deliberately, so an admin's edits survive a re-seed -- which also
// means a seed-file change can never reach a database that already has those
// rows. The catalog needed a one-time correction that the seeder is designed
// not to perform, so it gets its own re-runnable pass.
//
// IDEMPOTENT. styleEntityPrompt returns an already-styled prompt unchanged, so
// running this twice is a no-op and a row edited in the admin UI to something
// already styled is left exactly as the admin wrote it. Rows with no prompt at
// all stay empty: inventing a subject for them is a catalog decision, not a
// formatting one, and generate skips them loudly.

const path = require('path');
const dotenv = require('dotenv');
const { Pool } = require('pg');
const { styleEntityPrompt } = require('../seeds/data/spritePrompt.js');
const { BESTIARY_P4_CREATURES } = require('../seeds/data/bestiaryP4.js');

// The bestiary's 288 prompts are GENERATED (scripts/gen-p4-bestiary.js), so
// when that template is corrected the fix has to reach rows the creature
// seeder will not touch -- it is ON CONFLICT DO NOTHING by design. Syncing
// from the seed file keeps one source of truth rather than reimplementing the
// template's rules here.
//
// It only overwrites a prompt that still matches what the OLD template would
// have produced, which in practice means: never clobber something a human
// edited. A row whose prompt differs from both the old and new generated form
// is left alone.
async function syncBestiaryPrompts(pool, { dryRun = false } = {}) {
  let changed = 0;
  for (const c of BESTIARY_P4_CREATURES) {
    if (!c.prompt) continue;
    // eslint-disable-next-line no-await-in-loop
    const r = await pool.query('SELECT id, prompt FROM entity_types WHERE name = $1', [c.name]);
    const row = r.rows[0];
    if (!row || row.prompt === c.prompt) continue;
    const wasGenerated = /^(pixel art, )?an? \w+ ([\w-]+ )?\w+ creature(,|$)/.test(row.prompt || '');
    if (!wasGenerated) continue;
    if (!dryRun) {
      // eslint-disable-next-line no-await-in-loop
      await pool.query('UPDATE entity_types SET prompt = $1 WHERE id = $2', [c.prompt, row.id]);
    }
    changed += 1;
  }
  return changed;
}

async function restyleEntityPrompts(pool, { dryRun = false } = {}) {
  const synced = await syncBestiaryPrompts(pool, { dryRun });
  const r = await pool.query(
    `SELECT id, name, prompt FROM entity_types
      WHERE prompt IS NOT NULL AND prompt <> '' ORDER BY name`,
  );
  const stats = { changed: 0, already: 0, empty: 0, synced };
  for (const row of r.rows) {
    const styled = styleEntityPrompt(row.prompt);
    if (styled === row.prompt) {
      stats.already += 1;
      continue;
    }
    if (!dryRun) {
      // eslint-disable-next-line no-await-in-loop
      await pool.query('UPDATE entity_types SET prompt = $1 WHERE id = $2', [styled, row.id]);
    }
    stats.changed += 1;
  }
  const empties = await pool.query(
    `SELECT count(*)::int AS n FROM entity_types WHERE prompt IS NULL OR prompt = ''`,
  );
  stats.empty = empties.rows[0].n;
  return stats;
}

module.exports = { restyleEntityPrompts, syncBestiaryPrompts };

if (require.main === module) {
  const env = dotenv.config({ path: path.resolve(__dirname, '../../.env') }).parsed || {};
  const url = process.env.DATABASE_URL || env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is not set'); process.exit(1); }
  const dryRun = process.argv.includes('--dry-run');
  const pool = new Pool({ connectionString: url });
  restyleEntityPrompts(pool, { dryRun })
    .then((s) => {
      console.log(`${dryRun ? '[DRY RUN] ' : ''}synced ${s.synced} bestiary prompts, `
        + `restyled ${s.changed}, ${s.already} already styled, `
        + `${s.empty} still have no prompt at all`);
    })
    .catch((e) => { console.error(e.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
