const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { Pool } = require('pg');
const { withSeedSyncLock, cleanupSx, makeTempSyncDir } = require('./helpers/seedSyncTest.js');

const DB_URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://user:password@localhost:15432/game_db';

const { _withTestGroups } = require('../src/services/seedSync/registry.js');
const { exportGroup, fileFor } = require('../src/services/seedSync/exportGroup.js');
const { diffGroup } = require('../src/services/seedSync/diffGroup.js');
const { previewSeed, applySeed } = require('../src/services/seedSync/applySeed.js');
const { stableStringify } = require('../src/services/seedSync/canonical.js');
const { coverageProblems } = require('../src/services/seedSync/coverage.js');

// Throwaway tables live in their own schema (sx_spec): the coverage test,
// which may run in parallel, classifies every base table of current_schema()
// (public) and must never see them. The pool puts sx_spec first on the
// search_path, so the engine's unqualified names and current_schema() find them.
const SCHEMA = 'sx_spec';
const ART = 'art group (plan 3)';

const filtSpec = {
  table: 'sx_filt', naturalKey: ['name'], rowFilter: 'keep',
  omit: { id: 'local', keep: 'filter', sync_uuid: 'identity' }, secretColumns: [], refs: {},
};
const verSpec = {
  table: 'sx_ver', naturalKey: ['name'], versioned: true,
  omit: { id: 'local', active: 'versioned', sync_uuid: 'identity' }, secretColumns: [], refs: {},
};
const ownSpec = {
  table: 'sx_own', naturalKey: ['name'],
  omit: { id: 'local', sync_uuid: 'identity', art: ART, art2: ART }, secretColumns: [], refs: {},
};
const artSlice = { table: 'sx_own', slice: true, columns: ['art', 'art2'], naturalKey: ['name'], secretColumns: [], refs: {} };
const GROUPS = [
  { id: 'sx_filt', label: 'SX filtered', tables: [filtSpec] },
  { id: 'sx_ver', label: 'SX versioned', tables: [verSpec] },
  { id: 'sx_own', label: 'SX owner', tables: [ownSpec] },
  { id: 'sx_art', label: 'SX art slice', tables: [artSlice] },
];

const SCHEMA_SQL = `
  DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE;
  CREATE SCHEMA ${SCHEMA};
  CREATE TABLE ${SCHEMA}.sx_filt (
    id serial PRIMARY KEY, name text NOT NULL UNIQUE, keep boolean NOT NULL DEFAULT true, val int,
    sync_uuid uuid NOT NULL UNIQUE DEFAULT gen_random_uuid());
  CREATE TABLE ${SCHEMA}.sx_ver (
    id serial PRIMARY KEY, name text NOT NULL, val int, active boolean NOT NULL DEFAULT true,
    sync_uuid uuid NOT NULL DEFAULT gen_random_uuid());
  CREATE UNIQUE INDEX sx_ver_uuid_active ON ${SCHEMA}.sx_ver (sync_uuid) WHERE active;
  CREATE UNIQUE INDEX sx_ver_name_active ON ${SCHEMA}.sx_ver (name) WHERE active;
  CREATE TABLE ${SCHEMA}.sx_own (
    id serial PRIMARY KEY, name text NOT NULL UNIQUE, val int, art text, art2 text,
    sync_uuid uuid NOT NULL UNIQUE DEFAULT gen_random_uuid());
  CREATE TABLE ${SCHEMA}.sx_ref (
    id serial PRIMARY KEY, own_id int REFERENCES ${SCHEMA}.sx_own(id) ON DELETE SET NULL);`;

async function cleanupAudio(pool) {
  await pool.query("DELETE FROM audio_jobs WHERE subject_key LIKE 'sx\\_%'");
  await pool.query("DELETE FROM audio_clips WHERE label LIKE 'sx\\_%'");
}

function dbTest(name, body) {
  test(name, async (t) => {
    if (!process.env.TEST_DATABASE_URL) {
      const msg = 'TEST_DATABASE_URL not set -- skipping to avoid mutating a real database (seed_sync spec features)';
      if (process.env.CI) assert.fail(msg);
      t.skip(msg);
      return;
    }
    const dir = makeTempSyncDir();
    const prev = process.env.SEED_SYNC_DIR;
    process.env.SEED_SYNC_DIR = dir;
    const pool = new Pool({
      connectionString: DB_URL, max: 4, connectionTimeoutMillis: 3000, options: `-c search_path=${SCHEMA},public`,
    });
    // Public-schema pool (real tables: current_schema() must be public).
    const pub = new Pool({ connectionString: DB_URL, max: 4, connectionTimeoutMillis: 3000 });
    t.after(async () => {
      if (prev === undefined) delete process.env.SEED_SYNC_DIR; else process.env.SEED_SYNC_DIR = prev;
      fs.rmSync(dir, { recursive: true, force: true });
      await pool.end().catch(() => {});
      await pub.end().catch(() => {});
    });
    await withSeedSyncLock(pub, async () => {
      await cleanupSx(pub);
      await cleanupAudio(pub);
      await pub.query(SCHEMA_SQL);
      try {
        await _withTestGroups(GROUPS, () => body(t, pool, pub));
      } finally {
        await pub.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
        await cleanupAudio(pub).catch(() => {});
        await cleanupSx(pub).catch(() => {});
      }
    });
  });
}

const one = async (pool, sql, params) => (await pool.query(sql, params)).rows[0];
const all = async (pool, sql, params) => (await pool.query(sql, params)).rows;
const readDoc = (groupId) => JSON.parse(fs.readFileSync(fileFor(groupId), 'utf8'));
function writeDoc(groupId, doc) {
  for (const [tbl, rows] of Object.entries(doc.tables)) doc.header.row_counts[tbl] = rows.length;
  fs.writeFileSync(fileFor(groupId), `${stableStringify(doc)}\n`);
}
async function apply(pool, groupId, decisions = {}) {
  const { signature } = await previewSeed(pool, groupId);
  return applySeed(pool, groupId, decisions, { signature });
}

dbTest('rowFilter hides filtered rows from export, diff and delete', async (t, pool) => {
  await pool.query(`INSERT INTO sx_filt (name, keep, val) VALUES ('sx_a', true, 1), ('sx_b', false, 2), ('sx_c', true, 3)`);
  await exportGroup(pool, 'sx_filt');
  const doc = readDoc('sx_filt');
  assert.deepStrictEqual(doc.tables.sx_filt.map((r) => r.name), ['sx_a', 'sx_c'], 'filtered row absent from the file');
  assert.deepStrictEqual(doc.header.row_counts, { sx_filt: 2 });
  const d0 = await diffGroup(pool, 'sx_filt');
  assert.strictEqual(d0.status, 'in_sync');
  assert.deepStrictEqual(d0.rows, [], 'the filtered row never shows as only_here');

  // Both rows removed from git; sx_a is now filtered out here, sx_c is not.
  doc.tables.sx_filt = [];
  writeDoc('sx_filt', doc);
  await pool.query("UPDATE sx_filt SET keep = false WHERE name = 'sx_a'");
  const p = await previewSeed(pool, 'sx_filt');
  assert.deepStrictEqual(p.rows.map((r) => [r.key, r.kind]), [['sx_c', 'deleted_in_git']]);
  const res = await apply(pool, 'sx_filt');
  assert.strictEqual(res.summary.deleted, 1);
  assert.deepStrictEqual((await all(pool, 'SELECT name, keep, val FROM sx_filt ORDER BY name')),
    [{ name: 'sx_a', keep: false, val: 1 }, { name: 'sx_b', keep: false, val: 2 }], 'filtered rows untouched');
});

dbTest('versioned take-git updates the active row in place, delete deactivates', async (t, pool) => {
  const u = (await one(pool, "INSERT INTO sx_ver (name, val, active) VALUES ('sx_x', 1, false) RETURNING sync_uuid")).sync_uuid;
  await pool.query("INSERT INTO sx_ver (name, val, active, sync_uuid) VALUES ('sx_x', 2, true, $1)", [u]);
  const history = await one(pool, 'SELECT * FROM sx_ver WHERE NOT active');
  await exportGroup(pool, 'sx_ver');
  const doc = readDoc('sx_ver');
  assert.deepStrictEqual(doc.tables.sx_ver, [{ name: 'sx_x', sync_uuid: u, val: 2 }], 'only the active version travels');
  assert.strictEqual((await diffGroup(pool, 'sx_ver')).status, 'in_sync');

  doc.tables.sx_ver[0].val = 3;
  doc.tables.sx_ver.push({ name: 'sx_y', sync_uuid: '00000000-0000-4000-8000-0000000000a1', val: 9 });
  writeDoc('sx_ver', doc);
  const p = await previewSeed(pool, 'sx_ver');
  assert.deepStrictEqual(p.rows.map((r) => [r.key, r.kind]), [['sx_x', 'changed'], ['sx_y', 'new']]);
  const r1 = await apply(pool, 'sx_ver');
  assert.deepStrictEqual(r1.summary, { updated: 1, created: 1, deleted: 0, kept: 0, adopted: 0 });
  const count = async (active) => Number((await one(pool, 'SELECT count(*) AS n FROM sx_ver WHERE active = $1', [active])).n);
  assert.strictEqual(await count(true), 2);
  assert.strictEqual(await count(false), 1);
  assert.strictEqual((await one(pool, "SELECT val FROM sx_ver WHERE name = 'sx_x' AND active")).val, 3, 'updated in place');
  assert.deepStrictEqual(await one(pool, 'SELECT * FROM sx_ver WHERE id = $1', [history.id]), history, 'history row unchanged');
  assert.strictEqual((await diffGroup(pool, 'sx_ver')).status, 'in_sync');

  // Deleted in git: the active row is deactivated, never deleted.
  doc.tables.sx_ver = doc.tables.sx_ver.filter((r) => r.name !== 'sx_x');
  writeDoc('sx_ver', doc);
  const p2 = await previewSeed(pool, 'sx_ver');
  assert.deepStrictEqual(p2.rows.map((r) => [r.key, r.kind, r.blockedReason]), [['sx_x', 'deleted_in_git', null]]);
  const r2 = await apply(pool, 'sx_ver');
  assert.strictEqual(r2.summary.deleted, 1);
  assert.strictEqual(await count(true), 1);
  assert.strictEqual(await count(false), 2);
  assert.strictEqual(Number((await one(pool, "SELECT count(*) AS n FROM sx_ver WHERE name = 'sx_x'")).n), 2, 'no row deleted');
  assert.deepStrictEqual(await one(pool, 'SELECT * FROM sx_ver WHERE id = $1', [history.id]), history, 'history row unchanged');
  assert.strictEqual((await diffGroup(pool, 'sx_ver')).status, 'in_sync');
});

dbTest('versioned new version on this PC keeps identity', async (t, pool) => {
  const u = (await one(pool, "INSERT INTO sx_ver (name, val) VALUES ('sx_x', 2) RETURNING sync_uuid")).sync_uuid;
  await exportGroup(pool, 'sx_ver');
  // A new local version (what the admin's "save" does: old row inactive, new
  // row inheriting the subject's uuid) while git changed the row too.
  await pool.query('UPDATE sx_ver SET active = false WHERE sync_uuid = $1 AND active', [u]);
  await pool.query("INSERT INTO sx_ver (name, val, sync_uuid) VALUES ('sx_x', 5, $1)", [u]);
  const doc = readDoc('sx_ver');
  doc.tables.sx_ver[0].val = 7;
  writeDoc('sx_ver', doc);
  const p = await previewSeed(pool, 'sx_ver');
  assert.deepStrictEqual(p.rows.map((r) => [r.key, r.syncUuid, r.kind, r.blockedReason]), [['sx_x', u, 'edited_here', null]]);
  assert.deepStrictEqual(p.rows[0].fields, [{ name: 'val', local: 5, git: 7 }]);
  await apply(pool, 'sx_ver', { [u]: 'git' });
  assert.deepStrictEqual(await all(pool, 'SELECT val, active FROM sx_ver ORDER BY id'),
    [{ val: 2, active: false }, { val: 7, active: true }]);
});

dbTest('slice exports only its columns and updates in place', async (t, pool) => {
  await pool.query(`INSERT INTO sx_own (name, val, art, art2) VALUES ('sx_a', 1, 'p', 'q'), ('sx_b', 2, 'r', 's')`);
  await exportGroup(pool, 'sx_own');
  assert.deepStrictEqual(Object.keys(readDoc('sx_own').tables.sx_own[0]).sort(), ['name', 'sync_uuid', 'val']);
  await exportGroup(pool, 'sx_art');
  const doc = readDoc('sx_art');
  assert.deepStrictEqual(Object.keys(doc.tables.sx_own[0]).sort(), ['art', 'art2', 'name', 'sync_uuid']);
  assert.deepStrictEqual(doc.tables.sx_own.map((r) => [r.name, r.art, r.art2]), [['sx_a', 'p', 'q'], ['sx_b', 'r', 's']]);
  const before = await all(pool, 'SELECT * FROM sx_own ORDER BY id');

  doc.tables.sx_own[0].art = 'p2';
  writeDoc('sx_art', doc);
  const p = await previewSeed(pool, 'sx_art');
  assert.deepStrictEqual(p.rows.map((r) => [r.key, r.kind, r.defaultDecision]), [['sx_a', 'changed', 'git']]);
  const res = await apply(pool, 'sx_art');
  assert.deepStrictEqual(res.summary, { updated: 1, created: 0, deleted: 0, kept: 0, adopted: 0 });
  const after = await all(pool, 'SELECT * FROM sx_own ORDER BY id');
  assert.deepStrictEqual(after, [{ ...before[0], art: 'p2' }, before[1]], 'only the sliced column changed');
  assert.strictEqual((await diffGroup(pool, 'sx_art')).status, 'in_sync');
  assert.strictEqual((await diffGroup(pool, 'sx_own')).status, 'in_sync', 'owner hashes exclude slice columns');
  const groupsOf = await all(pool,
    "SELECT group_id, count(*)::int AS n FROM seed_row_hashes WHERE group_id IN ('sx_own', 'sx_art') GROUP BY 1 ORDER BY 1");
  assert.deepStrictEqual(groupsOf, [{ group_id: 'sx_art', n: 2 }, { group_id: 'sx_own', n: 2 }]);
});

dbTest('slice git row missing locally is blocked owner_missing; delete decision on slice row refuses', async (t, pool) => {
  await pool.query(`INSERT INTO sx_own (name, val, art) VALUES ('sx_a', 1, 'p'), ('sx_c', 3, 'z')`);
  await exportGroup(pool, 'sx_art');
  const doc = readDoc('sx_art');
  const cUuid = doc.tables.sx_own.find((r) => r.name === 'sx_c').sync_uuid;
  doc.tables.sx_own = doc.tables.sx_own.filter((r) => r.name !== 'sx_c');
  // A git row whose owner row is not here: one with an unknown name, one whose
  // name matches a local row under another uuid (never adopted by a slice).
  const ghost = '00000000-0000-4000-8000-0000000000b1';
  const twin = '00000000-0000-4000-8000-0000000000b2';
  doc.tables.sx_own.push({ name: 'sx_ghost', sync_uuid: ghost, art: 'g', art2: null });
  writeDoc('sx_art', doc);
  await pool.query("INSERT INTO sx_own (name, val, art) VALUES ('sx_twin', 4, 'local')");
  doc.tables.sx_own.push({ name: 'sx_twin', sync_uuid: twin, art: 'git', art2: null });
  writeDoc('sx_art', doc);

  const p = await previewSeed(pool, 'sx_art');
  const byUuid = new Map(p.rows.map((r) => [r.syncUuid, r]));
  for (const u of [ghost, twin]) {
    const r = byUuid.get(u);
    assert.strictEqual(r.kind, 'new', r.key);
    assert.strictEqual(r.blockedReason, 'owner_missing', r.key);
    assert.strictEqual(r.blockedMessage, 'seed SX owner first', r.key);
    assert.strictEqual(r.defaultDecision, null, r.key);
    assert.deepStrictEqual(r.allowedDecisions, ['local'], r.key);
  }
  assert.ok(!p.rows.some((r) => r.kind === 'adopt_identity'));
  // The same-name local row stays a separate local row (no adopt).
  assert.deepStrictEqual(p.rows.filter((r) => r.key === 'sx_twin').map((r) => r.kind).sort(), ['new', 'only_here']);
  // sx_c left git: a slice never deletes, so it defaults to keep.
  assert.strictEqual(byUuid.get(cUuid).kind, 'deleted_in_git');
  assert.strictEqual(byUuid.get(cUuid).defaultDecision, 'local');
  assert.deepStrictEqual(byUuid.get(cUuid).allowedDecisions, ['local'], 'a slice row is keep-only');

  const { signature } = p;
  const base = { [ghost]: 'local', [twin]: 'local' };
  await assert.rejects(applySeed(pool, 'sx_art', { ...base, [cUuid]: 'delete' }, { signature }),
    (e) => e.code === 'invalid_decision' && e.details.uuids.includes(cUuid));
  const localTwin = (await one(pool, "SELECT sync_uuid FROM sx_own WHERE name = 'sx_twin'")).sync_uuid;
  await pool.query(`INSERT INTO sx_own (name) VALUES ('sx_only')`);
  const p2 = await previewSeed(pool, 'sx_art');
  const only = p2.rows.filter((r) => r.kind === 'only_here').map((r) => r.syncUuid).sort();
  assert.ok(only.includes(localTwin));
  for (const r of p2.rows.filter((x) => x.kind === 'only_here')) {
    assert.deepStrictEqual(r.allowedDecisions, ['local'], `${r.key}: no delete on a slice row`);
  }
  for (const u of only) {
    await assert.rejects(applySeed(pool, 'sx_art', { ...base, [u]: 'delete' }, { signature: p2.signature }),
      (e) => e.code === 'invalid_decision', u);
  }
  await assert.rejects(applySeed(pool, 'sx_art', { ...base, [ghost]: 'git' }, { signature: p2.signature }),
    (e) => e.code === 'owner_missing' && /seed SX owner first/.test(e.message));
  const before = await all(pool, 'SELECT * FROM sx_own ORDER BY id');
  await applySeed(pool, 'sx_art', base, { signature: p2.signature });
  assert.deepStrictEqual(await all(pool, 'SELECT * FROM sx_own ORDER BY id'), before, 'nothing inserted, deleted or adopted');
});

dbTest('SET NULL fk from excluded table does not block delete', async (t, pool, pub) => {
  const group = {
    id: 'sx_clips', label: 'SX clips',
    tables: [{
      table: 'audio_clips', naturalKey: ['storage_key'], rowFilter: "label LIKE 'sx\\_%'",
      omit: { id: 'local', created_at: 'local', sync_uuid: 'identity', provider_id: 'test group' },
      secretColumns: [], refs: {},
    }],
  };
  await _withTestGroups([group], async () => {
    const clip = await one(pub, `INSERT INTO audio_clips (kind, label, storage_key, bytes, duration_ms, source)
      VALUES ('sfx', 'sx_clip', 'sx/clip.ogg', 1, 1, 'seeded') RETURNING id, sync_uuid`);
    await exportGroup(pub, 'sx_clips');
    const doc = readDoc('sx_clips');
    assert.deepStrictEqual(doc.tables.audio_clips.map((r) => r.label), ['sx_clip'], 'only sx_ clips (rowFilter)');
    const job = await one(pub, `INSERT INTO audio_jobs (batch_id, subject_kind, subject_key, slot, clip_kind, drain_group, state, clip_id)
      VALUES (gen_random_uuid(), 'sx', 'sx_job', 'hit', 'sfx', 'sfx_retro', 'done', $1) RETURNING id`, [clip.id]);
    doc.tables.audio_clips = [];
    writeDoc('sx_clips', doc);
    const p = await previewSeed(pub, 'sx_clips');
    assert.deepStrictEqual(p.rows.map((r) => [r.syncUuid, r.kind, r.blockedReason, r.defaultDecision]),
      [[clip.sync_uuid, 'deleted_in_git', null, 'delete']]);
    await applySeed(pub, 'sx_clips', {}, { signature: p.signature });
    assert.strictEqual((await pub.query('SELECT 1 FROM audio_clips WHERE id = $1', [clip.id])).rowCount, 0);
    assert.strictEqual((await one(pub, 'SELECT clip_id FROM audio_jobs WHERE id = $1', [job.id])).clip_id, null);
  });
});

dbTest('SET NULL fk from a table NOT in EXCLUDED still blocks delete', async (t, pool) => {
  const row = await one(pool, "INSERT INTO sx_own (name, val) VALUES ('sx_a', 1) RETURNING id, sync_uuid");
  await exportGroup(pool, 'sx_own');
  await pool.query('INSERT INTO sx_ref (own_id) VALUES ($1)', [row.id]);
  const doc = readDoc('sx_own');
  doc.tables.sx_own = [];
  writeDoc('sx_own', doc);
  const p = await previewSeed(pool, 'sx_own');
  assert.deepStrictEqual(p.rows.map((r) => [r.kind, r.blockedReason, r.defaultDecision, r.allowedDecisions]),
    [['deleted_in_git', '1 rows in sx_ref reference this', 'local', ['local']]]);
  await assert.rejects(applySeed(pool, 'sx_own', { [row.sync_uuid]: 'delete' }, { signature: p.signature }),
    (e) => e.code === 'blocked');
  assert.strictEqual((await pool.query('SELECT 1 FROM sx_own WHERE id = $1', [row.id])).rowCount, 1);
});

test('coverage: art-omitted columns sit in exactly one slice; slice columns are omitted by the full spec', () => {
  const specs = [
    { table: 'a', naturalKey: ['name'], omit: { id: 'local', x: ART, y: ART, z: 'per-PC' } },
    { table: 'a', slice: true, columns: ['x', 'w'], naturalKey: ['name'] },
    { table: 'a', slice: true, columns: ['x', 'z'], naturalKey: ['name'] },
    { table: 'b', naturalKey: ['name'], omit: { id: 'local', q: ART } },
  ];
  assert.deepStrictEqual(coverageProblems(['a', 'b'], { specs, excluded: {}, pending: {} }), [
    'column a.w is in a slice but the full spec of a exports it',
    'column a.x is in 2 slices',
    'column a.y is omitted as art but in no slice',
    'column b.q is omitted as art but in no slice',
  ]);
  const ok = [
    { table: 'a', naturalKey: ['name'], omit: { id: 'local', x: ART, y: ART } },
    { table: 'a', slice: true, columns: ['x'], naturalKey: ['name'] },
    { table: 'a', slice: true, columns: ['y'], naturalKey: ['name'] },
  ];
  assert.deepStrictEqual(coverageProblems(['a'], { specs: ok, excluded: {}, pending: {} }), [], 'one full spec plus slices is fine');
  assert.deepStrictEqual(coverageProblems(['c'], { specs: [{ table: 'c', slice: true, columns: ['x'], naturalKey: ['k'] }], excluded: {}, pending: {} }),
    ['slices of c have no full spec']);
});
