// SOMET-641 (Plan 4a, Task 5). After a Maps export, the hand edits of each
// exported spec are pushed to the GPU box (worldGenService) -- best effort.
// The box is NEVER called for real: every test injects fetch through `deps`.
//
// Fixture specs sx-m4-* with sx_m4_-prefixed worlds, in a temp maps dir and a
// temp sync dir. Every test holds the seed-sync test lock AND the entry lock
// (withEntryPreserved puts the entry world back), and deletes only its own
// worlds (links, waypoints, villages, chests and creatures cascade), its own
// map_spec_state rows and its own maps runs.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Pool } = require('pg');
const { canonicalSpecJson } = require('../src/services/mapSpecExport.js');
const { deterministicUuid } = require('../src/services/seedSync/canonical.js');
const { diffGroup } = require('../src/services/seedSync/diffGroup.js');
const { previewSeed, applySeed } = require('../src/services/seedSync/applySeed.js');
const { exportGroup } = require('../src/services/seedSync/exportGroup.js');
const { SyncRefused, SyncFileError } = require('../src/services/seedSync/errors.js');
const { withEntryPreserved } = require('./helpers/entryWorld.js');
const { setEntryWorldByName } = require('../src/services/entryWorld.js');
const { withSeedSyncLock, makeTempSyncDir } = require('./helpers/seedSyncTest.js');

const DB_URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://user:password@localhost:15432/game_db';

const P = 'sx_m4_';
const mapsGroup = require('../src/services/seedSync/mapsGroup.js');
const SEED_MAP = path.join(__dirname, '..', 'scripts', 'seed-map.js');

const sha = (spec) => crypto.createHash('sha256').update(canonicalSpecJson(spec)).digest('hex');
const uuidOf = (name) => deterministicUuid('map_specs', name);

// Deep Forest is all-walkable terrain, so navigability never depends on a seed.
function world(key, grid, seed, extra = {}) {
  return {
    key, name: `${P}${key}`, ...(grid ? { grid } : {}), seed,
    width: 64, height: 64, chunk_size: 64, biomes: ['Deep Forest'], biome_cell: 32,
    allowed_creature_types: [], ...extra,
  };
}
const specA = () => ({
  name: 'sx-m4-a',
  worlds: [
    world('a', [0, 0], 741001, { is_entry: true, entry_spawn: { x: 3200, y: 3200 } }),
    world('b', [1, 0], 741002),
  ],
  links: [{ from: 'a', edge: 'E', to: 'b' }],
});
const specB = () => ({
  name: 'sx-m4-b',
  worlds: [world('c', [0, 0], 741003, { is_entry: true, entry_spawn: { x: 3200, y: 3200 } })],
  links: [],
});

async function cleanup(pool, watermark) {
  await pool.query("DELETE FROM characters WHERE name LIKE 'sx\\_m4\\_%'");
  await pool.query("DELETE FROM users WHERE username LIKE 'sx\\_m4\\_%'");
  await pool.query("DELETE FROM worlds WHERE name LIKE 'sx\\_m4\\_%'");
  await pool.query("DELETE FROM map_spec_state WHERE spec_name LIKE 'sx-m4-%'");
  if (watermark != null) await pool.query("DELETE FROM seed_export_runs WHERE group_id = 'maps' AND id > $1", [watermark]);
}

function dbTest(name, body) {
  test(name, async (t) => {
    if (!process.env.TEST_DATABASE_URL) {
      const msg = 'TEST_DATABASE_URL not set -- skipping to avoid mutating a real database (seed_sync maps)';
      if (process.env.CI) assert.fail(msg);
      t.skip(msg);
      return;
    }
    const syncDir = makeTempSyncDir();
    const mapsDir = path.join(syncDir, 'maps');
    fs.mkdirSync(mapsDir);
    const prev = { sync: process.env.SEED_SYNC_DIR, maps: process.env.SEED_MAPS_DIR };
    process.env.SEED_SYNC_DIR = syncDir;
    process.env.SEED_MAPS_DIR = mapsDir;
    const pool = new Pool({ connectionString: DB_URL, max: 4, connectionTimeoutMillis: 3000 });
    t.after(async () => {
      for (const [k, v] of [['SEED_SYNC_DIR', prev.sync], ['SEED_MAPS_DIR', prev.maps]]) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      fs.rmSync(syncDir, { recursive: true, force: true });
      await pool.end().catch(() => {});
    });
    await withSeedSyncLock(pool, () => withEntryPreserved(pool, async () => {
      const watermark = (await pool.query('SELECT coalesce(max(id), 0)::int AS m FROM seed_export_runs')).rows[0].m;
      await cleanup(pool);
      try {
        await body({ pool, syncDir, mapsDir });
      } finally {
        await cleanup(pool, watermark);
      }
    }));
  });
}

// ---- fixture files ---------------------------------------------------------

function writeSpec(mapsDir, spec, text = canonicalSpecJson(spec)) {
  fs.writeFileSync(path.join(mapsDir, `${spec.name}.map.json`), text);
}
const readSpec = (mapsDir, name) => JSON.parse(fs.readFileSync(path.join(mapsDir, `${name}.map.json`), 'utf8'));
const readSpecText = (mapsDir, name) => fs.readFileSync(path.join(mapsDir, `${name}.map.json`), 'utf8');

function writeManifest(syncDir, specs, entryWorld, extra = {}) {
  const doc = {
    header: {
      group: 'maps', exported_at: '2026-10-19T00:00:00.000Z', exported_by: 'sx-test', schema_version: '',
      spec_count: specs.length,
    },
    specs: specs.map((s) => ({ name: s.name, sha256: sha(s) })),
    entry_world: entryWorld,
    ...extra,
  };
  fs.writeFileSync(path.join(syncDir, 'maps.json'), `${JSON.stringify(doc, null, 2)}\n`);
}
const readManifest = (syncDir) => JSON.parse(fs.readFileSync(path.join(syncDir, 'maps.json'), 'utf8'));

function setup(ctx, specs, entryWorld) {
  for (const s of specs) writeSpec(ctx.mapsDir, s);
  writeManifest(ctx.syncDir, specs, entryWorld);
}

// Preview, then apply every row on its default (plus `overrides`).
async function seed(pool, overrides = {}, opts = {}) {
  const pre = await previewSeed(pool, 'maps');
  const decisions = {};
  for (const r of pre.rows) decisions[r.syncUuid] = r.defaultDecision;
  Object.assign(decisions, overrides);
  return applySeed(pool, 'maps', decisions, { signature: pre.signature, ...opts });
}

// A PC that built the worlds before seed sync (plain applyMapSpec, no state).
async function buildWithoutState(pool, specs) {
  const { applyMapSpec } = require('../scripts/seed-map.js');
  const { compassSlots } = require('../src/services/mapSpecExport.js');
  for (const s of specs) {
    await applyMapSpec(pool, s, { moveEntry: false, keepSlots: specs.filter((o) => o !== s).flatMap(compassSlots) });
  }
}

const rowOf = (d, name) => d.rows.find((r) => r.key === name);
const kindOf = async (pool, name) => {
  const r = rowOf(await previewSeed(pool, 'maps'), name);
  return r ? r.kind : 'in_sync';
};
const entryWorlds = async (pool) => (await pool.query('SELECT name FROM worlds WHERE is_entry ORDER BY name')).rows.map((r) => r.name);
const stateOf = async (pool, name) => (await pool.query('SELECT * FROM map_spec_state WHERE spec_name = $1', [name])).rows[0];
const graphX = async (pool, name) => (await pool.query('SELECT graph_x FROM worlds WHERE name = $1', [name])).rows[0].graph_x;

// ---- box fixtures -------------------------------------------------------------

const PROVIDER = {
  id: 1, name: 'sx box', base_url: 'http://192.168.0.217:8001/sdapi/v1/txt2img',
  auth_header_name: null, auth_token: 'sx-secret-token-123', enabled: true, is_active: true,
};
const serviceDb = { query: async () => ({ rows: [PROVIDER] }) };
const jres = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json' },
});
// A fake box: `boxes` = spec name -> the spec the box holds (absent = 404).
// GET answers with ETag "etag-<name>"; `put` = { status, body } for the PUT.
function fakeBox(boxes, { put = { status: 200, body: { problems: [] } }, getStatus = 200, noEtag = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const parts = new URL(url).pathname.split('/');
    const name = parts[3];
    calls.push({ method, name, path: parts.slice(4).join('/'), body: opts.body ? JSON.parse(opts.body) : null, headers: opts.headers });
    if (!(name in boxes)) return jres({ detail: 'not found' }, 404);
    if (method === 'GET') {
      if (getStatus !== 200) return jres({ detail: 'nope' }, getStatus);
      return new Response(JSON.stringify(boxes[name]), {
        status: 200, headers: { 'content-type': 'application/json', ...(noEtag ? {} : { etag: `"etag-${name}"` }) },
      });
    }
    return jres(put.body, put.status);
  };
  return { calls, deps: { fetchImpl, serviceDb } };
}
const unreachableDeps = () => ({
  serviceDb,
  fetchImpl: async () => { throw new Error('connect EHOSTUNREACH 192.168.0.217:8001'); },
});

// Seed A and B, then hand-edit world b of A (graph_x) so an export writes A.
async function editedA(ctx) {
  const { pool } = ctx;
  setup(ctx, [specA(), specB()], `${P}a`);
  await seed(pool);
  await pool.query('UPDATE worlds SET graph_x = graph_x + 77 WHERE name = $1', [`${P}b`]);
}

// ---- tests -------------------------------------------------------------------

dbTest('box unreachable: export ok, box_error recorded, group note says so', async (ctx) => {
  const { pool } = ctx;
  await editedA(ctx);
  const ex = await exportGroup(pool, 'maps', { pushToBox: true, boxDeps: unreachableDeps() });
  assert.strictEqual(ex.rowCount, 1);
  assert.deepStrictEqual(ex.box.map((b) => [b.spec, b.status]), [['sx-m4-a', 'failed']]);
  const st = await stateOf(pool, 'sx-m4-a');
  assert.ok(st.exported_sha256);
  assert.match(st.box_error, /^unreachable: /);
  assert.ok(st.box_error.length <= 300);
  assert.notStrictEqual(st.box_pushed_sha256, st.exported_sha256);
  const d = await diffGroup(pool, 'maps');
  assert.strictEqual(d.note, 'GPU box unreachable — generate regions locally in Generated Worlds; box sync resumes when it is back');
  // The spec file and state are written despite the box.
  assert.strictEqual((await diffGroup(pool, 'maps')).status, 'in_sync');
});

dbTest('box 200: PUT carries our whole spec with the GET ETag; pushed, problems surfaced', async (ctx) => {
  const { pool } = ctx;
  await editedA(ctx);
  const { calls, deps } = fakeBox({ 'sx-m4-a': JSON.parse(canonicalSpecJson(specA())) },
    { put: { status: 200, body: { name: 'sx-m4-a', problems: ['p1', 'p2'] } } });
  const ex = await exportGroup(pool, 'maps', { pushToBox: true, boxDeps: deps });
  assert.deepStrictEqual(ex.box.map((b) => [b.spec, b.status]), [['sx-m4-a', 'pushed']]);
  assert.deepStrictEqual(calls.map((c) => c.method), ['GET', 'PUT']);
  assert.strictEqual(calls[1].path, 'spec');
  assert.deepStrictEqual(calls[1].body, readSpec(ctx.mapsDir, 'sx-m4-a'));
  assert.strictEqual(calls[1].headers['If-Match'], '"etag-sx-m4-a"');
  assert.deepStrictEqual(ex.box[0].problems, ['p1', 'p2']);
  assert.strictEqual(ex.boxNote, 'GPU box notes: 2 problems on sx-m4-a');
  const st = await stateOf(pool, 'sx-m4-a');
  assert.strictEqual(st.box_pushed_sha256, st.exported_sha256);
  assert.strictEqual(st.box_error, null);
  assert.strictEqual((await diffGroup(pool, 'maps')).note, undefined);
});

dbTest('box 409: failed box_changed, no second PUT in the same pass', async (ctx) => {
  const { pool } = ctx;
  await editedA(ctx);
  const { calls, deps } = fakeBox({ 'sx-m4-a': JSON.parse(canonicalSpecJson(specA())) },
    { put: { status: 409, body: { detail: 'spec changed on the box', sha256: 'x' } } });
  const ex = await exportGroup(pool, 'maps', { pushToBox: true, boxDeps: deps });
  assert.deepStrictEqual(ex.box.map((b) => [b.spec, b.status]), [['sx-m4-a', 'failed']]);
  assert.deepStrictEqual(calls.map((c) => c.method), ['GET', 'PUT']);
  const st = await stateOf(pool, 'sx-m4-a');
  assert.strictEqual(st.box_error, 'box_changed: the region changed on the GPU box since this export — review it there, then export again');
  assert.notStrictEqual(st.box_pushed_sha256, st.exported_sha256);
});

dbTest('box 422: failed box_rejected with the errors', async (ctx) => {
  const { pool } = ctx;
  await editedA(ctx);
  const { deps } = fakeBox({ 'sx-m4-a': JSON.parse(canonicalSpecJson(specA())) },
    { put: { status: 422, body: { detail: ['worlds[1].grid is bad', 'links[0].edge is bad'] } } });
  const ex = await exportGroup(pool, 'maps', { pushToBox: true, boxDeps: deps });
  assert.strictEqual(ex.box[0].status, 'failed');
  const st = await stateOf(pool, 'sx-m4-a');
  assert.strictEqual(st.box_error, 'box_rejected: worlds[1].grid is bad; links[0].edge is bad');
  assert.strictEqual((await diffGroup(pool, 'maps')).note, `GPU box not updated: sx-m4-a: ${st.box_error}`);
});

dbTest('box 401: auth_failed, fatal for the remaining specs, token not in the error', async (ctx) => {
  const { pool } = ctx;
  await editedA(ctx);
  await exportGroup(pool, 'maps');
  await pool.query(`INSERT INTO map_spec_state (spec_name, exported_sha256) VALUES ('sx-m4-b', 'abc')
                    ON CONFLICT (spec_name) DO UPDATE SET exported_sha256 = 'abc'`);
  const boxes = { 'sx-m4-a': JSON.parse(canonicalSpecJson(specA())), 'sx-m4-b': JSON.parse(canonicalSpecJson(specB())) };
  const { calls, deps } = fakeBox(boxes, { put: { status: 401, body: { detail: 'bad token' } } });
  const res = await mapsGroup.pushToBox(pool, ['sx-m4-a', 'sx-m4-b'], deps);
  assert.deepStrictEqual(res.map((r) => r.status), ['failed', 'failed']);
  assert.ok(res.every((r) => /^auth_failed: /.test(r.error)));
  assert.match(res[0].error, /revoked/);
  assert.deepStrictEqual(calls.map((c) => `${c.method} ${c.name}`), ['GET sx-m4-a', 'PUT sx-m4-a']);
  for (const n of ['sx-m4-a', 'sx-m4-b']) {
    const st = await stateOf(pool, n);
    assert.match(st.box_error, /^auth_failed: /);
    assert.ok(!st.box_error.includes('sx-secret-token-123'));
  }
});

dbTest('box does not know spec: skipped silently, no note', async (ctx) => {
  const { pool } = ctx;
  await editedA(ctx);
  const { calls, deps } = fakeBox({});
  const ex = await exportGroup(pool, 'maps', { pushToBox: true, boxDeps: deps });
  assert.deepStrictEqual(ex.box.map((b) => [b.spec, b.status]), [['sx-m4-a', 'skipped']]);
  assert.deepStrictEqual(calls.map((c) => c.method), ['GET']);
  const st = await stateOf(pool, 'sx-m4-a');
  assert.strictEqual(st.box_error, null);
  assert.strictEqual(st.box_pushed_sha256, `skipped:${st.exported_sha256}`);
  assert.strictEqual((await diffGroup(pool, 'maps')).note, undefined);
});

const A_BOX = () => ({ 'sx-m4-a': JSON.parse(canonicalSpecJson(specA())) });

dbTest('problems are scrubbed, capped at 10 x 200 chars, count kept', async (ctx) => {
  const { pool } = ctx;
  await editedA(ctx);
  const many = Array.from({ length: 12 }, (_, i) => `p${i} sx-secret-token-123 ${'x'.repeat(300)}`);
  const { deps } = fakeBox(A_BOX(), { put: { status: 200, body: { problems: many } } });
  const ex = await exportGroup(pool, 'maps', { pushToBox: true, boxDeps: deps });
  assert.strictEqual(ex.box[0].problems.length, 10);
  assert.strictEqual(ex.box[0].problemCount, 12);
  assert.ok(ex.box[0].problems.every((p) => p.length <= 200 && !p.includes('sx-secret-token-123')));
  assert.strictEqual(ex.boxNote, 'GPU box notes: 12 problems on sx-m4-a');
});

dbTest('GET 401: auth_failed naming the connector, fatal', async (ctx) => {
  const { pool } = ctx;
  await editedA(ctx);
  const { calls, deps } = fakeBox(A_BOX(), { getStatus: 401 });
  const ex = await exportGroup(pool, 'maps', { pushToBox: true, boxDeps: deps });
  assert.strictEqual(ex.box[0].status, 'failed');
  assert.deepStrictEqual(calls.map((c) => c.method), ['GET']);
  const st = await stateOf(pool, 'sx-m4-a');
  assert.match(st.box_error, /^auth_failed: .*"sx box".*revoked.*update the AI provider token/);
  assert.ok(st.box_error.length <= 300);
});

dbTest('PUT 403: auth_failed, the remaining specs are not tried', async (ctx) => {
  const { pool } = ctx;
  await editedA(ctx);
  await pool.query(`INSERT INTO map_spec_state (spec_name, exported_sha256) VALUES ('sx-m4-b', 'abc')
                    ON CONFLICT (spec_name) DO UPDATE SET exported_sha256 = 'abc'`);
  await exportGroup(pool, 'maps');
  const { calls, deps } = fakeBox({ ...A_BOX(), 'sx-m4-b': JSON.parse(canonicalSpecJson(specB())) }, { put: { status: 403, body: {} } });
  const res = await mapsGroup.pushToBox(pool, ['sx-m4-a', 'sx-m4-b'], deps);
  assert.ok(res.every((r) => r.status === 'failed' && /^auth_failed: /.test(r.error)));
  assert.deepStrictEqual(calls.map((c) => `${c.method} ${c.name}`), ['GET sx-m4-a', 'PUT sx-m4-a']);
});

dbTest('PUT 404 after a good GET: failed (not skipped), retryable, shown in the note, not fatal', async (ctx) => {
  const { pool } = ctx;
  await editedA(ctx);
  await pool.query(`INSERT INTO map_spec_state (spec_name, exported_sha256) VALUES ('sx-m4-b', 'abc')
                    ON CONFLICT (spec_name) DO UPDATE SET exported_sha256 = 'abc'`);
  await exportGroup(pool, 'maps');
  const { calls, deps } = fakeBox({ ...A_BOX(), 'sx-m4-b': JSON.parse(canonicalSpecJson(specB())) }, { put: { status: 404, body: {} } });
  const res = await mapsGroup.pushToBox(pool, ['sx-m4-a', 'sx-m4-b'], deps);
  assert.deepStrictEqual(res.map((r) => r.status), ['failed', 'failed']);
  assert.deepStrictEqual(calls.map((c) => `${c.method} ${c.name}`), ['GET sx-m4-a', 'PUT sx-m4-a', 'GET sx-m4-b', 'PUT sx-m4-b']);
  const st = await stateOf(pool, 'sx-m4-a');
  assert.strictEqual(st.box_error, 'not_found: PUT /spec returned 404 after the GET succeeded — the box may lack the spec endpoint');
  assert.ok(!String(st.box_pushed_sha256).startsWith('skipped:'));
  assert.ok(require('../src/services/seedSync/mapsBoxPush.js').needsPush(st));
  assert.strictEqual((await diffGroup(pool, 'maps')).note.split('\n')[0], `GPU box not updated: sx-m4-a: ${st.box_error}`);
});

dbTest('PUT 428: failed service_error, recorded', async (ctx) => {
  const { pool } = ctx;
  await editedA(ctx);
  const { deps } = fakeBox(A_BOX(), { put: { status: 428, body: { detail: 'If-Match required' } } });
  const ex = await exportGroup(pool, 'maps', { pushToBox: true, boxDeps: deps });
  assert.strictEqual(ex.box[0].status, 'failed');
  assert.match((await stateOf(pool, 'sx-m4-a')).box_error, /^service_error: .*428/);
});

dbTest('GET without an ETag: failed, no PUT sent', async (ctx) => {
  const { pool } = ctx;
  await editedA(ctx);
  const { calls, deps } = fakeBox(A_BOX(), { noEtag: true });
  const ex = await exportGroup(pool, 'maps', { pushToBox: true, boxDeps: deps });
  assert.strictEqual(ex.box[0].status, 'failed');
  assert.deepStrictEqual(calls.map((c) => c.method), ['GET']);
  assert.match((await stateOf(pool, 'sx-m4-a')).box_error, /^service_error: .*ETag/);
});

test('putWorldSpec refuses If-Match * and an empty etag without calling the box', async () => {
  const wg = require('../src/services/worldGenService.js');
  let called = 0;
  const deps = { fetchImpl: async () => { called += 1; return jres({}); } };
  for (const bad of ['*', ' * ', '', null, undefined]) {
    await assert.rejects(() => wg.putWorldSpec(serviceDb, 'sx-m4-a', {}, bad, deps), (e) => e.code === 'bad_etag');
  }
  assert.strictEqual(called, 0);
});

dbTest('box PUT 500: service_error recorded, token never in box_error', async (ctx) => {
  const { pool } = ctx;
  await editedA(ctx);
  const { deps } = fakeBox({ 'sx-m4-a': JSON.parse(canonicalSpecJson(specA())) },
    { put: { status: 500, body: { detail: 'boom sx-secret-token-123' } } });
  const ex = await exportGroup(pool, 'maps', { pushToBox: true, boxDeps: deps });
  assert.strictEqual(ex.box[0].status, 'failed');
  const st = await stateOf(pool, 'sx-m4-a');
  assert.match(st.box_error, /^service_error: /);
  assert.ok(!st.box_error.includes('sx-secret-token-123'));
  const d = await diffGroup(pool, 'maps');
  assert.strictEqual(d.note, `GPU box not updated: sx-m4-a: ${st.box_error}`);
});

dbTest('an error carrying the token or a Bearer header is scrubbed before it is stored', async (ctx) => {
  const { pool } = ctx;
  await editedA(ctx);
  const deps = {
    serviceDb,
    fetchImpl: async () => { throw new Error('boom Authorization: Bearer sx-secret-token-123 sx-secret-token-123'); },
  };
  await exportGroup(pool, 'maps', { pushToBox: true, boxDeps: deps });
  const st = await stateOf(pool, 'sx-m4-a');
  assert.ok(st.box_error);
  assert.ok(!st.box_error.includes('sx-secret-token-123'));
  assert.ok(!/bearer/i.test(st.box_error));
});

dbTest('a spec name the box would refuse is skipped, not failed', async (ctx) => {
  const { pool } = ctx;
  await editedA(ctx);
  await pool.query(`INSERT INTO map_spec_state (spec_name, exported_sha256) VALUES ('sx-m4-bad.name', 'abc')
                    ON CONFLICT (spec_name) DO NOTHING`);
  const { calls, deps } = fakeBox({});
  const res = await mapsGroup.pushToBox(pool, ['sx-m4-bad.name'], deps);
  assert.deepStrictEqual(res.map((r) => r.status), ['skipped']);
  assert.strictEqual(calls.length, 0);
});

dbTest('progress: phase box with done/total per spec; a retry picks up an earlier failure', async (ctx) => {
  const { pool } = ctx;
  await editedA(ctx);
  await exportGroup(pool, 'maps', { pushToBox: true, boxDeps: unreachableDeps() });
  assert.match((await stateOf(pool, 'sx-m4-a')).box_error, /^unreachable/);
  // Nothing edited now: a second export writes no spec but retries the failed push.
  const prog = [];
  const { deps } = fakeBox({ 'sx-m4-a': JSON.parse(canonicalSpecJson(specA())) });
  const ex = await exportGroup(pool, 'maps', { pushToBox: true, boxDeps: deps, onProgress: (p) => prog.push(p) });
  assert.strictEqual(ex.rowCount, 0);
  assert.deepStrictEqual(ex.box.map((b) => b.status), ['pushed']);
  assert.deepStrictEqual(prog.filter((p) => p.phase === 'box').map((p) => [p.done, p.total]), [[0, 1], [1, 1]]);
  assert.strictEqual((await stateOf(pool, 'sx-m4-a')).box_error, null);
});

dbTest('a CLI-style export (no push) leaves "not pushed yet"; the next pushing export retries it', async (ctx) => {
  const { pool } = ctx;
  await editedA(ctx);
  await exportGroup(pool, 'maps');
  assert.strictEqual((await diffGroup(pool, 'maps')).note, 'GPU box not updated: sx-m4-a: not pushed yet');
  const { calls, deps } = fakeBox({ 'sx-m4-a': JSON.parse(canonicalSpecJson(specA())) });
  const ex = await exportGroup(pool, 'maps', { pushToBox: true, boxDeps: deps });
  assert.strictEqual(ex.rowCount, 0);
  assert.deepStrictEqual(ex.box.map((b) => [b.spec, b.status]), [['sx-m4-a', 'pushed']]);
  assert.ok(calls.some((c) => c.method === 'PUT'));
  assert.strictEqual((await diffGroup(pool, 'maps')).note, undefined);
});

dbTest('a stale skip marker counts as unpushed and is retried', async (ctx) => {
  const { pool } = ctx;
  await editedA(ctx);
  await exportGroup(pool, 'maps', { pushToBox: true, boxDeps: fakeBox({}).deps });
  const st = await stateOf(pool, 'sx-m4-a');
  assert.strictEqual(st.box_pushed_sha256, `skipped:${st.exported_sha256}`);
  assert.strictEqual((await diffGroup(pool, 'maps')).note, undefined);
  // The spec is re-exported with other content: the old marker no longer matches.
  await pool.query("UPDATE map_spec_state SET box_pushed_sha256 = 'skipped:old' WHERE spec_name = 'sx-m4-a'");
  assert.strictEqual((await diffGroup(pool, 'maps')).note, 'GPU box not updated: sx-m4-a: not pushed yet');
  const { deps } = fakeBox({ 'sx-m4-a': JSON.parse(canonicalSpecJson(specA())) });
  const ex = await exportGroup(pool, 'maps', { pushToBox: true, boxDeps: deps });
  assert.deepStrictEqual(ex.box.map((b) => b.status), ['pushed']);
  assert.strictEqual((await diffGroup(pool, 'maps')).note, undefined);
});

test('note lists at most 3 specs then +N more; unreachable replaces the lines', () => {
  const rows = ['a', 'b', 'c', 'd', 'e'].map((k) => ({ spec: k, error: 'service_error: boom' }));
  assert.strictEqual(mapsGroup._boxNote(rows), [
    'GPU box not updated: a: service_error: boom',
    'GPU box not updated: b: service_error: boom',
    'GPU box not updated: c: service_error: boom',
    '+2 more',
  ].join('\n'));
  assert.strictEqual(mapsGroup._boxNote([]), null);
  const mixed = [{ spec: 'a', error: 'unreachable: x' }, { spec: 'b', error: 'service_error: y' }];
  assert.match(mapsGroup._boxNote(mixed), /^GPU box not updated: a: unreachable: x\n/);
  const allDown = [{ spec: 'a', error: 'unreachable: x' }, { spec: 'b', error: 'unreachable: y' }];
  assert.strictEqual(mapsGroup._boxNote(allDown), 'GPU box unreachable — generate regions locally in Generated Worlds; box sync resumes when it is back');
});
