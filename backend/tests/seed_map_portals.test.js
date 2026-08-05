const test = require('node:test');
const assert = require('node:assert');
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

// Every world/village name in this spec is uuid-suffixed so a failed run
// never collides with a real seeded map, and every row this test creates is
// deleted in `finally` regardless of outcome.
function uniqueSpec(suffix) {
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
        guard: { creature_type: 'Orc', count: 2 } },
    ],
  };
}

test('applyMapSpec writes a grid-less dungeon world, its portal link, and its guards', async (t) => {
  if (!requireTestDb(t, 'writes a real spec through applyMapSpec')) return;
  const pool = await openPool();
  if (pool.unreachable) { t.skip(`NO DATABASE at ${DB_URL}`); return; }
  const suffix = 'a1';
  const spec = uniqueSpec(suffix);
  let worldIds = [];
  try {
    const orcRow = await pool.query(`SELECT 1 FROM entity_types WHERE name = 'Orc' AND is_creature = true`);
    if (orcRow.rowCount === 0) { t.skip('no "Orc" creature type in this database — cannot exercise guard insertion'); return; }

    const result = await applyMapSpec(pool, spec);
    assert.equal(result.worlds, 2);
    assert.equal(result.links, 1);
    assert.equal(result.portalGuards, 2);

    const worldRows = await pool.query(
      `SELECT id, name, width, height, level_min, level_max, graph_x, graph_y FROM worlds WHERE name = ANY($1)`,
      [spec.worlds.map((w) => w.name)]);
    worldIds = worldRows.rows.map((r) => r.id);
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
      assert.equal(g.type, 'Orc');
      assert.equal(g.blocks_portal_id, linkRows.rows[0].id);
      assert.equal(g.home_x, 1050);
      assert.equal(g.home_y, 1050);
    }
  } finally {
    if (worldIds.length) {
      await pool.query('DELETE FROM worlds WHERE id = ANY($1)', [worldIds]); // CASCADEs links/creatures
    }
    await pool.end();
  }
});

test('re-applying the same spec does not duplicate the portal guard pack', async (t) => {
  if (!requireTestDb(t, 'writes a real spec through applyMapSpec twice')) return;
  const pool = await openPool();
  if (pool.unreachable) { t.skip(`NO DATABASE at ${DB_URL}`); return; }
  const suffix = 'idempotent1';
  const spec = uniqueSpec(suffix);
  let worldIds = [];
  try {
    const orcRow = await pool.query(`SELECT 1 FROM entity_types WHERE name = 'Orc' AND is_creature = true`);
    if (orcRow.rowCount === 0) { t.skip('no "Orc" creature type — cannot exercise guard insertion'); return; }

    await applyMapSpec(pool, spec);
    await applyMapSpec(pool, spec); // second application, same spec

    const worldRows = await pool.query(`SELECT id FROM worlds WHERE name = ANY($1)`,
      [spec.worlds.map((w) => w.name)]);
    worldIds = worldRows.rows.map((r) => r.id);
    const surfaceId = worldRows.rows[0].id; // either order works: both are cleaned up below

    const guardCount = await pool.query(
      `SELECT count(*) FROM world_creatures WHERE world_id = ANY($1) AND type = 'Orc'`, [worldIds]);
    assert.equal(Number(guardCount.rows[0].count), 2, 'guards must not double up on re-apply');
  } finally {
    if (worldIds.length) await pool.query('DELETE FROM worlds WHERE id = ANY($1)', [worldIds]);
    await pool.end();
  }
});
