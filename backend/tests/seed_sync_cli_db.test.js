const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Pool } = require('pg');
const { withSeedSyncLock, cleanupSx, makeTempSyncDir } = require('./helpers/seedSyncTest.js');
const { GROUPS } = require('../src/services/seedSync/registry.js');
const { fileFor } = require('../src/services/seedSync/exportGroup.js');

const DB_URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://user:password@localhost:15432/game_db';
const SCRIPT = path.join(__dirname, '..', 'scripts', 'seed-sync.js');
const { decide, progressPrinter } = require('../scripts/seed-sync.js');
const ALL_IDS = GROUPS.map((g) => g.id);

// The CLI writes through the real engine: exports rewrite baselines of every
// group they touch and add runs. Both are snapshotted/restored like the
// round-trip test.
const baselinesOf = async (pool) => (await pool.query(
  `SELECT group_id, sync_uuid::text AS sync_uuid, hash FROM seed_row_hashes
    WHERE group_id = ANY($1::text[]) ORDER BY group_id, sync_uuid`, [ALL_IDS])).rows;

async function restoreBaselines(pool, snapshot) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM seed_row_hashes WHERE group_id = ANY($1::text[])', [ALL_IDS]);
    if (snapshot.length) {
      await client.query(
        `INSERT INTO seed_row_hashes (group_id, sync_uuid, hash)
         SELECT * FROM unnest($1::text[], $2::uuid[], $3::text[])`,
        [snapshot.map((r) => r.group_id), snapshot.map((r) => r.sync_uuid), snapshot.map((r) => r.hash)]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

function dbTest(name, body) {
  test(name, async (t) => {
    if (!process.env.TEST_DATABASE_URL) {
      const msg = 'TEST_DATABASE_URL not set -- skipping to avoid mutating a real database (seed_sync cli)';
      if (process.env.CI) assert.fail(msg);
      t.skip(msg);
      return;
    }
    const dir = makeTempSyncDir();
    const prev = process.env.SEED_SYNC_DIR;
    process.env.SEED_SYNC_DIR = dir; // fileFor() in this process; child gets it via env
    const pool = new Pool({ connectionString: DB_URL, max: 4, connectionTimeoutMillis: 3000 });
    t.after(async () => {
      if (prev === undefined) delete process.env.SEED_SYNC_DIR; else process.env.SEED_SYNC_DIR = prev;
      fs.rmSync(dir, { recursive: true, force: true });
      await pool.end().catch(() => {});
    });
    await withSeedSyncLock(pool, async () => {
      await cleanupSx(pool);
      await pool.query("DELETE FROM chest_loot WHERE level_min = 9101");
      const snapshot = await baselinesOf(pool);
      const watermark = (await pool.query('SELECT coalesce(max(id), 0)::int AS m FROM seed_export_runs')).rows[0].m;
      let failure = null;
      try { await body(t, pool, dir); } catch (e) { failure = e; } finally {
        await pool.query('DELETE FROM chest_loot WHERE level_min = 9101').catch(() => {});
        await cleanupSx(pool).catch(() => {});
        await pool.query('DELETE FROM seed_export_runs WHERE id > $1', [watermark]).catch(() => {});
        await restoreBaselines(pool, snapshot);
      }
      if (failure) throw failure;
      assert.deepStrictEqual(await baselinesOf(pool), snapshot, 'real baselines restored exactly');
    });
  });
}

// `--all` includes the binary groups (art, audio): their repo files go under
// the temp sync dir, and the object store is pointed at a closed port, so the
// child can never read the real store (the scratch DB holds no asset keys
// anyway: those groups export without touching it).
function cli(args, env = {}) {
  const base = {
    ...process.env,
    DATABASE_URL: DB_URL,
    SEED_SYNC_DIR: process.env.SEED_SYNC_DIR,
    SEED_ASSETS_ROOT: path.join(process.env.SEED_SYNC_DIR, 'assets'),
    MINIO_ENDPOINT: 'http://127.0.0.1:1',
    MINIO_PORT: '1',
  };
  for (const [k, v] of Object.entries(env)) { if (v === null) delete base[k]; else base[k] = v; }
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { env: base, encoding: 'utf8', timeout: 120000 });
  const lines = r.stdout.split('\n').filter(Boolean);
  return { code: r.status, out: r.stdout, err: r.stderr, lines, line: (g) => lines.find((l) => l.startsWith(`${g} `)) };
}

const radiusOf = async (pool) => (await pool.query("SELECT radius FROM aura_effects WHERE name = 'sx_cli_aura'")).rows[0];
const rewriteFile = (group, fn) => {
  const doc = JSON.parse(fs.readFileSync(fileFor(group), 'utf8'));
  fn(doc);
  fs.writeFileSync(fileFor(group), `${JSON.stringify(doc, null, 2)}\n`);
};
const mkAura = (pool) => pool.query("INSERT INTO aura_effects (name, radius, dot_element) VALUES ('sx_cli_aura', 50, 'fire')");

// Aura row edited here AND changed in git: the red (edited_here) case.
async function makeRed(pool) {
  await mkAura(pool);
  assert.strictEqual(cli(['export', '--group=aura_effects']).code, 0);
  await pool.query("UPDATE aura_effects SET radius = 60 WHERE name = 'sx_cli_aura'");
  rewriteFile('aura_effects', (d) => { d.tables.aura_effects.find((r) => r.name === 'sx_cli_aura').radius = 70; });
}

dbTest('status prints one line per group in registry order, exit 0', async () => {
  const r = cli(['status']);
  assert.strictEqual(r.code, 0, r.err);
  assert.deepStrictEqual(r.lines.map((l) => l.split(' ')[0]), ALL_IDS);
  assert.ok(r.lines.every((l) => l.split(' ').length === 4), r.out);
  // Empty temp dir: never_exported, or file_missing on a DB that has an ok
  // export run of the group from elsewhere (e.g. a browser verification).
  assert.match(r.line('aura_effects'), /^aura_effects (never_exported|file_missing) 0 0$/);
  const one = cli(['status', '--group=aura_effects']);
  assert.strictEqual(one.lines.length, 1);
});

dbTest('export then status is in_sync', async (t, pool) => {
  await mkAura(pool);
  const e = cli(['export', '--group=aura_effects']);
  assert.strictEqual(e.code, 0, e.err);
  assert.match(e.line('aura_effects'), /^aura_effects ok rows=\d+ run=\d+$/);
  assert.match(cli(['status', '--group=aura_effects']).line('aura_effects'), /^aura_effects in_sync 0 0$/);
});

dbTest('seed refuses red rows without --resolve (exit 2), DB unchanged', async (t, pool) => {
  await makeRed(pool);
  const r = cli(['seed', '--group=aura_effects']);
  assert.strictEqual(r.code, 2, r.out + r.err);
  assert.match(r.line('aura_effects'), /^aura_effects refused:undecided /);
  assert.strictEqual((await radiusOf(pool)).radius, 60);
});

dbTest('seed --resolve=git applies git for red rows; --resolve=local keeps', async (t, pool) => {
  await makeRed(pool);
  const keep = cli(['seed', '--group=aura_effects', '--resolve=local']);
  assert.strictEqual(keep.code, 0, keep.out + keep.err);
  assert.strictEqual((await radiusOf(pool)).radius, 60);
  // local acknowledged git's version; make a fresh red row for the git case.
  await pool.query("UPDATE aura_effects SET radius = 61 WHERE name = 'sx_cli_aura'");
  rewriteFile('aura_effects', (d) => { d.tables.aura_effects.find((r) => r.name === 'sx_cli_aura').radius = 71; });
  const r = cli(['seed', '--group=aura_effects', '--resolve=git']);
  assert.strictEqual(r.code, 0, r.out + r.err);
  assert.match(r.line('aura_effects'), /^aura_effects ok /);
  assert.strictEqual((await radiusOf(pool)).radius, 71);
});

dbTest('--resolve=git never deletes a blocked row', async (t, pool) => {
  await pool.query(`INSERT INTO item_types (name, category, damage, cooldown) VALUES ('sx_cli_gem', 'currency', 0, 0)`);
  const gem = (await pool.query("SELECT id FROM item_types WHERE name = 'sx_cli_gem'")).rows[0].id;
  await pool.query('INSERT INTO chest_loot (level_min, level_max, item_type_id, chance) VALUES (9101, 9102, $1, 0.5)', [gem]);
  assert.strictEqual(cli(['export', '--group=items']).code, 0);
  rewriteFile('items', (d) => {
    d.tables.item_types = d.tables.item_types.filter((r) => r.name !== 'sx_cli_gem');
    if (d.header.row_counts) d.header.row_counts.item_types = d.tables.item_types.length;
  });
  const r = cli(['seed', '--group=items', '--resolve=git']);
  assert.strictEqual(r.code, 0, r.out + r.err);
  assert.match(r.line('items'), /^items ok .*"deleted":0/);
  assert.match(r.line('items'), /"kept":[1-9]/, 'the blocked row was seen and kept');
  assert.strictEqual((await pool.query("SELECT count(*)::int AS n FROM item_types WHERE name = 'sx_cli_gem'")).rows[0].n, 1,
    'blocked row kept, not deleted');
});

dbTest('export --all continues past a refused group; exit 2', async (t, pool) => {
  await mkAura(pool);
  assert.strictEqual(cli(['export', '--group=aura_effects']).code, 0);
  rewriteFile('aura_effects', (d) => { d.tables.aura_effects.find((r) => r.name === 'sx_cli_aura').radius = 99; });
  const r = cli(['export', '--all']);
  assert.strictEqual(r.code, 2, r.out + r.err);
  assert.deepStrictEqual(r.lines.map((l) => l.split(' ')[0]), ALL_IDS, 'every group reported, in order');
    const refusedLines = r.lines.filter((l) => /^\S+ refused:/.test(l));
  assert.ok(refusedLines.some((l) => l.startsWith('aura_effects ')), r.out);
  const ok = r.lines.filter((l) => /^\S+ ok /.test(l));
  assert.strictEqual(ok.length, ALL_IDS.length - refusedLines.length, 'every non-refused group exported');
  assert.ok(ok.length >= 1, r.out);
});

test('missing DATABASE_URL -> exit 1 with a clear message, no fallback', () => {
  const r = spawnSync(process.execPath, [SCRIPT, 'status'], {
    env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 30000,
  });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /DATABASE_URL is not set/);
  assert.strictEqual(r.stdout, '');
});

test('decide: defaults kept, red rows take --resolve, forbidden git degrades to local with a note', () => {
  const rows = [
    { syncUuid: 'a', kind: 'changed', defaultDecision: 'git' },
    { syncUuid: 'b', kind: 'edited_here', defaultDecision: null },
    { syncUuid: 'c', kind: 'new', defaultDecision: null, blockedReason: 'key already used by a local row', table: 't', key: 'k' },
  ];
  const git = decide(rows, 'git');
  assert.deepStrictEqual(git.decisions, { a: 'git', b: 'git', c: 'local' });
  assert.strictEqual(git.notes.length, 1);
  assert.match(git.notes[0], /key already used/);
  assert.strictEqual(git.undecided, 0);
  assert.deepStrictEqual(decide(rows, 'local').decisions, { a: 'git', b: 'local', c: 'local' });
  const none = decide(rows, null);
  assert.strictEqual(none.undecided, 2);
  assert.deepStrictEqual(none.decisions, { a: 'git' });
});

test('progressPrinter: at most one line per 250 ms, plus the final line on flush', () => {
  const lines = [];
  let t = 1000;
  const p = progressPrinter('art', { write: (l) => lines.push(l), now: () => t });
  p({ phase: 'download', done: 1, total: 5 }); // printed (first)
  t += 100; p({ phase: 'download', done: 2, total: 5 }); // throttled
  t += 100; p({ phase: 'download', done: 3, total: 5 }); // throttled
  t += 60; p({ phase: 'download', done: 4, total: 5 }); // 260 ms since the last line: printed
  t += 10; p({ phase: 'download', done: 5, total: 5 }); // throttled ...
  p.flush(); // ... but it is the last one
  p.flush(); // nothing new
  assert.deepStrictEqual(lines, ['progress art download 1/5', 'progress art download 4/5', 'progress art download 5/5']);
  const quiet = [];
  progressPrinter('quests', { write: (l) => quiet.push(l) }).flush();
  assert.deepStrictEqual(quiet, [], 'a data group prints no progress');
});
