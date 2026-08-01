const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { seedCatalogs } = require('../scripts/seed-catalogs.js');
const { DEFAULT_TILE_TYPES } = require('../seeds/data/tileTypes.js');
const { STARTER_BIOMES } = require('../seeds/data/biomes.js');
const { NEW_DECORATIONS, SIZE_FIXES } = require('../seeds/data/decorationTypes.js');

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

// SIZE_FIXES (Tree/Stone/IceRock display size) is a ONE-TIME correction that
// belongs to migration 1714440042000_decoration_types.js — its own `down`
// reverts those columns back to 0x0, which only makes sense for a migration
// step, not an ongoing invariant. The seeder must NOT replay it, or it would
// silently stomp an admin's hand-resized decoration on every `make
// seed-catalogs` run. This test hand-resizes a real seeded decoration to a
// value nothing in any seed file would ever produce, then asserts a seed run
// leaves it alone.
test('seeding does not revert a hand-resized decoration', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} — hand-resized-decoration survival is UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  const NAME = 'Tree';
  const original = SIZE_FIXES[NAME];
  const HAND_SIZE = { w: 777, h: 888 };
  try {
    const before = await pool.query('SELECT 1 FROM entity_types WHERE name = $1', [NAME]);
    assert.equal(before.rowCount, 1, `${NAME} is not seeded — cannot exercise this test`);

    await pool.query(
      'UPDATE entity_types SET display_width = $1, display_height = $2 WHERE name = $3',
      [HAND_SIZE.w, HAND_SIZE.h, NAME],
    );
    await seedCatalogs(pool);
    const r = await pool.query(
      'SELECT display_width, display_height FROM entity_types WHERE name = $1', [NAME],
    );
    assert.equal(r.rows[0].display_width, HAND_SIZE.w, 'seeding reverted a hand-resized decoration width');
    assert.equal(r.rows[0].display_height, HAND_SIZE.h, 'seeding reverted a hand-resized decoration height');
  } finally {
    await pool.query(
      'UPDATE entity_types SET display_width = $1, display_height = $2 WHERE name = $3',
      [original.w, original.h, NAME],
    ).catch(() => {});
    await pool.end();
  }
});

test('seeding biomes twice is a no-op the second time', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} — biome seeding is UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  try {
    await seedCatalogs(pool);
    const cols = 'name, terrain_tiles, flora_types, creature_types, palette, art_style, exclusions, color';
    const after1 = await pool.query(`SELECT ${cols} FROM biomes ORDER BY name`);
    await seedCatalogs(pool);
    const after2 = await pool.query(`SELECT ${cols} FROM biomes ORDER BY name`);

    assert.deepEqual(after2.rows, after1.rows, 'second seed changed biomes');
    assert.ok(after1.rowCount >= STARTER_BIOMES.length,
      'fewer biomes than the seed file defines — the upsert did not apply');
  } finally { await pool.end(); }
});

test('seeding does not delete a hand-added biome', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} — hand-added-biome survival is UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  const CANARY = 'zz_seed_canary_biome';
  try {
    await pool.query(
      'INSERT INTO biomes (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [CANARY],
    );
    await seedCatalogs(pool);
    const r = await pool.query('SELECT 1 FROM biomes WHERE name = $1', [CANARY]);
    assert.equal(r.rowCount, 1, 'seeding deleted a biome it did not create');
  } finally {
    await pool.query('DELETE FROM biomes WHERE name = $1', [CANARY]).catch(() => {});
    await pool.end();
  }
});

test('seeding decorations twice is a no-op the second time', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} — decoration seeding is UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  try {
    const names = NEW_DECORATIONS.map((d) => d.name);
    await seedCatalogs(pool);
    const cols = 'name, is_creature, walkable, render_mode, spawn_tiles, chance, display_width, display_height, color';
    const after1 = await pool.query(
      `SELECT ${cols} FROM entity_types WHERE name = ANY($1) ORDER BY name`, [names],
    );
    await seedCatalogs(pool);
    const after2 = await pool.query(
      `SELECT ${cols} FROM entity_types WHERE name = ANY($1) ORDER BY name`, [names],
    );

    assert.deepEqual(after2.rows, after1.rows, 'second seed changed decoration entity_types rows');
    assert.ok(after1.rowCount >= NEW_DECORATIONS.length,
      'fewer decorations than the seed file defines — the insert did not apply');
  } finally { await pool.end(); }
});

test('seeding does not delete a hand-added decoration', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} — hand-added-decoration survival is UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  const CANARY = 'zz_seed_canary_decoration';
  try {
    await pool.query(
      `INSERT INTO entity_types
        (name, color, walkable, is_creature, render_mode, spawn_tiles, chance, display_width, display_height)
       VALUES ($1, '#654321', false, false, 'static', '[]', 0.1, 10, 10)
       ON CONFLICT (name) DO NOTHING`, [CANARY],
    );
    await seedCatalogs(pool);
    const r = await pool.query('SELECT 1 FROM entity_types WHERE name = $1', [CANARY]);
    assert.equal(r.rowCount, 1, 'seeding deleted a decoration it did not create');
  } finally {
    await pool.query('DELETE FROM entity_types WHERE name = $1', [CANARY]).catch(() => {});
    await pool.end();
  }
});
