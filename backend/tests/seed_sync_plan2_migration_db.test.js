const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { withSeedSyncLock } = require('./helpers/seedSyncTest.js');

// SOMET-639. Plan-2 migration: travelling sync_uuid on the data-group tables
// (deterministic backfill from natural keys) + unique composite keys on
// creature_drops / behavior_drops / chest_loot.
const DB_URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
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

function expectedUuid(table, key) {
  const h = crypto.createHash('md5').update(`s2sync:${table}:${key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// table -> SQL selecting (sync_uuid, key) for one pre-existing row (lowest id /
// key, non-sx so it was present when the migration backfilled).
const KEYED = {
  item_types: "SELECT sync_uuid, name AS k FROM item_types WHERE name NOT LIKE 'sx\\_%' ORDER BY id LIMIT 1",
  affix_types: "SELECT sync_uuid, key AS k FROM affix_types WHERE key NOT LIKE 'sx\\_%' ORDER BY id LIMIT 1",
  vfx_effects: "SELECT sync_uuid, name AS k FROM vfx_effects WHERE name NOT LIKE 'sx\\_%' ORDER BY id LIMIT 1",
  creature_skills: "SELECT sync_uuid, name AS k FROM creature_skills WHERE name NOT LIKE 'sx\\_%' ORDER BY id LIMIT 1",
  aura_effects: "SELECT sync_uuid, name AS k FROM aura_effects WHERE name NOT LIKE 'sx\\_%' ORDER BY id LIMIT 1",
  creature_behaviors: "SELECT sync_uuid, name AS k FROM creature_behaviors WHERE name NOT LIKE 'sx\\_%' ORDER BY id LIMIT 1",
  creature_abilities: `SELECT t.sync_uuid, b.name || '|' || t.slot AS k FROM creature_abilities t
    JOIN creature_behaviors b ON b.id = t.behavior_id WHERE b.name NOT LIKE 'sx\\_%' ORDER BY t.id LIMIT 1`,
  creature_behavior_skills: `SELECT t.sync_uuid, b.name || '|' || t.slot AS k FROM creature_behavior_skills t
    JOIN creature_behaviors b ON b.id = t.behavior_id WHERE b.name NOT LIKE 'sx\\_%' ORDER BY t.id LIMIT 1`,
  behavior_drops: `SELECT t.sync_uuid, b.name || '|' || i.name AS k FROM behavior_drops t
    JOIN creature_behaviors b ON b.id = t.behavior_id JOIN item_types i ON i.id = t.item_type_id
    WHERE b.name NOT LIKE 'sx\\_%' ORDER BY t.id LIMIT 1`,
  chest_loot: `SELECT t.sync_uuid, t.level_min || '|' || t.level_max || '|' || i.name AS k FROM chest_loot t
    JOIN item_types i ON i.id = t.item_type_id WHERE i.name NOT LIKE 'sx\\_%' ORDER BY t.id LIMIT 1`,
  entity_types: "SELECT sync_uuid, name AS k FROM entity_types WHERE name NOT LIKE 'sx\\_%' ORDER BY id LIMIT 1",
  creature_drops: `SELECT t.sync_uuid, e.name || '|' || i.name AS k FROM creature_drops t
    JOIN entity_types e ON e.id = t.entity_type_id JOIN item_types i ON i.id = t.item_type_id
    WHERE e.name NOT LIKE 'sx\\_%' ORDER BY t.id LIMIT 1`,
  class_loadouts: `SELECT t.sync_uuid, e.name || '|' || i.name AS k FROM class_loadouts t
    JOIN entity_types e ON e.id = t.entity_type_id JOIN item_types i ON i.id = t.item_type_id
    WHERE e.name NOT LIKE 'sx\\_%' ORDER BY t.id LIMIT 1`,
  biomes: "SELECT sync_uuid, name AS k FROM biomes WHERE name NOT LIKE 'sx\\_%' ORDER BY id LIMIT 1",
  passive_nodes: "SELECT sync_uuid, key AS k FROM passive_nodes WHERE key NOT LIKE 'sx\\_%' ORDER BY id LIMIT 1",
  passive_edges: `SELECT t.sync_uuid, LEAST(a.key COLLATE "C", b.key COLLATE "C") || '|'
      || GREATEST(a.key COLLATE "C", b.key COLLATE "C") AS k FROM passive_edges t
    JOIN passive_nodes a ON a.id = t.a_id JOIN passive_nodes b ON b.id = t.b_id
    WHERE a.key NOT LIKE 'sx\\_%' ORDER BY t.a_id, t.b_id LIMIT 1`,
  game_settings: "SELECT sync_uuid, key AS k FROM game_settings WHERE key NOT LIKE 'sx\\_%' ORDER BY key LIMIT 1",
};

function dbTest(name, body) {
  test(name, async (t) => {
    if (!requireTestDb(t, 'reads plan-2 tables; duplicate probes are rolled back')) return;
    const pool = new Pool({ connectionString: DB_URL, max: 2, connectionTimeoutMillis: 3000 });
    t.after(async () => { await pool.end().catch(() => {}); });
    await withSeedSyncLock(pool, () => body(t, pool));
  });
}

dbTest('every plan-2 table has a NOT NULL UNIQUE sync_uuid with a uuid default', async (t, pool) => {
  for (const table of Object.keys(KEYED)) {
    const col = await pool.query(
      `SELECT is_nullable, column_default, data_type FROM information_schema.columns
        WHERE table_name = $1 AND column_name = 'sync_uuid'`, [table]);
    assert.strictEqual(col.rows.length, 1, `${table}: sync_uuid column exists`);
    assert.strictEqual(col.rows[0].data_type, 'uuid');
    assert.strictEqual(col.rows[0].is_nullable, 'NO', `${table}: NOT NULL`);
    assert.match(col.rows[0].column_default, /gen_random_uuid/, `${table}: default`);
    const uq = await pool.query(
      `SELECT 1 FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = $1::regclass AND i.indisunique AND i.indnatts = 1 AND a.attname = 'sync_uuid'`, [table]);
    assert.strictEqual(uq.rows.length, 1, `${table}: unique on sync_uuid`);
  }
});

dbTest('pre-existing rows carry the deterministic md5 sync_uuid', async (t, pool) => {
  for (const [table, sql] of Object.entries(KEYED)) {
    const { rows } = await pool.query(sql);
    if (rows.length === 0) {
      t.diagnostic(`${table}: empty on this DB -- deterministic check skipped`);
      continue;
    }
    assert.strictEqual(rows[0].sync_uuid, expectedUuid(table, rows[0].k), `${table}: ${rows[0].k}`);
  }
});

const DUP_PROBES = {
  creature_drops: `INSERT INTO creature_drops (entity_type_id, item_type_id, chance, min_qty, max_qty)
    SELECT entity_type_id, item_type_id, chance, min_qty, max_qty FROM creature_drops ORDER BY id LIMIT 1`,
  behavior_drops: `INSERT INTO behavior_drops (behavior_id, item_type_id, chance, min_qty, max_qty)
    SELECT behavior_id, item_type_id, chance, min_qty, max_qty FROM behavior_drops ORDER BY id LIMIT 1`,
  chest_loot: `INSERT INTO chest_loot (level_min, level_max, item_type_id, chance, min_qty, max_qty)
    SELECT level_min, level_max, item_type_id, chance, min_qty, max_qty FROM chest_loot ORDER BY id LIMIT 1`,
};

dbTest('duplicate composite keys are rejected (23505), rolled back', async (t, pool) => {
  for (const [table, sql] of Object.entries(DUP_PROBES)) {
    const have = await pool.query(`SELECT 1 FROM ${table} LIMIT 1`);
    if (have.rows.length === 0) { t.diagnostic(`${table}: empty -- skipped`); continue; }
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await assert.rejects(c.query(sql), (e) => e.code === '23505', `${table}: duplicate rejected`);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }
});

// Final review (3): computed deterministic uuids that collide block the
// UNIQUE step; the migration lists them and deletes nothing.
const plan2Migration = require('../migrations/1714440790000_seed_sync_plan2.js');

dbTest('uuid collision pre-check: none on this DB; an injected key collision is listed (rolled back)', async (t, pool) => {
  assert.deepStrictEqual(await plan2Migration._uuidCollisions(pool), []);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    // behavior 'sx_col_b|sx_col_i' + item 'sx_col_j' and behavior 'sx_col_b'
    // + item 'sx_col_i|sx_col_j' both join to 'sx_col_b|sx_col_i|sx_col_j'.
    const beh = async (name) => (await c.query(`INSERT INTO creature_behaviors (name, aggro_radius, leash_radius, chase_style)
      VALUES ($1, 100, 200, 'charge') RETURNING id`, [name])).rows[0].id;
    const item = async (name) => (await c.query(`INSERT INTO item_types (name, category, damage, cooldown)
      VALUES ($1, 'currency', 0, 0) RETURNING id`, [name])).rows[0].id;
    const b1 = await beh('sx_col_b|sx_col_i');
    const b2 = await beh('sx_col_b');
    const i1 = await item('sx_col_j');
    const i2 = await item('sx_col_i|sx_col_j');
    await c.query('INSERT INTO behavior_drops (behavior_id, item_type_id, chance) VALUES ($1, $2, 0.5), ($3, $4, 0.5)',
      [b1, i1, b2, i2]);
    const out = await plan2Migration._uuidCollisions(c);
    assert.deepStrictEqual(out,
      ['behavior_drops keys ["sx_col_b|sx_col_i|sx_col_j","sx_col_b|sx_col_i|sx_col_j"] -> one sync_uuid x2']);
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
});
