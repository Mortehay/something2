// backend/tests/map_links_portals_db.test.js
// Database-gated tests for setPortalLink and clearPortalLink against real Postgres.
// Exercises the ON CONFLICT clauses and bidirectional operations.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { setPortalLink, clearPortalLink, fetchLinks } = require('../src/services/mapLinks.js');

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

test('setPortalLink creates bidirectional rows with correct coordinates', async (t) => {
  if (!requireTestDb(t, 'exercises setPortalLink against real Postgres')) return;
  const pool = await openPool();
  if (pool.unreachable) { t.skip(`NO DATABASE at ${DB_URL}`); return; }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Create test worlds
    const a = (await client.query(
      `INSERT INTO worlds (name, seed) VALUES ('portal-db-test-a', 12345) RETURNING id`
    )).rows[0].id;
    const b = (await client.query(
      `INSERT INTO worlds (name, seed) VALUES ('portal-db-test-b', 12346) RETURNING id`
    )).rows[0].id;

    // Call setPortalLink
    const { id: forwardId } = await setPortalLink(client, a, 100, 100, b, 50, 50);

    // Verify forward row exists
    const forward = (await client.query(
      `SELECT from_world_id, to_world_id, from_x, from_y, to_x, to_y, edge
       FROM map_links WHERE id = $1`,
      [forwardId]
    )).rows[0];

    assert.equal(forward.from_world_id, a, 'forward row from_world_id');
    assert.equal(forward.to_world_id, b, 'forward row to_world_id');
    assert.equal(forward.from_x, 100, 'forward row from_x');
    assert.equal(forward.from_y, 100, 'forward row from_y');
    assert.equal(forward.to_x, 50, 'forward row to_x');
    assert.equal(forward.to_y, 50, 'forward row to_y');
    assert.equal(forward.edge, 'PORTAL', 'forward row edge');

    // Verify mirror row exists
    const mirror = (await client.query(
      `SELECT from_world_id, to_world_id, from_x, from_y, to_x, to_y, edge
       FROM map_links WHERE from_world_id = $1 AND edge = 'PORTAL' AND from_x = $2 AND from_y = $3`,
      [b, 50, 50]
    )).rows[0];

    assert.equal(mirror.from_world_id, b, 'mirror row from_world_id');
    assert.equal(mirror.to_world_id, a, 'mirror row to_world_id');
    assert.equal(mirror.from_x, 50, 'mirror row from_x');
    assert.equal(mirror.from_y, 50, 'mirror row from_y');
    assert.equal(mirror.to_x, 100, 'mirror row to_x');
    assert.equal(mirror.to_y, 100, 'mirror row to_y');
    assert.equal(mirror.edge, 'PORTAL', 'mirror row edge');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
});

test('setPortalLink updates existing portal at same tile (ON CONFLICT ... DO UPDATE)', async (t) => {
  if (!requireTestDb(t, 'exercises setPortalLink ON CONFLICT UPDATE branch')) return;
  const pool = await openPool();
  if (pool.unreachable) { t.skip(`NO DATABASE at ${DB_URL}`); return; }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Create test worlds
    const a = (await client.query(
      `INSERT INTO worlds (name, seed) VALUES ('portal-update-test-a', 12345) RETURNING id`
    )).rows[0].id;
    const b = (await client.query(
      `INSERT INTO worlds (name, seed) VALUES ('portal-update-test-b', 12346) RETURNING id`
    )).rows[0].id;

    // Create initial portal from a to b
    const { id: firstId } = await setPortalLink(client, a, 100, 100, b, 50, 50);

    // Verify initial row exists
    let count = (await client.query(
      `SELECT COUNT(*)::int AS n FROM map_links
       WHERE from_world_id = $1 AND from_x = 100 AND from_y = 100 AND edge = 'PORTAL'`,
      [a]
    )).rows[0].n;
    assert.equal(count, 1, 'should have 1 forward row from a at (100,100)');

    // Call setPortalLink again for the same source tile (100,100) with same destination
    // This should UPDATE the existing row (ON CONFLICT ... DO UPDATE branch)
    const { id: secondId } = await setPortalLink(client, a, 100, 100, b, 55, 55);

    // Both calls should return the same row id (the forward row)
    assert.equal(firstId, secondId, 'ON CONFLICT should update existing row, not create duplicate');

    // Verify the row was updated to point to new coordinates
    const updated = (await client.query(
      `SELECT to_x, to_y FROM map_links WHERE id = $1`,
      [firstId]
    )).rows[0];

    assert.equal(updated.to_x, 55, 'to_x should be updated');
    assert.equal(updated.to_y, 55, 'to_y should be updated');

    // Verify no duplicate rows were created
    count = (await client.query(
      `SELECT COUNT(*)::int AS n FROM map_links
       WHERE from_world_id = $1 AND from_x = 100 AND from_y = 100 AND edge = 'PORTAL'`,
      [a]
    )).rows[0].n;
    assert.equal(count, 1, 'should still have exactly 1 forward row (no duplicate from ON CONFLICT)');

    // Verify the mirror row was also updated with new coordinates
    const mirrorUpdated = (await client.query(
      `SELECT to_x, to_y FROM map_links WHERE from_world_id = $1 AND from_x = $2 AND from_y = $3 AND edge = 'PORTAL'`,
      [b, 55, 55]
    )).rows[0];

    assert.equal(mirrorUpdated.to_x, 100, 'mirror to_x should be updated');
    assert.equal(mirrorUpdated.to_y, 100, 'mirror to_y should be updated');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
});

test('clearPortalLink removes both forward and mirror rows', async (t) => {
  if (!requireTestDb(t, 'exercises clearPortalLink bidirectional delete')) return;
  const pool = await openPool();
  if (pool.unreachable) { t.skip(`NO DATABASE at ${DB_URL}`); return; }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Create test worlds
    const a = (await client.query(
      `INSERT INTO worlds (name, seed) VALUES ('portal-clear-test-a', 12345) RETURNING id`
    )).rows[0].id;
    const b = (await client.query(
      `INSERT INTO worlds (name, seed) VALUES ('portal-clear-test-b', 12346) RETURNING id`
    )).rows[0].id;

    // Create a portal
    await setPortalLink(client, a, 100, 100, b, 50, 50);

    // Verify both rows exist
    let count = (await client.query(
      `SELECT COUNT(*)::int AS n FROM map_links
       WHERE (from_world_id = $1 OR from_world_id = $2) AND edge = 'PORTAL'`,
      [a, b]
    )).rows[0].n;
    assert.equal(count, 2, 'should have 2 portal rows before clear');

    // Clear the portal
    await clearPortalLink(client, a, 100, 100);

    // Verify both rows are gone
    count = (await client.query(
      `SELECT COUNT(*)::int AS n FROM map_links
       WHERE (from_world_id = $1 OR from_world_id = $2) AND edge = 'PORTAL'`,
      [a, b]
    )).rows[0].n;
    assert.equal(count, 0, 'should have 0 portal rows after clear');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
});

test('fetchLinks returns portal rows with coordinate fields', async (t) => {
  if (!requireTestDb(t, 'exercises fetchLinks with portal coordinates')) return;
  const pool = await openPool();
  if (pool.unreachable) { t.skip(`NO DATABASE at ${DB_URL}`); return; }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Create test worlds
    const a = (await client.query(
      `INSERT INTO worlds (name, seed, width, height) VALUES ('portal-fetch-test-a', 12345, 100, 100) RETURNING id`
    )).rows[0].id;
    const b = (await client.query(
      `INSERT INTO worlds (name, seed, width, height) VALUES ('portal-fetch-test-b', 12346, 100, 100) RETURNING id`
    )).rows[0].id;

    // Create a portal
    await setPortalLink(client, a, 100, 100, b, 50, 50);

    // Fetch links for world a
    const links = await fetchLinks(client, a);

    assert.equal(links.length, 1, 'should have 1 link for world a');
    const link = links[0];
    assert.equal(link.edge, 'PORTAL', 'edge should be PORTAL');
    assert.equal(link.to_world_id, b, 'to_world_id should be b');
    assert.equal(link.from_x, 100, 'from_x should be 100');
    assert.equal(link.from_y, 100, 'from_y should be 100');
    assert.equal(link.to_x, 50, 'to_x should be 50');
    assert.equal(link.to_y, 50, 'to_y should be 50');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
});
