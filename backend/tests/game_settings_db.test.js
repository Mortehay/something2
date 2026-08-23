const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { getSetting, getSettings, setSetting } = require('../src/services/gameSettings.js');

// Gated on TEST_DATABASE_URL alone, with NO DATABASE_URL fallback -- the same
// idiom progression_migration.test.js uses -- so a bare `npm test` on a
// machine with a working dev database can never reach this file.
const DB_URL = process.env.TEST_DATABASE_URL || 'postgres://user:password@localhost:15432/game_db';

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
  try { await pool.query('SELECT 1'); return pool; } catch (err) {
    await pool.end().catch(() => {});
    return { unreachable: err.message };
  }
}

test('game_settings has the documented shape', async (t) => {
  if (!requireTestDb(t, 'this test reads game_settings column metadata')) return;
  const pool = await openPool();
  if (pool.unreachable) { t.skip(`NO DATABASE at ${DB_URL} -- the schema is UNVERIFIED`); return; }
  try {
    const { rows } = await pool.query(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_name = 'game_settings'`,
    );
    const by = new Map(rows.map((r) => [r.column_name, r]));
    assert.equal(by.get('key').data_type, 'text');
    assert.equal(by.get('key').is_nullable, 'NO');
    assert.equal(by.get('value').data_type, 'jsonb');
    assert.equal(by.get('value').is_nullable, 'NO');
    assert.equal(by.get('updated_at').data_type, 'timestamp with time zone');

    const { rows: pk } = await pool.query(
      `SELECT a.attname FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = 'game_settings'::regclass AND i.indisprimary`,
    );
    assert.deepStrictEqual(pk.map((r) => r.attname), ['key'], 'key must be the primary key');
  } finally { await pool.end(); }
});

test('the migration seeded the four default rows with the documented values', async (t) => {
  if (!requireTestDb(t, 'this test reads the seeded game_settings rows')) return;
  const pool = await openPool();
  if (pool.unreachable) { t.skip(`NO DATABASE at ${DB_URL} -- the seed rows are UNVERIFIED`); return; }
  try {
    const { rows } = await pool.query('SELECT key, value FROM game_settings ORDER BY key');
    const by = new Map(rows.map((r) => [r.key, r.value]));
    assert.strictEqual(by.get('passive_points_per_level'), 1);
    assert.strictEqual(by.get('ground_item_ttl_seconds'), 180);
    assert.strictEqual(by.get('respec_base_gold'), 50);
    assert.strictEqual(by.get('rarity_weights').length, 3);
    assert.deepStrictEqual(by.get('rarity_weights')[2],
      { item_level: 150, white: 45, blue: 30, yellow: 20, foxy: 5 });
  } finally { await pool.end(); }
});

// Writes are wrapped in a transaction this test rolls back, so the seeded
// rows survive untouched even on a scratch database.
test('setSetting upserts and getSetting reads the new value back', async (t) => {
  if (!requireTestDb(t, 'this test UPDATEs a game_settings row inside a rolled-back transaction')) return;
  const pool = await openPool();
  if (pool.unreachable) { t.skip(`NO DATABASE at ${DB_URL} -- the upsert is UNVERIFIED`); return; }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const written = await setSetting(client, 'ground_item_ttl_seconds', 42);
    assert.strictEqual(written.key, 'ground_item_ttl_seconds');
    assert.strictEqual(written.value, 42);
    assert.strictEqual(await getSetting(client, 'ground_item_ttl_seconds'), 42);

    // Upsert, not insert: a second write of the same key replaces it.
    await setSetting(client, 'ground_item_ttl_seconds', 43);
    assert.strictEqual(await getSetting(client, 'ground_item_ttl_seconds'), 43);
    const { rows } = await client.query(
      "SELECT count(*)::int AS n FROM game_settings WHERE key = 'ground_item_ttl_seconds'");
    assert.strictEqual(rows[0].n, 1, 'the upsert must not create a second row');

    // A structured value survives the jsonb round trip unchanged.
    const anchors = [{ item_level: 1, white: 1, blue: 2, yellow: 3, foxy: 4 }];
    await setSetting(client, 'rarity_weights', anchors);
    assert.deepStrictEqual(await getSetting(client, 'rarity_weights'), anchors);

    const bundle = await getSettings(client, ['ground_item_ttl_seconds', 'respec_base_gold']);
    assert.deepStrictEqual(bundle, { ground_item_ttl_seconds: 43, respec_base_gold: 50 });

    await client.query('ROLLBACK');
  } finally { client.release(); await pool.end(); }
});
