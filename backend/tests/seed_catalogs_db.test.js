const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { seedCatalogs } = require('../scripts/seed-catalogs.js');
const { DEFAULT_TILE_TYPES } = require('../seeds/data/tileTypes.js');

// Skips without a database, FAILS under CI — same posture as
// creature_drops_db.test.js. A skip reads like a pass; treat it as unknown.
const DB_URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://user:password@localhost:15432/game_db';

async function openPool() {
  const pool = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 2000, max: 2 });
  try { await pool.query('SELECT 1'); return pool; }
  catch (err) { await pool.end().catch(() => {}); return { unreachable: err.message }; }
}

test('seeding catalogs twice is a no-op the second time', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} (${pool.unreachable}) — catalog seeding is UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  try {
    await seedCatalogs(pool);
    const after1 = await pool.query('SELECT name, color, walkable, speed FROM tile_types ORDER BY name');
    await seedCatalogs(pool);
    const after2 = await pool.query('SELECT name, color, walkable, speed FROM tile_types ORDER BY name');

    assert.deepEqual(after2.rows, after1.rows, 'second seed changed tile_types');
    assert.ok(after1.rowCount >= DEFAULT_TILE_TYPES.length,
      'fewer tiles than the seed file defines — the upsert did not apply');
  } finally { await pool.end(); }
});

test('seeding does not delete a hand-added tile type', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} — hand-added-tile survival is UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  const CANARY = 'zz_seed_canary_tile';
  try {
    await pool.query(
      `INSERT INTO tile_types (name, color, walkable, speed, image, valid_neighbors)
       VALUES ($1, '#123456', true, 1.0, '', '[]') ON CONFLICT (name) DO NOTHING`, [CANARY]);
    await seedCatalogs(pool);
    const r = await pool.query('SELECT 1 FROM tile_types WHERE name = $1', [CANARY]);
    assert.equal(r.rowCount, 1, 'seeding deleted a tile type it did not create');
  } finally {
    await pool.query('DELETE FROM tile_types WHERE name = $1', [CANARY]).catch(() => {});
    await pool.end();
  }
});
