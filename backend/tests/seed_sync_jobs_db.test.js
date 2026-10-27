const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { Pool } = require('pg');
const { withSeedSyncLock, cleanupSx, makeTempSyncDir } = require('./helpers/seedSyncTest.js');
const { _withTestGroups } = require('../src/services/seedSync/registry.js');
const { exportGroup } = require('../src/services/seedSync/exportGroup.js');
const { previewSeed, applySeed } = require('../src/services/seedSync/applySeed.js');
const { markInterruptedRuns } = require('../src/services/seedSync/runs.js');
const { SyncRefused } = require('../src/services/seedSync/errors.js');
const jobs = require('../src/services/seedSync/jobs.js');
const { encodeRGBA } = require('../src/services/pngTrim.js');

// SOMET-640 plan 3 Task 5: the single-flight background job runner the binary
// groups (art, audio) run under. Throwaway tables live in their own schema
// (seed_sync_assets_db.test.js pattern).
const DB_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'sx_jobs';
const GROUP = 'sx_jobs_art';
const artSpec = {
  table: 'sx_jart', naturalKey: ['name'], omit: { id: 'local', sync_uuid: 'identity' }, secretColumns: [], refs: {},
  assets: { image: { type: 'image', dir: 'sx_jtiles' } },
};
const GROUPS = [{ id: GROUP, label: 'SX jobs art', binary: true, tables: [artSpec] }];
const SCHEMA_SQL = `
  DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE;
  CREATE SCHEMA ${SCHEMA};
  CREATE TABLE ${SCHEMA}.sx_jart (
    id serial PRIMARY KEY, name text NOT NULL UNIQUE, image text,
    sync_uuid uuid NOT NULL UNIQUE DEFAULT gen_random_uuid());`;
const N = 4;

function png(rgb) {
  const px = Buffer.alloc(2 * 2 * 4);
  for (let i = 0; i < 4; i++) px.set([...rgb, 255], i * 4);
  return encodeRGBA(2, 2, px);
}

// Each getObjectStream waits `delayMs`: long enough to cancel between files.
function slowStore(delayMs) {
  const objects = new Map();
  for (let i = 0; i < N; i++) objects.set(`sxj/${i}.png`, png([i * 40, 0, 0]));
  const store = {
    gets: 0,
    BUCKET: () => 'sxjb',
    async ensureBucket() {},
    async getObjectStream(key) {
      store.gets += 1;
      await new Promise((r) => setTimeout(r, delayMs));
      if (!objects.has(key)) { const e = new Error('nope'); e.code = 'NoSuchKey'; throw e; }
      return Readable.from([objects.get(key)]);
    },
    async putObject() { throw new Error('no uploads in this test'); },
    async objectExists(key) { return objects.has(key); },
  };
  return store;
}

function filesUnder(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true }).map(String)
    .filter((f) => fs.statSync(path.join(dir, f)).isFile());
}

async function settle() {
  for (let i = 0; i < 1000; i++) {
    const j = jobs.currentJob();
    if (!j || j.status !== 'running') return j;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('job never settled');
}

function dbTest(name, body) {
  test(name, async (t) => {
    if (!DB_URL) {
      const msg = 'TEST_DATABASE_URL not set -- skipping to avoid mutating a real database (seed_sync jobs)';
      if (process.env.CI) assert.fail(msg);
      t.skip(msg);
      return;
    }
    const dir = makeTempSyncDir();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-jobs-assets-'));
    const prev = { dir: process.env.SEED_SYNC_DIR, root: process.env.SEED_ASSETS_ROOT };
    process.env.SEED_SYNC_DIR = dir;
    process.env.SEED_ASSETS_ROOT = root;
    const pool = new Pool({
      connectionString: DB_URL, max: 4, connectionTimeoutMillis: 3000, options: `-c search_path=${SCHEMA},public`,
    });
    const pub = new Pool({ connectionString: DB_URL, max: 4, connectionTimeoutMillis: 3000 });
    t.after(async () => {
      for (const [k, v] of [['SEED_SYNC_DIR', prev.dir], ['SEED_ASSETS_ROOT', prev.root]]) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
      await pool.end().catch(() => {});
      await pub.end().catch(() => {});
    });
    await withSeedSyncLock(pub, async () => {
      await cleanupSx(pub);
      await pub.query("DELETE FROM seed_asset_hashes WHERE object_key LIKE 'sxj/%'");
      await pub.query(SCHEMA_SQL);
      const watermark = (await pub.query('SELECT coalesce(max(id), 0)::int AS m FROM seed_export_runs')).rows[0].m;
      try {
        await _withTestGroups(GROUPS, () => body({ pool, pub, root, watermark }));
      } finally {
        await settle().catch(() => {});
        await pub.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
        await pub.query("DELETE FROM seed_asset_hashes WHERE object_key LIKE 'sxj/%'").catch(() => {});
        await cleanupSx(pub).catch(() => {});
      }
    });
  });
}

test('single flight: a second startJob throws busy; the last job stays visible', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const first = jobs.startJob({
    groupId: 'art', action: 'export',
    run: async (ctx) => { ctx.onProgress({ phase: 'download', done: 1, total: 3 }); await gate; return { rowCount: 3 }; },
  });
  assert.strictEqual(first.status, 'running');
  assert.ok(Number.isInteger(first.id));
  assert.strictEqual(jobs.isBusy(), true);
  assert.throws(
    () => jobs.startJob({ groupId: 'audio', action: 'export', run: async () => ({}) }),
    (e) => e instanceof SyncRefused && e.code === 'busy' && e.details.job.id === first.id,
  );
  for (let i = 0; i < 100 && jobs.currentJob().phase === null; i++) await new Promise((r) => setImmediate(r));
  const cur = jobs.currentJob();
  assert.deepStrictEqual([cur.phase, cur.done, cur.total, cur.groupId, cur.action], ['download', 1, 3, 'art', 'export']);
  // JSON-safe: no AbortController or promise leaks out.
  assert.deepStrictEqual(JSON.parse(JSON.stringify(cur)), cur);
  release();
  const done = await settle();
  assert.strictEqual(done.status, 'ok');
  assert.deepStrictEqual(done.result, { rowCount: 3 });
  assert.ok(done.finishedAt);
  assert.strictEqual(jobs.isBusy(), false);
  assert.strictEqual(jobs.cancelJob(), false, 'nothing to cancel');
  assert.strictEqual(jobs.currentJob().id, first.id, 'the last job stays visible');
  // A failing run ends failed with the SyncRefused code; no unhandled rejection.
  const second = jobs.startJob({
    groupId: 'audio', action: 'seed', run: async () => { throw new SyncRefused('stale_preview', 'preview is stale'); },
  });
  assert.ok(second.id > first.id, 'ids increase');
  const failed = await settle();
  assert.deepStrictEqual([failed.status, failed.error, failed.errorCode], ['failed', 'preview is stale', 'stale_preview']);
  // An unexpected error keeps internals out of the job.
  jobs.startJob({ groupId: 'audio', action: 'seed', run: async () => { throw new Error('ECONNREFUSED 10.0.0.1 secret'); } });
  const boom = await settle();
  assert.strictEqual(boom.status, 'failed');
  assert.ok(!boom.error.includes('secret'), boom.error);
});

dbTest('cancel mid-export: cancelled, no run row, no tmp files; the next export is ok', async ({ pool, pub, root, watermark }) => {
  for (let i = 0; i < N; i++) await pool.query('INSERT INTO sx_jart (name, image) VALUES ($1, $2)', [`sx_j${i}`, `sxj/${i}.png`]);
  const store = slowStore(60);
  jobs.startJob({ groupId: GROUP, action: 'export', run: (ctx) => exportGroup(pool, GROUP, { store, ...ctx }) });
  for (let i = 0; i < 400 && jobs.currentJob().done < 1; i++) await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(jobs.currentJob().done, 1, 'first file downloaded');
  assert.strictEqual(jobs.cancelJob(), true);
  const j = await settle();
  assert.strictEqual(j.status, 'cancelled', JSON.stringify(j));
  assert.ok(j.done < N, 'stopped before the last file');
  assert.ok(store.gets < N);
  // Cancel is only honoured before the locked transaction, and the engine
  // starts its run row inside it: a cancelled export leaves no run row.
  const { rows } = await pub.query('SELECT status FROM seed_export_runs WHERE group_id = $1 AND id > $2', [GROUP, watermark]);
  assert.deepStrictEqual(rows, []);
  assert.deepStrictEqual(filesUnder(root).filter((f) => f.endsWith('.tmp')), []);

  const fast = slowStore(0);
  jobs.startJob({ groupId: GROUP, action: 'export', run: (ctx) => exportGroup(pool, GROUP, { store: fast, ...ctx }) });
  const ok = await settle();
  assert.strictEqual(ok.status, 'ok', JSON.stringify(ok));
  assert.strictEqual(ok.result.rowCount, N);
  // Files the cancelled run already wrote are reused, the rest downloaded.
  assert.strictEqual(ok.phase, 'download');
  assert.ok(ok.total >= 1 && ok.total < N, String(ok.total));
  assert.strictEqual(ok.done, ok.total);
  assert.strictEqual(ok.result.downloaded + ok.result.reused, N);
  const run = await pub.query('SELECT status FROM seed_export_runs WHERE id = $1', [ok.result.runId]);
  assert.strictEqual(run.rows[0].status, 'ok');
  assert.deepStrictEqual(filesUnder(root).filter((f) => f.endsWith('.tmp')), []);
  await pub.query('DELETE FROM seed_export_runs WHERE group_id = $1', [GROUP]);
});

dbTest('markInterruptedRuns marks only running rows', async ({ pub }) => {
  const ins = async (status) => (await pub.query(
    `INSERT INTO seed_export_runs (group_id, action, status, pc_label) VALUES ($1, 'export', $2, 'sx') RETURNING id`,
    [GROUP, status])).rows[0].id;
  const running = await ins('running');
  const ok = await ins('ok');
  const failed = await ins('failed');
  const n = await markInterruptedRuns(pub);
  assert.ok(n >= 1, String(n));
  const { rows } = await pub.query(
    'SELECT id, status, error, finished_at FROM seed_export_runs WHERE id = ANY($1::int[]) ORDER BY id', [[running, ok, failed]]);
  assert.deepStrictEqual(rows.map((r) => r.status), ['failed', 'ok', 'failed']);
  assert.strictEqual(rows[0].error, 'interrupted: backend restarted');
  assert.ok(rows[0].finished_at);
  assert.strictEqual(rows[1].error, null);
  assert.strictEqual(rows[2].error, null, 'an already-failed row is untouched');
  assert.strictEqual((await pub.query("SELECT count(*)::int AS n FROM seed_export_runs WHERE status = 'running'")).rows[0].n, 0);
  assert.strictEqual(await markInterruptedRuns(pub), 0, 'idempotent');
});

// M-3: a failed seed job names its rows. Refusals that carry sync_uuids
// (undecided, asset_*, conflict, ...) also carry rows: [{ table, key }]
// (display keys, at most 50) -- what the tab's jobErrorRowsText lists.
dbTest('a refused seed job lists its rows by display key, capped at 50', async ({ pool, root }) => {
  for (let i = 0; i < 60; i++) {
    await pool.query('INSERT INTO sx_jart (name, image) VALUES ($1, NULL)', [`sx_j${String(i).padStart(2, '0')}`]);
  }
  await exportGroup(pool, GROUP, { store: slowStore(0) });
  // Edited here without baselines: every row is red (needs a decision).
  await pool.query("UPDATE sx_jart SET image = ''");
  await pool.query('DELETE FROM seed_row_hashes WHERE group_id = $1', [GROUP]);
  const p = await previewSeed(pool, GROUP);
  assert.strictEqual(p.rows.length, 60);
  jobs.startJob({ groupId: GROUP, action: 'seed', run: (ctx) => applySeed(pool, GROUP, {}, { signature: p.signature, store: slowStore(0), ...ctx }) });
  const j = await settle();
  assert.deepStrictEqual([j.status, j.errorCode], ['failed', 'undecided']);
  assert.strictEqual(j.errorDetails.uuids.length, 60);
  assert.strictEqual(j.errorDetails.rows.length, 50, 'capped');
  assert.deepStrictEqual(j.errorDetails.rows[0], { table: 'sx_jart', key: 'sx_j00' });
  assert.ok(j.errorDetails.rows.every((r) => r.table === 'sx_jart' && /^sx_j\d\d$/.test(r.key)));

  // An asset refusal: one row taking git whose file is missing.
  await pool.query('UPDATE sx_jart SET image = NULL');
  await exportGroup(pool, GROUP, { store: slowStore(0) }); // in sync again: baselines back
  await pool.query("UPDATE sx_jart SET image = 'sxj/0.png' WHERE name = 'sx_j00'");
  await exportGroup(pool, GROUP, { store: slowStore(0) });
  await pool.query("UPDATE sx_jart SET image = NULL WHERE name = 'sx_j00'");
  await pool.query("DELETE FROM seed_row_hashes WHERE group_id = $1", [GROUP]);
  fs.rmSync(path.join(root, 'sx_jtiles'), { recursive: true, force: true });
  const p2 = await previewSeed(pool, GROUP);
  const r0 = p2.rows.find((r) => r.key === 'sx_j00');
  jobs.startJob({
    groupId: GROUP, action: 'seed',
    run: (ctx) => applySeed(pool, GROUP, { [r0.syncUuid]: 'git' }, { signature: p2.signature, store: slowStore(0), ...ctx }),
  });
  const j2 = await settle();
  assert.deepStrictEqual([j2.status, j2.errorCode], ['failed', 'asset_file_missing']);
  assert.deepStrictEqual(j2.errorDetails.rows, [{ table: 'sx_jart', key: 'sx_j00' }]);
});
