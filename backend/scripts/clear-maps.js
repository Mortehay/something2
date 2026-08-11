#!/usr/bin/env node
// Delete every world. Run via `make clear-maps`.
//
// The confirmation names player_binds on purpose. Deleting a world cascades
// much further than "maps": a developer reading "clear maps" will not expect
// every player to lose their respawn bind, and there is no undo.
const path = require('path');
const readline = require('readline');
const dotenv = require('dotenv');
const { Pool } = require('pg');

const CASCADES = [
  'world_chunks', 'world_creatures', 'world_players', 'world_items',
  'map_links', 'villages', 'merchant_stock', 'player_binds (every player\'s respawn point)',
  'character_visited_worlds (every character\'s explored map)',
  'world_chests (every chest, including vault chests authored in a map spec)',
];

async function clearMaps(pool) {
  const r = await pool.query('DELETE FROM worlds');
  return { worlds: r.rowCount };
}

module.exports = { clearMaps, CASCADES };

if (require.main === module) {
  const env = dotenv.config({ path: path.resolve(__dirname, '../../.env') }).parsed || {};
  const url = process.env.DATABASE_URL || env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is not set in .env'); process.exit(1); }
  const pool = new Pool({ connectionString: url });

  (async () => {
    // Fail fast, before touching the database at all, when there is no human
    // to answer the prompt: a piped/redirected/CI stdin (e.g.
    // `make clear-maps < /dev/null`) is not a TTY. Without this check
    // rl.question(...) below waits forever for input that will never come --
    // it does NOT default to deleting, but a hang is still a broken script.
    if (!process.stdin.isTTY) {
      console.error('stdin is not a TTY -- refusing to prompt for confirmation. Aborting without deleting anything.');
      process.exitCode = 1;
      return;
    }

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM worlds');
    // Set by `make reseed-map` (never by standalone `make clear-maps`, which
    // leaves RESEED_SPEC unset) so the prompt names what is about to be
    // reapplied, not just what is about to be destroyed.
    const reseedSpec = process.env.RESEED_SPEC;
    if (reseedSpec) {
      console.log(`This clear is step 1 of "make reseed-map SPEC=${reseedSpec}" -- spec "${reseedSpec}" is applied immediately after.`);
    }
    console.log(`This deletes ALL ${rows[0].n} worlds and, by cascade:`);
    for (const t of CASCADES) console.log(`  - ${t}`);
    console.log('Kept: user accounts, inventory, equipment, and every catalog.');

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    // rl.question's callback never fires on EOF/'close' (e.g. Ctrl+D mid-
    // prompt in an interactive session) -- only the 'close' event does. Race
    // the two so a closed stdin aborts instead of hanging forever.
    const closed = new Promise((res) => rl.once('close', () => res(null)));
    const questioned = new Promise((res) => rl.question("Type 'yes' to confirm: ", res));
    const answer = await Promise.race([questioned, closed]);
    rl.close();
    if (answer === null) {
      console.error('stdin closed before confirmation was given. Aborting without deleting anything.');
      process.exitCode = 1;
      return;
    }
    if (answer.trim() !== 'yes') {
      // A declined confirmation must exit non-zero: `make reseed-map` chains
      // `clear-maps`, `seed-catalogs`, `seed-map` as sequential recipe lines
      // and only stops on a non-zero exit. Exiting 0 here (as this used to)
      // let a developer who read the destruction warning and typed anything
      // but 'yes' fall straight through into seed-catalogs re-seeding and the
      // spec being applied ON TOP of the worlds they meant to keep.
      console.log('Aborted.');
      process.exitCode = 1;
      return;
    }

    const n = await clearMaps(pool);
    console.log(`deleted ${n.worlds} worlds`);
  })()
    .catch((e) => { console.error(e.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
