const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { withSeedSyncLock } = require('./helpers/seedSyncTest.js');

// SOMET-632. seed_sync migration: history + baseline tables and a travelling
// sync_uuid on the three tables whose natural key is not the id.
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

// Same value Postgres yields for md5('s2sync:<table>:<key>')::uuid.
function expectedUuid(table, key) {
  const h = crypto.createHash('md5').update(`s2sync:${table}:${key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const INSERTS = {
  quests: {
    col: 'key',
    sql: "INSERT INTO quests (key, title, act, description) VALUES ($1, 'sx t', 1, 'sx d') RETURNING sync_uuid",
  },
  tile_types: {
    col: 'name',
    sql: "INSERT INTO tile_types (name, color) VALUES ($1, '#000000') RETURNING sync_uuid",
  },
  ai_providers: {
    col: 'name',
    sql: "INSERT INTO ai_providers (name, base_url, request_template) VALUES ($1, 'http://x', '{}') RETURNING sync_uuid",
  },
};

async function cleanup(pool) {
  for (const [table, { col }] of Object.entries(INSERTS)) {
    await pool.query(`DELETE FROM ${table} WHERE ${col} LIKE 'sx\\_%'`);
  }
}

function dbTest(name, body) {
  test(name, async (t) => {
    if (!requireTestDb(t, 'writes quests/tile_types/ai_providers')) return;
    const pool = new Pool({ connectionString: DB_URL, max: 2, connectionTimeoutMillis: 3000 });
    t.after(async () => { await pool.end().catch(() => {}); });
    // Shared lock: other seed_sync files clean up sx_ rows too (cleanupSx), so
    // running unlocked lets them delete this file's rows mid-test.
    await withSeedSyncLock(pool, async () => {
      await cleanup(pool);
      try {
        await body(t, pool);
      } finally {
        await cleanup(pool).catch(() => {});
      }
    });
  });
}

async function columns(pool, table) {
  const { rows } = await pool.query(
    'SELECT column_name FROM information_schema.columns WHERE table_name = $1', [table]);
  return rows.map((r) => r.column_name).sort();
}

dbTest('seed_sync tables exist', async (t, pool) => {
  assert.deepStrictEqual(await columns(pool, 'seed_export_runs'), [
    'action', 'error', 'finished_at', 'git_commit', 'group_id', 'id',
    'pc_label', 'started_at', 'status', 'summary',
  ]);
  assert.deepStrictEqual(await columns(pool, 'seed_row_hashes'), [
    'group_id', 'hash', 'sync_uuid', 'updated_at',
  ]);
  // CHECK constraints are enforced, not just declared.
  await assert.rejects(
    pool.query("INSERT INTO seed_export_runs (group_id, action, status, pc_label) VALUES ('sx_g','bogus','ok','p')"),
    (e) => e.code === '23514');
  await assert.rejects(
    pool.query("INSERT INTO seed_export_runs (group_id, action, status, pc_label) VALUES ('sx_g','export','bogus','p')"),
    (e) => e.code === '23514');
});

dbTest('existing rows get deterministic sync_uuid', async (t, pool) => {
  for (const [table, { col, sql }] of Object.entries(INSERTS)) {
    const key = `sx_det_${table}`;
    const { rows } = await pool.query(sql, [key]);
    assert.ok(rows[0].sync_uuid, `${table}: DB default fills sync_uuid`);
    await pool.query(
      `UPDATE ${table} SET sync_uuid = md5('s2sync:'||'${table}'||':'||${col})::uuid WHERE ${col} = $1`, [key]);
    const got = await pool.query(`SELECT sync_uuid FROM ${table} WHERE ${col} = $1`, [key]);
    assert.strictEqual(got.rows[0].sync_uuid, expectedUuid(table, key));
  }
});

dbTest('sync_uuid is unique', async (t, pool) => {
  for (const [table, { col, sql }] of Object.entries(INSERTS)) {
    const a = await pool.query(sql, [`sx_uq_a_${table}`]);
    await pool.query(`UPDATE ${table} SET sync_uuid = $1 WHERE ${col} = $2`, [a.rows[0].sync_uuid, `sx_uq_a_${table}`]);
    await pool.query(sql, [`sx_uq_b_${table}`]);
    await assert.rejects(
      pool.query(`UPDATE ${table} SET sync_uuid = $1 WHERE ${col} = $2`, [a.rows[0].sync_uuid, `sx_uq_b_${table}`]),
      (e) => e.code === '23505', `${table}: duplicate sync_uuid`);
  }
});
