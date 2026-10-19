// SOMET-641 (Plan 4a, Task 4). The seed-sync Maps group: its unit of sync is a
// .map.json spec file (SEED_MAPS_DIR) listed in the manifest
// seeds/sync/maps.json (SEED_SYNC_DIR), not a DB row.
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

// ---- tests -------------------------------------------------------------------

dbTest('fresh PC: new specs seed and land in sync', async (ctx) => {
  const { pool } = ctx;
  setup(ctx, [specA(), specB()], `${P}a`);
  const d = await diffGroup(pool, 'maps');
  assert.strictEqual(d.groupId, 'maps');
  assert.strictEqual(d.status, 'git_newer');
  assert.strictEqual(d.header.group, 'maps');
  assert.strictEqual(d.gitChanges, 2);
  assert.strictEqual(d.localEdits, 0);
  const pre = await previewSeed(pool, 'maps');
  assert.strictEqual(typeof pre.signature, 'string');
  const a = rowOf(pre, 'sx-m4-a');
  assert.deepStrictEqual(
    { table: a.table, key: a.key, syncUuid: a.syncUuid, kind: a.kind, defaultDecision: a.defaultDecision, blockedReason: a.blockedReason },
    { table: 'map_specs', key: 'sx-m4-a', syncUuid: uuidOf('sx-m4-a'), kind: 'new', defaultDecision: 'git', blockedReason: null });
  assert.deepStrictEqual(a.allowedDecisions, ['git']);
  assert.deepStrictEqual(a.fields.map((f) => f.name), [`${P}a`, `${P}b`]);

  const res = await seed(pool);
  assert.ok(Number.isInteger(res.runId));
  assert.deepStrictEqual(res.summary.applied, ['sx-m4-a', 'sx-m4-b']);
  assert.strictEqual((await pool.query("SELECT count(*)::int AS n FROM worlds WHERE name LIKE 'sx\\_m4\\_%'")).rows[0].n, 3);
  assert.deepStrictEqual(await entryWorlds(pool), [`${P}a`]);
  for (const s of [specA(), specB()]) {
    const st = await stateOf(pool, s.name);
    assert.strictEqual(st.applied_sha256, sha(s), s.name);
    assert.ok(st.applied_at instanceof Date);
  }
  const after = await diffGroup(pool, 'maps');
  assert.strictEqual(after.status, 'in_sync');
  assert.deepStrictEqual((await previewSeed(pool, 'maps')).rows, []);
  const run = (await pool.query('SELECT * FROM seed_export_runs WHERE id = $1', [res.runId])).rows[0];
  assert.strictEqual(run.group_id, 'maps');
  assert.strictEqual(run.status, 'ok');
});

dbTest('admin edit → edited_here → export writes spec → other PC git_newer → seed → in sync', async (ctx) => {
  const { pool, mapsDir, syncDir } = ctx;
  setup(ctx, [specA(), specB()], `${P}a`);
  await seed(pool);
  const v1 = specA();
  const x0 = await graphX(pool, `${P}b`);

  // The World Map Editor drags world b.
  await pool.query('UPDATE worlds SET graph_x = graph_x + 77 WHERE name = $1', [`${P}b`]);
  const d = await diffGroup(pool, 'maps');
  assert.strictEqual(d.status, 'local_edits');
  assert.strictEqual(d.localEdits, 1);
  assert.strictEqual(d.gitChanges, 0);
  const row = rowOf(await previewSeed(pool, 'maps'), 'sx-m4-a');
  assert.strictEqual(row.kind, 'edited_here');
  assert.strictEqual(row.defaultDecision, 'local');
  assert.deepStrictEqual(row.fields.map((f) => f.name), [`${P}b`]);

  const ex = await exportGroup(pool, 'maps');
  assert.ok(Number.isInteger(ex.runId));
  assert.strictEqual(ex.rowCount, 1);
  const v2 = readSpec(mapsDir, 'sx-m4-a');
  assert.deepStrictEqual(v2.worlds[1].graph, [x0 + 77, 0]);
  assert.strictEqual(readSpecText(mapsDir, 'sx-m4-a'), canonicalSpecJson(v2));
  // spec B was not edited: its file is untouched.
  assert.strictEqual(readSpecText(mapsDir, 'sx-m4-b'), canonicalSpecJson(specB()));
  const man = readManifest(syncDir);
  assert.deepStrictEqual(man.specs, [{ name: 'sx-m4-a', sha256: sha(v2) }, { name: 'sx-m4-b', sha256: sha(specB()) }]);
  assert.strictEqual(man.entry_world, `${P}a`);
  assert.strictEqual(man.header.group, 'maps');
  assert.strictEqual((await stateOf(pool, 'sx-m4-a')).exported_sha256, sha(v2));
  assert.strictEqual((await diffGroup(pool, 'maps')).status, 'in_sync');

  // The other PC: it applied v1, its DB still has v1, and git now holds v2.
  await pool.query('UPDATE worlds SET graph_x = $2 WHERE name = $1', [`${P}b`, x0]);
  await pool.query(`UPDATE map_spec_state SET applied_sha256 = $2, exported_sha256 = NULL, exported_at = NULL,
                    base_spec = $3 WHERE spec_name = $1`, ['sx-m4-a', sha(v1), canonicalSpecJson(v1)]);
  const other = await diffGroup(pool, 'maps');
  assert.strictEqual(other.status, 'git_newer');
  const g = rowOf(await previewSeed(pool, 'maps'), 'sx-m4-a');
  assert.strictEqual(g.kind, 'git_newer');
  assert.strictEqual(g.defaultDecision, 'git');
  assert.deepStrictEqual(g.fields.map((f) => f.name), [`${P}b`]);
  await assert.rejects(exportGroup(pool, 'maps'), (e) => e instanceof SyncRefused && e.code === 'git_newer');

  const res = await seed(pool);
  assert.deepStrictEqual(res.summary.applied, ['sx-m4-a']);
  assert.strictEqual(await graphX(pool, `${P}b`), x0 + 77);
  assert.strictEqual((await stateOf(pool, 'sx-m4-a')).applied_sha256, sha(v2));
  assert.strictEqual((await diffGroup(pool, 'maps')).status, 'in_sync');
});

dbTest('both sides changed → conflict, red, export refused', async (ctx) => {
  const { pool, mapsDir, syncDir } = ctx;
  setup(ctx, [specA(), specB()], `${P}a`);
  await seed(pool);
  await pool.query('UPDATE worlds SET graph_x = graph_x + 40 WHERE name = $1', [`${P}b`]);
  // Git moves on too (another PC exported an edit of world a).
  const git = specA();
  git.worlds[0].entry_spawn = { x: 3000, y: 3000 };
  writeSpec(mapsDir, git);
  writeManifest(syncDir, [git, specB()], `${P}a`);

  const d = await diffGroup(pool, 'maps');
  assert.strictEqual(d.status, 'local_edits');
  assert.ok(d.gitChanges >= 1 && d.localEdits >= 1);
  const pre = await previewSeed(pool, 'maps');
  const row = rowOf(pre, 'sx-m4-a');
  assert.strictEqual(row.kind, 'conflict');
  assert.strictEqual(row.defaultDecision, null, 'red: no default');
  assert.deepStrictEqual(row.allowedDecisions, ['git', 'local']);
  assert.deepStrictEqual(row.fields.map((f) => f.name).sort(), [`${P}a`, `${P}b`]);

  const before = readSpecText(mapsDir, 'sx-m4-a');
  await assert.rejects(exportGroup(pool, 'maps'), (e) => e instanceof SyncRefused && e.code === 'git_newer');
  assert.strictEqual(readSpecText(mapsDir, 'sx-m4-a'), before, 'export refused: nothing written');
  await assert.rejects(applySeed(pool, 'maps', {}, { signature: pre.signature }),
    (e) => e instanceof SyncRefused && e.code === 'undecided');

  // Keep local acknowledges git's version: next it is a plain local edit.
  await seed(pool, { [uuidOf('sx-m4-a')]: 'local' });
  assert.strictEqual(await kindOf(pool, 'sx-m4-a'), 'edited_here');
  assert.strictEqual((await stateOf(pool, 'sx-m4-a')).applied_sha256, sha(git));
});

dbTest('removed spec is only_here, nothing deleted', async (ctx) => {
  const { pool, mapsDir, syncDir } = ctx;
  setup(ctx, [specA(), specB()], `${P}a`);
  await seed(pool);
  // A player standing in world c: player data must survive.
  const c = (await pool.query('SELECT id FROM worlds WHERE name = $1', [`${P}c`])).rows[0].id;
  const user = (await pool.query(
    "INSERT INTO users (username, password_hash) VALUES ('sx_m4_player', 'x') RETURNING id")).rows[0].id;
  // A playable class with an appearance (characters_appearance_fk).
  const ap = (await pool.query(
    'SELECT entity_type_id, variant FROM character_appearances ORDER BY entity_type_id, variant LIMIT 1')).rows[0];
  const ch = (await pool.query(
    `INSERT INTO characters (user_id, slot, name, entity_type_id, appearance_variant)
     VALUES ($1, 1, 'sx_m4_hero', $2, $3) RETURNING id`, [user, ap.entity_type_id, ap.variant])).rows[0].id;
  await pool.query('INSERT INTO world_players (world_id, character_id, x, y) VALUES ($1, $2, 100, 100)', [c, ch]);
  fs.rmSync(path.join(mapsDir, 'sx-m4-b.map.json'));
  writeManifest(syncDir, [specA()], `${P}a`);

  const pre = await previewSeed(pool, 'maps');
  const row = rowOf(pre, 'sx-m4-b');
  assert.strictEqual(row.kind, 'only_here');
  assert.strictEqual(row.defaultDecision, 'local');
  assert.deepStrictEqual(row.allowedDecisions, ['local']);
  await assert.rejects(seed(pool, { [uuidOf('sx-m4-b')]: 'git' }),
    (e) => e instanceof SyncRefused && e.code === 'invalid_decision');

  await seed(pool);
  assert.strictEqual((await pool.query('SELECT count(*)::int AS n FROM worlds WHERE id = $1', [c])).rows[0].n, 1, 'world kept');
  assert.strictEqual((await pool.query(
    'SELECT count(*)::int AS n FROM world_players WHERE world_id = $1 AND character_id = $2', [c, ch])).rows[0].n, 1,
  'player position kept');
  assert.strictEqual(await stateOf(pool, 'sx-m4-b'), undefined, 'acknowledged: no longer tracked');
  const after = await previewSeed(pool, 'maps');
  assert.deepStrictEqual(after.rows, []);
  assert.ok(after.warnings.some((w) => w.code === 'world_not_in_spec' && w.key === `${P}c`), JSON.stringify(after.warnings));
});

dbTest('entry world comes from the manifest', async (ctx) => {
  const { pool, syncDir } = ctx;
  // Both specs say is_entry; the manifest names spec B's world.
  setup(ctx, [specA(), specB()], `${P}c`);
  await seed(pool);
  assert.deepStrictEqual(await entryWorlds(pool), [`${P}c`]);

  // A manifest naming a world no spec holds is a bad file.
  writeManifest(syncDir, [specA(), specB()], `${P}nowhere`);
  await assert.rejects(diffGroup(pool, 'maps'), (e) => e instanceof SyncFileError && /entry_world/.test(e.message));
  writeManifest(syncDir, [specA(), specB()], [`${P}a`, `${P}c`]);
  await assert.rejects(diffGroup(pool, 'maps'), (e) => e instanceof SyncFileError && /entry_world/.test(e.message));
});

dbTest('a spec whose name differs from its file stem is a bad file', async (ctx) => {
  const { pool, mapsDir } = ctx;
  setup(ctx, [specA(), specB()], `${P}a`);
  writeSpec(mapsDir, specB(), canonicalSpecJson({ ...specB(), name: 'sx-m4-other' }));
  await assert.rejects(diffGroup(pool, 'maps'), (e) => e instanceof SyncFileError && /sx-m4-other/.test(e.message));
});

dbTest('two specs claiming one doorway slot are refused before any write', async (ctx) => {
  const { pool } = ctx;
  const a = specA();
  // Spec B's c claims c:W -> a, whose mirror is a:E -- the slot spec A's a -E-> b owns.
  const b = specB();
  b.links.push({ from: 'c', edge: 'W', to_name: `${P}a` });
  setup(ctx, [a, b], `${P}a`);
  const pre = await previewSeed(pool, 'maps');
  assert.ok(pre.warnings.some((w) => w.code === 'slot_conflict'), JSON.stringify(pre.warnings));
  const decisions = Object.fromEntries(pre.rows.map((r) => [r.syncUuid, r.defaultDecision]));
  await assert.rejects(applySeed(pool, 'maps', decisions, { signature: pre.signature }),
    (e) => e instanceof SyncRefused && e.code === 'slot_conflict' && /sx-m4-a/.test(e.message) && /sx-m4-b/.test(e.message));
  assert.strictEqual((await pool.query("SELECT count(*)::int AS n FROM worlds WHERE name LIKE 'sx\\_m4\\_%'")).rows[0].n, 0);
});

dbTest('a failing spec: the ones before it stay applied and recorded (partial)', async (ctx) => {
  const { pool } = ctx;
  const b = specB();
  b.worlds[0].biomes = ['sx no such biome'];
  setup(ctx, [specA(), b], `${P}a`);
  await assert.rejects(seed(pool), (e) => e instanceof SyncRefused && e.code === 'partial_apply'
    && JSON.stringify(e.details.applied) === '["sx-m4-a"]' && e.details.failed === 'sx-m4-b' && e.details.step === 'apply');
  assert.strictEqual((await stateOf(pool, 'sx-m4-a')).applied_sha256, sha(specA()));
  assert.strictEqual(await stateOf(pool, 'sx-m4-b'), undefined);
  assert.strictEqual(await kindOf(pool, 'sx-m4-a'), 'in_sync');
  // Exactly one entry world: git's, which spec A built.
  assert.deepStrictEqual(await entryWorlds(pool), [`${P}a`]);
});

dbTest('a failure after every spec applied is still partial_apply, entry world set', async (ctx) => {
  const { pool } = ctx;
  setup(ctx, [specA(), specB()], `${P}c`);
  const boom = async () => { throw new Error('sx boom after specs'); };
  await assert.rejects(seed(pool, {}, { _afterSpecs: boom }), (e) => e instanceof SyncRefused && e.code === 'partial_apply'
    && JSON.stringify(e.details.applied) === '["sx-m4-a","sx-m4-b"]' && e.details.failed === null
    && e.details.step === 'keep_local' && /the keep_local step failed: sx boom after specs/.test(e.message));
  assert.deepStrictEqual(await entryWorlds(pool), [`${P}c`]);
  const run = (await pool.query("SELECT status FROM seed_export_runs WHERE group_id = 'maps' ORDER BY id DESC LIMIT 1")).rows[0];
  assert.strictEqual(run.status, 'failed');
});

const BASELINE_HINT = "Seed Maps once to record this PC's baseline — no map data changes";

dbTest('existing PC, DB matches the files: baseline_pending, recorded by export', async (ctx) => {
  const { pool, mapsDir } = ctx;
  setup(ctx, [specA(), specB()], `${P}a`);
  await buildWithoutState(pool, [specA(), specB()]);
  const d = await diffGroup(pool, 'maps');
  assert.strictEqual(d.status, 'baseline_pending');
  assert.strictEqual(d.hint, BASELINE_HINT);
  assert.deepStrictEqual([d.localEdits, d.gitChanges], [0, 0]);
  const rows = (await previewSeed(pool, 'maps')).rows;
  assert.deepStrictEqual(rows.map((r) => [r.key, r.kind, r.defaultDecision, r.allowedDecisions]),
    [['sx-m4-a', 'baseline', 'local', ['local']], ['sx-m4-b', 'baseline', 'local', ['local']]]);
  assert.strictEqual(await stateOf(pool, 'sx-m4-a'), undefined, 'status never writes');
  const ex = await exportGroup(pool, 'maps');
  assert.strictEqual(ex.rowCount, 0);
  assert.strictEqual(readSpecText(mapsDir, 'sx-m4-a'), canonicalSpecJson(specA()));
  for (const s of [specA(), specB()]) {
    const st = await stateOf(pool, s.name);
    assert.strictEqual(st.applied_sha256, sha(s), s.name);
    assert.strictEqual(st.base_spec, canonicalSpecJson(s), s.name);
  }
  // Adopted: a hand edit is now an ordinary local edit, and export writes it.
  await pool.query('UPDATE worlds SET graph_x = graph_x + 33 WHERE name = $1', [`${P}a`]);
  assert.strictEqual(await kindOf(pool, 'sx-m4-a'), 'edited_here');
  assert.strictEqual((await exportGroup(pool, 'maps')).rowCount, 1);
  assert.ok(Array.isArray(readSpec(mapsDir, 'sx-m4-a').worlds[0].graph));
});

dbTest('existing PC, DB differs: conflict → Keep local → edited_here → export writes the spec', async (ctx) => {
  const { pool, mapsDir } = ctx;
  setup(ctx, [specA(), specB()], `${P}a`);
  await buildWithoutState(pool, [specA(), specB()]);
  await pool.query('UPDATE worlds SET graph_x = graph_x + 55 WHERE name = $1', [`${P}b`]);
  const row = rowOf(await previewSeed(pool, 'maps'), 'sx-m4-a');
  assert.strictEqual(row.kind, 'conflict');
  assert.strictEqual(row.defaultDecision, null);
  assert.deepStrictEqual(row.allowedDecisions, ['git', 'local']);
  assert.strictEqual(row.blockedReason, 'no_baseline');
  // The loss list: Keep local would write world b's hand-placed graph into git.
  assert.strictEqual(row.blockedMessage,
    "No baseline on this PC — Keep local will change graph on 1 world. Take git will discard this PC's differences.");
  assert.strictEqual(await kindOf(pool, 'sx-m4-b'), 'baseline');
  await assert.rejects(exportGroup(pool, 'maps'), (e) => e instanceof SyncRefused && e.code === 'git_newer');
  const res = await seed(pool, { [uuidOf('sx-m4-a')]: 'local' });
  assert.deepStrictEqual(res.summary.applied, []);
  assert.strictEqual(res.summary.adopted, 1, 'spec B (in sync) adopted by the seed');
  assert.strictEqual((await stateOf(pool, 'sx-m4-b')).base_spec, canonicalSpecJson(specB()));
  assert.strictEqual(await kindOf(pool, 'sx-m4-a'), 'edited_here');
  const x = await graphX(pool, `${P}b`);
  assert.strictEqual((await exportGroup(pool, 'maps')).rowCount, 1);
  assert.deepStrictEqual(readSpec(mapsDir, 'sx-m4-a').worlds[1].graph, [x, 0]);
  assert.strictEqual((await diffGroup(pool, 'maps')).status, 'in_sync');
});

dbTest('baseline only: Seed records it without applying anything', async (ctx) => {
  const { pool } = ctx;
  setup(ctx, [specA(), specB()], `${P}a`);
  await buildWithoutState(pool, [specA(), specB()]);
  const snap = async () => (await pool.query(
    "SELECT name, seed, graph_x, graph_y, entry_spawn FROM worlds WHERE name LIKE 'sx\\_m4\\_%' ORDER BY name")).rows;
  const linkCount = async () => (await pool.query(
    "SELECT count(*)::int AS n FROM map_links l JOIN worlds w ON w.id = l.from_world_id WHERE w.name LIKE 'sx\\_m4\\_%'")).rows[0].n;
  const before = [await snap(), await linkCount()];
  const res = await seed(pool);
  assert.deepStrictEqual(res.summary.applied, []);
  assert.strictEqual(res.summary.adopted, 2);
  assert.strictEqual(res.summary.kept, 0);
  assert.deepStrictEqual([await snap(), await linkCount()], before, 'no map data written');
  for (const s of [specA(), specB()]) assert.strictEqual((await stateOf(pool, s.name)).base_spec, canonicalSpecJson(s));
  const d = await diffGroup(pool, 'maps');
  assert.strictEqual(d.status, 'in_sync');
  assert.ok(!('hint' in d));
});

dbTest('legacy state row (hash only) is back-filled by the next seed', async (ctx) => {
  const { pool } = ctx;
  setup(ctx, [specA(), specB()], `${P}a`);
  await seed(pool);
  await pool.query("UPDATE map_spec_state SET base_spec = NULL WHERE spec_name = 'sx-m4-a'");
  assert.strictEqual(await kindOf(pool, 'sx-m4-a'), 'baseline');
  assert.strictEqual((await diffGroup(pool, 'maps')).status, 'baseline_pending');
  await seed(pool);
  assert.strictEqual((await stateOf(pool, 'sx-m4-a')).base_spec, canonicalSpecJson(specA()));
  assert.strictEqual((await diffGroup(pool, 'maps')).status, 'in_sync');
});

dbTest('a spec whose worlds were all renamed is not new (seed-aware match)', async (ctx) => {
  const { pool } = ctx;
  setup(ctx, [specA(), specB()], `${P}a`);
  await buildWithoutState(pool, [specA(), specB()]);
  await pool.query('UPDATE worlds SET name = $2 WHERE name = $1', [`${P}c`, `${P}c_renamed`]);
  const row = rowOf(await previewSeed(pool, 'maps'), 'sx-m4-b');
  assert.strictEqual(row.kind, 'conflict', 'matched by seed: not new, so a seed never builds it twice');
  assert.strictEqual(row.blockedReason, 'no_baseline');
});

dbTest('Take git on a conflict row rebuilds the spec from git', async (ctx) => {
  const { pool, mapsDir, syncDir } = ctx;
  setup(ctx, [specA(), specB()], `${P}a`);
  await seed(pool);
  const x0 = await graphX(pool, `${P}b`);
  await pool.query('UPDATE worlds SET graph_x = graph_x + 40 WHERE name = $1', [`${P}b`]);
  const git = specA();
  git.worlds[0].entry_spawn = { x: 3000, y: 3000 };
  writeSpec(mapsDir, git);
  writeManifest(syncDir, [git, specB()], `${P}a`);
  assert.strictEqual(await kindOf(pool, 'sx-m4-a'), 'conflict');
  const res = await seed(pool, { [uuidOf('sx-m4-a')]: 'git' });
  assert.deepStrictEqual(res.summary.applied, ['sx-m4-a']);
  assert.strictEqual(await graphX(pool, `${P}b`), x0, 'hand edit replaced by git');
  const spawn = (await pool.query('SELECT entry_spawn FROM worlds WHERE name = $1', [`${P}a`])).rows[0].entry_spawn;
  assert.deepStrictEqual(spawn, { x: 3000, y: 3000 });
  assert.strictEqual((await stateOf(pool, 'sx-m4-a')).applied_sha256, sha(git));
  assert.strictEqual((await diffGroup(pool, 'maps')).status, 'in_sync');
});

dbTest('entry world drift is a warning', async (ctx) => {
  const { pool } = ctx;
  setup(ctx, [specA(), specB()], `${P}a`);
  await seed(pool);
  assert.ok(!(await previewSeed(pool, 'maps')).warnings.some((w) => w.code === 'entry_world_drift'));
  await setEntryWorldByName(pool, `${P}c`); // e.g. a `make seed-map` of spec B
  const w = (await diffGroup(pool, 'maps')).warnings.find((x) => x.code === 'entry_world_drift');
  assert.ok(w, 'drift warned');
  assert.deepStrictEqual(w.here, [`${P}c`]);
  assert.strictEqual(w.key, `${P}a`);
});

dbTest('make seed-map records applied hash', async (ctx) => {
  const { pool, mapsDir } = ctx;
  writeSpec(mapsDir, specB());
  const r = spawnSync(process.execPath, [SEED_MAP], {
    env: { ...process.env, DATABASE_URL: DB_URL, SPEC: 'sx-m4-b', SEED_MAPS_DIR: mapsDir },
    encoding: 'utf8', timeout: 180000,
  });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const st = await stateOf(pool, 'sx-m4-b');
  assert.strictEqual(st.applied_sha256, sha(specB()));
  assert.ok(st.applied_at instanceof Date);
  assert.strictEqual(st.base_spec, canonicalSpecJson(specB()));
});

// SOMET-641 final review I2: a no-baseline conflict's message lists what Keep
// local would remove from (or change in) git, so the admin can see the cost.
dbTest('no baseline: blockedMessage lists what Keep local removes from git', async (ctx) => {
  const { pool } = ctx;
  await buildWithoutState(pool, [specA(), specB()]);
  // Git (another PC) added two portals a -> b and a village in b; this DB
  // never had them.
  const git = specA();
  git.links.push(
    { kind: 'portal', from: 'a', from_x: 1050, from_y: 1050, to: 'b', to_x: 1550, to_y: 1550 },
    { kind: 'portal', from: 'a', from_x: 2050, from_y: 2050, to: 'b', to_x: 2550, to_y: 2550 });
  git.worlds[1].village = {
    key: 'bv', min_row: 40, min_col: 40, width: 6, height: 4, gate_edge: 'S', spawn_x: 4350, spawn_y: 4350,
  };
  setup(ctx, [git, specB()], `${P}a`);
  const row = rowOf(await previewSeed(pool, 'maps'), 'sx-m4-a');
  assert.strictEqual(row.kind, 'conflict');
  assert.strictEqual(row.defaultDecision, null, 'still red: no default');
  assert.strictEqual(row.blockedReason, 'no_baseline');
  assert.strictEqual(row.blockedMessage,
    "No baseline on this PC — Keep local will remove from git: 1 village, 2 portals. Take git will discard this PC's differences.");
});

test('noBaselineMessage: kinds, world fields by name, capped list', () => {
  const { _noBaselineMessage: msg } = require('../src/services/seedSync/mapsGroup.js');
  const w = (key, extra = {}) => ({ key, name: `${P}${key}`, ...extra });
  const g = {
    name: 'x',
    worlds: [
      w('a', { level_band: [1, 5], waypoints: [{ x: 1, y: 1, name: 'wp1' }], chest: { x: 1, y: 1 } }),
      w('b', { level_band: [2, 6], allows_fast_travel: true }),
      w('c', { level_band: [3, 7] }),
      w('gone'),
    ],
    links: [
      { from: 'a', edge: 'E', to: 'b' },
      { kind: 'portal', from: 'a', from_x: 1, from_y: 1, to: 'c', to_x: 2, to_y: 2, is_waypoint: true },
    ],
  };
  const out = {
    name: 'x',
    worlds: [w('a', { level_band: [1, 9] }), w('b', { level_band: [2, 9] }), w('c', { level_band: [3, 9] })],
    links: [],
  };
  assert.strictEqual(msg(g, out),
    'No baseline on this PC — Keep local will remove from git: 1 world, 2 waypoints, 1 chest, 1 compass link, 1 portal; '
    + "change level_band on 3 worlds, …. Take git will discard this PC's differences.");
  // Field changes only: the first names worlds, the rest a bare count.
  const g2 = { name: 'x', worlds: [w('a', { level_band: [1, 5], allows_fast_travel: true }), w('b', { level_band: [1, 5] })], links: [] };
  const o2 = { name: 'x', worlds: [w('a'), w('b')], links: [] };
  assert.strictEqual(msg(g2, o2),
    "No baseline on this PC — Keep local will change level_band on 2 worlds, allows_fast_travel on 1. Take git will discard this PC's differences.");
  assert.strictEqual(msg(g2, g2), "No baseline on this PC — Keep local changes nothing in git. Take git will discard this PC's differences.");
});
