const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { WILD_GEAR_POOL_SQL, WILD_GEAR_BAND, wildGearCapFor } = require('../src/authority/loot.js');

// Wild gear used to be `ORDER BY req_level DESC LIMIT 15` over brackets of 24 items with no tie-break:
// about 40 weapons and armour could never drop from a creature. Run the real pool query for every
// creature level and check that every piece of gear can come out of it somewhere.

const DB_URL = process.env.TEST_DATABASE_URL;
let pool = null;
before(async () => {
  if (!DB_URL) return;
  const p = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 2000, max: 2 });
  try { await p.query('SELECT 1'); pool = p; } catch { await p.end().catch(() => {}); }
});
after(async () => { if (pool) await pool.end().catch(() => {}); });

test('every weapon and armour of the ladder can drop from some creature level', async (t) => {
  if (!pool) {
    const m = 'TEST_DATABASE_URL not set or unreachable -- wild gear coverage is UNVERIFIED on this run';
    if (process.env.CI) assert.fail(m);
    t.skip(m); return;
  }
  const all = (await pool.query(
    `SELECT id FROM item_types WHERE category IN ('weapon','armor') AND tier IS NOT NULL
        AND name NOT LIKE 'test-%' AND name NOT LIKE '%-test-%' AND name NOT LIKE 'zz-%' AND name NOT LIKE 'probe-%'
        AND name NOT LIKE 'resp-%' AND name NOT LIKE 'noop-%' AND name NOT LIKE 'req-%' AND name NOT LIKE 'ok-%'
        AND name NOT LIKE 'dep-%' AND name NOT LIKE 'free-%' AND name NOT LIKE 'over-%' AND name NOT LIKE 'atcap-%'
        AND name NOT LIKE 'circ-%' AND name NOT LIKE 's496_%' AND name NOT LIKE 's484-%' AND name NOT LIKE 's498-%'
        AND name NOT LIKE 's500-%'`)).rows.map((r) => r.id);
  const seen = new Set();
  // Creature levels 1..140 are what exists (the strongest ordinary creature is 140).
  for (let level = 1; level <= 140; level += 1) {
    const rows = (await pool.query(WILD_GEAR_POOL_SQL, [wildGearCapFor(level), WILD_GEAR_BAND])).rows;
    for (const r of rows) seen.add(r.id);
  }
  const missing = all.filter((id) => !seen.has(id));
  assert.deepStrictEqual(missing, [], `${missing.length} gear items can never drop from a creature`);
});
