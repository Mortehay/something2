// backend/tests/creature_blocks_portal_migration.test.js
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

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

test('world_creatures.blocks_portal_id is a nullable FK to map_links', async (t) => {
  if (!requireTestDb(t, 'reads world_creatures column metadata')) return;
  const pool = await openPool();
  if (pool.unreachable) { t.skip(`NO DATABASE at ${DB_URL}`); return; }
  try {
    const { rows } = await pool.query(
      `SELECT is_nullable, data_type FROM information_schema.columns
        WHERE table_name = 'world_creatures' AND column_name = 'blocks_portal_id'`);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].is_nullable, 'YES');
    assert.equal(rows[0].data_type, 'uuid');
  } finally {
    await pool.end();
  }
});

test('deleting the linked map_links row sets blocks_portal_id to NULL, not delete the creature', async (t) => {
  if (!requireTestDb(t, 'exercises ON DELETE SET NULL')) return;
  const pool = await openPool();
  if (pool.unreachable) { t.skip(`NO DATABASE at ${DB_URL}`); return; }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const a = (await client.query(
      `INSERT INTO worlds (name, seed) VALUES ('blocks-portal-test-a', 12345) RETURNING id`)).rows[0].id;
    const b = (await client.query(
      `INSERT INTO worlds (name, seed) VALUES ('blocks-portal-test-b', 12346) RETURNING id`)).rows[0].id;
    const link = (await client.query(
      `INSERT INTO map_links (from_world_id, edge, to_world_id, from_x, from_y, to_x, to_y)
       VALUES ($1,'PORTAL',$2,100,100,50,50) RETURNING id`, [a, b])).rows[0].id;
    const creature = (await client.query(
      `INSERT INTO world_creatures (world_id, type, x, y, hp, facing, blocks_portal_id)
       VALUES ($1,'Orc',100,100,50,'S',$2) RETURNING id`, [a, link])).rows[0].id;

    await client.query('DELETE FROM map_links WHERE id = $1', [link]);

    const { rows } = await client.query(
      'SELECT blocks_portal_id FROM world_creatures WHERE id = $1', [creature]);
    assert.strictEqual(rows[0].blocks_portal_id, null);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
});
