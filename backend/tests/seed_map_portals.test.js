const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { applyMapSpec } = require('../scripts/seed-map.js');

const DB_URL = process.env.TEST_DATABASE_URL
  || 'postgres://user:password@localhost:15432/game_db';

function requireTestDb(t, why) {
  if (!process.env.TEST_DATABASE_URL) {
    const msg = `TEST_DATABASE_URL not set -- skipping to avoid mutating a real database (${why})`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return false;
  }
  return true;
}

async function openPool() {
  const pool = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 2000, max: 2 });
  try { await pool.query('SELECT 1'); return pool; }
  catch (err) { await pool.end().catch(() => {}); return { unreachable: err.message }; }
}

// Snapshot whichever world is currently is_entry (0 or 1 of them), run fn,
// then restore exactly that snapshot -- copied from
// tests/seed_map_db.test.js's helper of the same name (see its comment for
// the full rationale). Our spec's `surface` world declares is_entry: true,
// and applyMapSpec's own is_entry step clears every OTHER world when it sets
// a new one -- so without this, running these tests against a real dev DB
// steals is_entry off whatever the real entry world is (e.g. "Old
// Trailhead"), and then `finally` deletes `surface` outright, leaving ZERO
// worlds with is_entry = true anywhere in the database.
async function withEntryPreserved(pool, fn) {
  const before = await pool.query('SELECT id FROM worlds WHERE is_entry = true');
  const beforeId = before.rows[0]?.id ?? null;
  try {
    return await fn();
  } finally {
    // Single atomic UPDATE, not two separate ones: a crash between "clear
    // every is_entry" and "set it back on beforeId" used to be able to leave
    // the database with ZERO entry worlds. COALESCE(id = $1, false) keeps
    // the SET expression a plain boolean (never SQL NULL) when beforeId is
    // null -- is_entry is NOT NULL, so assigning NULL would throw.
    await pool.query(
      'UPDATE worlds SET is_entry = COALESCE(id = $1, false) WHERE is_entry = true OR id = $1',
      [beforeId],
    );
  }
}

// Every world name in this spec carries a random uuid suffix so concurrent
// or repeated runs never collide with each other or with a real seeded map.
// Cleanup below deletes strictly by these names, computed here and never
// re-derived from a query result -- so it runs unconditionally in `finally`
// regardless of where inside the test an assertion throws. (An earlier
// version of this file instead captured world ids from a query made AFTER
// the assertions that could fail, which meant a failed assertion skipped
// cleanup entirely and left the `Portal Test *` rows to leak permanently --
// self-perpetuating, since the next run's idempotency guard would then
// suppress guard re-insertion against the surviving rows and fail the same
// assertion again.)
function uniqueSpec() {
  const suffix = randomUUID().slice(0, 8);
  return {
    name: `portal-seed-test-${suffix}`,
    worlds: [
      { key: 'surface', name: `Portal Test Surface ${suffix}`, grid: [0, 0],
        width: 20, height: 20, seed: 7001, is_entry: true },
      { key: 'dungeon-1', name: `Portal Test Dungeon 1 ${suffix}`,
        width: 20, height: 20, seed: 7002, level_band: [3, 5] },
    ],
    links: [
      { kind: 'portal', from: 'surface', from_x: 1050, from_y: 1050,
        to: 'dungeon-1', to_x: 550, to_y: 550,
        guard: { creature_type: 'Wolf', count: 2 } },
    ],
  };
}

test('applyMapSpec writes a grid-less dungeon world, its portal link, and its guards', async (t) => {
  if (!requireTestDb(t, 'writes a real spec through applyMapSpec')) return;
  const pool = await openPool();
  if (pool.unreachable) { t.skip(`NO DATABASE at ${DB_URL}`); return; }
  const spec = uniqueSpec();
  const worldNames = spec.worlds.map((w) => w.name);
  try {
    const wolfRow = await pool.query(`SELECT 1 FROM entity_types WHERE name = 'Wolf' AND is_creature = true`);
    if (wolfRow.rowCount === 0) { t.skip('no "Wolf" creature type in this database — cannot exercise guard insertion'); return; }

    const result = await withEntryPreserved(pool, () => applyMapSpec(pool, spec));
    assert.equal(result.worlds, 2);
    assert.equal(result.links, 1);
    assert.equal(result.portalGuards, 2);

    const worldRows = await pool.query(
      `SELECT id, name, width, height, level_min, level_max, graph_x, graph_y FROM worlds WHERE name = ANY($1)`,
      [worldNames]);
    assert.equal(worldRows.rowCount, 2);
    const dungeon = worldRows.rows.find((r) => r.name === spec.worlds[1].name);
    assert.equal(dungeon.level_min, 3);
    assert.equal(dungeon.level_max, 5);
    assert.strictEqual(dungeon.graph_x, null, 'a grid-less world must not get a graph position');
    assert.strictEqual(dungeon.graph_y, null);

    const surface = worldRows.rows.find((r) => r.name === spec.worlds[0].name);
    const linkRows = await pool.query(
      `SELECT id, edge, to_world_id, from_x, from_y, to_x, to_y
         FROM map_links WHERE from_world_id = $1 AND edge = 'PORTAL'`, [surface.id]);
    assert.equal(linkRows.rowCount, 1);
    assert.equal(linkRows.rows[0].to_world_id, dungeon.id);

    const guardRows = await pool.query(
      `SELECT type, blocks_portal_id, home_x, home_y FROM world_creatures WHERE world_id = $1`, [surface.id]);
    assert.equal(guardRows.rowCount, 2);
    for (const g of guardRows.rows) {
      assert.equal(g.type, 'Wolf');
      assert.equal(g.blocks_portal_id, linkRows.rows[0].id);
      assert.equal(g.home_x, 1050);
      assert.equal(g.home_y, 1050);
    }
  } finally {
    await pool.query('DELETE FROM worlds WHERE name = ANY($1)', [worldNames]); // CASCADEs links/creatures
    await pool.end();
  }
});

test('re-applying the same spec does not duplicate the portal guard pack', async (t) => {
  if (!requireTestDb(t, 'writes a real spec through applyMapSpec twice')) return;
  const pool = await openPool();
  if (pool.unreachable) { t.skip(`NO DATABASE at ${DB_URL}`); return; }
  const spec = uniqueSpec();
  const worldNames = spec.worlds.map((w) => w.name);
  try {
    const wolfRow = await pool.query(`SELECT 1 FROM entity_types WHERE name = 'Wolf' AND is_creature = true`);
    if (wolfRow.rowCount === 0) { t.skip('no "Wolf" creature type — cannot exercise guard insertion'); return; }

    await withEntryPreserved(pool, () => applyMapSpec(pool, spec));
    await withEntryPreserved(pool, () => applyMapSpec(pool, spec)); // second application, same spec

    const worldRows = await pool.query(`SELECT id FROM worlds WHERE name = ANY($1)`, [worldNames]);
    const worldIds = worldRows.rows.map((r) => r.id);

    const guardCount = await pool.query(
      `SELECT count(*) FROM world_creatures WHERE world_id = ANY($1) AND type = 'Wolf'`, [worldIds]);
    assert.equal(Number(guardCount.rows[0].count), 2, 'guards must not double up on re-apply');
  } finally {
    await pool.query('DELETE FROM worlds WHERE name = ANY($1)', [worldNames]);
    await pool.end();
  }
});
