// backend/tests/map_link_portals_migration.test.js
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

test('map_links has PORTAL coordinate columns and the widened edge check', async (t) => {
  if (!requireTestDb(t, 'reads map_links column metadata')) return;
  const pool = await openPool();
  if (pool.unreachable) { t.skip(`NO DATABASE at ${DB_URL}`); return; }
  try {
    const { rows } = await pool.query(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'map_links'
          AND column_name IN ('from_x','from_y','to_x','to_y')`);
    assert.equal(rows.length, 4, 'expected all four coordinate columns');
    for (const r of rows) {
      assert.equal(r.data_type, 'integer');
      assert.equal(r.is_nullable, 'YES', `${r.column_name} must stay nullable for compass rows`);
    }
  } finally {
    await pool.end();
  }
});

test('a compass edge still allows at most one per world (unchanged guarantee)', async (t) => {
  if (!requireTestDb(t, 'exercises the split unique indexes')) return;
  const pool = await openPool();
  if (pool.unreachable) { t.skip(`NO DATABASE at ${DB_URL}`); return; }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const a = (await client.query(
      `INSERT INTO worlds (name, seed) VALUES ('portal-test-a', 12345) RETURNING id`)).rows[0].id;
    const b = (await client.query(
      `INSERT INTO worlds (name, seed) VALUES ('portal-test-b', 12346) RETURNING id`)).rows[0].id;
    const c = (await client.query(
      `INSERT INTO worlds (name, seed) VALUES ('portal-test-c', 12347) RETURNING id`)).rows[0].id;

    await client.query(
      `INSERT INTO map_links (from_world_id, edge, to_world_id) VALUES ($1,'N',$2)`, [a, b]);
    await assert.rejects(
      client.query(`INSERT INTO map_links (from_world_id, edge, to_world_id) VALUES ($1,'N',$2)`, [a, c]),
      /duplicate key|unique constraint/i,
      'a second N edge from the same world must still be rejected',
    );
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
});

test('two PORTAL rows from the same world at different tiles are both allowed (branching)', async (t) => {
  if (!requireTestDb(t, 'exercises the portal partial unique index')) return;
  const pool = await openPool();
  if (pool.unreachable) { t.skip(`NO DATABASE at ${DB_URL}`); return; }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const a = (await client.query(
      `INSERT INTO worlds (name, seed) VALUES ('portal-test-branch-a', 12345) RETURNING id`)).rows[0].id;
    const b = (await client.query(
      `INSERT INTO worlds (name, seed) VALUES ('portal-test-branch-b', 12345) RETURNING id`)).rows[0].id;
    const c = (await client.query(
      `INSERT INTO worlds (name, seed) VALUES ('portal-test-branch-c', 12345) RETURNING id`)).rows[0].id;

    await client.query(
      `INSERT INTO map_links (from_world_id, edge, to_world_id, from_x, from_y, to_x, to_y)
       VALUES ($1,'PORTAL',$2,100,100,50,50)`, [a, b]);
    await client.query(
      `INSERT INTO map_links (from_world_id, edge, to_world_id, from_x, from_y, to_x, to_y)
       VALUES ($1,'PORTAL',$2,300,300,50,50)`, [a, c]);
    const { rows } = await client.query(
      `SELECT to_world_id FROM map_links WHERE from_world_id = $1 AND edge = 'PORTAL' ORDER BY from_x`, [a]);
    assert.deepStrictEqual(rows.map((r) => r.to_world_id), [b, c],
      'branching requires two portal rows from the same world to coexist');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
});

test('two PORTAL rows from the same world at the SAME tile are rejected', async (t) => {
  if (!requireTestDb(t, 'exercises the portal partial unique index')) return;
  const pool = await openPool();
  if (pool.unreachable) { t.skip(`NO DATABASE at ${DB_URL}`); return; }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const a = (await client.query(
      `INSERT INTO worlds (name, seed) VALUES ('portal-test-collide-a', 12345) RETURNING id`)).rows[0].id;
    const b = (await client.query(
      `INSERT INTO worlds (name, seed) VALUES ('portal-test-collide-b', 12345) RETURNING id`)).rows[0].id;
    const c = (await client.query(
      `INSERT INTO worlds (name, seed) VALUES ('portal-test-collide-c', 12345) RETURNING id`)).rows[0].id;

    await client.query(
      `INSERT INTO map_links (from_world_id, edge, to_world_id, from_x, from_y, to_x, to_y)
       VALUES ($1,'PORTAL',$2,100,100,50,50)`, [a, b]);
    await assert.rejects(
      client.query(
        `INSERT INTO map_links (from_world_id, edge, to_world_id, from_x, from_y, to_x, to_y)
         VALUES ($1,'PORTAL',$2,100,100,60,60)`, [a, c]),
      /duplicate key|unique constraint/i,
      'two destinations wired to the identical source tile must be rejected',
    );
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
});

test('a PORTAL row without all four coordinates is rejected', async (t) => {
  if (!requireTestDb(t, 'exercises the coordinate-presence check')) return;
  const pool = await openPool();
  if (pool.unreachable) { t.skip(`NO DATABASE at ${DB_URL}`); return; }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const a = (await client.query(
      `INSERT INTO worlds (name, seed) VALUES ('portal-test-nocoord-a', 12345) RETURNING id`)).rows[0].id;
    const b = (await client.query(
      `INSERT INTO worlds (name, seed) VALUES ('portal-test-nocoord-b', 12345) RETURNING id`)).rows[0].id;
    await assert.rejects(
      client.query(
        `INSERT INTO map_links (from_world_id, edge, to_world_id, from_x) VALUES ($1,'PORTAL',$2,100)`,
        [a, b]),
      /check constraint|violates/i,
    );
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
});

test('a compass row is rejected if it carries coordinates', async (t) => {
  if (!requireTestDb(t, 'exercises the coordinate-absence check for compass rows')) return;
  const pool = await openPool();
  if (pool.unreachable) { t.skip(`NO DATABASE at ${DB_URL}`); return; }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const a = (await client.query(
      `INSERT INTO worlds (name, seed) VALUES ('portal-test-badcompass-a', 12345) RETURNING id`)).rows[0].id;
    const b = (await client.query(
      `INSERT INTO worlds (name, seed) VALUES ('portal-test-badcompass-b', 12345) RETURNING id`)).rows[0].id;
    await assert.rejects(
      client.query(
        `INSERT INTO map_links (from_world_id, edge, to_world_id, from_x, from_y, to_x, to_y)
         VALUES ($1,'N',$2,100,100,50,50)`, [a, b]),
      /check constraint|violates/i,
    );
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
});
