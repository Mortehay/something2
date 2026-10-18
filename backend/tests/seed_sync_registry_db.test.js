const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { GROUPS, getGroup, liveColumns } = require('../src/services/seedSync/registry.js');
const { deterministicUuid } = require('../src/services/seedSync/canonical.js');
const { withSeedSyncLock, cleanupSx } = require('./helpers/seedSyncTest.js');

const DB_URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://user:password@localhost:15432/game_db';

function dbTest(name, body) {
  test(name, async (t) => {
    if (!process.env.TEST_DATABASE_URL) {
      const msg = 'TEST_DATABASE_URL not set -- skipping to avoid mutating a real database (seed_sync fixtures)';
      if (process.env.CI) assert.fail(msg);
      t.skip(msg);
      return;
    }
    const pool = new Pool({ connectionString: DB_URL, max: 2, connectionTimeoutMillis: 3000 });
    t.after(async () => { await pool.end().catch(() => {}); });
    await withSeedSyncLock(pool, async () => {
      await cleanupSx(pool);
      try { await body(t, pool); } finally { await cleanupSx(pool).catch(() => {}); }
    });
  });
}

test('getGroup throws on unknown id and GROUPS is in seed order', () => {
  assert.deepStrictEqual(GROUPS.map((g) => g.id), ['tile_types', 'quests', 'ai_providers']);
  assert.throws(() => getGroup('nope'), /unknown group/);
});

dbTest('every live column is exported or explicitly omitted', async (t, pool) => {
  for (const g of GROUPS) {
    const all = (await pool.query(
      'SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1', [g.table],
    )).rows.map((r) => r.column_name);
    assert.ok(all.length > 0, `${g.table} has columns`);
    const live = new Set((await liveColumns(pool, g)).map((c) => c.name));
    const skipped = new Set([...Object.keys(g.omit), ...(g.secretColumns || [])]);
    for (const c of all) {
      assert.ok(live.has(c) || skipped.has(c), `${g.table}.${c} is neither exported nor omitted`);
      assert.ok(!(live.has(c) && skipped.has(c)), `${g.table}.${c} is both`);
    }
  }
});

dbTest('liveColumns is sorted and carries information_schema data_type', async (t, pool) => {
  const cols = await liveColumns(pool, getGroup('tile_types'));
  const names = cols.map((c) => c.name);
  assert.deepStrictEqual(names, [...names].sort());
  assert.strictEqual(cols.find((c) => c.name === 'valid_neighbors').dataType, 'jsonb');
  assert.strictEqual(cols.find((c) => c.name === 'speed').dataType, 'real');
});

dbTest('ai_providers liveColumns never includes auth_token', async (t, pool) => {
  const names = (await liveColumns(pool, getGroup('ai_providers'))).map((c) => c.name);
  assert.ok(!names.includes('auth_token'));
  assert.ok(names.includes('base_url'));
});

dbTest('deterministicUuid matches the SQL backfill formula', async (t, pool) => {
  await pool.query("INSERT INTO quests (key, act, title, description) VALUES ('sx_q1', 1, 't', 'd')");
  const sql = (await pool.query("SELECT md5('s2sync:'||'quests'||':'||$1)::uuid::text AS u", ['sx_q1'])).rows[0].u;
  assert.strictEqual(deterministicUuid('quests', 'sx_q1'), sql);
});

dbTest('migration backfilled pre-existing rows', async (t, pool) => {
  const { rows } = await pool.query("SELECT name, sync_uuid FROM tile_types WHERE name NOT LIKE 'sx\\_%' ORDER BY name LIMIT 1");
  assert.ok(rows.length, 'scratch DB has a seeded tile_types row');
  assert.strictEqual(rows[0].sync_uuid, deterministicUuid('tile_types', rows[0].name));
});
