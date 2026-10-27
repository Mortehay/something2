const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const { withSeedSyncLock, cleanupSx, makeTempSyncDir } = require('./helpers/seedSyncTest.js');

const DB_URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://user:password@localhost:15432/game_db';

// Baselines this file writes for uuids that may have no local sx_ row
// (cleanupSx only clears baselines of rows that still exist).
let extraBaselines = [];
// Users created for character fixtures; deleting them cascades to characters
// and character_quests.
let createdUsers = [];
// Run rows written by this file: every seed run above this id (seed_sync test
// files are serialized by one lock, so only this file seeds meanwhile), plus
// tracked export runs. A watermark also catches runs of an apply that
// unexpectedly succeeded inside assert.rejects.
let runWatermark = null;
let createdRuns = [];

function dbTest(name, body) {
  test(name, async (t) => {
    if (!process.env.TEST_DATABASE_URL) {
      const msg = 'TEST_DATABASE_URL not set -- skipping to avoid mutating a real database (seed_sync apply)';
      if (process.env.CI) assert.fail(msg);
      t.skip(msg);
      return;
    }
    const dir = makeTempSyncDir();
    const prev = process.env.SEED_SYNC_DIR;
    process.env.SEED_SYNC_DIR = dir;
    const pool = new Pool({ connectionString: DB_URL, max: 4, connectionTimeoutMillis: 3000 });
    t.after(async () => {
      if (prev === undefined) delete process.env.SEED_SYNC_DIR; else process.env.SEED_SYNC_DIR = prev;
      fs.rmSync(dir, { recursive: true, force: true });
      await pool.end().catch(() => {});
    });
    const dropExtra = async () => {
      if (createdUsers.length) await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [createdUsers]);
      createdUsers = [];
      if (extraBaselines.length) {
        await pool.query('DELETE FROM seed_row_hashes WHERE sync_uuid = ANY($1::uuid[])', [extraBaselines]);
      }
      extraBaselines = [];
      if (createdRuns.length) await pool.query('DELETE FROM seed_export_runs WHERE id = ANY($1::int[])', [createdRuns]);
      createdRuns = [];
      if (runWatermark !== null) {
        await pool.query("DELETE FROM seed_export_runs WHERE action = 'seed' AND id > $1", [runWatermark]);
      }
    };
    await withSeedSyncLock(pool, async () => {
      await dropExtra();
      await cleanupSx(pool);
      runWatermark = (await pool.query('SELECT coalesce(max(id), 0)::int AS m FROM seed_export_runs')).rows[0].m;
      try { await body(t, pool, dir); } finally {
        await dropExtra().catch(() => {});
        await cleanupSx(pool).catch(() => {});
      }
    });
  });
}

const { previewSeed, applySeed } = require('../src/services/seedSync/applySeed.js');
const { diffGroup } = require('../src/services/seedSync/diffGroup.js');
const { exportGroup, fileFor } = require('../src/services/seedSync/exportGroup.js');
const { SyncRefused } = require('../src/services/seedSync/errors.js');
const { canonicalRow, rowHash, stableStringify } = require('../src/services/seedSync/canonical.js');
const { getGroup, tableSpecs, liveColumns } = require('../src/services/seedSync/registry.js');
const { buildRefMaps, exportRow, exportColumns } = require('../src/services/seedSync/refs.js');
const { recentRuns } = require('../src/services/seedSync/runs.js');

const addQuest = (pool, key, title = 'sx t') => pool.query(
  "INSERT INTO quests (key, title, act, description) VALUES ($1, $2, 1, 'sx d')", [key, title]);

// The one table of a Plan-1 group (tile_types has a ref since plan 2, so not
// soleSpec).
const onlySpec = (groupId) => {
  const specs = tableSpecs(getGroup(groupId));
  assert.strictEqual(specs.length, 1, groupId);
  return specs[0];
};

// Canonical form of every local row of a group, exactly as export writes it
// (refs translated).
async function snapAll(pool, groupId) {
  const g = onlySpec(groupId);
  const cols = exportColumns(await liveColumns(pool, g), g);
  const maps = await buildRefMaps(pool, g);
  const { rows } = await pool.query(`SELECT * FROM ${g.table}`);
  return rows.map((r) => canonicalRow(exportRow(r, g, maps), cols));
}

async function snap(pool, groupId, key) {
  const g = onlySpec(groupId);
  return (await snapAll(pool, groupId)).find((r) => r[g.naturalKey[0]] === key);
}

async function setBaseline(pool, groupId, row) {
  await pool.query(
    `INSERT INTO seed_row_hashes (group_id, sync_uuid, hash) VALUES ($1, $2, $3)
     ON CONFLICT (group_id, sync_uuid) DO UPDATE SET hash = EXCLUDED.hash`,
    [groupId, row.sync_uuid, rowHash(row)]);
  extraBaselines.push(row.sync_uuid);
}

async function baselineOf(pool, groupId, uuid) {
  const { rows } = await pool.query(
    'SELECT hash FROM seed_row_hashes WHERE group_id = $1 AND sync_uuid = $2', [groupId, uuid]);
  return rows[0] ? rows[0].hash : null;
}

function writeGit(groupId, rows, { schemaVersion = '' } = {}) {
  const doc = {
    header: { group: groupId, exported_at: '2026-10-18T00:00:00.000Z', exported_by: 'sx-pc', schema_version: schemaVersion, row_count: rows.length },
    rows,
  };
  fs.writeFileSync(fileFor(groupId), `${stableStringify(doc)}\n`);
}

// The git file = the whole local table (so non-sx rows are in sync) with the
// sx_ rows replaced by `sxRows` (local sx_ rows not listed are absent in git).
async function writeGitWith(pool, groupId, sxRows, opts) {
  const g = onlySpec(groupId);
  const others = (await snapAll(pool, groupId)).filter((r) => !String(r[g.naturalKey[0]]).startsWith('sx_'));
  writeGit(groupId, [...others, ...sxRows], opts);
  extraBaselines.push(...sxRows.map((r) => r.sync_uuid));
}

const sxRows = (diff) => diff.rows.filter((r) => String(r.key).startsWith('sx_'));
const byKey = (diff, key) => diff.rows.find((r) => r.key === key);

// Guard: never let a test apply over non-sx rows of the shared scratch table.
async function onlySxListed(pool, groupId) {
  const d = await previewSeed(pool, groupId);
  const foreign = d.rows.filter((r) => !String(r.key).startsWith('sx_'));
  assert.deepStrictEqual(foreign, [], 'fixture must only list sx_ rows');
  return d;
}

// The real client contract: preview, then post the decisions with the
// preview's signature. Without an explicit signature, a fresh preview's.
const sigOf = async (pool, groupId) => (await previewSeed(pool, groupId)).signature;
async function applyNow(pool, groupId, decisions, signature) {
  return applySeed(pool, groupId, decisions, { signature: signature ?? await sigOf(pool, groupId) });
}
// The FULL decision map the UI posts: every row with a default.
const defaultsOf = (preview) => Object.fromEntries(
  preview.rows.filter((r) => r.defaultDecision != null).map((r) => [r.syncUuid, r.defaultDecision]));

async function apply(pool, groupId, decisions, signature) {
  const res = await applyNow(pool, groupId, decisions, signature);
  createdRuns.push(res.runId);
  return res;
}

const refused = (code, uuids) => (e) => {
  assert.ok(e instanceof SyncRefused, `expected SyncRefused, got ${e && e.stack}`);
  assert.strictEqual(e.code, code);
  if (uuids) assert.deepStrictEqual([...e.details.uuids].sort(), [...uuids].sort());
  return true;
};

async function questState(pool) {
  const { rows } = await pool.query(
    "SELECT key, title, sync_uuid FROM quests WHERE key LIKE 'sx\\_%' ORDER BY key, sync_uuid");
  return rows;
}

async function baselineState(pool, uuids) {
  const { rows } = await pool.query(
    'SELECT group_id, sync_uuid, hash FROM seed_row_hashes WHERE sync_uuid = ANY($1::uuid[]) ORDER BY sync_uuid',
    [uuids]);
  return rows;
}

async function seedRunCount(pool) {
  return (await pool.query("SELECT count(*)::int AS n FROM seed_export_runs WHERE action = 'seed'")).rows[0].n;
}

async function createCharacter(pool) {
  const tag = `sx_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const u = await pool.query(
    "INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'player') RETURNING id", [tag]);
  createdUsers.push(u.rows[0].id);
  const c = await pool.query(
    `INSERT INTO characters (user_id, slot, name, entity_type_id)
     SELECT $1, 1, $2, e.id FROM entity_types e WHERE e.name = 'Warrior' RETURNING id`,
    [u.rows[0].id, tag]);
  return c.rows[0].id;
}

// ---------------------------------------------------------------- brief tests

dbTest('apply writes chosen rows only', async (t, pool) => {
  await addQuest(pool, 'sx_a');
  await addQuest(pool, 'sx_b');
  const a = await snap(pool, 'quests', 'sx_a');
  const b = await snap(pool, 'quests', 'sx_b');
  await setBaseline(pool, 'quests', a);
  await setBaseline(pool, 'quests', b);
  const gitA = { ...a, title: 'sx git a' };
  const gitB = { ...b, title: 'sx git b' };
  await writeGitWith(pool, 'quests', [gitA, gitB]);
  await pool.query("UPDATE quests SET title = 'sx local b' WHERE key = 'sx_b'");
  const d = await onlySxListed(pool, 'quests');
  assert.strictEqual(byKey(d, 'sx_a').kind, 'changed');
  assert.strictEqual(byKey(d, 'sx_b').kind, 'edited_here');

  const res = await apply(pool, 'quests', { [b.sync_uuid]: 'local' });
  assert.deepStrictEqual(res.summary, { updated: 1, created: 0, deleted: 0, kept: 1, adopted: 0 });
  const st = await questState(pool);
  assert.strictEqual(st.find((r) => r.key === 'sx_a').title, 'sx git a');
  assert.strictEqual(st.find((r) => r.key === 'sx_b').title, 'sx local b');
  assert.strictEqual(await baselineOf(pool, 'quests', a.sync_uuid), rowHash(gitA));
  // 'local' acknowledges git's version: B = hG, so the row is now exportable.
  assert.strictEqual(await baselineOf(pool, 'quests', b.sync_uuid), rowHash(gitB));
  const after = await previewSeed(pool, 'quests');
  assert.deepStrictEqual(sxRows(after).map((r) => [r.key, r.kind]), [['sx_b', 'not_exported']]);
});

dbTest('undecided red row refuses', async (t, pool) => {
  await addQuest(pool, 'sx_a');
  const a = await snap(pool, 'quests', 'sx_a');
  await writeGitWith(pool, 'quests', [{ ...a, title: 'sx git' }]); // no baseline: edited_here
  assert.strictEqual(byKey(await onlySxListed(pool, 'quests'), 'sx_a').kind, 'edited_here');
  const runs = await seedRunCount(pool);
  await assert.rejects(applyNow(pool, 'quests', {}), refused('undecided', [a.sync_uuid]));
  assert.strictEqual((await questState(pool))[0].title, 'sx t');
  assert.strictEqual(await baselineOf(pool, 'quests', a.sync_uuid), null);
  assert.strictEqual(await seedRunCount(pool), runs, 'a refusal records no run');
});

dbTest('undecided divergent adopt_identity refuses', async (t, pool) => {
  await addQuest(pool, 'sx_a');
  const a = await snap(pool, 'quests', 'sx_a');
  const gitUuid = crypto.randomUUID();
  await writeGitWith(pool, 'quests', [{ ...a, sync_uuid: gitUuid, title: 'sx git' }]);
  const r = byKey(await onlySxListed(pool, 'quests'), 'sx_a');
  assert.strictEqual(r.kind, 'adopt_identity');
  assert.strictEqual(r.defaultDecision, null);
  await assert.rejects(applyNow(pool, 'quests', {}), refused('undecided', [gitUuid]));
  assert.deepStrictEqual((await questState(pool)).map((x) => [x.title, x.sync_uuid]), [['sx t', a.sync_uuid]]);
});

dbTest('delete blocked by character_quests', async (t, pool) => {
  await addQuest(pool, 'sx_q');
  const q = await snap(pool, 'quests', 'sx_q');
  await setBaseline(pool, 'quests', q);
  await writeGitWith(pool, 'quests', []); // sx_q unchanged here, gone in git
  const charId = await createCharacter(pool);
  await pool.query(
    "INSERT INTO character_quests (character_id, quest_id) SELECT $1, id FROM quests WHERE key = 'sx_q'", [charId]);

  const r = byKey(await onlySxListed(pool, 'quests'), 'sx_q');
  assert.strictEqual(r.kind, 'deleted_in_git');
  assert.match(r.blockedReason, /character_quests/);
  assert.strictEqual(r.blockedReason, '1 rows in character_quests reference this');
  // The plain diff does not compute blocking; only the preview does.
  const plain = byKey(await diffGroup(pool, 'quests'), 'sx_q');
  assert.strictEqual(plain.blockedReason, null);
  assert.strictEqual(plain.defaultDecision, 'delete');
  // A blocked deleted_in_git defaults to keep.
  assert.strictEqual(r.defaultDecision, 'local');

  await assert.rejects(applyNow(pool, 'quests', { [q.sync_uuid]: 'delete' }), refused('blocked', [q.sync_uuid]));
  assert.strictEqual((await questState(pool)).length, 1, 'quest still exists');
  const cq = await pool.query('SELECT 1 FROM character_quests WHERE character_id = $1', [charId]);
  assert.strictEqual(cq.rowCount, 1, 'player data untouched');

  // Default (no decision) keeps it; 'local' on deleted_in_git drops its B.
  const res = await apply(pool, 'quests', {});
  assert.deepStrictEqual(res.summary, { updated: 0, created: 0, deleted: 0, kept: 1, adopted: 0 });
  assert.strictEqual((await questState(pool)).length, 1);
  assert.strictEqual(await baselineOf(pool, 'quests', q.sync_uuid), null);
  const again = byKey(await previewSeed(pool, 'quests'), 'sx_q');
  assert.strictEqual(again.kind, 'only_here');
  assert.strictEqual(again.defaultDecision, 'local');
  assert.strictEqual((await pool.query('SELECT 1 FROM character_quests WHERE character_id = $1', [charId])).rowCount, 1);
});

dbTest('preview blocks only deletable kinds; unreferenced delete goes through', async (t, pool) => {
  await addQuest(pool, 'sx_changed');
  await addQuest(pool, 'sx_only');
  const c = await snap(pool, 'quests', 'sx_changed');
  await setBaseline(pool, 'quests', c);
  await writeGitWith(pool, 'quests', [{ ...c, title: 'sx git' }]);
  const charId = await createCharacter(pool);
  await pool.query(
    "INSERT INTO character_quests (character_id, quest_id) SELECT $1, id FROM quests WHERE key = 'sx_changed'", [charId]);
  const d = await onlySxListed(pool, 'quests');
  assert.strictEqual(byKey(d, 'sx_changed').kind, 'changed');
  assert.strictEqual(byKey(d, 'sx_changed').blockedReason, null, 'a changed row cannot be deleted');
  const only = byKey(d, 'sx_only');
  assert.strictEqual(only.kind, 'only_here');
  assert.strictEqual(only.blockedReason, null);

  const res = await apply(pool, 'quests', { [only.syncUuid]: 'delete' });
  assert.deepStrictEqual(res.summary, { updated: 1, created: 0, deleted: 1, kept: 0, adopted: 0 });
  assert.deepStrictEqual((await questState(pool)).map((x) => x.key), ['sx_changed']);
  assert.strictEqual(await baselineOf(pool, 'quests', only.syncUuid), null);
  const cq = await pool.query('SELECT 1 FROM character_quests WHERE character_id = $1', [charId]);
  assert.strictEqual(cq.rowCount, 1, 'updating a referenced quest keeps player data');
});

dbTest('new ai_provider from git arrives with NULL token; existing keeps its token', async (t, pool) => {
  await pool.query(
    "INSERT INTO ai_providers (name, base_url, request_template, auth_token) VALUES ('sx_p1', 'http://x', '{\"a\":1}', 'sx-secret')");
  const p1 = await snap(pool, 'ai_providers', 'sx_p1');
  await setBaseline(pool, 'ai_providers', p1);
  const p2 = {
    ...p1, sync_uuid: crypto.randomUUID(), name: 'sx_p2', base_url: 'http://y',
    request_template: { z: { b: 2, a: 1 } }, auth_token: 'sx-injected',
  };
  await writeGitWith(pool, 'ai_providers', [{ ...p1, model: 'sx-m' }, p2]);
  const d = await onlySxListed(pool, 'ai_providers');
  assert.strictEqual(byKey(d, 'sx_p1').kind, 'changed');
  assert.strictEqual(byKey(d, 'sx_p2').kind, 'new');

  const res = await apply(pool, 'ai_providers', {});
  assert.deepStrictEqual(res.summary, { updated: 1, created: 1, deleted: 0, kept: 0, adopted: 0 });
  const { rows } = await pool.query(
    "SELECT name, model, auth_token, request_template, sync_uuid FROM ai_providers WHERE name LIKE 'sx\\_%' ORDER BY name");
  assert.deepStrictEqual(rows.map((r) => [r.name, r.auth_token]), [['sx_p1', 'sx-secret'], ['sx_p2', null]]);
  assert.strictEqual(rows[0].model, 'sx-m');
  assert.deepStrictEqual(rows[1].request_template, { z: { a: 1, b: 2 } });
  assert.strictEqual(rows[1].sync_uuid, p2.sync_uuid);
  assert.deepStrictEqual(sxRows(await previewSeed(pool, 'ai_providers')), []);
});

dbTest('schema_newer refuses', async (t, pool) => {
  await addQuest(pool, 'sx_a');
  const a = await snap(pool, 'quests', 'sx_a');
  await setBaseline(pool, 'quests', a);
  await writeGitWith(pool, 'quests', [{ ...a, title: 'sx git' }], { schemaVersion: '9999999999999_from_the_future' });
  const runs = await seedRunCount(pool);
  await assert.rejects(applyNow(pool, 'quests', {}), refused('schema_newer'));
  assert.strictEqual((await questState(pool))[0].title, 'sx t');
  assert.strictEqual(await seedRunCount(pool), runs);
});

dbTest('no export file refuses with no_export', async (t, pool) => {
  await assert.rejects(applyNow(pool, 'quests', {}), refused('no_export'));
});

dbTest('adopt_identity rewrites sync_uuid', async (t, pool) => {
  await addQuest(pool, 'sx_a');
  await addQuest(pool, 'sx_b');
  const a = await snap(pool, 'quests', 'sx_a');
  const b = await snap(pool, 'quests', 'sx_b');
  const ids = (await pool.query("SELECT key, id FROM quests WHERE key LIKE 'sx\\_%' ORDER BY key")).rows;
  const gitA = { ...a, sync_uuid: crypto.randomUUID() };
  const gitB = { ...b, sync_uuid: crypto.randomUUID(), title: 'sx git b' };
  await writeGitWith(pool, 'quests', [gitA, gitB]);
  const d = await onlySxListed(pool, 'quests');
  assert.deepStrictEqual(sxRows(d).map((r) => [r.key, r.kind, r.defaultDecision]),
    [['sx_a', 'adopt_identity', 'git'], ['sx_b', 'adopt_identity', null]]);

  const res = await apply(pool, 'quests', { [gitB.sync_uuid]: 'git' });
  assert.deepStrictEqual(res.summary, { updated: 0, created: 0, deleted: 0, kept: 0, adopted: 2 });
  const after = (await pool.query("SELECT key, id, title, sync_uuid FROM quests WHERE key LIKE 'sx\\_%' ORDER BY key")).rows;
  assert.deepStrictEqual(after.map((r) => [r.key, r.id, r.title, r.sync_uuid]), [
    ['sx_a', ids[0].id, 'sx t', gitA.sync_uuid],
    ['sx_b', ids[1].id, 'sx git b', gitB.sync_uuid],
  ]);
  assert.strictEqual(await baselineOf(pool, 'quests', gitA.sync_uuid), rowHash(gitA));
  assert.strictEqual(await baselineOf(pool, 'quests', gitB.sync_uuid), rowHash(gitB));
});

dbTest('after apply, re-diff shows in_sync for applied rows', async (t, pool) => {
  const ins = (name, speed, json) => pool.query(
    "INSERT INTO tile_types (name, color, speed, valid_neighbors) VALUES ($1, '#123456', $2, $3)", [name, speed, json]);
  await ins('sx_changed', 0.75, '[{"z":1,"a":{"y":2,"b":3}}]');
  await ins('sx_adopt', 0.5, '["grass"]');
  await ins('sx_gone', 0.25, '[]');
  await ins('sx_same', 1, '[]');
  await ins('sx_reinsert', 0.3, '[]');
  const changed = await snap(pool, 'tile_types', 'sx_changed');
  const adopt = await snap(pool, 'tile_types', 'sx_adopt');
  const gone = await snap(pool, 'tile_types', 'sx_gone');
  const same = await snap(pool, 'tile_types', 'sx_same');
  const reinsert = await snap(pool, 'tile_types', 'sx_reinsert');
  for (const r of [changed, gone, reinsert]) await setBaseline(pool, 'tile_types', r);
  await pool.query("DELETE FROM tile_types WHERE name = 'sx_reinsert'");
  extraBaselines.push(same.sync_uuid);
  const gitRows = [
    { ...changed, speed: 0.125, valid_neighbors: [{ q: { d: 4, c: 3 } }, 'sand'] },
    { ...adopt, sync_uuid: crypto.randomUUID() },
    { ...same },
    { ...reinsert },
    { ...same, sync_uuid: crypto.randomUUID(), name: 'sx_new', speed: 2.5 },
  ];
  await writeGitWith(pool, 'tile_types', gitRows);
  const d = await onlySxListed(pool, 'tile_types');
  assert.deepStrictEqual(sxRows(d).map((r) => [r.key, r.kind]), [
    ['sx_adopt', 'adopt_identity'], ['sx_changed', 'changed'], ['sx_gone', 'deleted_in_git'],
    ['sx_new', 'new'], ['sx_reinsert', 'deleted_here'],
  ]);
  assert.strictEqual(await baselineOf(pool, 'tile_types', same.sync_uuid), null);

  const res = await apply(pool, 'tile_types', { [reinsert.sync_uuid]: 'git' });
  assert.deepStrictEqual(res.summary, { updated: 1, created: 2, deleted: 1, kept: 0, adopted: 1 });
  assert.deepStrictEqual(sxRows(await previewSeed(pool, 'tile_types')), []);
  assert.deepStrictEqual(sxRows(await diffGroup(pool, 'tile_types')), []);
  // in sync with no B: the first sync establishes B = hL
  assert.strictEqual(await baselineOf(pool, 'tile_types', same.sync_uuid), rowHash(same));
  assert.strictEqual(await baselineOf(pool, 'tile_types', gone.sync_uuid), null);
  // B equals what export would write right now
  for (const r of await snapAll(pool, 'tile_types')) {
    if (!r.name.startsWith('sx_')) continue;
    assert.strictEqual(await baselineOf(pool, 'tile_types', r.sync_uuid), rowHash(r), r.name);
  }
});

dbTest('git row whose natural key a kept local row holds is blocked: conflict', async (t, pool) => {
  await addQuest(pool, 'sx_a');
  await addQuest(pool, 'sx_b');
  const a = await snap(pool, 'quests', 'sx_a');
  const b = await snap(pool, 'quests', 'sx_b');
  await setBaseline(pool, 'quests', a);
  await setBaseline(pool, 'quests', b);
  // sx_b has a baseline (no adopt) and is gone in git; git adds a NEW row with
  // natural key sx_b. Unless the local sx_b is deleted, inserting it would hit
  // quests_key_key.
  const clash = { ...b, sync_uuid: crypto.randomUUID(), title: 'sx clash' };
  await writeGitWith(pool, 'quests', [{ ...a, title: 'sx git a' }, clash]);
  const d = await onlySxListed(pool, 'quests');
  const row = d.rows.find((r) => r.syncUuid === clash.sync_uuid);
  assert.strictEqual(row.kind, 'new');
  // The local holder's default is delete, so by default there is no clash.
  assert.strictEqual(row.blockedReason, null);
  assert.strictEqual(row.defaultDecision, 'git');
  assert.strictEqual(d.rows.find((r) => r.syncUuid === b.sync_uuid).kind, 'deleted_in_git');

  // Keeping the local holder: the git row is blocked (preview needs it kept
  // too; simulate with only_here by editing the holder locally).
  await pool.query("UPDATE quests SET title = 'sx kept b' WHERE key = 'sx_b'");
  const d2 = await onlySxListed(pool, 'quests');
  assert.strictEqual(d2.rows.find((r) => r.syncUuid === b.sync_uuid).kind, 'only_here');
  const row2 = d2.rows.find((r) => r.syncUuid === clash.sync_uuid);
  assert.strictEqual(row2.blockedReason, 'key already used by a local row');
  assert.strictEqual(row2.defaultDecision, null, 'a key clash is red: explicit decision required');

  const uuids = [a.sync_uuid, b.sync_uuid, clash.sync_uuid];
  const beforeQ = await questState(pool);
  const beforeB = await baselineState(pool, uuids);
  const runs = await seedRunCount(pool);
  await assert.rejects(applyNow(pool, 'quests', {}), refused('undecided', [clash.sync_uuid]));
  await assert.rejects(applyNow(pool, 'quests', { [clash.sync_uuid]: 'git' }), refused('conflict', [clash.sync_uuid]));
  await assert.rejects(applyNow(pool, 'quests', { [clash.sync_uuid]: 'git', [b.sync_uuid]: 'local' }),
    refused('conflict', [clash.sync_uuid]));
  assert.deepStrictEqual(await questState(pool), beforeQ);
  assert.deepStrictEqual(await baselineState(pool, uuids), beforeB);
  assert.strictEqual(await seedRunCount(pool), runs, 'a refusal records no run');

  // Explicit 'local' acknowledges git's row: B = hG, next diff deleted_here
  // (still a clash while the holder stays, so still red).
  const kept = await apply(pool, 'quests', { [clash.sync_uuid]: 'local' });
  assert.deepStrictEqual(kept.summary, { updated: 1, created: 0, deleted: 0, kept: 2, adopted: 0 });
  assert.strictEqual(await baselineOf(pool, 'quests', clash.sync_uuid), rowHash(clash));
  const d3 = await onlySxListed(pool, 'quests');
  const row3 = d3.rows.find((r) => r.syncUuid === clash.sync_uuid);
  assert.deepStrictEqual([row3.kind, row3.blockedReason, row3.defaultDecision],
    ['deleted_here', 'key already used by a local row', null]);

  // Deleting the holder in the same seed frees the key: explicit git inserts.
  const res = await apply(pool, 'quests', { [b.sync_uuid]: 'delete', [clash.sync_uuid]: 'git' });
  assert.deepStrictEqual(res.summary, { updated: 0, created: 1, deleted: 1, kept: 0, adopted: 0 });
  assert.deepStrictEqual((await questState(pool)).map((r) => [r.key, r.title, r.sync_uuid]),
    [['sx_a', 'sx git a', a.sync_uuid], ['sx_b', 'sx clash', clash.sync_uuid]]);
});

// Wrap pool.connect so the checked-out client fails a chosen statement and/or
// its ROLLBACK, and record what release() was called with. pg-pool's own
// query() calls connect(cb): that path is passed through untouched.
function instrumentConnect(t, pool, { failOn = null, failRollback = false } = {}) {
  const orig = pool.connect.bind(pool);
  const released = [];
  t.mock.method(pool, 'connect', (cb) => {
    if (typeof cb === 'function') return orig(cb);
    return orig().then((c) => {
      const q = c.query;
      const rel = c.release;
      c.query = function query(...args) {
        const sql = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].text) || '';
        if (failOn && failOn.test(sql)) return Promise.reject(new Error('sx injected failure'));
        if (failRollback && sql === 'ROLLBACK') {
          return q.apply(c, args).then(() => { throw new Error('sx rollback failed'); });
        }
        return q.apply(c, args);
      };
      c.release = function release(...args) {
        c.query = q;
        c.release = rel;
        released.push(args[0]);
        return rel.apply(c, args);
      };
      return c;
    });
  });
  return released;
}

dbTest('failure mid-apply rolls back everything', async (t, pool) => {
  await addQuest(pool, 'sx_a');
  const a = await snap(pool, 'quests', 'sx_a');
  await setBaseline(pool, 'quests', a);
  const gitNew = { ...a, sync_uuid: crypto.randomUUID(), key: 'sx_z', title: 'sx new' };
  await writeGitWith(pool, 'quests', [{ ...a, title: 'sx git a' }, gitNew]);
  await onlySxListed(pool, 'quests');
  const uuids = [a.sync_uuid, gitNew.sync_uuid];
  const beforeQ = await questState(pool);
  const beforeB = await baselineState(pool, uuids);

  // The row writes succeed; the first baseline write fails after them.
  const signature = await sigOf(pool, 'quests');
  const released = instrumentConnect(t, pool, { failOn: /INSERT INTO seed_row_hashes/ });
  try {
    await assert.rejects(applySeed(pool, 'quests', {}, { signature }), (e) => e.message === 'sx injected failure');
  } finally {
    t.mock.restoreAll();
  }
  assert.deepStrictEqual(released, [undefined], 'a clean ROLLBACK returns the client to the pool');
  assert.deepStrictEqual(await questState(pool), beforeQ);
  assert.deepStrictEqual(await baselineState(pool, uuids), beforeB);
  const run = (await recentRuns(pool, { groupId: 'quests', limit: 1 })).runs[0];
  assert.strictEqual(run.action, 'seed');
  assert.strictEqual(run.status, 'failed');
  assert.strictEqual(run.error, 'sx injected failure');
  assert.ok(run.finished_at);
});

dbTest('a failed ROLLBACK destroys the client (apply and export)', async (t, pool) => {
  await addQuest(pool, 'sx_a');
  const a = await snap(pool, 'quests', 'sx_a');
  await setBaseline(pool, 'quests', a);
  await writeGitWith(pool, 'quests', [{ ...a, title: 'sx git a' }]);
  const signature = await sigOf(pool, 'quests');
  let released = instrumentConnect(t, pool, { failOn: /INSERT INTO seed_row_hashes/, failRollback: true });
  try {
    await assert.rejects(applySeed(pool, 'quests', {}, { signature }), (e) => e.message === 'sx injected failure');
  } finally {
    t.mock.restoreAll();
  }
  assert.strictEqual(released.length, 1);
  assert.ok(released[0] instanceof Error && released[0].message === 'sx rollback failed', 'release(err)');

  await writeGitWith(pool, 'quests', [a]);
  released = instrumentConnect(t, pool, { failOn: /INSERT INTO seed_row_hashes/, failRollback: true });
  try {
    await assert.rejects(exportGroup(pool, 'quests'), (e) => e.message === 'sx injected failure');
  } finally {
    t.mock.restoreAll();
  }
  assert.ok(released[0] instanceof Error && released[0].message === 'sx rollback failed', 'export release(err)');
  createdRuns.push((await recentRuns(pool, { groupId: 'quests', limit: 1 })).runs[0].id);
  assert.strictEqual((await questState(pool))[0].title, 'sx t');
});

dbTest('a git row may take the natural key of a row deleted in the same seed', async (t, pool) => {
  await addQuest(pool, 'sx_b');
  const b = await snap(pool, 'quests', 'sx_b');
  await setBaseline(pool, 'quests', b);
  const clash = { ...b, sync_uuid: crypto.randomUUID(), title: 'sx replacement' };
  await writeGitWith(pool, 'quests', [clash]);
  await onlySxListed(pool, 'quests');
  const res = await apply(pool, 'quests', {}); // defaults: delete old, create new
  assert.deepStrictEqual(res.summary, { updated: 0, created: 1, deleted: 1, kept: 0, adopted: 0 });
  assert.deepStrictEqual((await questState(pool)).map((r) => [r.title, r.sync_uuid]), [['sx replacement', clash.sync_uuid]]);
  assert.strictEqual(await baselineOf(pool, 'quests', b.sync_uuid), null);
  assert.deepStrictEqual(sxRows(await previewSeed(pool, 'quests')), []);
});

// ---------------------------------------------------------- controller rulings

dbTest('invalid decision for the row kind refuses', async (t, pool) => {
  await addQuest(pool, 'sx_a');
  await addQuest(pool, 'sx_o');
  const a = await snap(pool, 'quests', 'sx_a');
  const o = await snap(pool, 'quests', 'sx_o');
  await setBaseline(pool, 'quests', a);
  await writeGitWith(pool, 'quests', [{ ...a, title: 'sx git' }]);
  await assert.rejects(applyNow(pool, 'quests', { [a.sync_uuid]: 'delete' }), refused('invalid_decision', [a.sync_uuid]));
  await assert.rejects(applyNow(pool, 'quests', { [o.sync_uuid]: 'git' }), refused('invalid_decision', [o.sync_uuid]));
  await assert.rejects(applyNow(pool, 'quests', { [a.sync_uuid]: 'bogus' }), refused('invalid_decision', [a.sync_uuid]));
  assert.deepStrictEqual((await questState(pool)).map((r) => r.title), ['sx t', 'sx t']);
});

dbTest('decision for a uuid not in the diff refuses stale_preview', async (t, pool) => {
  await addQuest(pool, 'sx_a');
  const a = await snap(pool, 'quests', 'sx_a');
  await setBaseline(pool, 'quests', a);
  await writeGitWith(pool, 'quests', [{ ...a, title: 'sx git' }]);
  const ghost = crypto.randomUUID();
  await assert.rejects(applyNow(pool, 'quests', { [ghost]: 'git' }), refused('stale_preview', [ghost]));
  assert.strictEqual((await questState(pool))[0].title, 'sx t');
});

dbTest('apply recomputes the diff: a row edited after the preview refuses stale_preview', async (t, pool) => {
  await addQuest(pool, 'sx_a');
  const a = await snap(pool, 'quests', 'sx_a');
  await setBaseline(pool, 'quests', a);
  await writeGitWith(pool, 'quests', [{ ...a, title: 'sx git' }]);
  const preview = await onlySxListed(pool, 'quests');
  assert.strictEqual(byKey(preview, 'sx_a').kind, 'changed');
  const decisions = defaultsOf(preview);
  assert.strictEqual(decisions[a.sync_uuid], 'git', 'the UI posts the full default map');
  // Someone edits the row between preview and apply: it is now edited_here.
  await pool.query("UPDATE quests SET title = 'sx late edit' WHERE key = 'sx_a'");
  // The preview's 'git' (sent explicitly, as the UI does) is allowed for
  // edited_here too, so only the signature stops it overwriting the edit.
  const runs = await seedRunCount(pool);
  await assert.rejects(applySeed(pool, 'quests', decisions, { signature: preview.signature }), refused('stale_preview'));
  assert.strictEqual((await questState(pool))[0].title, 'sx late edit');
  assert.strictEqual(await baselineOf(pool, 'quests', a.sync_uuid), rowHash(a), 'baseline untouched');
  assert.strictEqual(await seedRunCount(pool), runs, 'a refusal records no run');
});

// The signature covers each row's current local and git VALUES, not just its
// kind: a second edit keeps the row edited_here with the same default and
// reason, and 'git' would silently overwrite a value the admin never saw.
dbTest('a row edited again after the preview (same kind) refuses stale_preview', async (t, pool) => {
  await addQuest(pool, 'sx_a');
  const a = await snap(pool, 'quests', 'sx_a');
  await setBaseline(pool, 'quests', a);
  await writeGitWith(pool, 'quests', [{ ...a, title: 'sx git' }]);
  await pool.query("UPDATE quests SET title = 'sx local 1' WHERE key = 'sx_a'");
  const preview = await onlySxListed(pool, 'quests');
  assert.strictEqual(byKey(preview, 'sx_a').kind, 'edited_here');
  await pool.query("UPDATE quests SET title = 'sx local 2' WHERE key = 'sx_a'");
  const again = byKey(await previewSeed(pool, 'quests'), 'sx_a');
  assert.deepStrictEqual([again.kind, again.defaultDecision, again.blockedReason], ['edited_here', null, null]);
  const runs = await seedRunCount(pool);
  await assert.rejects(applySeed(pool, 'quests', { [a.sync_uuid]: 'git' }, { signature: preview.signature }),
    refused('stale_preview'));
  assert.strictEqual((await questState(pool))[0].title, 'sx local 2', 'newest local value kept');
  assert.strictEqual(await baselineOf(pool, 'quests', a.sync_uuid), rowHash(a), 'baseline untouched');
  assert.strictEqual(await seedRunCount(pool), runs, 'a refusal records no run');
});

dbTest('a git value changed after the preview (same kind, same exported_at) refuses stale_preview', async (t, pool) => {
  await addQuest(pool, 'sx_a');
  const a = await snap(pool, 'quests', 'sx_a');
  await setBaseline(pool, 'quests', a);
  await writeGitWith(pool, 'quests', [{ ...a, title: 'sx git 1' }]);
  const preview = await onlySxListed(pool, 'quests');
  assert.strictEqual(byKey(preview, 'sx_a').kind, 'changed');
  await writeGitWith(pool, 'quests', [{ ...a, title: 'sx git 2' }]);
  const runs = await seedRunCount(pool);
  await assert.rejects(applySeed(pool, 'quests', defaultsOf(preview), { signature: preview.signature }),
    refused('stale_preview'));
  assert.strictEqual((await questState(pool))[0].title, 'sx t');
  assert.strictEqual(await seedRunCount(pool), runs, 'a refusal records no run');
});

dbTest('a git file changed after the preview (row removed) refuses stale_preview', async (t, pool) => {
  await addQuest(pool, 'sx_a');
  await addQuest(pool, 'sx_b');
  const a = await snap(pool, 'quests', 'sx_a');
  const b = await snap(pool, 'quests', 'sx_b');
  await setBaseline(pool, 'quests', a);
  await setBaseline(pool, 'quests', b);
  await writeGitWith(pool, 'quests', [{ ...a, title: 'sx git' }, b]);
  const preview = await onlySxListed(pool, 'quests');
  assert.deepStrictEqual(sxRows(preview).map((r) => [r.key, r.kind]), [['sx_a', 'changed']]);
  // A pull lands between preview and apply: sx_b is gone in git (same
  // exported_at, so only the rows differ). Its default would be 'delete'.
  await writeGitWith(pool, 'quests', [{ ...a, title: 'sx git' }]);
  assert.strictEqual(byKey(await previewSeed(pool, 'quests'), 'sx_b').kind, 'deleted_in_git');
  await assert.rejects(applySeed(pool, 'quests', defaultsOf(preview), { signature: preview.signature }),
    refused('stale_preview'));
  assert.deepStrictEqual((await questState(pool)).map((r) => [r.key, r.title]), [['sx_a', 'sx t'], ['sx_b', 'sx t']]);
});

dbTest('apply without a signature refuses stale_preview', async (t, pool) => {
  await addQuest(pool, 'sx_a');
  const a = await snap(pool, 'quests', 'sx_a');
  await setBaseline(pool, 'quests', a);
  await writeGitWith(pool, 'quests', [{ ...a, title: 'sx git' }]);
  const preview = await onlySxListed(pool, 'quests');
  assert.match(preview.signature, /^[0-9a-f]{64}$/);
  assert.strictEqual(preview.signature, await sigOf(pool, 'quests'), 'stable across previews');
  await assert.rejects(applySeed(pool, 'quests', defaultsOf(preview)), refused('stale_preview'));
  await assert.rejects(applySeed(pool, 'quests', defaultsOf(preview), { signature: 'x' }), refused('stale_preview'));
  assert.strictEqual((await questState(pool))[0].title, 'sx t');
});

dbTest('a unique clash while writing is a conflict refusal, rolled back, run failed', async (t, pool) => {
  await addQuest(pool, 'sx_a');
  await addQuest(pool, 'sx_b');
  const a = await snap(pool, 'quests', 'sx_a');
  await setBaseline(pool, 'quests', a);
  // Git renames sx_a onto sx_b's key; the local sx_b (no baseline, not in git)
  // is only_here and kept by default. The by-uuid update hits quests_key_key.
  await writeGitWith(pool, 'quests', [{ ...a, key: 'sx_b', title: 'sx renamed' }]);
  const preview = await onlySxListed(pool, 'quests');
  assert.deepStrictEqual(sxRows(preview).map((r) => [r.key, r.kind, r.defaultDecision]),
    [['sx_a', 'changed', 'git'], ['sx_b', 'only_here', 'local']]);
  const beforeQ = await questState(pool);
  const beforeB = await baselineState(pool, [a.sync_uuid]);
  await assert.rejects(applySeed(pool, 'quests', defaultsOf(preview), { signature: preview.signature }), (e) => {
    refused('conflict')(e);
    assert.deepStrictEqual(e.details, { constraint: 'quests_key_key' });
    assert.match(e.message, /quests_key_key/);
    assert.ok(!/sx_b/.test(e.message), 'no row values in the message');
    return true;
  });
  assert.deepStrictEqual(await questState(pool), beforeQ);
  assert.deepStrictEqual(await baselineState(pool, [a.sync_uuid]), beforeB);
  const run = (await recentRuns(pool, { groupId: 'quests', limit: 1 })).runs[0];
  assert.deepStrictEqual([run.action, run.status], ['seed', 'failed']);
  assert.match(run.error, /quests_key_key/);
});

// Holds the seed_sync xact lock on its own client. release() is idempotent and
// always called from a finally: a leaked checked-out client would hang pool.end().
async function heldSeedLock(pool) {
  const holder = await pool.connect();
  await holder.query('BEGIN');
  await holder.query("SELECT pg_advisory_xact_lock(hashtext('seed_sync'))");
  let open = true;
  return async () => {
    if (!open) return;
    open = false;
    try { await holder.query('COMMIT'); } finally { holder.release(); }
  };
}

const tick = (ms) => new Promise((r) => { setTimeout(r, ms); });

// Starts `fn` while another client holds the lock; asserts it waits, then
// releases and returns its result.
async function waitsForLock(pool, what, fn) {
  const release = await heldSeedLock(pool);
  let p;
  try {
    let done = false;
    p = fn().then((r) => { done = true; return r; });
    p.catch(() => {}); // surfaced by the await below
    await tick(400);
    assert.strictEqual(done, false, `${what} waits while another holder has the lock`);
  } finally {
    await release();
  }
  return p;
}

dbTest('applySeed and exportGroup wait for the seed_sync transaction lock', async (t, pool) => {
  await addQuest(pool, 'sx_a');
  const a = await snap(pool, 'quests', 'sx_a');
  await setBaseline(pool, 'quests', a);
  await writeGitWith(pool, 'quests', [{ ...a, title: 'sx git' }]);

  await waitsForLock(pool, 'apply', () => apply(pool, 'quests', {}));
  assert.strictEqual((await questState(pool))[0].title, 'sx git');

  const r = await waitsForLock(pool, 'export', () => exportGroup(pool, 'quests'));
  createdRuns.push(r.runId);
});

dbTest('apply records an ok seed run with its summary', async (t, pool) => {
  await addQuest(pool, 'sx_a');
  const a = await snap(pool, 'quests', 'sx_a');
  await setBaseline(pool, 'quests', a);
  await writeGitWith(pool, 'quests', [{ ...a, title: 'sx git' }]);
  const { runId, summary } = await apply(pool, 'quests', {});
  const run = (await pool.query('SELECT * FROM seed_export_runs WHERE id = $1', [runId])).rows[0];
  assert.strictEqual(run.action, 'seed');
  assert.strictEqual(run.status, 'ok');
  assert.strictEqual(run.group_id, 'quests');
  assert.ok(run.finished_at);
  assert.deepStrictEqual(run.summary, summary);
  assert.deepStrictEqual(summary, { updated: 1, created: 0, deleted: 0, kept: 0, adopted: 0 });
});

// ------------------------------------------------------------ review fixes

dbTest('edited_here resolved local becomes exportable and export carries the local value', async (t, pool) => {
  await addQuest(pool, 'sx_a');
  const a = await snap(pool, 'quests', 'sx_a');
  await setBaseline(pool, 'quests', a);
  await writeGitWith(pool, 'quests', [{ ...a, title: 'sx git' }]);
  await pool.query("UPDATE quests SET title = 'sx mine' WHERE key = 'sx_a'");
  assert.strictEqual(byKey(await onlySxListed(pool, 'quests'), 'sx_a').kind, 'edited_here');
  // Before the seed, export is refused: git has a change for this row.
  await assert.rejects(exportGroup(pool, 'quests'), refused('git_newer'));

  await apply(pool, 'quests', { [a.sync_uuid]: 'local' });
  const d = await previewSeed(pool, 'quests');
  assert.deepStrictEqual(sxRows(d).map((r) => [r.key, r.kind]), [['sx_a', 'not_exported']]);
  const { runId } = await exportGroup(pool, 'quests');
  createdRuns.push(runId);
  const row = JSON.parse(fs.readFileSync(fileFor('quests'), 'utf8')).tables.quests.find((r) => r.key === 'sx_a');
  assert.strictEqual(row.title, 'sx mine');
  assert.deepStrictEqual(sxRows(await previewSeed(pool, 'quests')), []);
});

dbTest('adopt_identity and new resolved local acknowledge git', async (t, pool) => {
  await addQuest(pool, 'sx_a');
  const a = await snap(pool, 'quests', 'sx_a');
  const id = (await pool.query("SELECT id FROM quests WHERE key = 'sx_a'")).rows[0].id;
  const gitA = { ...a, sync_uuid: crypto.randomUUID(), title: 'sx git a' };
  const gitN = { ...a, sync_uuid: crypto.randomUUID(), key: 'sx_n', title: 'sx git n' };
  await writeGitWith(pool, 'quests', [gitA, gitN]);
  const d = await onlySxListed(pool, 'quests');
  assert.deepStrictEqual(sxRows(d).map((r) => [r.key, r.kind]), [['sx_a', 'adopt_identity'], ['sx_n', 'new']]);

  const res = await apply(pool, 'quests', { [gitA.sync_uuid]: 'local', [gitN.sync_uuid]: 'local' });
  assert.deepStrictEqual(res.summary, { updated: 0, created: 0, deleted: 0, kept: 2, adopted: 0 });
  // adopt + local: git identity, local values, same row.
  assert.deepStrictEqual((await pool.query("SELECT id, title, sync_uuid FROM quests WHERE key LIKE 'sx\\_%'")).rows,
    [{ id, title: 'sx t', sync_uuid: gitA.sync_uuid }]);
  assert.strictEqual(await baselineOf(pool, 'quests', gitA.sync_uuid), rowHash(gitA));
  assert.strictEqual(await baselineOf(pool, 'quests', gitN.sync_uuid), rowHash(gitN));
  const after = await previewSeed(pool, 'quests');
  assert.deepStrictEqual(sxRows(after).map((r) => [r.key, r.kind, r.defaultDecision]),
    [['sx_a', 'not_exported', 'local'], ['sx_n', 'deleted_here', 'local']]);
  assert.strictEqual(after.gitChanges - (await diffGroup(pool, 'quests')).gitChanges, 0);
  const { runId } = await exportGroup(pool, 'quests'); // not refused: no git changes left
  createdRuns.push(runId);
});

dbTest('preview warns schema_older for an older file; apply still allowed', async (t, pool) => {
  await addQuest(pool, 'sx_a');
  const a = await snap(pool, 'quests', 'sx_a');
  await setBaseline(pool, 'quests', a);
  const current = (await pool.query('SELECT max(name) AS v FROM pgmigrations')).rows[0].v;
  await writeGitWith(pool, 'quests', [{ ...a, title: 'sx git' }], { schemaVersion: current });
  assert.deepStrictEqual((await previewSeed(pool, 'quests')).warnings, []);
  await writeGitWith(pool, 'quests', [{ ...a, title: 'sx git' }], { schemaVersion: '0000000000000_ancient' });
  assert.deepStrictEqual((await previewSeed(pool, 'quests')).warnings, [{ code: 'schema_older' }]);
  await apply(pool, 'quests', {});
  assert.strictEqual((await questState(pool))[0].title, 'sx git');
});

async function pollUntil(fn, what, ms = 10000) {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await tick(20);
  }
}

dbTest('apply waits for an open edit of the table and then sees it (no silent overwrite)', async (t, pool) => {
  await addQuest(pool, 'sx_a');
  const a = await snap(pool, 'quests', 'sx_a');
  await setBaseline(pool, 'quests', a);
  await writeGitWith(pool, 'quests', [{ ...a, title: 'sx git' }]);
  const preview = await onlySxListed(pool, 'quests');
  assert.strictEqual(byKey(preview, 'sx_a').kind, 'changed');

  const editor = await pool.connect();
  let p;
  let open = true;
  try {
    await editor.query('BEGIN');
    await editor.query("UPDATE quests SET title = 'sx concurrent' WHERE key = 'sx_a'");
    const editorPid = (await editor.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    p = applySeed(pool, 'quests', defaultsOf(preview), { signature: preview.signature });
    p.catch(() => {});
    await pollUntil(async () => (await pool.query(
      'SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [editorPid],
    )).rows[0].n > 0, 'apply to block on the open edit');
    await editor.query('COMMIT');
    open = false;
  } finally {
    if (open) await editor.query('ROLLBACK').catch(() => {});
    editor.release();
  }
  // Apply re-diffed after the edit committed: the row is edited_here now, so
  // the preview it was given is stale.
  await assert.rejects(p, refused('stale_preview'));
  assert.strictEqual((await questState(pool))[0].title, 'sx concurrent');
});

dbTest('lock wait past lock_timeout refuses busy (apply and export)', async (t, pool) => {
  await addQuest(pool, 'sx_a');
  const a = await snap(pool, 'quests', 'sx_a');
  await setBaseline(pool, 'quests', a);
  await writeGitWith(pool, 'quests', [{ ...a, title: 'sx git' }]);
  const prev = process.env.SEED_SYNC_LOCK_TIMEOUT_MS;
  process.env.SEED_SYNC_LOCK_TIMEOUT_MS = '200';
  const release = await heldSeedLock(pool);
  const runs = (await pool.query('SELECT count(*)::int AS n FROM seed_export_runs')).rows[0].n;
  try {
    await assert.rejects(applyNow(pool, 'quests', {}), (e) => refused('busy')(e) && /open edit of this table is in progress/.test(e.message));
    await assert.rejects(exportGroup(pool, 'quests'), refused('busy'));
  } finally {
    await release();
    if (prev === undefined) delete process.env.SEED_SYNC_LOCK_TIMEOUT_MS; else process.env.SEED_SYNC_LOCK_TIMEOUT_MS = prev;
  }
  assert.strictEqual((await pool.query('SELECT count(*)::int AS n FROM seed_export_runs')).rows[0].n, runs);
  assert.strictEqual((await questState(pool))[0].title, 'sx t');
});

// Fail the first "mark run ok" UPDATE; the run is then left 'running'.
function failFirstRunOk(t, pool) {
  const orig = pool.query.bind(pool);
  let armed = true;
  t.mock.method(pool, 'query', (...args) => {
    const params = args[1];
    if (armed && /UPDATE seed_export_runs/.test(String(args[0])) && Array.isArray(params) && params[1] === 'ok') {
      armed = false;
      return Promise.reject(new Error('sx finishRun failed'));
    }
    return orig(...args);
  });
}

dbTest('a committed seed or export is never reported failed', async (t, pool) => {
  await addQuest(pool, 'sx_a');
  const a = await snap(pool, 'quests', 'sx_a');
  await setBaseline(pool, 'quests', a);
  await writeGitWith(pool, 'quests', [{ ...a, title: 'sx git' }]);
  const signature = await sigOf(pool, 'quests');
  failFirstRunOk(t, pool);
  let res;
  try { res = await applySeed(pool, 'quests', {}, { signature }); } finally { t.mock.restoreAll(); }
  const run = (await pool.query('SELECT status FROM seed_export_runs WHERE id = $1', [res.runId])).rows[0];
  assert.notStrictEqual(run.status, 'failed');
  assert.strictEqual((await questState(pool))[0].title, 'sx git');

  failFirstRunOk(t, pool);
  let ex;
  try { ex = await exportGroup(pool, 'quests'); } finally { t.mock.restoreAll(); }
  createdRuns.push(ex.runId);
  const exRun = (await pool.query('SELECT status FROM seed_export_runs WHERE id = $1', [ex.runId])).rows[0];
  assert.notStrictEqual(exRun.status, 'failed');
});

// ------------------------------------------------- Plan 2: multi-table apply

const { _withTestGroups, fkProblems } = require('../src/services/seedSync/registry.js');
const { applyLockPlan, exportLockTables, mapLockError } = require('../src/services/seedSync/txn.js');

// TEST-ONLY groups over the real tables (Task 6 registers the real ones).
const LOCAL = { id: 'local', created_at: 'local', updated_at: 'local', sync_uuid: 'identity' };
const ELEMENT_REF = { table: 'elements', by: 'key', keyCol: 'name' };
const BEH_REF = { table: 'creature_behaviors', by: 'uuid' };
const behSpec = { table: 'creature_behaviors', naturalKey: ['name'], omit: LOCAL, secretColumns: [], refs: {} };
const abilSpec = {
  table: 'creature_abilities', naturalKey: ['behavior_id', 'slot'], omit: LOCAL, secretColumns: [], refs: { behavior_id: BEH_REF },
};
const bskSpec = {
  table: 'creature_behavior_skills', naturalKey: ['behavior_id', 'slot'], omit: LOCAL, secretColumns: [],
  refs: { behavior_id: BEH_REF, skill_id: { table: 'creature_skills', by: 'uuid' } },
};
const bdropSpec = {
  table: 'behavior_drops', naturalKey: ['behavior_id', 'item_type_id'], omit: LOCAL, secretColumns: [],
  refs: { behavior_id: BEH_REF, item_type_id: { table: 'item_types', by: 'uuid' } },
};
const entBSpec = {
  table: 'entity_types', naturalKey: ['name'],
  omit: { ...LOCAL, ai_provider_id: 'test group', point_kind: 'test group' },
  secretColumns: [], refs: { behavior_id: BEH_REF, element: ELEMENT_REF },
};
const entPSpec = {
  table: 'entity_types', naturalKey: ['name'],
  omit: { ...LOCAL, ai_provider_id: 'test group', point_kind: 'test group', behavior_id: 'test group' },
  secretColumns: [], refs: { element: ELEMENT_REF },
};
const dropsSpec = {
  table: 'creature_drops', naturalKey: ['entity_type_id', 'item_type_id'], omit: LOCAL, secretColumns: [],
  refs: { entity_type_id: { table: 'entity_types', by: 'uuid' }, item_type_id: { table: 'item_types', by: 'uuid' } },
};
const itemsSpec = {
  table: 'item_types', naturalKey: ['name'], omit: LOCAL, secretColumns: [],
  refs: {
    ammo_type_id: { table: 'item_types', by: 'uuid' },
    element: ELEMENT_REF,
    attack_origin: { table: 'attack_origins', by: 'key', keyCol: 'name' },
    projectile_shape_id: { table: 'projectile_shapes', by: 'key', keyCol: 'name' },
    impact_behavior_id: { table: 'impact_behaviors', by: 'key', keyCol: 'name' },
  },
};
const settingsSpec = {
  table: 'game_settings', naturalKey: ['key'], omit: { updated_at: 'local', sync_uuid: 'identity' }, secretColumns: [],
  refs: {}, validate: 'game_settings',
};
const P2_GROUPS = [
  { id: 'sx_beh', label: 'SX behaviors', tables: [behSpec, abilSpec, bskSpec, bdropSpec] },
  { id: 'sx_entb', label: 'SX behaviors+entities', tables: [behSpec, entBSpec] },
  { id: 'sx_ento', label: 'SX entities (behavior outside)', tables: [entBSpec] },
  { id: 'sx_edrop', label: 'SX entities+drops', tables: [entPSpec, dropsSpec] },
  { id: 'sx_items', label: 'SX items', tables: [itemsSpec] },
  { id: 'sx_set', label: 'SX settings', tables: [settingsSpec] },
];

function p2Test(name, body) {
  dbTest(name, (t, pool, dir) => _withTestGroups(P2_GROUPS, () => body(t, pool, dir)));
}

const q1 = async (pool, sql, params) => (await pool.query(sql, params)).rows[0];
const addBehavior = (pool, name) => q1(pool,
  `INSERT INTO creature_behaviors (name, aggro_radius, leash_radius, chase_style)
   VALUES ($1, 5, 10, 'charge') RETURNING id, sync_uuid`, [name]);
const addAbility = (pool, behId, slot) => q1(pool,
  `INSERT INTO creature_abilities (behavior_id, slot, name, attack_kind, attack_range, attack_cooldown)
   VALUES ($1, $2, 'sx hit', 'melee', 1, 1) RETURNING id, sync_uuid`, [behId, slot]);
const addSkill = (pool, name) => q1(pool,
  "INSERT INTO creature_skills (name, kind, cooldown_ms) VALUES ($1, 'slam', 1000) RETURNING id, sync_uuid", [name]);
const addBehSkill = (pool, behId, skillId, slot) => q1(pool,
  'INSERT INTO creature_behavior_skills (behavior_id, skill_id, slot) VALUES ($1, $2, $3) RETURNING id, sync_uuid',
  [behId, skillId, slot]);
const addItem = (pool, name) => q1(pool,
  "INSERT INTO item_types (name, category, damage, cooldown, stackable) VALUES ($1, 'ammo', 0, 0, true) RETURNING id, sync_uuid",
  [name]);
const addBehDrop = (pool, behId, itemId) => q1(pool,
  'INSERT INTO behavior_drops (behavior_id, item_type_id, chance) VALUES ($1, $2, 0.5) RETURNING id, sync_uuid',
  [behId, itemId]);
const addEnt = (pool, name, behaviorId = null, auras = []) => q1(pool,
  `INSERT INTO entity_types (name, color, behavior_id, auras) VALUES ($1, '#010203', $2, $3::jsonb)
   RETURNING id, sync_uuid`, [name, behaviorId, JSON.stringify(auras)]);
const addDrop = (pool, entId, itemId, chance = 0.5) => q1(pool,
  'INSERT INTO creature_drops (entity_type_id, item_type_id, chance) VALUES ($1, $2, $3) RETURNING id, sync_uuid',
  [entId, itemId, chance]);

const readDoc = (groupId) => JSON.parse(fs.readFileSync(fileFor(groupId), 'utf8'));
function writeDoc(groupId, doc) {
  for (const [tbl, rows] of Object.entries(doc.tables)) doc.header.row_counts[tbl] = rows.length;
  fs.writeFileSync(fileFor(groupId), `${stableStringify(doc)}\n`);
}
async function exportNow(pool, groupId) {
  const ex = await exportGroup(pool, groupId);
  createdRuns.push(ex.runId);
  return ex;
}
// Guard: the fixture only lists sx_ rows (never apply over the shared tables).
async function sxListed(pool, groupId) {
  const d = await previewSeed(pool, groupId);
  assert.deepStrictEqual(d.rows.filter((r) => !String(r.key).startsWith('sx_')), [], 'fixture must only list sx_ rows');
  return d;
}
const listed = async (pool, groupId) => (await previewSeed(pool, groupId)).rows;
const exists = async (pool, table, uuid) => (await pool.query(
  `SELECT 1 FROM ${table} WHERE sync_uuid = $1`, [uuid])).rowCount === 1;

p2Test('Plan-2 test groups cover every FK column (fixture sanity)', async (t, pool) => {
  for (const s of [behSpec, abilSpec, bskSpec, bdropSpec, entBSpec, entPSpec, dropsSpec, itemsSpec, settingsSpec]) {
    assert.deepStrictEqual(await fkProblems(pool, s), [], s.table);
  }
});

dbTest('apply locks: group tables SHARE ROW EXCLUSIVE, outside ref targets SHARE, in the export lock order', async () => {
  const specs = P2_GROUPS[0].tables;
  const plan = applyLockPlan(specs);
  assert.deepStrictEqual(plan.map(([tbl]) => tbl), exportLockTables(specs));
  assert.deepStrictEqual(plan, [
    ['behavior_drops', 'SHARE ROW EXCLUSIVE'],
    ['creature_abilities', 'SHARE ROW EXCLUSIVE'],
    ['creature_behavior_skills', 'SHARE ROW EXCLUSIVE'],
    ['creature_behaviors', 'SHARE ROW EXCLUSIVE'],
    ['creature_skills', 'SHARE'],
    ['item_types', 'SHARE'],
  ]);
  // Losing a deadlock against an open admin edit is 'busy', like a lock timeout.
  assert.strictEqual(mapLockError(Object.assign(new Error('deadlock'), { code: '40P01' })).code, 'busy');
});

// Review Focus 2 (a)
p2Test('deleting a behavior in git deletes its abilities, behavior skills and drops in the same transaction', async (t, pool) => {
  const b = await addBehavior(pool, 'sx_b1');
  const keep = await addBehavior(pool, 'sx_b2');
  const ab = await addAbility(pool, b.id, 1);
  const sk = await addSkill(pool, 'sx_sk');
  const bs = await addBehSkill(pool, b.id, sk.id, 1);
  const it = await addItem(pool, 'sx_it');
  const bd = await addBehDrop(pool, b.id, it.id);
  const ab2 = await addAbility(pool, keep.id, 1);
  await exportNow(pool, 'sx_beh');
  const doc = readDoc('sx_beh');
  doc.tables.creature_behaviors = doc.tables.creature_behaviors.filter((r) => r.sync_uuid !== b.sync_uuid);
  for (const tbl of ['creature_abilities', 'creature_behavior_skills', 'behavior_drops']) {
    doc.tables[tbl] = doc.tables[tbl].filter((r) => r.behavior_id !== b.sync_uuid);
  }
  writeDoc('sx_beh', doc);
  const d = await sxListed(pool, 'sx_beh');
  assert.deepStrictEqual(d.rows.map((r) => [r.table, r.syncUuid, r.kind, r.defaultDecision, r.blockedReason]), [
    ['creature_behaviors', b.sync_uuid, 'deleted_in_git', 'delete', null],
    ['creature_abilities', ab.sync_uuid, 'deleted_in_git', 'delete', null],
    ['creature_behavior_skills', bs.sync_uuid, 'deleted_in_git', 'delete', null],
    ['behavior_drops', bd.sync_uuid, 'deleted_in_git', 'delete', null],
  ], 'in-group children deleted in the same seed do not block their parent');
  const res = await apply(pool, 'sx_beh', defaultsOf(d));
  assert.deepStrictEqual(res.summary, { updated: 0, created: 0, deleted: 4, kept: 0, adopted: 0 });
  for (const [tbl, u] of [['creature_behaviors', b.sync_uuid], ['creature_abilities', ab.sync_uuid],
    ['creature_behavior_skills', bs.sync_uuid], ['behavior_drops', bd.sync_uuid]]) {
    assert.strictEqual(await exists(pool, tbl, u), false, tbl);
    assert.strictEqual(await baselineOf(pool, 'sx_beh', u), null, `${tbl} baseline dropped`);
  }
  assert.ok(await exists(pool, 'creature_behaviors', keep.sync_uuid));
  assert.ok(await exists(pool, 'creature_abilities', ab2.sync_uuid));
  assert.ok(await exists(pool, 'creature_skills', sk.sync_uuid), 'out-of-group targets untouched');
  assert.ok(await exists(pool, 'item_types', it.sync_uuid));
  assert.deepStrictEqual(await listed(pool, 'sx_beh'), []);
});

// Review Focus 2 (b)
p2Test('a behavior still referenced by entity_types (another group) cannot be deleted; nothing written', async (t, pool) => {
  const b = await addBehavior(pool, 'sx_b1');
  const ab = await addAbility(pool, b.id, 1);
  await addEnt(pool, 'sx_e', b.id);
  await exportNow(pool, 'sx_beh');
  const doc = readDoc('sx_beh');
  doc.tables.creature_behaviors = doc.tables.creature_behaviors.filter((r) => r.sync_uuid !== b.sync_uuid);
  doc.tables.creature_abilities = doc.tables.creature_abilities.filter((r) => r.behavior_id !== b.sync_uuid);
  writeDoc('sx_beh', doc);
  const d = await sxListed(pool, 'sx_beh');
  const beh = d.rows.find((r) => r.syncUuid === b.sync_uuid);
  assert.strictEqual(beh.blockedReason, '1 rows in entity_types reference this');
  assert.strictEqual(beh.defaultDecision, 'local', 'a blocked deleted_in_git defaults to keep');
  const runs = await seedRunCount(pool);
  await assert.rejects(applyNow(pool, 'sx_beh', { [b.sync_uuid]: 'delete', [ab.sync_uuid]: 'delete' }),
    refused('blocked', [b.sync_uuid]));
  assert.ok(await exists(pool, 'creature_behaviors', b.sync_uuid));
  assert.ok(await exists(pool, 'creature_abilities', ab.sync_uuid), 'no partial write: the child is still there');
  assert.strictEqual(await seedRunCount(pool), runs);
});

p2Test('an in-group child kept on this PC blocks deleting its parent until it is deleted too', async (t, pool) => {
  const b = await addBehavior(pool, 'sx_b1');
  await exportNow(pool, 'sx_beh');
  const ab = await addAbility(pool, b.id, 1); // created here after the export: only_here, default keep
  const doc = readDoc('sx_beh');
  doc.tables.creature_behaviors = doc.tables.creature_behaviors.filter((r) => r.sync_uuid !== b.sync_uuid);
  writeDoc('sx_beh', doc);
  const d = await sxListed(pool, 'sx_beh');
  const beh = d.rows.find((r) => r.syncUuid === b.sync_uuid);
  assert.strictEqual(beh.blockedReason, '1 rows in creature_abilities reference this',
    'ON DELETE CASCADE would silently delete the kept local child');
  assert.strictEqual(beh.defaultDecision, 'local');
  const child = d.rows.find((r) => r.syncUuid === ab.sync_uuid);
  assert.deepStrictEqual([child.kind, child.defaultDecision], ['only_here', 'local']);
  await assert.rejects(applyNow(pool, 'sx_beh', { [b.sync_uuid]: 'delete' }), refused('blocked', [b.sync_uuid]));
  assert.ok(await exists(pool, 'creature_abilities', ab.sync_uuid));

  const res = await apply(pool, 'sx_beh', { [b.sync_uuid]: 'delete', [ab.sync_uuid]: 'delete' });
  assert.strictEqual(res.summary.deleted, 2);
  assert.strictEqual(await exists(pool, 'creature_behaviors', b.sync_uuid), false);
  assert.strictEqual(await exists(pool, 'creature_abilities', ab.sync_uuid), false);
  assert.deepStrictEqual(await listed(pool, 'sx_beh'), []);
});

p2Test('deleting an item that player data references (player_items) is blocked, never cascaded', async (t, pool) => {
  const it = await addItem(pool, 'sx_it');
  await exportNow(pool, 'sx_items');
  const charId = await createCharacter(pool);
  await pool.query('INSERT INTO player_items (item_type_id, character_id) VALUES ($1, $2)', [it.id, charId]);
  const doc = readDoc('sx_items');
  doc.tables.item_types = doc.tables.item_types.filter((r) => r.sync_uuid !== it.sync_uuid);
  writeDoc('sx_items', doc);
  const d = await sxListed(pool, 'sx_items');
  const r = d.rows.find((x) => x.syncUuid === it.sync_uuid);
  assert.strictEqual(r.blockedReason, '1 rows in player_items reference this');
  assert.strictEqual(r.defaultDecision, 'local');
  await assert.rejects(applyNow(pool, 'sx_items', { [it.sync_uuid]: 'delete' }), refused('blocked', [it.sync_uuid]));
  assert.ok(await exists(pool, 'item_types', it.sync_uuid));
  const pi = await pool.query('SELECT 1 FROM player_items WHERE character_id = $1', [charId]);
  assert.strictEqual(pi.rowCount, 1, 'player data untouched');
});

// Review Focus 3
p2Test('self-reference to an item new in the same seed: both inserted, the ref set in a second pass', async (t, pool) => {
  await addItem(pool, 'sx_m_sling');
  await exportNow(pool, 'sx_items');
  const doc = readDoc('sx_items');
  const i = doc.tables.item_types.findIndex((r) => r.name === 'sx_m_sling');
  const sling = doc.tables.item_types[i];
  // A launcher template: ammo_type_id needs kind 'projectile' (item_types_ammo_ref_check).
  const launcher = doc.tables.item_types.find((r) => r.ammo_type_id !== null && r.kind === 'projectile');
  assert.ok(launcher, 'scratch DB has a projectile launcher to copy');
  const bowUuid = crypto.randomUUID();
  const arrowUuid = crypto.randomUUID();
  // The referencing rows sort (and are written) before their target.
  doc.tables.item_types.push(
    { ...launcher, sync_uuid: bowUuid, name: 'sx_a_bow', ammo_type_id: arrowUuid },
    { ...sling, sync_uuid: arrowUuid, name: 'sx_z_arrow', ammo_type_id: null },
  );
  // An existing row re-pointed at the new one.
  doc.tables.item_types[i] = { ...launcher, sync_uuid: sling.sync_uuid, name: 'sx_m_sling', ammo_type_id: arrowUuid };
  writeDoc('sx_items', doc);
  const d = await sxListed(pool, 'sx_items');
  assert.deepStrictEqual(d.rows.map((r) => [r.key, r.kind]), [['sx_a_bow', 'new'], ['sx_m_sling', 'changed'], ['sx_z_arrow', 'new']]);
  const res = await apply(pool, 'sx_items', defaultsOf(d));
  assert.deepStrictEqual(res.summary, { updated: 1, created: 2, deleted: 0, kept: 0, adopted: 0 });
  const { rows } = await pool.query(
    "SELECT name, id, ammo_type_id, sync_uuid FROM item_types WHERE name LIKE 'sx\\_%' ORDER BY name");
  const by = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.strictEqual(by.sx_a_bow.sync_uuid, bowUuid);
  assert.strictEqual(by.sx_a_bow.ammo_type_id, by.sx_z_arrow.id);
  assert.strictEqual(by.sx_m_sling.ammo_type_id, by.sx_z_arrow.id);
  assert.strictEqual(by.sx_z_arrow.ammo_type_id, null);
  assert.deepStrictEqual(await listed(pool, 'sx_items'), [], 'applied rows are in sync (B == hL == hG)');
});

// Review Focus 4
p2Test('missing_ref: an entity naming a behavior absent here and in git is refused before any write', async (t, pool) => {
  const e1 = await addEnt(pool, 'sx_e1');
  await exportNow(pool, 'sx_ento');
  const doc = readDoc('sx_ento');
  const e1Row = doc.tables.entity_types.find((r) => r.sync_uuid === e1.sync_uuid);
  e1Row.color = '#0a0b0c';
  const ghost = crypto.randomUUID();
  const e2Uuid = crypto.randomUUID();
  doc.tables.entity_types.push({ ...e1Row, sync_uuid: e2Uuid, name: 'sx_e2', behavior_id: ghost });
  writeDoc('sx_ento', doc);
  await sxListed(pool, 'sx_ento');
  const runs = await seedRunCount(pool);
  await assert.rejects(applyNow(pool, 'sx_ento', {}), (e) => {
    refused('missing_ref')(e);
    assert.deepStrictEqual(e.details.refs, [
      { table: 'entity_types', key: 'sx_e2', column: 'behavior_id', target: 'creature_behaviors', value: ghost },
    ]);
    return true;
  });
  const { rows } = await pool.query("SELECT name, color FROM entity_types WHERE name LIKE 'sx\\_%' ORDER BY name");
  assert.deepStrictEqual(rows, [{ name: 'sx_e1', color: '#010203' }], 'nothing written');
  assert.strictEqual(await seedRunCount(pool), runs, 'refused before a run starts');
});

p2Test('refs to rows created in the same seed resolve; a ref to a git row kept out or deleted here is missing_ref', async (t, pool) => {
  const old = await addBehavior(pool, 'sx_old');
  await exportNow(pool, 'sx_entb');
  const doc = readDoc('sx_entb');
  const tmpl = doc.tables.creature_behaviors.find((r) => r.name === 'sx_old');
  const nb = crypto.randomUUID();
  const ne = crypto.randomUUID();
  doc.tables.creature_behaviors = doc.tables.creature_behaviors.filter((r) => r.sync_uuid !== old.sync_uuid);
  doc.tables.creature_behaviors.push({ ...tmpl, sync_uuid: nb, name: 'sx_nb' });
  const anyEnt = doc.tables.entity_types[0];
  doc.tables.entity_types.push({ ...anyEnt, sync_uuid: ne, name: 'sx_ne', behavior_id: nb });
  writeDoc('sx_entb', doc);
  const d = await sxListed(pool, 'sx_entb');
  assert.deepStrictEqual(d.rows.map((r) => [r.key, r.kind]), [['sx_nb', 'new'], ['sx_old', 'deleted_in_git'], ['sx_ne', 'new']]);
  await assert.rejects(applyNow(pool, 'sx_entb', { [nb]: 'local' }), (e) => refused('missing_ref')(e)
    && assert.deepStrictEqual(e.details.refs, [
      { table: 'entity_types', key: 'sx_ne', column: 'behavior_id', target: 'creature_behaviors', value: nb }]) === undefined);

  // The entity now names the behavior git deletes (and this seed deletes too).
  doc.tables.entity_types.find((r) => r.sync_uuid === ne).behavior_id = old.sync_uuid;
  writeDoc('sx_entb', doc);
  await assert.rejects(applyNow(pool, 'sx_entb', {}), (e) => refused('missing_ref')(e)
    && e.details.refs.length === 1 && e.details.refs[0].value === old.sync_uuid);
  assert.ok(await exists(pool, 'creature_behaviors', old.sync_uuid), 'nothing written');

  doc.tables.entity_types.find((r) => r.sync_uuid === ne).behavior_id = nb;
  writeDoc('sx_entb', doc);
  const res = await apply(pool, 'sx_entb', {});
  assert.deepStrictEqual(res.summary, { updated: 0, created: 2, deleted: 1, kept: 0, adopted: 0 });
  const ent = await q1(pool, 'SELECT behavior_id FROM entity_types WHERE sync_uuid = $1', [ne]);
  const beh = await q1(pool, 'SELECT id FROM creature_behaviors WHERE sync_uuid = $1', [nb]);
  assert.strictEqual(ent.behavior_id, beh.id, 'resolved through pending (created earlier in this seed)');
  assert.deepStrictEqual(await listed(pool, 'sx_entb'), []);
});

// Both PCs created sx_gob and its drop: same names, different random uuids.
async function adoptPairFixture(pool) {
  const gob = await addEnt(pool, 'sx_gob');
  const sword = await addItem(pool, 'sx_sword');
  const drop = await addDrop(pool, gob.id, sword.id, 0.5);
  await exportNow(pool, 'sx_edrop');
  await pool.query('DELETE FROM seed_row_hashes WHERE group_id = $1 AND sync_uuid = ANY($2::uuid[])',
    ['sx_edrop', [gob.sync_uuid, drop.sync_uuid]]);
  const doc = readDoc('sx_edrop');
  const gitGob = crypto.randomUUID();
  const gitDrop = crypto.randomUUID();
  doc.tables.entity_types.find((r) => r.name === 'sx_gob').sync_uuid = gitGob;
  const dr = doc.tables.creature_drops.find((r) => r.sync_uuid === drop.sync_uuid);
  Object.assign(dr, { sync_uuid: gitDrop, entity_type_id: gitGob });
  writeDoc('sx_edrop', doc);
  extraBaselines.push(gitGob, gitDrop);
  return { gob, sword, drop, gitGob, gitDrop, doc, dr };
}

p2Test('parent and child adopted together: the child takes the git uuid and resolves to the local parent', async (t, pool) => {
  const f = await adoptPairFixture(pool);
  const d = await sxListed(pool, 'sx_edrop');
  assert.deepStrictEqual(d.rows.map((r) => [r.table, r.syncUuid, r.kind, r.defaultDecision]), [
    ['entity_types', f.gitGob, 'adopt_identity', 'git'],
    ['creature_drops', f.gitDrop, 'adopt_identity', 'git'],
  ]);
  const res = await apply(pool, 'sx_edrop', defaultsOf(d));
  assert.deepStrictEqual(res.summary, { updated: 0, created: 0, deleted: 0, kept: 0, adopted: 2 });
  const ent = await q1(pool, "SELECT id, sync_uuid FROM entity_types WHERE name = 'sx_gob'");
  assert.deepStrictEqual(ent, { id: f.gob.id, sync_uuid: f.gitGob }, 'same local row, git identity');
  const drop = await q1(pool, 'SELECT id, sync_uuid, entity_type_id, item_type_id FROM creature_drops WHERE id = $1', [f.drop.id]);
  assert.deepStrictEqual(drop, { id: f.drop.id, sync_uuid: f.gitDrop, entity_type_id: f.gob.id, item_type_id: f.sword.id });
  assert.ok(await baselineOf(pool, 'sx_edrop', f.gitGob));
  assert.ok(await baselineOf(pool, 'sx_edrop', f.gitDrop));
  assert.deepStrictEqual(await listed(pool, 'sx_edrop'), []);
});

p2Test('adopt decided git writes git values (refs resolved to local ids); decided local takes git identity only', async (t, pool) => {
  const f = await adoptPairFixture(pool);
  f.dr.chance = 0.9;
  writeDoc('sx_edrop', f.doc);
  const d = await sxListed(pool, 'sx_edrop');
  assert.strictEqual(d.rows.find((r) => r.syncUuid === f.gitDrop).defaultDecision, null, 'red: values differ');
  await apply(pool, 'sx_edrop', { [f.gitGob]: 'local', [f.gitDrop]: 'git' });
  const drop = await q1(pool, 'SELECT sync_uuid, entity_type_id, chance FROM creature_drops WHERE id = $1', [f.drop.id]);
  assert.deepStrictEqual(drop, { sync_uuid: f.gitDrop, entity_type_id: f.gob.id, chance: '0.9' });
  assert.strictEqual((await q1(pool, 'SELECT sync_uuid FROM entity_types WHERE id = $1', [f.gob.id])).sync_uuid, f.gitGob);
  assert.deepStrictEqual(await listed(pool, 'sx_edrop'), []);
});

p2Test('adopt of a child decided local keeps its values and its ref to the (adopted) local parent', async (t, pool) => {
  const f = await adoptPairFixture(pool);
  f.dr.chance = 0.9;
  writeDoc('sx_edrop', f.doc);
  await apply(pool, 'sx_edrop', { [f.gitDrop]: 'local' });
  const drop = await q1(pool, 'SELECT sync_uuid, entity_type_id, chance FROM creature_drops WHERE id = $1', [f.drop.id]);
  assert.deepStrictEqual(drop, { sync_uuid: f.gitDrop, entity_type_id: f.gob.id, chance: '0.5' });
  const after = await listed(pool, 'sx_edrop');
  assert.deepStrictEqual(after.map((r) => [r.syncUuid, r.kind]), [[f.gitDrop, 'not_exported']],
    'the kept local value is exportable, git acknowledged');
});

p2Test('game_settings: a value failing assertValid is refused (invalid_value) before any write; a valid one applies', async (t, pool) => {
  const orig = await q1(pool, "SELECT value, sync_uuid FROM game_settings WHERE key = 'respec_base_gold'");
  assert.ok(orig, 'scratch DB has respec_base_gold');
  try {
    await exportNow(pool, 'sx_set');
    const doc = readDoc('sx_set');
    const row = doc.tables.game_settings.find((r) => r.key === 'respec_base_gold');
    row.value = -5;
    writeDoc('sx_set', doc);
    const runs = await seedRunCount(pool);
    await assert.rejects(applyNow(pool, 'sx_set', {}), (e) => {
      refused('invalid_value')(e);
      assert.strictEqual(e.details.key, 'respec_base_gold');
      assert.match(e.details.error, /respec_base_gold must be an integer >= 0/);
      return true;
    });
    assert.deepStrictEqual((await q1(pool, "SELECT value FROM game_settings WHERE key = 'respec_base_gold'")).value, orig.value);
    assert.strictEqual(await seedRunCount(pool), runs);

    row.value = orig.value;
    doc.tables.game_settings.push({ key: 'sx_unknown_setting', value: 1, sync_uuid: crypto.randomUUID() });
    writeDoc('sx_set', doc);
    await assert.rejects(applyNow(pool, 'sx_set', {}),
      (e) => refused('invalid_value')(e) && e.details.key === 'sx_unknown_setting');
    assert.strictEqual((await pool.query("SELECT 1 FROM game_settings WHERE key = 'sx_unknown_setting'")).rowCount, 0);

    doc.tables.game_settings.pop();
    row.value = orig.value + 1;
    writeDoc('sx_set', doc);
    await apply(pool, 'sx_set', {});
    assert.strictEqual((await q1(pool, "SELECT value FROM game_settings WHERE key = 'respec_base_gold'")).value, orig.value + 1);
  } finally {
    await pool.query("UPDATE game_settings SET value = $1::jsonb WHERE key = 'respec_base_gold'", [JSON.stringify(orig.value)]);
    await pool.query("DELETE FROM game_settings WHERE key = 'sx_unknown_setting'");
  }
});

p2Test('apply waits for an open admin write to a group table; the committed edit is never overwritten', async (t, pool) => {
  const b = await addBehavior(pool, 'sx_b1');
  const ab = await addAbility(pool, b.id, 1);
  await exportNow(pool, 'sx_beh');
  const doc = readDoc('sx_beh');
  doc.tables.creature_behaviors.find((r) => r.sync_uuid === b.sync_uuid).aggro_radius = 9;
  doc.tables.creature_abilities.find((r) => r.sync_uuid === ab.sync_uuid).attack_range = 3;
  writeDoc('sx_beh', doc);
  const preview = await sxListed(pool, 'sx_beh');
  assert.strictEqual(preview.rows.length, 2);

  const editor = await pool.connect();
  let p;
  let open = true;
  try {
    await editor.query('BEGIN');
    await editor.query('UPDATE creature_abilities SET attack_range = 7 WHERE id = $1', [ab.id]);
    const editorPid = (await editor.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    p = applySeed(pool, 'sx_beh', defaultsOf(preview), { signature: preview.signature });
    p.catch(() => {});
    await pollUntil(async () => (await pool.query(
      'SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [editorPid],
    )).rows[0].n > 0, 'apply to block on the open edit of a child table');
    await editor.query('COMMIT');
    open = false;
  } finally {
    if (open) await editor.query('ROLLBACK').catch(() => {});
    editor.release();
  }
  await assert.rejects(p, refused('stale_preview'));
  assert.strictEqual((await q1(pool, 'SELECT attack_range FROM creature_abilities WHERE id = $1', [ab.id])).attack_range, 7);
  assert.strictEqual((await q1(pool, 'SELECT aggro_radius FROM creature_behaviors WHERE id = $1', [b.id])).aggro_radius, 5);
});

p2Test('apply also waits for an open write to a by-uuid ref target outside the group', async (t, pool) => {
  const b = await addBehavior(pool, 'sx_b1');
  const sk = await addSkill(pool, 'sx_sk');
  await addBehSkill(pool, b.id, sk.id, 1);
  await exportNow(pool, 'sx_beh');
  const doc = readDoc('sx_beh');
  doc.tables.creature_behaviors.find((r) => r.sync_uuid === b.sync_uuid).aggro_radius = 9;
  writeDoc('sx_beh', doc);
  const preview = await sxListed(pool, 'sx_beh');
  const editor = await pool.connect();
  let p;
  let open = true;
  try {
    await editor.query('BEGIN');
    await editor.query('UPDATE creature_skills SET cooldown_ms = 2000 WHERE id = $1', [sk.id]);
    const editorPid = (await editor.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    p = applySeed(pool, 'sx_beh', defaultsOf(preview), { signature: preview.signature });
    p.catch(() => {});
    await pollUntil(async () => (await pool.query(
      'SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [editorPid],
    )).rows[0].n > 0, 'apply to block on the open edit of creature_skills');
    await editor.query('COMMIT');
    open = false;
  } finally {
    if (open) await editor.query('ROLLBACK').catch(() => {});
    editor.release();
  }
  const res = await p;
  createdRuns.push(res.runId);
  assert.strictEqual(res.summary.updated, 1);
  assert.strictEqual((await q1(pool, 'SELECT cooldown_ms FROM creature_skills WHERE id = $1', [sk.id])).cooldown_ms, 2000);
  assert.strictEqual((await q1(pool, 'SELECT aggro_radius FROM creature_behaviors WHERE id = $1', [b.id])).aggro_radius, 9);
});

dbTest('auth_token is never written from a file, even when a changed row carries one', async (t, pool) => {
  await pool.query(
    "INSERT INTO ai_providers (name, base_url, request_template, auth_token) VALUES ('sx_p1', 'http://x', '{\"a\":1}', 'sx-secret')");
  const p1 = await snap(pool, 'ai_providers', 'sx_p1');
  await setBaseline(pool, 'ai_providers', p1);
  await writeGitWith(pool, 'ai_providers', [{ ...p1, model: 'sx-m', auth_token: 'sx-injected' }]);
  await apply(pool, 'ai_providers', {});
  const r = await q1(pool, "SELECT model, auth_token FROM ai_providers WHERE name = 'sx_p1'");
  assert.deepStrictEqual(r, { model: 'sx-m', auth_token: 'sx-secret' });
});
