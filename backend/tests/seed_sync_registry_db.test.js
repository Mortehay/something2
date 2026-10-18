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

dbTest('every live column is exported or explicitly omitted, with no stale omit keys', async (t, pool) => {
  for (const g of GROUPS) {
    const all = (await pool.query(
      'SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1', [g.table],
    )).rows.map((r) => r.column_name);
    assert.ok(all.length > 0, `${g.table} has columns`);
    const live = (await liveColumns(pool, g)).map((c) => c.name);
    const omit = Object.keys(g.omit);
    const secret = g.secretColumns || [];
    for (const c of [...omit, ...secret]) assert.ok(all.includes(c), `${g.table}: stale omit/secret key ${c}`);
    const union = [...live, ...omit, ...secret];
    assert.strictEqual(new Set(union).size, union.length, `${g.table}: a column is listed twice`);
    assert.deepStrictEqual([...union].sort(), [...all].sort(), `${g.table}: columns drifted`);
  }
});

// A FK column holds a local numeric id that means nothing on another PC (or
// worse, points at a different row). Plan 1 omits them; plan 2 maps them.
dbTest('no live column of any group carries a FK constraint', async (t, pool) => {
  for (const g of GROUPS) {
    const fkCols = (await pool.query(
      `SELECT a.attname::text AS name FROM pg_constraint c
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
        WHERE c.contype = 'f' AND c.conrelid = $1::text::regclass`, [g.table],
    )).rows.map((r) => r.name);
    const live = (await liveColumns(pool, g)).map((c) => c.name);
    assert.deepStrictEqual(live.filter((c) => fkCols.includes(c)), [], `${g.table}: FK column exported`);
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

// Per-PC choices and art travel separately (final review rulings).
dbTest('per-PC and art columns are omitted, with their reason', async (t, pool) => {
  const ai = getGroup('ai_providers');
  assert.ok(!(await liveColumns(pool, ai)).some((c) => c.name === 'is_active'));
  assert.strictEqual(ai.omit.is_active, 'per-PC choice: which box this PC can reach');
  const tt = getGroup('tile_types');
  const ttNames = (await liveColumns(pool, tt)).map((c) => c.name);
  for (const c of ['render_mode', 'sprite']) {
    assert.ok(!ttNames.includes(c), c);
    assert.strictEqual(tt.omit[c], 'art group (plan 3)');
  }
});

dbTest('deterministicUuid matches the SQL backfill formula', async (t, pool) => {
  const sql = (await pool.query("SELECT md5('s2sync:'||'quests'||':'||$1::text)::uuid::text AS u", ['sx_q1'])).rows[0].u;
  assert.strictEqual(deterministicUuid('quests', 'sx_q1'), sql);
});

// 'grass' is seeded by 1714440002000_create_tile_types.js, long before the
// sync_uuid migration, so its uuid can only come from the backfill.
dbTest('migration backfilled pre-existing rows', async (t, pool) => {
  const { rows } = await pool.query("SELECT sync_uuid FROM tile_types WHERE name = 'grass'");
  if (!rows.length) { t.skip("tile 'grass' (seeded by the create_tile_types migration) is absent on this DB"); return; }
  assert.strictEqual(rows[0].sync_uuid, deterministicUuid('tile_types', 'grass'));
});
