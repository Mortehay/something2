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
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM worlds');
    console.log(`This deletes ALL ${rows[0].n} worlds and, by cascade:`);
    for (const t of CASCADES) console.log(`  - ${t}`);
    console.log('Kept: user accounts, inventory, equipment, and every catalog.');

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((res) => rl.question("Type 'yes' to confirm: ", res));
    rl.close();
    if (answer.trim() !== 'yes') { console.log('Aborted.'); return; }

    const n = await clearMaps(pool);
    console.log(`deleted ${n.worlds} worlds`);
  })()
    .catch((e) => { console.error(e.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
