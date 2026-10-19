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
function fakeBox(boxes, { patchStatus = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const name = new URL(url).pathname.split('/')[3];
    calls.push({ method, name, body: opts.body ? JSON.parse(opts.body) : null, headers: opts.headers });
    if (!(name in boxes)) return jres({ detail: 'not found' }, 404);
    if (method === 'GET') return jres(boxes[name]);
    return jres({ ok: true }, patchStatus);
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
  assert.strictEqual(d.note, 'GPU box unreachable — new regions need the box (local generator: SOMET-644)');
  // The spec file and state are written despite the box.
  assert.strictEqual((await diffGroup(pool, 'maps')).status, 'in_sync');
});

dbTest('box knows spec: PATCH carries only the changed keys; state records the push', async (ctx) => {
  const { pool } = ctx;
  await editedA(ctx);
  const v1 = specA();
  const { calls, deps } = fakeBox({ 'sx-m4-a': JSON.parse(canonicalSpecJson(v1)) });
  const ex = await exportGroup(pool, 'maps', { pushToBox: true, boxDeps: deps });
  assert.deepStrictEqual(ex.box.map((b) => [b.spec, b.status]), [['sx-m4-a', 'pushed']]);
  const patches = calls.filter((c) => c.method === 'PATCH');
  assert.strictEqual(patches.length, 1);
  assert.strictEqual(patches[0].name, 'sx-m4-a');
  assert.deepStrictEqual(Object.keys(patches[0].body), ['worlds']);
  assert.deepStrictEqual(patches[0].body.worlds, readSpec(ctx.mapsDir, 'sx-m4-a').worlds);
  const st = await stateOf(pool, 'sx-m4-a');
  assert.strictEqual(st.box_pushed_sha256, st.exported_sha256);
  assert.strictEqual(st.box_error, null);
  assert.strictEqual((await diffGroup(pool, 'maps')).note, undefined);
});

dbTest('box already identical: pushed with no PATCH sent', async (ctx) => {
  const { pool } = ctx;
  await editedA(ctx);
  const ex0 = await exportGroup(pool, 'maps');
  assert.strictEqual(ex0.box, undefined);
  const f = fakeBox({ 'sx-m4-a': readSpec(ctx.mapsDir, 'sx-m4-a') });
  const res = await mapsGroup.pushToBox(pool, ['sx-m4-a'], f.deps);
  assert.deepStrictEqual(res.map((r) => r.status), ['pushed']);
  assert.deepStrictEqual(f.calls.map((c) => c.method), ['GET']);
  const st = await stateOf(pool, 'sx-m4-a');
  assert.strictEqual(st.box_pushed_sha256, st.exported_sha256);
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

dbTest('box PATCH failure: per-spec note, error scrubbed of the token', async (ctx) => {
  const { pool } = ctx;
  await editedA(ctx);
  const { deps } = fakeBox({ 'sx-m4-a': JSON.parse(canonicalSpecJson(specA())) }, { patchStatus: 500 });
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
  assert.strictEqual(mapsGroup._boxNote(allDown), 'GPU box unreachable — new regions need the box (local generator: SOMET-644)');
});
