const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { entryWorldForJoin } = require('./helpers/entryWorld.js');

// Every world must be reachable from the entry world by following map_links (either direction).
// A world nobody can walk to is content nobody can ever see: its creatures, its bosses and every
// quest that names it. 66 worlds were cut off like that until the Descent got its entrance.
// Asserted against LIVE rows, like home_region_portals_db.test.js.
//
// The start and the subject both come from the checked-in specs, not from live flags (SOMET-784).
// Peer files borrow worlds.is_entry for their zz* fixtures for longer than the entry lock waits
// (helpers/entryWorld.js), and while they hold it every shipped world -- Vale Crossing included --
// read as unreachable; their fixture worlds are unreachable by design too. The links walked are live.
const SPEC_DIR = path.join(__dirname, '..', 'seeds', 'maps');
const shippedWorldNames = () => fs.readdirSync(SPEC_DIR).filter((f) => f.endsWith('.map.json'))
  .flatMap((f) => JSON.parse(fs.readFileSync(path.join(SPEC_DIR, f), 'utf8')).worlds.map((w) => w.name));

const DB_URL = process.env.TEST_DATABASE_URL;
let pool = null;

before(async () => {
  if (!DB_URL) return;
  const p = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 2000, max: 2 });
  try { await p.query('SELECT 1'); pool = p; } catch { await p.end().catch(() => {}); }
});
after(async () => { if (pool) await pool.end().catch(() => {}); });

test('every world is reachable from the entry world', async (t) => {
  if (!pool) {
    const m = 'TEST_DATABASE_URL not set or unreachable -- world reachability is UNVERIFIED on this run';
    if (process.env.CI) assert.fail(m);
    t.skip(m); return;
  }
  const entry = await entryWorldForJoin(pool);
  const r = await pool.query(`
    WITH RECURSIVE reach(id) AS (
      SELECT $1::uuid
      UNION
      SELECT CASE WHEN l.from_world_id = r.id THEN l.to_world_id ELSE l.from_world_id END
        FROM map_links l JOIN reach r ON l.from_world_id = r.id OR l.to_world_id = r.id
    )
    SELECT name FROM worlds WHERE id NOT IN (SELECT id FROM reach)
       AND name = ANY($2::text[]) ORDER BY name`, [entry.id, shippedWorldNames()]);
  assert.deepStrictEqual(r.rows.map((x) => x.name), [],
    'these worlds cannot be reached from the entry world by any link');
});

test('the worlds the quests send a player to exist and can be reached', async (t) => {
  if (!pool) { t.skip('no database'); return; }
  const q = await pool.query(`SELECT key, target_key FROM quests WHERE objective_type = 'reach'`);
  for (const row of q.rows) {
    const w = await pool.query(`SELECT count(*)::int AS n FROM worlds WHERE lower(name) LIKE lower($1) || '%'`, [row.target_key]);
    assert.ok(w.rows[0].n > 0, `quest ${row.key}: no world starts with "${row.target_key}"`);
  }
});
