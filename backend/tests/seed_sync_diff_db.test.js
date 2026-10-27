const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { Pool } = require('pg');
const { withSeedSyncLock, cleanupSx, makeTempSyncDir } = require('./helpers/seedSyncTest.js');

const DB_URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://user:password@localhost:15432/game_db';

// Baselines this file writes for uuids that have no local sx_ row (cleanupSx
// only clears baselines of rows that still exist).
let extraBaselines = [];

function dbTest(name, body) {
  test(name, async (t) => {
    if (!process.env.TEST_DATABASE_URL) {
      const msg = 'TEST_DATABASE_URL not set -- skipping to avoid mutating a real database (seed_sync diff)';
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
    const dropExtra = async () => {
      if (extraBaselines.length) {
        await pool.query('DELETE FROM seed_row_hashes WHERE sync_uuid = ANY($1::uuid[])', [extraBaselines]);
      }
      extraBaselines = [];
    };
    await withSeedSyncLock(pool, async () => {
      await cleanupSx(pool);
      try { await body(t, pool, dir); } finally {
        await dropExtra().catch(() => {});
        await cleanupSx(pool).catch(() => {});
      }
    });
  });
}

const { diffGroup } = require('../src/services/seedSync/diffGroup.js');
const { exportGroup, fileFor } = require('../src/services/seedSync/exportGroup.js');
const { SyncFileError, SyncRefused } = require('../src/services/seedSync/errors.js');
const { canonicalRow, rowHash, stableStringify } = require('../src/services/seedSync/canonical.js');
const { getGroup, soleSpec, liveColumns } = require('../src/services/seedSync/registry.js');

const KINDS = ['adopt_identity', 'changed', 'deleted_here', 'deleted_in_git', 'edited_here', 'new', 'not_exported', 'only_here'];

const addQuest = (pool, key) => pool.query(
  "INSERT INTO quests (key, title, act, description) VALUES ($1, 'sx t', 1, 'sx d')", [key]);

// Canonical form of a local row, exactly as export would write it.
async function snap(pool, groupId, key) {
  const g = soleSpec(getGroup(groupId));
  const cols = await liveColumns(pool, g);
  const { rows } = await pool.query(`SELECT * FROM ${g.table} WHERE ${g.naturalKey[0]} = $1`, [key]);
  return canonicalRow(rows[0], cols);
}

async function setBaseline(pool, groupId, row) {
  await pool.query(
    `INSERT INTO seed_row_hashes (group_id, sync_uuid, hash) VALUES ($1, $2, $3)
     ON CONFLICT (group_id, sync_uuid) DO UPDATE SET hash = EXCLUDED.hash`,
    [groupId, row.sync_uuid, rowHash(row)]);
  extraBaselines.push(row.sync_uuid);
}

function writeGit(groupId, rows, { raw = false } = {}) {
  const doc = {
    header: { group: groupId, exported_at: '2026-10-18T00:00:00.000Z', exported_by: 'sx-pc', schema_version: '', row_count: rows.length },
    rows,
  };
  fs.writeFileSync(fileFor(groupId), raw ? JSON.stringify(doc, null, 2) : `${stableStringify(doc)}\n`);
}

const sxRows = (diff) => diff.rows.filter((r) => String(r.key).startsWith('sx_'));
const only = (diff) => {
  const rows = sxRows(diff);
  assert.strictEqual(rows.length, 1, `expected one sx_ row, got ${JSON.stringify(rows)}`);
  return rows[0];
};

dbTest('identical row on both sides is not listed', async (t, pool) => {
  await addQuest(pool, 'sx_a');
  const s = await snap(pool, 'quests', 'sx_a');
  writeGit('quests', [s]);
  const d = await diffGroup(pool, 'quests');
  assert.deepStrictEqual(sxRows(d), []);
});

dbTest('changed', async (t, pool) => {
  await addQuest(pool, 'sx_a');
  const s = await snap(pool, 'quests', 'sx_a');
  await setBaseline(pool, 'quests', s);
  writeGit('quests', [{ ...s, title: 'sx git' }]);
  const r = only(await diffGroup(pool, 'quests'));
  assert.strictEqual(r.kind, 'changed');
  assert.strictEqual(r.defaultDecision, 'git');
  assert.strictEqual(r.syncUuid, s.sync_uuid);
  assert.strictEqual(r.key, 'sx_a');
  assert.strictEqual(r.blockedReason, null);
  assert.deepStrictEqual(r.fields, [{ name: 'title', local: 'sx t', git: 'sx git' }]);
});

dbTest('not_exported', async (t, pool) => {
  await addQuest(pool, 'sx_a');
  const s = await snap(pool, 'quests', 'sx_a');
  await setBaseline(pool, 'quests', s);
  writeGit('quests', [s]);
  await pool.query("UPDATE quests SET title = 'sx local' WHERE key = 'sx_a'");
  const r = only(await diffGroup(pool, 'quests'));
  assert.strictEqual(r.kind, 'not_exported');
  assert.strictEqual(r.defaultDecision, 'local');
  assert.deepStrictEqual(r.fields, [{ name: 'title', local: 'sx local', git: 'sx t' }]);
});

dbTest('edited_here when both sides moved', async (t, pool) => {
  await addQuest(pool, 'sx_a');
  const s = await snap(pool, 'quests', 'sx_a');
  await setBaseline(pool, 'quests', s);
  writeGit('quests', [{ ...s, title: 'sx git' }]);
  await pool.query("UPDATE quests SET title = 'sx local' WHERE key = 'sx_a'");
  const r = only(await diffGroup(pool, 'quests'));
  assert.strictEqual(r.kind, 'edited_here');
  assert.strictEqual(r.defaultDecision, null);
  assert.deepStrictEqual(r.fields, [{ name: 'title', local: 'sx local', git: 'sx git' }]);
});

dbTest('edited_here when no baseline (two PCs never synced)', async (t, pool) => {
  await addQuest(pool, 'sx_a');
  const s = await snap(pool, 'quests', 'sx_a');
  writeGit('quests', [{ ...s, exp_reward: 50 }]);
  const d = await diffGroup(pool, 'quests');
  const r = only(d);
  assert.strictEqual(r.kind, 'edited_here');
  assert.strictEqual(r.defaultDecision, null);
  assert.deepStrictEqual(r.fields, [{ name: 'exp_reward', local: 0, git: 50 }]);
  // Counts are over the whole table; measure the sx_ row's contribution.
  writeGit('quests', [s]);
  const same = await diffGroup(pool, 'quests');
  assert.strictEqual(d.counts.edited_here - same.counts.edited_here, 1);
  assert.strictEqual(d.localEdits - same.localEdits, 1, 'edited_here counts as a local edit');
  assert.strictEqual(d.gitChanges - same.gitChanges, 1, 'edited_here counts as a git change');
});

// Count deltas of the sx_ fixture against the same table with git == local.
async function deltas(pool, gitRows, sameRows) {
  const d = await diffGroup(pool, 'quests');
  writeGit('quests', sameRows);
  const base = await diffGroup(pool, 'quests');
  writeGit('quests', gitRows);
  return {
    d,
    localEdits: d.localEdits - base.localEdits,
    gitChanges: d.gitChanges - base.gitChanges,
    adopt: d.counts.adopt_identity - base.counts.adopt_identity,
  };
}

dbTest('adopt_identity on natural-key match with identical values defaults to git', async (t, pool) => {
  await addQuest(pool, 'sx_a');
  const s = await snap(pool, 'quests', 'sx_a');
  const gitUuid = crypto.randomUUID();
  const gitRows = [{ ...s, sync_uuid: gitUuid }];
  writeGit('quests', gitRows);
  const x = await deltas(pool, gitRows, [s]);
  const r = only(x.d); // the local row is consumed, never also only_here
  assert.strictEqual(r.kind, 'adopt_identity');
  assert.strictEqual(r.defaultDecision, 'git');
  assert.strictEqual(r.syncUuid, gitUuid);
  assert.strictEqual(r.key, 'sx_a');
  assert.deepStrictEqual(r.fields, []);
  assert.deepStrictEqual([x.adopt, x.gitChanges, x.localEdits], [1, 1, 0]);
});

dbTest('adopt_identity with differing values is red and counts on both sides', async (t, pool) => {
  await addQuest(pool, 'sx_a');
  const s = await snap(pool, 'quests', 'sx_a');
  const gitUuid = crypto.randomUUID();
  const gitRows = [{ ...s, sync_uuid: gitUuid, title: 'sx git' }];
  writeGit('quests', gitRows);
  const x = await deltas(pool, gitRows, [s]);
  const r = only(x.d);
  assert.strictEqual(r.kind, 'adopt_identity');
  assert.strictEqual(r.defaultDecision, null);
  assert.strictEqual(r.syncUuid, gitUuid);
  assert.deepStrictEqual(r.fields, [{ name: 'title', local: 'sx t', git: 'sx git' }]);
  assert.deepStrictEqual([x.adopt, x.gitChanges, x.localEdits], [1, 1, 1]);
});

dbTest('adopt_identity when deleted and recreated locally (git uuid has a baseline) is red', async (t, pool) => {
  await addQuest(pool, 'sx_a');
  const old = await snap(pool, 'quests', 'sx_a');
  await setBaseline(pool, 'quests', old);
  await pool.query("DELETE FROM quests WHERE key = 'sx_a'");
  await pool.query("INSERT INTO quests (key, title, act, description) VALUES ('sx_a', 'sx recreated', 1, 'sx d')");
  const now = await snap(pool, 'quests', 'sx_a');
  assert.notStrictEqual(now.sync_uuid, old.sync_uuid);
  writeGit('quests', [old]);
  const d = await diffGroup(pool, 'quests');
  const r = only(d); // not deleted_here + only_here
  assert.strictEqual(r.kind, 'adopt_identity');
  assert.strictEqual(r.syncUuid, old.sync_uuid);
  assert.strictEqual(r.defaultDecision, null);
  assert.deepStrictEqual(r.fields, [{ name: 'title', local: 'sx recreated', git: 'sx t' }]);
});

dbTest('adopt_identity not offered when the natural-key local row has a baseline', async (t, pool) => {
  await addQuest(pool, 'sx_a');
  const s = await snap(pool, 'quests', 'sx_a');
  await setBaseline(pool, 'quests', s);
  const gitUuid = crypto.randomUUID();
  writeGit('quests', [{ ...s, sync_uuid: gitUuid }]);
  const rows = sxRows(await diffGroup(pool, 'quests'));
  const byUuid = Object.fromEntries(rows.map((r) => [r.syncUuid, r.kind]));
  assert.deepStrictEqual(byUuid, { [gitUuid]: 'new', [s.sync_uuid]: 'deleted_in_git' });
});

dbTest('adopt_identity not offered when the natural-key local row uuid is in git', async (t, pool) => {
  await addQuest(pool, 'sx_a');
  const s = await snap(pool, 'quests', 'sx_a');
  const gitUuid = crypto.randomUUID();
  // git renamed the local row's identity to sx_b and has a different sx_a.
  writeGit('quests', [{ ...s, sync_uuid: gitUuid }, { ...s, key: 'sx_b' }]);
  const rows = sxRows(await diffGroup(pool, 'quests'));
  const byUuid = Object.fromEntries(rows.map((r) => [r.syncUuid, r.kind]));
  assert.deepStrictEqual(byUuid, { [gitUuid]: 'new', [s.sync_uuid]: 'edited_here' });
});

dbTest('deleted_here', async (t, pool) => {
  await addQuest(pool, 'sx_a');
  const s = await snap(pool, 'quests', 'sx_a');
  await setBaseline(pool, 'quests', s);
  await pool.query("DELETE FROM quests WHERE key = 'sx_a'");
  writeGit('quests', [s]);
  const r = only(await diffGroup(pool, 'quests'));
  assert.strictEqual(r.kind, 'deleted_here');
  assert.strictEqual(r.defaultDecision, 'local');
  assert.strictEqual(r.syncUuid, s.sync_uuid);
  assert.strictEqual(r.key, 'sx_a');
  assert.deepStrictEqual(r.fields, []);
});

dbTest('new', async (t, pool) => {
  await addQuest(pool, 'sx_a');
  const s = await snap(pool, 'quests', 'sx_a');
  await pool.query("DELETE FROM quests WHERE key = 'sx_a'");
  writeGit('quests', [s]);
  const r = only(await diffGroup(pool, 'quests'));
  assert.strictEqual(r.kind, 'new');
  assert.strictEqual(r.defaultDecision, 'git');
  assert.strictEqual(r.key, 'sx_a');
  assert.deepStrictEqual(r.fields, []);
});

dbTest('deleted_in_git', async (t, pool) => {
  await addQuest(pool, 'sx_a');
  const s = await snap(pool, 'quests', 'sx_a');
  await setBaseline(pool, 'quests', s);
  writeGit('quests', []);
  const r = only(await diffGroup(pool, 'quests'));
  assert.strictEqual(r.kind, 'deleted_in_git');
  assert.strictEqual(r.defaultDecision, 'delete');
  assert.deepStrictEqual(r.fields, []);
});

dbTest('only_here', async (t, pool) => {
  await addQuest(pool, 'sx_a'); // never exported: no baseline
  await addQuest(pool, 'sx_b'); // exported, then edited locally, then dropped from git
  const b = await snap(pool, 'quests', 'sx_b');
  await setBaseline(pool, 'quests', b);
  await pool.query("UPDATE quests SET title = 'sx local' WHERE key = 'sx_b'");
  writeGit('quests', []);
  const rows = sxRows(await diffGroup(pool, 'quests'));
  assert.deepStrictEqual(rows.map((r) => [r.key, r.kind, r.defaultDecision, r.fields]),
    [['sx_a', 'only_here', 'local', []], ['sx_b', 'only_here', 'local', []]]);
});

dbTest('fields lists only differing columns', async (t, pool) => {
  await addQuest(pool, 'sx_a');
  const s = await snap(pool, 'quests', 'sx_a');
  await setBaseline(pool, 'quests', s);
  writeGit('quests', [{ ...s, title: 'sx git', gold_reward: 7, npc_key: 'sx_npc' }]);
  const r = only(await diffGroup(pool, 'quests'));
  assert.deepStrictEqual(r.fields, [
    { name: 'gold_reward', local: 0, git: 7 },
    { name: 'npc_key', local: null, git: 'sx_npc' },
    { name: 'title', local: 'sx t', git: 'sx git' },
  ]);
});

dbTest('hand-edited file with unsorted row keys hashes the same', async (t, pool) => {
  await addQuest(pool, 'sx_a');
  const s = await snap(pool, 'quests', 'sx_a');
  await setBaseline(pool, 'quests', s);
  const reversed = {};
  for (const k of Object.keys(s).reverse()) reversed[k] = s[k];
  reversed.id = 999; // a hand-added non-exported column is ignored, not hashed
  writeGit('quests', [reversed], { raw: true });
  const text = fs.readFileSync(fileFor('quests'), 'utf8');
  assert.ok(text.indexOf('"title"') < text.indexOf('"act"'), 'fixture really is unsorted');
  const d = await diffGroup(pool, 'quests');
  assert.deepStrictEqual(sxRows(d), []);
});

// Pool wrapper that records every row any query returns to JS.
function spyPool(pool) {
  const seen = [];
  const wrap = (q) => async (...a) => { const r = await q(...a); seen.push(...(r.rows || [])); return r; };
  return {
    seen,
    query: wrap(pool.query.bind(pool)),
    connect: async () => {
      const c = await pool.connect();
      return { query: wrap(c.query.bind(c)), release: (...a) => c.release(...a) };
    },
  };
}

dbTest('ai_providers diff never exposes auth_token', async (t, pool) => {
  const before = await diffGroup(pool, 'ai_providers');
  await pool.query(
    `INSERT INTO ai_providers (name, base_url, request_template, auth_token, auth_header_name) VALUES
       ('sx_p', 'http://x', '{}', 'sx-secret', 'Authorization'),
       ('sx_q', 'http://q', '{}', 'sx-secret', 'Authorization'),
       ('sx_r', 'http://r', '{}', NULL, 'Authorization'),
       ('sx_s', 'http://s', '{}', '', 'X-Key'),
       ('sx_t', 'http://t', '{}', NULL, NULL),
       ('sx_u', 'http://u', '{}', '', ''),
       ('sx_v', 'http://v', '{}', NULL, '  ')`);
  const p = await snap(pool, 'ai_providers', 'sx_p');
  const q = await snap(pool, 'ai_providers', 'sx_q');
  assert.ok(!('auth_token' in p));
  // sx_p differs from git only in its token (git never has one): not listed.
  // sx_q differs in base_url: listed, still without the token.
  writeGit('ai_providers', [p, { ...q, base_url: 'http://q2' }]);
  const spy = spyPool(pool);
  const d = await diffGroup(spy, 'ai_providers');
  assert.ok(spy.seen.length > 0);
  assert.ok(spy.seen.every((row) => !('auth_token' in row)), 'token values never read into JS');
  const rows = sxRows(d);
  assert.deepStrictEqual(rows.filter((r) => r.key === 'sx_p'), []);
  const rq = rows.find((r) => r.key === 'sx_q');
  assert.strictEqual(rq.kind, 'edited_here');
  assert.deepStrictEqual(rq.fields, [{ name: 'base_url', local: 'http://q', git: 'http://q2' }]);
  const json = JSON.stringify(d);
  assert.ok(!json.includes('sx-secret'));
  assert.ok(!json.includes('auth_token'));
  assert.strictEqual(d.tokensMissing - before.tokensMissing, 2,
    'NULL and empty tokens counted only where an auth header is configured');
  const quests = await diffGroup(pool, 'quests');
  assert.strictEqual(quests.tokensMissing, 0, 'only groups with secret columns count tokens');
});

// With no export file, the status depends on whether this PC ever exported
// the group (an ok export run); the DB may hold real history.
async function noFileStatus(db, groupId) {
  const { rows } = await db.query(
    "SELECT EXISTS (SELECT 1 FROM seed_export_runs WHERE group_id = $1 AND action = 'export' AND status = 'ok') AS x",
    [groupId]);
  return rows[0].x ? 'file_missing' : 'never_exported';
}

function assertEmptyNoFile(d) {
  assert.strictEqual(d.header, null);
  assert.deepStrictEqual(d.rows, []);
  assert.deepStrictEqual(Object.keys(d.counts).sort(), KINDS);
  assert.ok(Object.values(d.counts).every((n) => n === 0));
  assert.strictEqual(d.localEdits, 0);
  assert.strictEqual(d.gitChanges, 0);
}

dbTest('no file: never_exported without an ok export run here, file_missing with one', async (t, pool) => {
  // Run history is real state: change it only inside a rolled-back transaction.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("DELETE FROM seed_export_runs WHERE group_id = 'quests' AND action = 'export'");
    // Neither a failed/running export, an ok seed, nor another group's export counts.
    await client.query(`INSERT INTO seed_export_runs (group_id, action, status, pc_label) VALUES
      ('quests', 'export', 'failed', 'sx'), ('quests', 'export', 'running', 'sx'),
      ('quests', 'seed', 'ok', 'sx'), ('tile_types', 'export', 'ok', 'sx')`);
    const none = await diffGroup(client, 'quests');
    assert.strictEqual(none.status, 'never_exported');
    assertEmptyNoFile(none);
    await client.query("INSERT INTO seed_export_runs (group_id, action, status, pc_label) VALUES ('quests', 'export', 'ok', 'sx')");
    const missing = await diffGroup(client, 'quests');
    assert.strictEqual(missing.status, 'file_missing');
    assertEmptyNoFile(missing);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
});

dbTest('status precedence', async (t, pool) => {
  // no file: never_exported / file_missing
  const none = await diffGroup(pool, 'quests');
  assert.strictEqual(none.status, await noFileStatus(pool, 'quests'));
  assert.strictEqual(none.header, null);
  assert.deepStrictEqual(none.rows, []);
  assert.deepStrictEqual(Object.keys(none.counts).sort(), KINDS);
  assert.ok(Object.values(none.counts).every((n) => n === 0));
  assert.strictEqual(none.localEdits, 0);
  assert.strictEqual(none.gitChanges, 0);

  await addQuest(pool, 'sx_a');
  await addQuest(pool, 'sx_b');
  await exportGroup(pool, 'quests');
  const synced = await diffGroup(pool, 'quests');
  assert.strictEqual(synced.status, 'in_sync');
  assert.strictEqual(synced.header.group, 'quests');
  assert.deepStrictEqual(Object.keys(synced.counts).sort(), KINDS);

  // git moved sx_a -> git_newer
  const doc = JSON.parse(fs.readFileSync(fileFor('quests'), 'utf8'));
  doc.tables.quests.find((r) => r.key === 'sx_a').title = 'sx git';
  fs.writeFileSync(fileFor('quests'), `${stableStringify(doc)}\n`);
  const gitNewer = await diffGroup(pool, 'quests');
  assert.strictEqual(gitNewer.status, 'git_newer');
  assert.strictEqual(gitNewer.counts.changed, 1);
  assert.strictEqual(gitNewer.gitChanges, 1);
  assert.strictEqual(gitNewer.localEdits, 0);

  // local moved sx_b too -> local_edits wins
  await pool.query("UPDATE quests SET title = 'sx local' WHERE key = 'sx_b'");
  const both = await diffGroup(pool, 'quests');
  assert.strictEqual(both.status, 'local_edits');
  assert.strictEqual(both.counts.not_exported, 1);
  assert.strictEqual(both.localEdits, 1);
  assert.strictEqual(both.gitChanges, 1);

  // tokens_missing: below git_newer, above in_sync
  await pool.query(
    "INSERT INTO ai_providers (name, base_url, request_template, auth_header_name) VALUES ('sx_p', 'http://x', '{}', 'Authorization')");
  await exportGroup(pool, 'ai_providers');
  const tm = await diffGroup(pool, 'ai_providers');
  assert.ok(tm.tokensMissing >= 1);
  assert.strictEqual(tm.status, 'tokens_missing');
  const pdoc = JSON.parse(fs.readFileSync(fileFor('ai_providers'), 'utf8'));
  pdoc.tables.ai_providers.find((r) => r.name === 'sx_p').base_url = 'http://git';
  fs.writeFileSync(fileFor('ai_providers'), `${stableStringify(pdoc)}\n`);
  assert.strictEqual((await diffGroup(pool, 'ai_providers')).status, 'git_newer');
  await pool.query("UPDATE ai_providers SET model = 'sx-m' WHERE name = 'sx_p'");
  assert.strictEqual((await diffGroup(pool, 'ai_providers')).status, 'local_edits');
});

dbTest('schema_newer: status right after never_exported; export refuses', async (t, pool) => {
  await addQuest(pool, 'sx_a');
  await exportGroup(pool, 'quests');
  const doc = JSON.parse(fs.readFileSync(fileFor('quests'), 'utf8'));
  // Also a git change and a local edit: schema_newer still wins.
  doc.tables.quests.find((r) => r.key === 'sx_a').title = 'sx git';
  doc.header.schema_version = '9999999999999_from_the_future';
  const text = `${stableStringify(doc)}\n`;
  fs.writeFileSync(fileFor('quests'), text);
  await addQuest(pool, 'sx_b');
  const d = await diffGroup(pool, 'quests');
  assert.strictEqual(d.status, 'schema_newer');
  assert.strictEqual(d.counts.changed, 1, 'counts still computed');
  const runsBefore = (await pool.query("SELECT count(*)::int AS n FROM seed_export_runs WHERE group_id='quests'")).rows[0].n;
  await assert.rejects(exportGroup(pool, 'quests'),
    (e) => e instanceof SyncRefused && e.code === 'schema_newer' && e.message === 'run migrations first');
  assert.strictEqual(fs.readFileSync(fileFor('quests'), 'utf8'), text, 'file untouched');
  const runsAfter = (await pool.query("SELECT count(*)::int AS n FROM seed_export_runs WHERE group_id='quests'")).rows[0].n;
  assert.strictEqual(runsAfter, runsBefore);
  // An older or equal version is not schema_newer.
  const current = (await pool.query('SELECT max(name) AS v FROM pgmigrations')).rows[0].v;
  fs.writeFileSync(fileFor('quests'), `${stableStringify({ ...doc, header: { ...doc.header, schema_version: current } })}\n`);
  assert.strictEqual((await diffGroup(pool, 'quests')).status, 'local_edits');
});

dbTest('row_count mismatch and non-uuid sync_uuid are bad files', async (t, pool) => {
  const u = crypto.randomUUID();
  const write = (header, rows) => fs.writeFileSync(fileFor('quests'), JSON.stringify({ header: { group: 'quests', ...header }, rows }));
  write({ row_count: 2 }, [{ key: 'sx_a', sync_uuid: u }]);
  await assert.rejects(diffGroup(pool, 'quests'), (e) => e instanceof SyncFileError && /row_count/.test(e.message));
  write({}, [{ key: 'sx_a', sync_uuid: u }]);
  await assert.rejects(diffGroup(pool, 'quests'), (e) => e instanceof SyncFileError && /row_count/.test(e.message));
  for (const bad of [u.toUpperCase(), 'not-a-uuid', `{${u}}`, u.replace(/-/g, '')]) {
    write({ row_count: 1 }, [{ key: 'sx_a', sync_uuid: bad }]);
    await assert.rejects(diffGroup(pool, 'quests'),
      (e) => e instanceof SyncFileError && e.file === 'quests.json' && /not a lowercase uuid/.test(e.message), bad);
  }
  write({ row_count: 0 }, []);
  assert.strictEqual((await diffGroup(pool, 'quests')).header.row_count, 0);
});

dbTest('invalid JSON file raises SyncFileError with file name', async (t, pool) => {
  fs.writeFileSync(fileFor('quests'), '{ nope');
  await assert.rejects(diffGroup(pool, 'quests'),
    (e) => e instanceof SyncFileError && e.code === 'bad_file' && e.file === 'quests.json' && /quests\.json/.test(e.message));
  fs.writeFileSync(fileFor('quests'), '{"rows":[]}');
  await assert.rejects(diffGroup(pool, 'quests'), (e) => e instanceof SyncFileError && e.file === 'quests.json');
  // header names another group
  fs.writeFileSync(fileFor('quests'), JSON.stringify({ header: { group: 'tile_types' }, rows: [] }));
  await assert.rejects(diffGroup(pool, 'quests'), (e) => e instanceof SyncFileError && e.file === 'quests.json');
  // a row without sync_uuid
  fs.writeFileSync(fileFor('quests'), JSON.stringify({ header: { group: 'quests' }, rows: [{ key: 'sx_a' }] }));
  await assert.rejects(diffGroup(pool, 'quests'), (e) => e instanceof SyncFileError && e.file === 'quests.json');
  // a row that is not an object
  fs.writeFileSync(fileFor('quests'), JSON.stringify({ header: { group: 'quests' }, rows: ['sx_a'] }));
  await assert.rejects(diffGroup(pool, 'quests'), (e) => e instanceof SyncFileError && /row 0 is not an object/.test(e.message));
  // a row without its natural key
  fs.writeFileSync(fileFor('quests'), JSON.stringify({ header: { group: 'quests' }, rows: [{ sync_uuid: crypto.randomUUID() }] }));
  await assert.rejects(diffGroup(pool, 'quests'), (e) => e instanceof SyncFileError && /has no key/.test(e.message));
  // duplicate natural key
  fs.writeFileSync(fileFor('quests'), JSON.stringify({ header: { group: 'quests' },
    rows: [{ key: 'sx_a', sync_uuid: crypto.randomUUID() }, { key: 'sx_a', sync_uuid: crypto.randomUUID() }] }));
  await assert.rejects(diffGroup(pool, 'quests'), (e) => e instanceof SyncFileError && /duplicate key/.test(e.message));
  // duplicate sync_uuid
  const u = crypto.randomUUID();
  fs.writeFileSync(fileFor('quests'), JSON.stringify({ header: { group: 'quests' },
    rows: [{ key: 'sx_a', sync_uuid: u }, { key: 'sx_b', sync_uuid: u }] }));
  await assert.rejects(diffGroup(pool, 'quests'), (e) => e instanceof SyncFileError && /duplicate sync_uuid/.test(e.message));
});

dbTest('header returns only the known fields', async (t, pool) => {
  fs.writeFileSync(fileFor('quests'), JSON.stringify({
    header: { group: 'quests', exported_at: 'x', exported_by: 'sx-pc', schema_version: 'v', row_count: 0, auth_token: 'sx-secret' },
    rows: [],
  }));
  const d = await diffGroup(pool, 'quests');
  assert.deepStrictEqual(d.header,
    { group: 'quests', exported_at: 'x', exported_by: 'sx-pc', schema_version: 'v', row_count: 0 });
  assert.ok(!JSON.stringify(d).includes('sx-secret'));
});

dbTest('exportGroup refuses with git_newer when gitChanges > 0', async (t, pool) => {
  await addQuest(pool, 'sx_a');
  await exportGroup(pool, 'quests');
  const doc = JSON.parse(fs.readFileSync(fileFor('quests'), 'utf8'));
  doc.tables.quests.find((r) => r.key === 'sx_a').title = 'sx git';
  const edited = `${stableStringify(doc)}\n`;
  fs.writeFileSync(fileFor('quests'), edited);
  const runsBefore = (await pool.query("SELECT count(*)::int AS n FROM seed_export_runs WHERE group_id='quests'")).rows[0].n;
  await assert.rejects(exportGroup(pool, 'quests'),
    (e) => e instanceof SyncRefused && e.code === 'git_newer' && e.message === 'seed (preview) first'
      && e.details.gitChanges === 1);
  assert.strictEqual(fs.readFileSync(fileFor('quests'), 'utf8'), edited, 'file untouched');
  const runsAfter = (await pool.query("SELECT count(*)::int AS n FROM seed_export_runs WHERE group_id='quests'")).rows[0].n;
  assert.strictEqual(runsAfter, runsBefore, 'refused before a run is started');

  // local-only edits never block an export
  fs.writeFileSync(fileFor('quests'), `${stableStringify({ ...doc, tables: { quests: doc.tables.quests.map((r) => (r.key === 'sx_a' ? { ...r, title: 'sx t' } : r)) } })}\n`);
  await pool.query("UPDATE quests SET title = 'sx local' WHERE key = 'sx_a'");
  assert.strictEqual((await diffGroup(pool, 'quests')).status, 'local_edits');
  await exportGroup(pool, 'quests');
  assert.strictEqual((await diffGroup(pool, 'quests')).status, 'in_sync');
});

dbTest('exportGroup propagates SyncFileError over a corrupt file', async (t, pool) => {
  fs.writeFileSync(fileFor('quests'), '{ nope');
  await assert.rejects(exportGroup(pool, 'quests'), (e) => e instanceof SyncFileError);
  assert.strictEqual(fs.readFileSync(fileFor('quests'), 'utf8'), '{ nope');
});

// ---- Plan 2: multi-table groups, translated refs, display keys, names ----

const { _withTestGroups } = require('../src/services/seedSync/registry.js');
const { computeDiff, localByKeyOf } = require('../src/services/seedSync/diffGroup.js');
const { annotate, KEY_CLASH_REASON } = require('../src/services/seedSync/applySeed.js');

// TEST-ONLY groups over real tables (Task 6 registers the real ones).
const LOCAL_COLS = { id: 'local', created_at: 'local', updated_at: 'local', sync_uuid: 'identity' };
const ELEMENT_REF = { table: 'elements', by: 'key', keyCol: 'name' };
const aurasSpec = {
  table: 'aura_effects', naturalKey: ['name'], omit: LOCAL_COLS, secretColumns: [], refs: { dot_element: ELEMENT_REF },
};
const entSpec = {
  table: 'entity_types',
  naturalKey: ['name'],
  omit: { ...LOCAL_COLS, ai_provider_id: 'test group', point_kind: 'test group', behavior_id: 'test group' },
  secretColumns: [],
  refs: { element: ELEMENT_REF },
  nameRefs: {
    auras: { table: 'aura_effects', keyCol: 'name', shape: 'array' },
    // Test-only: exercises the object-values shape against a table in the group.
    vfx: { table: 'aura_effects', keyCol: 'name', shape: 'object-values' },
  },
};
const dropsSpec = {
  table: 'creature_drops',
  naturalKey: ['entity_type_id', 'item_type_id'],
  omit: { id: 'local', created_at: 'local', sync_uuid: 'identity' },
  secretColumns: [],
  refs: {
    entity_type_id: { table: 'entity_types', by: 'uuid' },
    item_type_id: { table: 'item_types', by: 'uuid' },
  },
};
const itemsSpecD = {
  table: 'item_types',
  naturalKey: ['name'],
  omit: LOCAL_COLS,
  secretColumns: [],
  refs: {
    ammo_type_id: { table: 'item_types', by: 'uuid' },
    element: ELEMENT_REF,
    attack_origin: { table: 'attack_origins', by: 'key', keyCol: 'name' },
    projectile_shape_id: { table: 'projectile_shapes', by: 'key', keyCol: 'name' },
    impact_behavior_id: { table: 'impact_behaviors', by: 'key', keyCol: 'name' },
  },
};
const SX_ENT = { id: 'sx_ent', label: 'SX entities', tables: [aurasSpec, entSpec, dropsSpec] };
const SX_ITEMS_D = { id: 'sx_items_d', label: 'SX items', tables: [itemsSpecD] };
const withGroups = (fn) => _withTestGroups([SX_ENT, SX_ITEMS_D], fn);

const q1 = async (pool, sql, params) => (await pool.query(sql, params)).rows[0];
const addItem = (pool, name) => q1(pool,
  "INSERT INTO item_types (name, category, damage, cooldown, stackable) VALUES ($1, 'ammo', 0, 0, true) RETURNING id, sync_uuid",
  [name]);
const addEnt = (pool, name, extra = {}) => q1(pool,
  `INSERT INTO entity_types (name, color, auras, vfx) VALUES ($1, '#010203', $2::jsonb, $3::jsonb)
   RETURNING id, sync_uuid`,
  [name, JSON.stringify(extra.auras || []), extra.vfx ? JSON.stringify(extra.vfx) : null]);
const addDrop = (pool, entId, itemId, chance = 0.5) => q1(pool,
  'INSERT INTO creature_drops (entity_type_id, item_type_id, chance) VALUES ($1, $2, $3) RETURNING sync_uuid',
  [entId, itemId, chance]);
const addAura = (pool, name) => q1(pool,
  'INSERT INTO aura_effects (name, radius) VALUES ($1, 10) RETURNING sync_uuid', [name]);

const readDoc = (groupId) => JSON.parse(fs.readFileSync(fileFor(groupId), 'utf8'));
function writeDoc(groupId, doc) {
  for (const [tbl, rows] of Object.entries(doc.tables)) doc.header.row_counts[tbl] = rows.length;
  fs.writeFileSync(fileFor(groupId), `${stableStringify(doc)}\n`);
}
const sxWarnings = (d) => d.warnings.filter((w) => String(w.key).startsWith('sx_'));
const pick = (r) => ({ table: r.table, key: r.key, kind: r.kind });

dbTest('multi-table: counts summed over tables, per-table counts, child edited on both sides is red', async (t, pool) => {
  await withGroups(async () => {
    const gob = await addEnt(pool, 'sx_gob');
    await addEnt(pool, 'sx_orc');
    const sword = await addItem(pool, 'sx_sword');
    const drop = await addDrop(pool, gob.id, sword.id, 0.5);
    await exportGroup(pool, 'sx_ent');
    const synced = await diffGroup(pool, 'sx_ent');
    assert.strictEqual(synced.status, 'in_sync');
    assert.deepStrictEqual(synced.rows, []);

    const doc = readDoc('sx_ent');
    doc.tables.entity_types.find((r) => r.name === 'sx_orc').color = '#0a0b0c'; // git only -> changed
    doc.tables.creature_drops.find((r) => r.sync_uuid === drop.sync_uuid).chance = 0.25; // git ...
    writeDoc('sx_ent', doc);
    await pool.query('UPDATE creature_drops SET chance = 0.75 WHERE sync_uuid = $1', [drop.sync_uuid]); // ... and local

    const d = await diffGroup(pool, 'sx_ent');
    assert.deepStrictEqual(sxRows(d).map(pick), [
      { table: 'entity_types', key: 'sx_orc', kind: 'changed' },
      { table: 'creature_drops', key: 'sx_gob → sx_sword', kind: 'edited_here' },
    ], 'rows in group table order');
    const red = sxRows(d)[1];
    assert.strictEqual(red.syncUuid, drop.sync_uuid);
    assert.strictEqual(red.defaultDecision, null);
    assert.deepStrictEqual(red.keyParts, ['sx_gob', 'sx_sword']);
    assert.deepStrictEqual(red.fields, [{ name: 'chance', local: 0.75, git: 0.25 }]);
    assert.deepStrictEqual(d.tables.map((x) => x.table), ['aura_effects', 'entity_types', 'creature_drops']);
    const byTable = Object.fromEntries(d.tables.map((x) => [x.table, x.counts]));
    assert.strictEqual(byTable.entity_types.changed, 1);
    assert.strictEqual(byTable.creature_drops.edited_here, 1);
    for (const k of KINDS) {
      assert.strictEqual(d.counts[k], d.tables.reduce((n, x) => n + x.counts[k], 0), `counts.${k} is the sum`);
    }
    assert.strictEqual(d.counts.changed, 1);
    assert.strictEqual(d.counts.edited_here, 1);
    assert.strictEqual(d.localEdits, 1);
    assert.strictEqual(d.gitChanges, 2);
    assert.strictEqual(d.status, 'local_edits');
  });
});

dbTest('the diff hashes the exported form: export baseline == hL of an unchanged row with refs', async (t, pool) => {
  await withGroups(async () => {
    const gob = await addEnt(pool, 'sx_gob');
    const sword = await addItem(pool, 'sx_sword');
    const drop = await addDrop(pool, gob.id, sword.id);
    await exportGroup(pool, 'sx_ent');
    const cd = await computeDiff(pool, 'sx_ent');
    const local = cd.tables.get('creature_drops').local.get(drop.sync_uuid);
    assert.strictEqual(local.row.entity_type_id, gob.sync_uuid, 'local row compared in translated form');
    assert.strictEqual(local.row.item_type_id, sword.sync_uuid);
    const b = await q1(pool, 'SELECT hash FROM seed_row_hashes WHERE group_id = $1 AND sync_uuid = $2', ['sx_ent', drop.sync_uuid]);
    assert.strictEqual(local.hash, b.hash);
    const fileRow = readDoc('sx_ent').tables.creature_drops.find((r) => r.sync_uuid === drop.sync_uuid);
    assert.strictEqual(rowHash(fileRow), b.hash);
    assert.ok(cd.inSync.some((s) => s.table === 'creature_drops' && s.syncUuid === drop.sync_uuid && s.hasBaseline));
  });
});

dbTest('adopt_identity matches on the translated composite natural key', async (t, pool) => {
  await withGroups(async () => {
    const gob = await addEnt(pool, 'sx_gob');
    const sword = await addItem(pool, 'sx_sword');
    await exportGroup(pool, 'sx_ent');
    const local = await addDrop(pool, gob.id, sword.id, 0.5); // created here after the export: no baseline
    const gitUuid = crypto.randomUUID();
    const doc = readDoc('sx_ent');
    const gitRow = {
      sync_uuid: gitUuid, entity_type_id: gob.sync_uuid, item_type_id: sword.sync_uuid, chance: 0.5, min_qty: 1, max_qty: 1,
    };
    doc.tables.creature_drops.push(gitRow);
    writeDoc('sx_ent', doc);
    let r = only(await diffGroup(pool, 'sx_ent')); // the local row is consumed, never also only_here
    assert.deepStrictEqual(r, {
      table: 'creature_drops', syncUuid: gitUuid, key: 'sx_gob → sx_sword', keyParts: ['sx_gob', 'sx_sword'],
      kind: 'adopt_identity', defaultDecision: 'git', fields: [], blockedReason: null,
    });
    assert.notStrictEqual(local.sync_uuid, gitUuid);
    gitRow.chance = 0.9;
    writeDoc('sx_ent', doc);
    r = only(await diffGroup(pool, 'sx_ent'));
    assert.strictEqual(r.kind, 'adopt_identity');
    assert.strictEqual(r.defaultDecision, null, 'differing values are red');
    assert.deepStrictEqual(r.fields, [{ name: 'chance', local: 0.5, git: 0.9 }]);
  });
});

dbTest('display key: a git-only parent shows its git key, an unknown target its uuid prefix', async (t, pool) => {
  await withGroups(async () => {
    const gob = await addEnt(pool, 'sx_gob');
    const sword = await addItem(pool, 'sx_sword');
    await exportGroup(pool, 'sx_ent');
    const doc = readDoc('sx_ent');
    const ghostUuid = crypto.randomUUID();
    const gobRow = doc.tables.entity_types.find((r) => r.name === 'sx_gob');
    doc.tables.entity_types.push({ ...gobRow, name: 'sx_ghost', sync_uuid: ghostUuid });
    const nowhere = crypto.randomUUID();
    const drop = (e, i) => ({ sync_uuid: crypto.randomUUID(), entity_type_id: e, item_type_id: i, chance: 0.5, min_qty: 1, max_qty: 1 });
    doc.tables.creature_drops.push(drop(ghostUuid, sword.sync_uuid), drop(gob.sync_uuid, nowhere));
    writeDoc('sx_ent', doc);
    const d = await diffGroup(pool, 'sx_ent');
    const drops = sxRows(d).filter((r) => r.table === 'creature_drops');
    assert.deepStrictEqual(drops.map((r) => [r.key, r.keyParts, r.kind]), [
      ['sx_ghost → sx_sword', ['sx_ghost', 'sx_sword'], 'new'],
      [`sx_gob → ${nowhere.slice(0, 8)}`, ['sx_gob', nowhere.slice(0, 8)], 'new'],
    ]);
  });
});

dbTest('dangling_name warnings: names neither local nor in the group file, sorted, never blocking', async (t, pool) => {
  await withGroups(async () => {
    await addAura(pool, 'sx_aura_here');
    await exportGroup(pool, 'sx_ent');
    const doc = readDoc('sx_ent');
    const hereRow = doc.tables.aura_effects.find((r) => r.name === 'sx_aura_here');
    doc.tables.aura_effects.push({ ...hereRow, name: 'sx_aura_git', sync_uuid: crypto.randomUUID() }); // created by the file
    const gob = await addEnt(pool, 'sx_gob', {
      auras: ['sx_aura_here', 'sx_aura_git', 'sx_aura_nope'],
      vfx: { hit: 'sx_vfx_nope', cast: 'sx_aura_here', n: 3 },
    });
    const ghostUuid = crypto.randomUUID();
    const tmpl = doc.tables.entity_types[0];
    doc.tables.entity_types.push({ ...tmpl, name: 'sx_ghost', sync_uuid: ghostUuid, auras: ['sx_aura_ghost', 'sx_aura_git'], vfx: null });
    writeDoc('sx_ent', doc);
    const d = await diffGroup(pool, 'sx_ent');
    const w = (key, syncUuid, column, name) => ({ code: 'dangling_name', table: 'entity_types', key, column, name, target: 'aura_effects', syncUuid });
    assert.deepStrictEqual(sxWarnings(d), [
      w('sx_ghost', ghostUuid, 'auras', 'sx_aura_ghost'),
      w('sx_gob', gob.sync_uuid, 'auras', 'sx_aura_nope'),
      w('sx_gob', gob.sync_uuid, 'vfx', 'sx_vfx_nope'),
    ]);
    assert.deepStrictEqual((await diffGroup(pool, 'sx_ent')).warnings, d.warnings, 'deterministic');
    assert.ok(d.rows.some((r) => r.key === 'sx_ghost' && r.kind === 'new'), 'diff unaffected');
    // A name also present locally after all: the warning goes away.
    await addAura(pool, 'sx_aura_nope');
    assert.deepStrictEqual(sxWarnings(await diffGroup(pool, 'sx_ent')).map((x) => x.name), ['sx_aura_ghost', 'sx_vfx_nope']);
  });
});

dbTest('Plan-1 group: output unchanged apart from table, keyParts, tables and warnings', async (t, pool) => {
  await addQuest(pool, 'sx_a');
  await addQuest(pool, 'sx_b');
  await exportGroup(pool, 'quests');
  const doc = readDoc('quests');
  doc.tables.quests.find((r) => r.key === 'sx_a').title = 'sx git';
  writeDoc('quests', doc);
  await pool.query("UPDATE quests SET title = 'sx local' WHERE key = 'sx_b'");
  await addQuest(pool, 'sx_c');
  const a = await snap(pool, 'quests', 'sx_a');
  const b = await snap(pool, 'quests', 'sx_b');
  const c = await snap(pool, 'quests', 'sx_c');
  const d = await diffGroup(pool, 'quests');
  assert.deepStrictEqual(Object.keys(d).sort(),
    ['counts', 'gitChanges', 'groupId', 'header', 'localEdits', 'rows', 'status', 'tables', 'tokensMissing', 'warnings']);
  const row = (s, kind, defaultDecision, fields) => ({
    table: 'quests', syncUuid: s.sync_uuid, key: s.key, keyParts: [s.key], kind, defaultDecision, fields, blockedReason: null,
  });
  assert.deepStrictEqual(sxRows(d), [
    row(a, 'changed', 'git', [{ name: 'title', local: 'sx t', git: 'sx git' }]),
    row(b, 'not_exported', 'local', [{ name: 'title', local: 'sx local', git: 'sx t' }]),
    row(c, 'only_here', 'local', []),
  ]);
  assert.deepStrictEqual(d.tables, [{ table: 'quests', counts: d.counts }]);
  assert.deepStrictEqual(d.warnings, []);
  assert.deepStrictEqual(Object.keys(d.counts).sort(), KINDS);
  assert.strictEqual(d.status, 'local_edits');
  const none = await diffGroup(pool, 'tile_types'); // no file in this temp dir
  assert.strictEqual(none.header, null);
  assert.deepStrictEqual(none.tables, [{ table: 'tile_types', counts: none.counts }]);
});

dbTest('pool diff reads one consistent snapshot and is not blocked by an open writer', async (t, pool) => {
  await withGroups(async () => {
    const gob = await addEnt(pool, 'sx_gob');
    const sword = await addItem(pool, 'sx_sword');
    await addDrop(pool, gob.id, sword.id);
    await exportGroup(pool, 'sx_ent');
    const { Client } = require('pg');
    const writer = new Client({ connectionString: DB_URL });
    await writer.connect();
    const prev = process.env.SEED_SYNC_LOCK_TIMEOUT_MS;
    try {
      await writer.query('BEGIN');
      const w = (await writer.query(
        "INSERT INTO entity_types (name, color) VALUES ('sx_w', '#010203') RETURNING id")).rows[0];
      await writer.query('INSERT INTO creature_drops (entity_type_id, item_type_id, chance) VALUES ($1, $2, 0.5)', [w.id, sword.id]);
      await writer.query("UPDATE entity_types SET color = '#0a0b0c' WHERE name = 'sx_gob'");
      process.env.SEED_SYNC_LOCK_TIMEOUT_MS = '300'; // a lock wait would fail fast
      const d = await diffGroup(pool, 'sx_ent');
      assert.strictEqual(d.status, 'in_sync', 'uncommitted writes are invisible');
      assert.deepStrictEqual(sxRows(d), []);
    } finally {
      if (prev === undefined) delete process.env.SEED_SYNC_LOCK_TIMEOUT_MS; else process.env.SEED_SYNC_LOCK_TIMEOUT_MS = prev;
      await writer.query('ROLLBACK').catch(() => {});
      await writer.end().catch(() => {});
    }
  });
});

// Both PCs created Goblin and its drop after the migration: same names,
// different random uuids for the parent AND the child.
async function adoptedParentFixture(pool, { keepChildBaseline = false } = {}) {
  const gob = await addEnt(pool, 'sx_gob');
  const sword = await addItem(pool, 'sx_sword');
  const drop = await addDrop(pool, gob.id, sword.id, 0.5);
  await exportGroup(pool, 'sx_ent');
  const forget = keepChildBaseline ? [gob.sync_uuid] : [gob.sync_uuid, drop.sync_uuid];
  await pool.query('DELETE FROM seed_row_hashes WHERE group_id = $1 AND sync_uuid = ANY($2::uuid[])', ['sx_ent', forget]);
  const doc = readDoc('sx_ent');
  const gitGob = crypto.randomUUID();
  const gitDrop = crypto.randomUUID();
  doc.tables.entity_types.find((r) => r.name === 'sx_gob').sync_uuid = gitGob;
  const dr = doc.tables.creature_drops.find((r) => r.sync_uuid === drop.sync_uuid);
  Object.assign(dr, { sync_uuid: gitDrop, entity_type_id: gitGob });
  writeDoc('sx_ent', doc);
  return { gob, drop, gitGob, gitDrop, doc, dr };
}

dbTest('a child of an adopted parent is adopt_identity too (deep natural key), red when values differ', async (t, pool) => {
  await withGroups(async () => {
    const f = await adoptedParentFixture(pool);
    let d = await diffGroup(pool, 'sx_ent');
    assert.deepStrictEqual(sxRows(d).map((r) => [r.table, r.syncUuid, r.key, r.kind, r.defaultDecision, r.fields]), [
      ['entity_types', f.gitGob, 'sx_gob', 'adopt_identity', 'git', []],
      ['creature_drops', f.gitDrop, 'sx_gob → sx_sword', 'adopt_identity', 'git', []],
    ], 'no new + only_here pair; the parent uuid alone is not a value difference');
    f.dr.chance = 0.9;
    writeDoc('sx_ent', f.doc);
    d = await diffGroup(pool, 'sx_ent');
    const child = sxRows(d).find((r) => r.table === 'creature_drops');
    assert.strictEqual(child.kind, 'adopt_identity');
    assert.strictEqual(child.defaultDecision, null);
    assert.deepStrictEqual(child.fields, [{ name: 'chance', local: 0.5, git: 0.9 }]);
    const cd = await computeDiff(pool, 'sx_ent');
    assert.strictEqual(localByKeyOf(cd, child).row.sync_uuid, f.drop.sync_uuid, 'the local child it adopts');
  });
});

dbTest('a parent renamed in git while a new one took its name: the child ref really changed (red)', async (t, pool) => {
  await withGroups(async () => {
    const x = await addEnt(pool, 'sx_arrow');
    const sword = await addItem(pool, 'sx_sword');
    const child = await addDrop(pool, x.id, sword.id, 0.5);
    await exportGroup(pool, 'sx_ent');
    // The local child was never synced: adoptable by its deep key.
    await pool.query('DELETE FROM seed_row_hashes WHERE group_id = $1 AND sync_uuid = $2', ['sx_ent', child.sync_uuid]);
    const doc = readDoc('sx_ent');
    const xRow = doc.tables.entity_types.find((r) => r.sync_uuid === x.sync_uuid);
    const yUuid = crypto.randomUUID();
    doc.tables.entity_types.push({ ...xRow, sync_uuid: yUuid }); // new Y takes the name ...
    xRow.name = 'sx_arrow_old'; // ... X is renamed
    const gitChild = crypto.randomUUID();
    const dr = doc.tables.creature_drops.find((r) => r.sync_uuid === child.sync_uuid);
    Object.assign(dr, { sync_uuid: gitChild, entity_type_id: yUuid });
    writeDoc('sx_ent', doc);
    const d = await diffGroup(pool, 'sx_ent');
    const r = sxRows(d).find((x2) => x2.table === 'creature_drops');
    assert.strictEqual(r.kind, 'adopt_identity');
    assert.strictEqual(r.syncUuid, gitChild);
    assert.strictEqual(r.defaultDecision, null, 'red, not default git');
    assert.deepStrictEqual(r.fields, [{ name: 'entity_type_id', local: x.sync_uuid, git: yUuid }]);
    assert.deepStrictEqual(sxRows(d).filter((x2) => x2.table === 'entity_types').map((x2) => [x2.syncUuid, x2.kind]).sort(),
      [[x.sync_uuid, 'changed'], [yUuid, 'new']].sort());
  });
});

dbTest('key-clash annotation finds a clashing child through the deep natural key', async (t, pool) => {
  await withGroups(async () => {
    // The local child keeps its baseline: not adoptable, so git's child is new
    // and the local one deleted_in_git -- both hold "sx_gob → sx_sword".
    const f = await adoptedParentFixture(pool, { keepChildBaseline: true });
    const cd = await computeDiff(pool, 'sx_ent');
    const kinds = Object.fromEntries(cd.diff.rows.filter((r) => r.table === 'creature_drops' && String(r.key).startsWith('sx_'))
      .map((r) => [r.syncUuid, r.kind]));
    assert.deepStrictEqual(kinds, { [f.gitDrop]: 'new', [f.drop.sync_uuid]: 'deleted_in_git' });
    const row = () => cd.diff.rows.find((r) => r.syncUuid === f.gitDrop);
    annotate(cd, new Map(), { [f.drop.sync_uuid]: 'local' }); // keep the local child
    assert.strictEqual(row().blockedReason, KEY_CLASH_REASON);
    assert.strictEqual(row().defaultDecision, null);
    const fresh = await computeDiff(pool, 'sx_ent');
    annotate(fresh, new Map(), {}); // default: the local child is deleted -> no clash
    assert.strictEqual(fresh.diff.rows.find((r) => r.syncUuid === f.gitDrop).blockedReason, null);
  });
});

dbTest("dangling_name for the 'text' shape", async (t, pool) => {
  const skillsSpec = {
    table: 'creature_skills', naturalKey: ['name'], omit: LOCAL_COLS, secretColumns: [], refs: {},
    nameRefs: { summon_entity: { table: 'entity_types', keyCol: 'name', shape: 'text' } },
  };
  await _withTestGroups([{ id: 'sx_skills', label: 'SX skills', tables: [skillsSpec] }], async () => {
    await addEnt(pool, 'sx_gob');
    const ins = (name, summon) => q1(pool,
      "INSERT INTO creature_skills (name, kind, cooldown_ms, summon_entity) VALUES ($1, 'summon', 1000, $2) RETURNING sync_uuid",
      [name, summon]);
    const bad = await ins('sx_sk_bad', 'sx_nope');
    await ins('sx_sk_ok', 'sx_gob');
    await ins('sx_sk_none', null);
    const d = await diffGroup(pool, 'sx_skills');
    assert.deepStrictEqual(sxWarnings(d), [{
      code: 'dangling_name', table: 'creature_skills', key: 'sx_sk_bad', column: 'summon_entity', name: 'sx_nope',
      target: 'entity_types', syncUuid: bad.sync_uuid,
    }]);
  });
});

dbTest('re-export over an existing multi-table file: allowed in sync, refused git_newer', async (t, pool) => {
  await withGroups(async () => {
    const gob = await addEnt(pool, 'sx_gob');
    const sword = await addItem(pool, 'sx_sword');
    const drop = await addDrop(pool, gob.id, sword.id);
    await exportGroup(pool, 'sx_ent');
    await exportGroup(pool, 'sx_ent');
    const doc = readDoc('sx_ent');
    doc.tables.creature_drops.find((r) => r.sync_uuid === drop.sync_uuid).max_qty = 3;
    writeDoc('sx_ent', doc);
    const text = fs.readFileSync(fileFor('sx_ent'), 'utf8');
    await assert.rejects(exportGroup(pool, 'sx_ent'),
      (e) => e instanceof SyncRefused && e.code === 'git_newer' && e.details.gitChanges === 1);
    assert.strictEqual(fs.readFileSync(fileFor('sx_ent'), 'utf8'), text, 'file untouched');
  });
});
