const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { Pool } = require('pg');
const { withSeedSyncLock, cleanupSx, makeTempSyncDir } = require('./helpers/seedSyncTest.js');

const DB_URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://user:password@localhost:15432/game_db';

function dbTest(name, body) {
  test(name, async (t) => {
    if (!process.env.TEST_DATABASE_URL) {
      const msg = 'TEST_DATABASE_URL not set -- skipping to avoid mutating a real database (seed_sync export)';
      if (process.env.CI) assert.fail(msg);
      t.skip(msg);
      return;
    }
    const dir = makeTempSyncDir();
    const prev = process.env.SEED_SYNC_DIR;
    process.env.SEED_SYNC_DIR = dir;
    const pool = new Pool({ connectionString: DB_URL, max: 2, connectionTimeoutMillis: 3000 });
    t.after(async () => {
      if (prev === undefined) delete process.env.SEED_SYNC_DIR; else process.env.SEED_SYNC_DIR = prev;
      fs.rmSync(dir, { recursive: true, force: true });
      await pool.end().catch(() => {});
    });
    await withSeedSyncLock(pool, async () => {
      await cleanupSx(pool);
      try { await body(t, pool, dir); } finally { await cleanupSx(pool).catch(() => {}); }
    });
  });
}

const { exportGroup, readExport, fileFor, syncDir } = require('../src/services/seedSync/exportGroup.js');
const { rowHash } = require('../src/services/seedSync/canonical.js');
const { lastRuns, recentRuns } = require('../src/services/seedSync/runs.js');

const addQuest = (pool, key) => pool.query(
  "INSERT INTO quests (key, title, act, description) VALUES ($1, 'sx t', 1, 'sx d')", [key]);

dbTest('export writes header and sorted canonical rows', async (t, pool, dir) => {
  await addQuest(pool, 'sx_b');
  await addQuest(pool, 'sx_a');
  const { rowCount } = await exportGroup(pool, 'quests');
  assert.strictEqual(syncDir(), dir);
  const text = fs.readFileSync(fileFor('quests'), 'utf8');
  assert.ok(text.endsWith('}\n') && !text.endsWith('\n\n'));
  const data = JSON.parse(text);
  assert.deepStrictEqual(Object.keys(data.header).sort(),
    ['exported_at', 'exported_by', 'group', 'row_count', 'schema_version']);
  assert.strictEqual(data.header.group, 'quests');
  assert.strictEqual(data.header.row_count, data.rows.length);
  assert.strictEqual(rowCount, data.rows.length);
  const keys = data.rows.map((r) => r.key);
  assert.ok(keys.indexOf('sx_a') >= 0 && keys.indexOf('sx_a') < keys.indexOf('sx_b'));
  const sorted = [...keys].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  assert.deepStrictEqual(keys, sorted);
  for (const r of data.rows) {
    assert.ok(!('id' in r) && !('created_at' in r));
    assert.ok(r.sync_uuid);
  }
  assert.deepStrictEqual(await readExport('quests'), data);
  assert.strictEqual(await readExport('tile_types'), null);
});

const rawNoStamp = (groupId) => fs.readFileSync(fileFor(groupId), 'utf8')
  .split('\n').filter((l) => !/^\s*"exported_at":/.test(l)).join('\n');

dbTest('second export is byte-identical', async (t, pool) => {
  await addQuest(pool, 'sx_a');
  await exportGroup(pool, 'quests');
  const first = rawNoStamp('quests');
  await exportGroup(pool, 'quests');
  assert.strictEqual(rawNoStamp('quests'), first);
});

dbTest('tile_types round trip: float, jsonb key order, stable hash', async (t, pool) => {
  await pool.query(
    `INSERT INTO tile_types (name, color, speed, valid_neighbors)
     VALUES ('sx_tile', '#123456', 0.75, '[{"z":1,"a":{"y":2,"b":3}},"grass"]')`);
  await exportGroup(pool, 'tile_types');
  const first = rawNoStamp('tile_types');
  await exportGroup(pool, 'tile_types');
  assert.strictEqual(rawNoStamp('tile_types'), first);
  const row = JSON.parse(fs.readFileSync(fileFor('tile_types'), 'utf8')).rows.find((r) => r.name === 'sx_tile');
  assert.strictEqual(row.speed, 0.75);
  const h = (await pool.query('SELECT hash FROM seed_row_hashes WHERE group_id=$1 AND sync_uuid=$2', ['tile_types', row.sync_uuid])).rows[0];
  assert.strictEqual(h.hash, rowHash(row));
});

dbTest('ai_providers export never contains auth_token', async (t, pool) => {
  await pool.query(
    "INSERT INTO ai_providers (name, base_url, request_template, auth_token) VALUES ('sx_p', 'http://x', '{}', 'sx-secret')");
  await exportGroup(pool, 'ai_providers');
  const text = fs.readFileSync(fileFor('ai_providers'), 'utf8');
  assert.ok(text.includes('sx_p'));
  assert.ok(!text.includes('sx-secret'));
  assert.ok(!text.includes('auth_token'));
});

dbTest('readExport throws bad_file on invalid JSON or missing header', async (t) => {
  fs.writeFileSync(fileFor('quests'), '{ nope');
  await assert.rejects(readExport('quests'), (e) => e.code === 'bad_file' && /quests\.json/.test(e.file));
  fs.writeFileSync(fileFor('quests'), '{"rows":[]}');
  await assert.rejects(readExport('quests'), (e) => e.code === 'bad_file');
});

dbTest('export records a run and baselines', async (t, pool) => {
  await addQuest(pool, 'sx_a');
  await addQuest(pool, 'sx_gone');
  await exportGroup(pool, 'quests');
  const gone = (await pool.query("SELECT sync_uuid FROM seed_row_hashes h JOIN quests q USING (sync_uuid) WHERE q.key='sx_gone'")).rows;
  assert.strictEqual(gone.length, 1);
  await pool.query("DELETE FROM quests WHERE key='sx_gone'");
  const { runId } = await exportGroup(pool, 'quests');
  const run = (await pool.query('SELECT * FROM seed_export_runs WHERE id=$1', [runId])).rows[0];
  assert.strictEqual(run.action, 'export');
  assert.strictEqual(run.status, 'ok');
  assert.strictEqual(run.group_id, 'quests');
  assert.strictEqual(run.git_commit, null);
  assert.ok(run.finished_at);
  assert.strictEqual(run.summary.rowCount > 0, true);
  const row = JSON.parse(fs.readFileSync(fileFor('quests'), 'utf8')).rows.find((r) => r.key === 'sx_a');
  const h = (await pool.query('SELECT hash FROM seed_row_hashes WHERE group_id=$1 AND sync_uuid=$2', ['quests', row.sync_uuid])).rows[0];
  assert.strictEqual(h.hash, rowHash(row));
  const left = await pool.query('SELECT 1 FROM seed_row_hashes WHERE group_id=$1 AND sync_uuid=$2', ['quests', gone[0].sync_uuid]);
  assert.strictEqual(left.rowCount, 0);
  const last = await lastRuns(pool);
  assert.strictEqual(last.quests.export.id, runId);
  // History-independent: a DB may hold real seed runs. Only check that the
  // export run is not reported as a seed and seeds stay seeds.
  for (const g of ['quests', 'tile_types']) {
    const seed = last[g].seed;
    assert.ok(seed === null || (seed.action === 'seed' && seed.id !== runId), `${g}: seed slot holds a seed run`);
  }
  const recent = await recentRuns(pool, { limit: 5, groupId: 'quests' });
  assert.strictEqual(recent.runs[0].id, runId);
});

dbTest('a failing export finishes its run as failed', async (t, pool, dir) => {
  // Fail the publish step (after startRun and the tmp write), uid-independent.
  // exportGroup calls fs.promises.rename at call time, so the mock takes effect.
  t.mock.method(fs.promises, 'rename', async () => {
    const e = new Error('sx injected rename failure');
    e.code = 'EIO';
    throw e;
  });
  try {
    await assert.rejects(exportGroup(pool, 'quests'), (e) => e.message === 'sx injected rename failure');
  } finally {
    t.mock.restoreAll();
  }
  assert.deepStrictEqual(fs.readdirSync(dir), [], 'tmp file removed, nothing published');
  const run = (await recentRuns(pool, { groupId: 'quests', limit: 1 })).runs[0];
  assert.strictEqual(run.action, 'export');
  assert.strictEqual(run.status, 'failed');
  assert.strictEqual(run.error, 'sx injected rename failure');
  assert.ok(run.finished_at);
  await pool.query('DELETE FROM seed_export_runs WHERE id=$1', [run.id]);
});
