require('./helpers/auth.js');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const request = require('supertest');
const { Pool } = require('pg');
const { signToken } = require('../src/auth/tokens.js');
const { withSeedSyncLock, cleanupSx, makeTempSyncDir } = require('./helpers/seedSyncTest.js');
const { exportGroup, fileFor } = require('../src/services/seedSync/exportGroup.js');
const seedExportRoutes = require('../src/api/seedExportRoutes.js');
const jobs = require('../src/services/seedSync/jobs.js');

// Registry (seed) order, global constraints.
const ALL_GROUPS = [
  'ai_providers', 'tile_types', 'items', 'attack_effects', 'aura_effects', 'creature_behaviors', 'entities',
  'biomes', 'skill_tree', 'progression', 'maps', 'quests', 'art', 'audio',
];

const DB_URL = process.env.TEST_DATABASE_URL;

async function makeUser(pool, role) {
  const username = `sx-routes-${role}-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const r = await pool.query(
    'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id, token_version',
    [username, 'x', role]);
  const u = { id: r.rows[0].id, username, role, tokenVersion: r.rows[0].token_version };
  u.auth = `Bearer ${signToken({ userId: u.id, username, role, tokenVersion: u.tokenVersion })}`;
  return u;
}

function dbTest(name, body) {
  test(name, async (t) => {
    if (!DB_URL) {
      const msg = 'TEST_DATABASE_URL not set -- skipping to avoid mutating a real database (seed_export routes)';
      if (process.env.CI) assert.fail(msg);
      t.skip(msg);
      return;
    }
    const dir = makeTempSyncDir();
    const trigger = path.join(os.tmpdir(), `sx-trigger-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    const prevDir = process.env.SEED_SYNC_DIR;
    const prevTrig = process.env.SEED_RESTART_TRIGGER;
    const prevRoot = process.env.SEED_ASSETS_ROOT;
    const prevMaps = process.env.SEED_MAPS_DIR;
    process.env.SEED_SYNC_DIR = dir;
    // The maps group reads (and export writes) spec files: never the real seeds/maps.
    process.env.SEED_MAPS_DIR = path.join(dir, 'maps');
    process.env.SEED_RESTART_TRIGGER = trigger;
    // Binary groups (art, audio) write repo asset files: never the real tree.
    process.env.SEED_ASSETS_ROOT = path.join(dir, 'assets');
    const pool = new Pool({ connectionString: DB_URL, max: 4, connectionTimeoutMillis: 3000 });
    const users = [];
    let watermark = null;
    t.after(async () => {
      if (prevDir === undefined) delete process.env.SEED_SYNC_DIR; else process.env.SEED_SYNC_DIR = prevDir;
      if (prevTrig === undefined) delete process.env.SEED_RESTART_TRIGGER; else process.env.SEED_RESTART_TRIGGER = prevTrig;
      if (prevRoot === undefined) delete process.env.SEED_ASSETS_ROOT; else process.env.SEED_ASSETS_ROOT = prevRoot;
      if (prevMaps === undefined) delete process.env.SEED_MAPS_DIR; else process.env.SEED_MAPS_DIR = prevMaps;
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(trigger, { force: true });
      await pool.end().catch(() => {});
    });
    await withSeedSyncLock(pool, async () => {
      await cleanupSx(pool);
      watermark = (await pool.query('SELECT coalesce(max(id), 0)::int AS m FROM seed_export_runs')).rows[0].m;
      try {
        const admin = await makeUser(pool, 'admin'); users.push(admin.id);
        const player = await makeUser(pool, 'player'); users.push(player.id);
        await body({ pool, dir, trigger, admin, player, watermark });
      } finally {
        await settleJob().catch(() => {});
        // seed runs only (see seedSyncTest.js note); export runs of this file are
        // removed too since they are above the watermark under the held lock.
        await pool.query('DELETE FROM seed_export_runs WHERE id > $1', [watermark]).catch(() => {});
        await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [users]).catch(() => {});
        await cleanupSx(pool).catch(() => {});
      }
    });
  });
}

// The object store is always a fake: binary-group jobs never reach MinIO.
function emptyStore() {
  return {
    BUCKET: () => 'sxb',
    async ensureBucket() {},
    async getObjectStream(key) { const e = new Error(`no such key ${key}`); e.code = 'NoSuchKey'; throw e; },
    async putObject() { throw new Error('fake store: no uploads expected'); },
    async objectExists() { return false; },
  };
}

function appFor(pool, startedAt = new Date(0)) {
  const app = express();
  app.use(express.json());
  app.use('/api/seed-export', seedExportRoutes(pool, { processStartedAt: startedAt, store: emptyStore() }));
  return app;
}

// Polls the in-process job until it is no longer running.
async function settleJob() {
  for (let i = 0; i < 2000; i++) {
    const j = jobs.currentJob();
    if (!j || j.status !== 'running') return j;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('job never settled');
}

async function pollJob(app, h) {
  for (let i = 0; i < 2000; i++) {
    const r = await request(app).get('/api/seed-export/jobs/current').set(h);
    assert.strictEqual(r.status, 200, r.text);
    if (r.body && r.body.status !== 'running') return r.body;
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error('job never settled');
}

// A job that runs until release() (holds the runner busy).
function holdBusy() {
  let release;
  const gate = new Promise((r) => { release = r; });
  const job = jobs.startJob({ groupId: 'art', action: 'export', run: async () => { await gate; return {}; } });
  return { job, release };
}

const ROUTES = [
  ['get', '/groups'], ['get', '/groups/quests/preview'], ['post', '/groups/quests/export'],
  ['post', '/groups/quests/seed'], ['get', '/runs'], ['get', '/restart'], ['post', '/restart'], ['get', '/meta'],
  ['post', '/groups/audio/export'], ['post', '/groups/art/seed'], ['get', '/jobs/current'], ['post', '/jobs/cancel'],
];

// Preview, then post the given decisions with the preview's signature (the
// UI's contract).
async function previewThenSeed(app, h, groupId, decisions) {
  const prev = await request(app).get(`/api/seed-export/groups/${groupId}/preview`).set(h);
  assert.strictEqual(prev.status, 200, prev.text);
  assert.match(prev.body.signature, /^[0-9a-f]{64}$/);
  return request(app).post(`/api/seed-export/groups/${groupId}/seed`).set(h)
    .send({ decisions, signature: prev.body.signature });
}

dbTest('routes require admin', async ({ pool, player, trigger }) => {
  const app = appFor(pool);
  for (const [m, p] of ROUTES) {
    const anon = await request(app)[m](`/api/seed-export${p}`).send({});
    assert.strictEqual(anon.status, 401, `${m} ${p} anon`);
    const res = await request(app)[m](`/api/seed-export${p}`).set('Authorization', player.auth).send({ decisions: {} });
    assert.strictEqual(res.status, 403, `${m} ${p} player`);
  }
  assert.ok(!fs.existsSync(trigger), 'denied POST /restart writes nothing');
});

dbTest('GET /groups lists every group in seed order with statuses', async ({ pool, admin, watermark }) => {
  const res = await request(appFor(pool)).get('/api/seed-export/groups').set('Authorization', admin.auth);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.map((g) => g.id), ALL_GROUPS);
  for (const g of res.body) {
    // No file in the temp dir: never_exported, or file_missing when this DB
    // holds an ok export run of the group (real history may exist).
    const { rows } = await pool.query(
      "SELECT EXISTS (SELECT 1 FROM seed_export_runs WHERE group_id = $1 AND action = 'export' AND status = 'ok') AS x",
      [g.id]);
    assert.strictEqual(g.status, rows[0].x ? 'file_missing' : 'never_exported', g.id);
    assert.strictEqual(g.inGit, null);
    assert.ok('lastExport' in g && 'lastSeed' in g); // runs of other PCs/tests may exist
    for (const k of ['label', 'counts', 'localEdits', 'gitChanges', 'tokensMissing']) assert.ok(k in g, k);
  }
  await exportGroup(pool, 'tile_types');
  const after = await request(appFor(pool)).get('/api/seed-export/groups').set('Authorization', admin.auth);
  const tt = after.body.find((g) => g.id === 'tile_types');
  assert.ok(tt.inGit && tt.inGit.group === 'tile_types');
  assert.ok(tt.lastExport.id > watermark);
  assert.ok(tt.lastExport && tt.lastExport.finished_at && tt.lastExport.pc_label);
  assert.ok(!['never_exported', 'file_missing'].includes(tt.status), tt.status);
  // The file goes away (e.g. not committed / pulled away): file_missing.
  fs.rmSync(fileFor('tile_types'));
  const gone = await request(appFor(pool)).get('/api/seed-export/groups').set('Authorization', admin.auth);
  assert.strictEqual(gone.body.find((g) => g.id === 'tile_types').status, 'file_missing');
});

dbTest('bad file yields status bad_file, not 500', async ({ pool, admin }) => {
  fs.writeFileSync(fileFor('quests'), '{ not json');
  const app = appFor(pool);
  const list = await request(app).get('/api/seed-export/groups').set('Authorization', admin.auth);
  assert.strictEqual(list.status, 200);
  const q = list.body.find((g) => g.id === 'quests');
  assert.strictEqual(q.status, 'bad_file');
  assert.ok(q.error);
  assert.ok(q.file);
  assert.deepStrictEqual(list.body.map((g) => g.id), ALL_GROUPS);
  const prev = await request(app).get('/api/seed-export/groups/quests/preview').set('Authorization', admin.auth);
  assert.strictEqual(prev.status, 422);
  assert.strictEqual(prev.body.code, 'bad_file');
  assert.ok(prev.body.file);
});

dbTest('unknown group is 404; bad bodies and limits', async ({ pool, admin }) => {
  const app = appFor(pool);
  const h = { Authorization: admin.auth };
  assert.strictEqual((await request(app).get('/api/seed-export/groups/nope/preview').set(h)).status, 404);
  assert.strictEqual((await request(app).post('/api/seed-export/groups/nope/export').set(h)).status, 404);
  assert.strictEqual((await request(app).post('/api/seed-export/groups/nope/seed').set(h).send({ decisions: {} })).status, 404);
  assert.strictEqual((await request(app).get('/api/seed-export/runs?group=nope').set(h)).status, 404);
  for (const bad of [undefined, null, [], 'x', { 'not-a-uuid': 'git' }, { '00000000-0000-0000-0000-000000000000': 5 }]) {
    const r = await request(app).post('/api/seed-export/groups/quests/seed').set(h).send({ decisions: bad, signature: 's' });
    assert.strictEqual(r.status, 400, JSON.stringify(bad));
    assert.ok(r.body.error);
  }
  // The preview's signature is required.
  for (const sig of [undefined, null, 5, '', {}]) {
    const r = await request(app).post('/api/seed-export/groups/quests/seed').set(h).send({ decisions: {}, signature: sig });
    assert.strictEqual(r.status, 400, JSON.stringify(sig));
    assert.match(r.body.error, /signature/);
  }
  await exportGroup(pool, 'tile_types');
  await exportGroup(pool, 'tile_types');
  const one = await request(app).get('/api/seed-export/runs?group=tile_types&limit=1').set(h);
  assert.strictEqual(one.body.runs.length, 1);
  const zero = await request(app).get('/api/seed-export/runs?limit=0').set(h);
  assert.strictEqual(zero.body.runs.length, 1, 'limit clamps up to 1');
  const all = await request(app).get('/api/seed-export/runs?group=tile_types').set(h);
  assert.ok(all.body.runs.every((r) => r.group_id === 'tile_types'));
});

dbTest('GET /runs pages newest first with a total', async ({ pool, admin }) => {
  const app = appFor(pool);
  const h = { Authorization: admin.auth };
  const get = (q) => request(app).get(`/api/seed-export/runs${q}`).set(h);
  const ids = [];
  for (let i = 0; i < 3; i += 1) ids.push((await exportGroup(pool, 'tile_types')).runId);
  const count = async (group) => (await pool.query(
    'SELECT count(*)::int AS n FROM seed_export_runs WHERE ($1::text IS NULL OR group_id = $1)', [group])).rows[0].n;
  const total = await count('tile_types');
  assert.ok(total >= 3);

  const first = await get('?group=tile_types&limit=2');
  assert.strictEqual(first.status, 200);
  assert.deepStrictEqual(first.body.runs.map((r) => r.id), [ids[2], ids[1]], 'newest first');
  assert.strictEqual(first.body.total, total);
  const second = await get('?group=tile_types&limit=2&offset=1');
  assert.deepStrictEqual(second.body.runs.map((r) => r.id), [ids[1], ids[0]]);
  assert.strictEqual(second.body.total, total);

  // Default limit 15, clamp to 200; total counts every group without a filter.
  const dflt = await get('');
  assert.strictEqual(dflt.body.total, await count(null));
  assert.strictEqual(dflt.body.runs.length, Math.min(15, dflt.body.total));
  const big = await get('?limit=100000');
  assert.strictEqual(big.body.runs.length, Math.min(200, big.body.total));

  // Paging boundaries.
  const last = await get(`?group=tile_types&limit=1&offset=${total - 1}`);
  assert.strictEqual(last.body.runs.length, 1);
  for (const off of [total, total + 50]) {
    const past = await get(`?group=tile_types&offset=${off}`);
    assert.strictEqual(past.status, 200);
    assert.deepStrictEqual(past.body, { runs: [], total });
  }
  for (const bad of ['-1', 'x', '1.5', '']) {
    const r = await get(`?group=tile_types&offset=${encodeURIComponent(bad)}`);
    assert.strictEqual(r.status, 400, `offset ${JSON.stringify(bad)}`);
    assert.match(r.body.error, /offset/);
  }
});

dbTest('POST seed with undecided rows -> 409 undecided', async ({ pool, admin }) => {
  await pool.query("INSERT INTO quests (key, title, act, description) VALUES ('sx_a', 'sx t', 1, 'sx d')");
  await exportGroup(pool, 'quests');
  // Git file now differs for sx_a while no baseline-ack exists locally: drop the
  // baseline and change git's copy so the row is red edited_here.
  const file = fileFor('quests');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const row = doc.tables.quests.find((r) => r.key === 'sx_a');
  row.title = 'sx git';
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
  await pool.query('DELETE FROM seed_row_hashes WHERE sync_uuid = $1', [row.sync_uuid]);
  const app = appFor(pool);
  const res = await previewThenSeed(app, { Authorization: admin.auth }, 'quests', {});
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.body.code, 'undecided');
  assert.ok(res.body.error);
  assert.ok(JSON.stringify(res.body.details).includes(row.sync_uuid));
  const q = await pool.query("SELECT title FROM quests WHERE key = 'sx_a'");
  assert.strictEqual(q.rows[0].title, 'sx t');
});

dbTest('no route response contains the provider auth_token', async ({ pool, admin }) => {
  await pool.query(
    "INSERT INTO ai_providers (name, base_url, request_template, auth_token) VALUES ('sx_p', 'http://x', '{}', 'sx-secret')");
  const app = appFor(pool);
  const h = { Authorization: admin.auth };
  const bodies = [];
  const grab = async (r) => { const x = await r; bodies.push(x.text); return x; };
  await grab(request(app).get('/api/seed-export/groups').set(h));
  await grab(request(app).get('/api/seed-export/groups/ai_providers/preview').set(h)); // 409 no_export
  const exp = await grab(request(app).post('/api/seed-export/groups/ai_providers/export').set(h));
  assert.strictEqual(exp.status, 200);
  await pool.query("UPDATE ai_providers SET base_url = 'http://y' WHERE name = 'sx_p'");
  await grab(request(app).get('/api/seed-export/groups/ai_providers/preview').set(h));
  await grab(request(app).get('/api/seed-export/groups').set(h));
  await grab(request(app).get('/api/seed-export/runs').set(h));
  await grab(request(app).get('/api/seed-export/restart').set(h));
  const bin = await grab(request(app).post('/api/seed-export/groups/audio/export').set(h));
  assert.strictEqual(bin.status, 202, bin.text);
  await settleJob();
  await grab(request(app).get('/api/seed-export/jobs/current').set(h));
  await grab(request(app).post('/api/seed-export/jobs/cancel').set(h));
  const held = holdBusy();
  try {
    await grab(request(app).post('/api/seed-export/groups/ai_providers/export').set(h)); // 409 busy
  } finally { held.release(); }
  assert.ok(bodies.length >= 11);
  for (const b of bodies) assert.ok(!b.includes('sx-secret'), b.slice(0, 200));
  assert.ok(!fs.readFileSync(fileFor('ai_providers'), 'utf8').includes('sx-secret'));
});

dbTest('restart required after seed; POST /restart writes the trigger', async ({ pool, admin, trigger }) => {
  const started = new Date(Date.now() - 1000);
  const app = appFor(pool, started);
  const h = { Authorization: admin.auth };
  assert.deepStrictEqual((await request(app).get('/api/seed-export/restart').set(h)).body, { required: false });
  await exportGroup(pool, 'tile_types');
  assert.deepStrictEqual((await request(app).get('/api/seed-export/restart').set(h)).body, { required: false },
    'an export does not require a restart');
  const seed = await previewThenSeed(app, h, 'tile_types', {});
  assert.strictEqual(seed.status, 200, seed.text);
  assert.ok(seed.body.runId);
  assert.deepStrictEqual((await request(app).get('/api/seed-export/restart').set(h)).body, { required: true });
  // A process that started after the seed is current.
  const later = appFor(pool, new Date(Date.now() + 60000));
  assert.deepStrictEqual((await request(later).get('/api/seed-export/restart').set(h)).body, { required: false });
  assert.ok(!fs.existsSync(trigger));
  const r = await request(app).post('/api/seed-export/restart').set(h);
  assert.deepStrictEqual(r.body, { ok: true });
  assert.ok(!Number.isNaN(Date.parse(JSON.parse(fs.readFileSync(trigger, 'utf8')).at)));
});

dbTest('POST seed with a stale signature -> 409 stale_preview, nothing written', async ({ pool, admin }) => {
  await pool.query("INSERT INTO quests (key, title, act, description) VALUES ('sx_a', 'sx t', 1, 'sx d')");
  await exportGroup(pool, 'quests');
  const file = fileFor('quests');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const row = doc.tables.quests.find((r) => r.key === 'sx_a');
  row.title = 'sx git';
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
  const app = appFor(pool);
  const h = { Authorization: admin.auth };
  const prev = await request(app).get('/api/seed-export/groups/quests/preview').set(h);
  const r = prev.body.rows.find((x) => x.key === 'sx_a');
  assert.deepStrictEqual([r.kind, r.defaultDecision], ['changed', 'git']);
  await pool.query("UPDATE quests SET title = 'sx local edit' WHERE key = 'sx_a'");
  const res = await request(app).post('/api/seed-export/groups/quests/seed').set(h)
    .send({ decisions: { [row.sync_uuid]: 'git' }, signature: prev.body.signature });
  assert.strictEqual(res.status, 409, res.text);
  assert.strictEqual(res.body.code, 'stale_preview');
  const q = await pool.query("SELECT title FROM quests WHERE key = 'sx_a'");
  assert.strictEqual(q.rows[0].title, 'sx local edit');
});

dbTest('GET /meta reports the PC label and whether it is set (never the hostname)', async ({ pool, admin }) => {
  const app = appFor(pool);
  const h = { Authorization: admin.auth };
  const prev = process.env.SEED_PC_LABEL;
  try {
    delete process.env.SEED_PC_LABEL;
    assert.deepStrictEqual((await request(app).get('/api/seed-export/meta').set(h)).body,
      { pcLabel: 'unnamed-pc', pcLabelSet: false });
    process.env.SEED_PC_LABEL = '';
    assert.deepStrictEqual((await request(app).get('/api/seed-export/meta').set(h)).body,
      { pcLabel: 'unnamed-pc', pcLabelSet: false });
    process.env.SEED_PC_LABEL = 'sx-desk';
    assert.deepStrictEqual((await request(app).get('/api/seed-export/meta').set(h)).body,
      { pcLabel: 'sx-desk', pcLabelSet: true });
    delete process.env.SEED_PC_LABEL;
    await exportGroup(pool, 'quests');
    assert.strictEqual(JSON.parse(fs.readFileSync(fileFor('quests'), 'utf8')).header.exported_by, 'unnamed-pc');
  } finally {
    if (prev === undefined) delete process.env.SEED_PC_LABEL; else process.env.SEED_PC_LABEL = prev;
  }
});

dbTest('binary export answers 202 and runs as a job; GET /groups flags binary groups', async ({ pool, admin }) => {
  const app = appFor(pool);
  const h = { Authorization: admin.auth };
  const list = await request(app).get('/api/seed-export/groups').set(h);
  assert.deepStrictEqual(list.body.filter((g) => g.binary === true).map((g) => g.id), ['art', 'audio']);
  assert.ok(list.body.every((g) => typeof g.binary === 'boolean'));
  const res = await request(app).post('/api/seed-export/groups/audio/export').set(h);
  assert.strictEqual(res.status, 202, res.text);
  assert.deepStrictEqual([res.body.job.groupId, res.body.job.action], ['audio', 'export']);
  assert.ok(Number.isInteger(res.body.job.id));
  const done = await pollJob(app, h);
  assert.strictEqual(done.id, res.body.job.id);
  assert.strictEqual(done.status, 'ok', JSON.stringify(done));
  assert.ok(done.result.runId);
  const run = await pool.query('SELECT status, group_id FROM seed_export_runs WHERE id = $1', [done.result.runId]);
  assert.deepStrictEqual(run.rows[0], { status: 'ok', group_id: 'audio' });
  assert.ok(fs.existsSync(fileFor('audio')));
  // A data group stays synchronous.
  const data = await request(app).post('/api/seed-export/groups/tile_types/export').set(h);
  assert.strictEqual(data.status, 200, data.text);
  assert.ok(data.body.runId);
});

// SOMET-641: Maps (registry `job`) runs as a job too; nothing to export in an
// empty maps dir, so the job ends failed with the engine's refusal code.
dbTest('maps export answers 202 and runs as a job; GET /groups flags it job', async ({ pool, admin }) => {
  const app = appFor(pool);
  const h = { Authorization: admin.auth };
  const list = await request(app).get('/api/seed-export/groups').set(h);
  const maps = list.body.find((g) => g.id === 'maps');
  assert.deepStrictEqual([maps.binary, maps.job], [false, true]);
  assert.deepStrictEqual(list.body.filter((g) => g.job).map((g) => g.id), ['maps', 'art', 'audio']);
  const res = await request(app).post('/api/seed-export/groups/maps/export').set(h);
  assert.strictEqual(res.status, 202, res.text);
  assert.deepStrictEqual([res.body.job.groupId, res.body.job.action], ['maps', 'export']);
  const done = await pollJob(app, h);
  assert.strictEqual(done.status, 'failed', JSON.stringify(done));
  assert.strictEqual(done.errorCode, 'no_specs');
});

dbTest('any export or seed while a job runs -> 409 busy with the job', async ({ pool, admin }) => {
  const app = appFor(pool);
  const h = { Authorization: admin.auth };
  await exportGroup(pool, 'tile_types');
  const prev = await request(app).get('/api/seed-export/groups/tile_types/preview').set(h);
  const held = holdBusy();
  try {
    const attempts = [
      request(app).post('/api/seed-export/groups/tile_types/seed').set(h).send({ decisions: {}, signature: prev.body.signature }),
      request(app).post('/api/seed-export/groups/tile_types/export').set(h),
      request(app).post('/api/seed-export/groups/audio/export').set(h),
      request(app).post('/api/seed-export/groups/art/seed').set(h).send({ decisions: {}, signature: 'x' }),
    ];
    for (const a of attempts) {
      const r = await a;
      assert.strictEqual(r.status, 409, r.text);
      assert.strictEqual(r.body.error, 'busy');
      assert.strictEqual(r.body.job.id, held.job.id);
      assert.strictEqual(r.body.job.status, 'running');
    }
    const cur = await request(app).get('/api/seed-export/jobs/current').set(h);
    assert.strictEqual(cur.body.id, held.job.id);
  } finally {
    held.release();
  }
  assert.strictEqual((await settleJob()).status, 'ok');
  // Free again: the data-group seed goes through synchronously.
  const ok = await previewThenSeed(app, h, 'tile_types', {});
  assert.strictEqual(ok.status, 200, ok.text);
});

dbTest('jobs/cancel: idle -> cancelled:false; running -> cancelled:true and the job ends cancelled', async ({ pool, admin }) => {
  const app = appFor(pool);
  const h = { Authorization: admin.auth };
  const idle = await request(app).post('/api/seed-export/jobs/cancel').set(h);
  assert.strictEqual(idle.status, 200);
  assert.strictEqual(idle.body.cancelled, false);
  assert.ok('job' in idle.body);
  // A job that honours its signal the way the engine's asset phases do.
  const { SyncRefused } = require('../src/services/seedSync/errors.js');
  jobs.startJob({
    groupId: 'art', action: 'export',
    run: ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new SyncRefused('cancelled', 'cancelled')));
    }),
  });
  const r = await request(app).post('/api/seed-export/jobs/cancel').set(h);
  assert.strictEqual(r.body.cancelled, true);
  assert.strictEqual((await pollJob(app, h)).status, 'cancelled');
});

dbTest('binary seed: bad bodies 400 synchronously; engine refusals end the job failed with errorCode', async ({ pool, admin }) => {
  const app = appFor(pool);
  const h = { Authorization: admin.auth };
  const before = jobs.currentJob();
  for (const body of [{ decisions: 'x', signature: 's' }, { decisions: {}, signature: '' }]) {
    const r = await request(app).post('/api/seed-export/groups/audio/seed').set(h).send(body);
    assert.strictEqual(r.status, 400, r.text);
  }
  assert.strictEqual(jobs.currentJob() && jobs.currentJob().id, before && before.id, 'no job started');
  await exportGroup(pool, 'audio', { store: emptyStore() });
  const res = await request(app).post('/api/seed-export/groups/audio/seed').set(h).send({ decisions: {}, signature: 'stale' });
  assert.strictEqual(res.status, 202, res.text);
  assert.strictEqual(res.body.job.action, 'seed');
  const done = await pollJob(app, h);
  assert.deepStrictEqual([done.status, done.errorCode], ['failed', 'stale_preview'], JSON.stringify(done));
  assert.ok(done.error);
  // With the preview's signature it applies.
  const prev = await request(app).get('/api/seed-export/groups/audio/preview').set(h);
  const ok = await request(app).post('/api/seed-export/groups/audio/seed').set(h).send({ decisions: {}, signature: prev.body.signature });
  assert.strictEqual(ok.status, 202, ok.text);
  const applied = await pollJob(app, h);
  assert.strictEqual(applied.status, 'ok', JSON.stringify(applied));
  assert.ok(applied.result.runId);
});

test("sendError: the engine's lock-timeout busy keeps its message and code; the job runner's busy carries the job", () => {
  const { SyncRefused } = require('../src/services/seedSync/errors.js');
  const res = () => ({ code: null, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
  const lock = seedExportRoutes.sendError(res(), new SyncRefused('busy', 'another seed/export ... try again', { pgCode: '55P03' }));
  assert.deepStrictEqual([lock.code, lock.body.code, lock.body.error], [409, 'busy', 'another seed/export ... try again']);
  const job = { id: 7, status: 'running' };
  const r = seedExportRoutes.sendError(res(), new SyncRefused('busy', 'another export or seed is running', { job }));
  assert.deepStrictEqual([r.code, r.body], [409, { error: 'busy', job }]);
});
