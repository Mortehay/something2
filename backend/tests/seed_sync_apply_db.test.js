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
const { getGroup, liveColumns } = require('../src/services/seedSync/registry.js');
const { recentRuns } = require('../src/services/seedSync/runs.js');

const addQuest = (pool, key, title = 'sx t') => pool.query(
  "INSERT INTO quests (key, title, act, description) VALUES ($1, $2, 1, 'sx d')", [key, title]);

// Canonical form of every local row of a group, exactly as export writes it.
async function snapAll(pool, groupId) {
  const g = getGroup(groupId);
  const cols = await liveColumns(pool, g);
  const { rows } = await pool.query(`SELECT * FROM ${g.table}`);
  return rows.map((r) => canonicalRow(r, cols));
}

async function snap(pool, groupId, key) {
  const g = getGroup(groupId);
  return (await snapAll(pool, groupId)).find((r) => r[g.naturalKey] === key);
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
  const g = getGroup(groupId);
  const others = (await snapAll(pool, groupId)).filter((r) => !String(r[g.naturalKey]).startsWith('sx_'));
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

async function apply(pool, groupId, decisions) {
  const res = await applySeed(pool, groupId, decisions);
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
  await writeGitWith(pool, 'quests', [gitA, { ...b, title: 'sx git b' }]);
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
  assert.strictEqual(await baselineOf(pool, 'quests', b.sync_uuid), rowHash(b), 'local keeps its old B');
});

dbTest('undecided red row refuses', async (t, pool) => {
  await addQuest(pool, 'sx_a');
  const a = await snap(pool, 'quests', 'sx_a');
  await writeGitWith(pool, 'quests', [{ ...a, title: 'sx git' }]); // no baseline: edited_here
  assert.strictEqual(byKey(await onlySxListed(pool, 'quests'), 'sx_a').kind, 'edited_here');
  const runs = await seedRunCount(pool);
  await assert.rejects(applySeed(pool, 'quests', {}), refused('undecided', [a.sync_uuid]));
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
  await assert.rejects(applySeed(pool, 'quests', {}), refused('undecided', [gitUuid]));
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
  assert.strictEqual(byKey(await diffGroup(pool, 'quests'), 'sx_q').blockedReason, null);

  await assert.rejects(applySeed(pool, 'quests', { [q.sync_uuid]: 'delete' }), refused('blocked', [q.sync_uuid]));
  // The default for deleted_in_git is delete: it is blocked too.
  await assert.rejects(applySeed(pool, 'quests', {}), refused('blocked', [q.sync_uuid]));
  assert.strictEqual((await questState(pool)).length, 1, 'quest still exists');
  const cq = await pool.query('SELECT 1 FROM character_quests WHERE character_id = $1', [charId]);
  assert.strictEqual(cq.rowCount, 1, 'player data untouched');

  const res = await apply(pool, 'quests', { [q.sync_uuid]: 'local' });
  assert.strictEqual(res.summary.kept, 1);
  assert.strictEqual((await questState(pool)).length, 1);
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
  await assert.rejects(applySeed(pool, 'quests', {}), refused('schema_newer'));
  assert.strictEqual((await questState(pool))[0].title, 'sx t');
  assert.strictEqual(await seedRunCount(pool), runs);
});

dbTest('no export file refuses with no_export', async (t, pool) => {
  await assert.rejects(applySeed(pool, 'quests', {}), refused('no_export'));
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

dbTest('failure mid-apply rolls back everything', async (t, pool) => {
  await addQuest(pool, 'sx_a');
  await addQuest(pool, 'sx_b');
  const a = await snap(pool, 'quests', 'sx_a');
  const b = await snap(pool, 'quests', 'sx_b');
  await setBaseline(pool, 'quests', a);
  await setBaseline(pool, 'quests', b);
  const clash = { ...b, sync_uuid: crypto.randomUUID(), title: 'sx clash' };
  // sx_a changed (git); local sx_b gone in git (kept local); git adds a NEW row
  // with natural key sx_b -> INSERT hits quests_key_key (23505).
  await writeGitWith(pool, 'quests', [{ ...a, title: 'sx git a' }, clash]);
  const d = await onlySxListed(pool, 'quests');
  assert.deepStrictEqual(sxRows(d).map((r) => [r.key, r.kind]).sort(),
    [['sx_a', 'changed'], ['sx_b', 'deleted_in_git'], ['sx_b', 'new']]);
  const uuids = [a.sync_uuid, b.sync_uuid, clash.sync_uuid];
  const beforeQ = await questState(pool);
  const beforeB = await baselineState(pool, uuids);

  await assert.rejects(applySeed(pool, 'quests', { [b.sync_uuid]: 'local' }), (e) => e.code === '23505');
  assert.deepStrictEqual(await questState(pool), beforeQ);
  assert.deepStrictEqual(await baselineState(pool, uuids), beforeB);
  const run = (await recentRuns(pool, { groupId: 'quests', limit: 1 }))[0];
  createdRuns.push(run.id);
  assert.strictEqual(run.action, 'seed');
  assert.strictEqual(run.status, 'failed');
  assert.match(run.error, /quests_key_key|duplicate/);
  assert.ok(run.finished_at);
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
  await assert.rejects(applySeed(pool, 'quests', { [a.sync_uuid]: 'delete' }), refused('invalid_decision', [a.sync_uuid]));
  await assert.rejects(applySeed(pool, 'quests', { [o.sync_uuid]: 'git' }), refused('invalid_decision', [o.sync_uuid]));
  await assert.rejects(applySeed(pool, 'quests', { [a.sync_uuid]: 'bogus' }), refused('invalid_decision', [a.sync_uuid]));
  assert.deepStrictEqual((await questState(pool)).map((r) => r.title), ['sx t', 'sx t']);
});

dbTest('decision for a uuid not in the diff refuses stale_preview', async (t, pool) => {
  await addQuest(pool, 'sx_a');
  const a = await snap(pool, 'quests', 'sx_a');
  await setBaseline(pool, 'quests', a);
  await writeGitWith(pool, 'quests', [{ ...a, title: 'sx git' }]);
  const ghost = crypto.randomUUID();
  await assert.rejects(applySeed(pool, 'quests', { [ghost]: 'git' }), refused('stale_preview', [ghost]));
  assert.strictEqual((await questState(pool))[0].title, 'sx t');
});

dbTest('apply recomputes the diff: a row edited after the preview must be re-decided', async (t, pool) => {
  await addQuest(pool, 'sx_a');
  const a = await snap(pool, 'quests', 'sx_a');
  await setBaseline(pool, 'quests', a);
  await writeGitWith(pool, 'quests', [{ ...a, title: 'sx git' }]);
  const preview = await onlySxListed(pool, 'quests');
  assert.strictEqual(byKey(preview, 'sx_a').kind, 'changed');
  // Someone edits the row between preview and apply: it is now edited_here.
  await pool.query("UPDATE quests SET title = 'sx late edit' WHERE key = 'sx_a'");
  // The preview's 'git' default must not carry over: apply re-diffs under its
  // lock, sees a red row and demands a decision.
  await assert.rejects(applySeed(pool, 'quests', {}), refused('undecided', [a.sync_uuid]));
  assert.strictEqual((await questState(pool))[0].title, 'sx late edit');
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
