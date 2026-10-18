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
const { getGroup, liveColumns } = require('../src/services/seedSync/registry.js');

const KINDS = ['adopt_identity', 'changed', 'deleted_here', 'deleted_in_git', 'edited_here', 'new', 'not_exported', 'only_here'];

const addQuest = (pool, key) => pool.query(
  "INSERT INTO quests (key, title, act, description) VALUES ($1, 'sx t', 1, 'sx d')", [key]);

// Canonical form of a local row, exactly as export would write it.
async function snap(pool, groupId, key) {
  const g = getGroup(groupId);
  const cols = await liveColumns(pool, g);
  const { rows } = await pool.query(`SELECT * FROM ${g.table} WHERE ${g.naturalKey} = $1`, [key]);
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
    `INSERT INTO ai_providers (name, base_url, request_template, auth_token) VALUES
       ('sx_p', 'http://x', '{}', 'sx-secret'),
       ('sx_q', 'http://q', '{}', 'sx-secret'),
       ('sx_r', 'http://r', '{}', NULL),
       ('sx_s', 'http://s', '{}', '')`);
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
  assert.strictEqual(d.tokensMissing - before.tokensMissing, 2, 'NULL and empty tokens counted');
  const quests = await diffGroup(pool, 'quests');
  assert.strictEqual(quests.tokensMissing, 0, 'only groups with secret columns count tokens');
});

dbTest('status precedence', async (t, pool) => {
  // never_exported: no file
  const none = await diffGroup(pool, 'quests');
  assert.strictEqual(none.status, 'never_exported');
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
  doc.rows.find((r) => r.key === 'sx_a').title = 'sx git';
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
  await pool.query("INSERT INTO ai_providers (name, base_url, request_template) VALUES ('sx_p', 'http://x', '{}')");
  await exportGroup(pool, 'ai_providers');
  const tm = await diffGroup(pool, 'ai_providers');
  assert.ok(tm.tokensMissing >= 1);
  assert.strictEqual(tm.status, 'tokens_missing');
  const pdoc = JSON.parse(fs.readFileSync(fileFor('ai_providers'), 'utf8'));
  pdoc.rows.find((r) => r.name === 'sx_p').base_url = 'http://git';
  fs.writeFileSync(fileFor('ai_providers'), `${stableStringify(pdoc)}\n`);
  assert.strictEqual((await diffGroup(pool, 'ai_providers')).status, 'git_newer');
  await pool.query("UPDATE ai_providers SET model = 'sx-m' WHERE name = 'sx_p'");
  assert.strictEqual((await diffGroup(pool, 'ai_providers')).status, 'local_edits');
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
  doc.rows.find((r) => r.key === 'sx_a').title = 'sx git';
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
  fs.writeFileSync(fileFor('quests'), `${stableStringify({ ...doc, rows: doc.rows.map((r) => (r.key === 'sx_a' ? { ...r, title: 'sx t' } : r)) })}\n`);
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
