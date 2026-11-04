const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Pool } = require('pg');
const { withSeedSyncLock } = require('./helpers/seedSyncTest.js');
const { getGroup } = require('../src/services/seedSync/registry.js');
const { BOARD_SEED_GROUPS } = require('../src/services/seedSync/boardSeedGroups.js');

// Only ever TEST_DATABASE_URL: no DATABASE_URL / dev-URL fallback, and never
// the dev database itself.
const DB_URL = process.env.TEST_DATABASE_URL;
const SCRIPT = path.join(__dirname, '..', 'scripts', 'seed-sync.js');
// Database name of a URL, percent-decoded; an unparseable URL or an empty name
// throws instead of being treated as safe.
function dbName(url) {
  let name;
  try { name = decodeURIComponent(new URL(url).pathname.replace(/^\//, '')); } catch { name = ''; }
  if (!name) throw new Error('TEST_DATABASE_URL is unparseable or names no database; refusing');
  return name;
}

function dbTest(name, body) {
  test(name, async (t) => {
    if (!DB_URL) {
      const msg = 'TEST_DATABASE_URL not set -- skipping to avoid touching a real database (board seed scope)';
      if (process.env.CI) assert.fail(msg);
      t.skip(msg);
      return;
    }
    assert.notStrictEqual(dbName(DB_URL), 'game_db', 'TEST_DATABASE_URL points at the dev database game_db; refusing');
    const pool = new Pool({ connectionString: DB_URL, max: 4, connectionTimeoutMillis: 3000 });
    t.after(async () => { await pool.end().catch(() => {}); });
    await withSeedSyncLock(pool, () => body(t, pool));
  });
}

// users, characters and every table with a user_id / character_id column.
async function playerTables(pool) {
  const { rows } = await pool.query(
    `SELECT DISTINCT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name IN ('user_id', 'character_id')
        AND table_name IN (SELECT table_name FROM information_schema.tables
                            WHERE table_schema = 'public' AND table_type = 'BASE TABLE')`);
  return [...new Set(['users', 'characters', ...rows.map((r) => r.table_name)])].sort();
}

const quoteIdent = (s) => `"${String(s).replace(/"/g, '""')}"`;
async function fingerprint(pool, tables) {
  const out = {};
  for (const tb of tables) {
    const q = quoteIdent(tb);
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n, coalesce(md5(string_agg(x::text, '|' ORDER BY x::text)), '') AS h FROM ${q} x`);
    out[tb] = rows[0];
  }
  return out;
}

function cli(cmd, group, extraEnv = {}, flags = ['--resolve=git']) {
  const r = spawnSync(process.execPath, [SCRIPT, cmd, `--group=${group}`, ...flags], {
    env: { ...process.env, DATABASE_URL: DB_URL, ...extraEnv }, encoding: 'utf8',
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

const groupTables = (id) => getGroup(id).tables.map((s) => s.table);


dbTest('BOARD_SEED_GROUPS touch no player table', async (t, pool) => {
  const players = new Set(await playerTables(pool));
  assert.ok(players.has('users') && players.has('characters') && players.has('player_items'), [...players].join());
  for (const id of BOARD_SEED_GROUPS) {
    const tables = groupTables(id);
    assert.ok(tables.length > 0, `${id} lists no tables`);
    for (const tb of tables) assert.ok(!players.has(tb), `group ${id} writes player table ${tb}`);
  }
});

dbTest('preview writes nothing', async (t, pool) => {
  const tables = [...new Set([...BOARD_SEED_GROUPS.flatMap(groupTables), 'seed_export_runs', 'seed_row_hashes'])].sort();
  const before = await fingerprint(pool, tables);
  for (const id of BOARD_SEED_GROUPS) {
    const r = cli('preview', id);
    assert.match(r.out, new RegExp(`^${id} preview \\{"add":\\d+,"change":\\d+,"remove":\\d+,"overwrite":\\d+,"blocked":\\d+\\}$`, 'm'), r.out + r.err);
  }
  assert.deepStrictEqual(await fingerprint(pool, tables), before);
});

async function editRow(pool, table, id, col, value) {
  await pool.query(`UPDATE ${quoteIdent(table)} SET ${quoteIdent(col)} = $2 WHERE id = $1`, [id, value]);
  await pool.query(`DELETE FROM seed_row_hashes WHERE sync_uuid = (SELECT sync_uuid FROM ${quoteIdent(table)} WHERE id = $1)`, [id]);
}

const NUMERIC = new Set(['value', 'xp_reward']); // integer columns the test edits

const seedAll = (label) => {
  for (const id of BOARD_SEED_GROUPS) {
    const r = cli('seed', id);
    assert.match(r.out, new RegExp(`^${id} ok `, 'm'), `${label} ${id}: ${r.out}${r.err}`);
  }
};

dbTest('seeding leaves player tables unchanged', async (t, pool) => {
  const stamp = `bs_${process.pid}`;
  let userId = null;
  const editedVals = [];
  const restore = []; // [table, id, column, original]: undone in finally if the seed did not
  try {
    seedAll('sync'); // start from "DB equals git" so a first and a repeat run begin alike
    userId = (await pool.query(
      `INSERT INTO users (username, password_hash) VALUES ($1, 'x') RETURNING id`, [stamp])).rows[0].id;
    const ent = (await pool.query(
      'SELECT entity_type_id AS id, variant FROM character_appearances ORDER BY entity_type_id, variant LIMIT 1')).rows[0];
    assert.ok(ent, 'scratch DB has no character_appearances; run seed-catalogs.js');
    const ch = (await pool.query(
      `INSERT INTO characters (user_id, slot, name, entity_type_id, appearance_variant)
       VALUES ($1, 1, $2, $3, $4) RETURNING id`,
      [userId, stamp, ent.id, ent.variant])).rows[0].id;
    await pool.query(
      `INSERT INTO player_items (character_id, item_type_id, quantity)
       SELECT $1, id, 3 FROM item_types ORDER BY id LIMIT 2`, [ch]);
    await pool.query(
      `INSERT INTO character_passives (character_id, node_id) SELECT $1, id FROM passive_nodes ORDER BY id LIMIT 3`, [ch]);

    // Catalog rows the player rows reference, plus an entity and a tile type:
    // each gets a local edit that only the seed (git wins) can undo.
    const pick = async (sql, ...args) => (await pool.query(sql, args)).rows[0].id;
    const targets = [
      ['item_types', await pick('SELECT item_type_id AS id FROM player_items WHERE character_id = $1 ORDER BY id LIMIT 1', ch), 'value'],
      ['passive_nodes', await pick('SELECT node_id AS id FROM character_passives WHERE character_id = $1 ORDER BY node_id LIMIT 1', ch), 'label'],
      ['entity_types', ent.id, 'xp_reward'],
      ['tile_types', await pick('SELECT id FROM tile_types ORDER BY id LIMIT 1'), 'color'],
    ];
    const orig = [];
    for (const [table, id, col] of targets) {
      const q = quoteIdent(table); const c = quoteIdent(col);
      const o = (await pool.query(`SELECT ${c} AS v FROM ${q} WHERE id = $1`, [id])).rows[0].v;
      restore.push([table, id, col, o]);
      // A bare local edit of a row whose baseline equals git's is kept by a
      // default seed ('not_exported' -> local). Dropping the baseline makes it
      // 'edited_here', which --resolve=git overwrites: git wins.
      const edited = NUMERIC.has(col) ? (o || 0) + 7919 : `bs_edit_${table}`;
      await editRow(pool, table, id, col, edited);
      editedVals.push(edited);
      orig.push(o);
    }

    const players = await playerTables(pool);
    const before = await fingerprint(pool, players);
    assert.ok(before.users.n >= 1 && before.characters.n >= 1 && before.player_items.n >= 2 && before.character_passives.n >= 3);
    seedAll('seed');
    for (let i = 0; i < targets.length; i += 1) {
      const [table, id, col] = targets[i];
      const v = (await pool.query(`SELECT ${quoteIdent(col)} AS v FROM ${quoteIdent(table)} WHERE id = $1`, [id])).rows[0].v;
      assert.notStrictEqual(v, editedVals[i], `${table}.${col} was not reset by the seed (the seed did nothing here)`);
      assert.strictEqual(v, orig[i], `${table}.${col} is not git's value after the seed`);
    }
    assert.deepStrictEqual(await fingerprint(pool, players), before);
  } finally {
    for (const [table, id, col, o] of restore) {
      await pool.query(`UPDATE ${quoteIdent(table)} SET ${quoteIdent(col)} = $2 WHERE id = $1`, [id, o]).catch(() => {});
    }
    if (userId !== null) await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  }
});

// applySeed never writes secretColumns (auth_token): the git file carries none
// and the upsert's SET list is the exported columns only. So a git row that
// overwrites a local provider leaves its token as it was; a token is never
// taken from git.
dbTest('ai_providers seeds with no token and keeps a local token', async (t, pool) => {
  const gitFile = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'seeds', 'sync', 'ai_providers.json'), 'utf8'));
  const gitRows = gitFile.tables.ai_providers;
  assert.ok(gitRows.length > 0);
  assert.ok(gitRows.every((r) => !('auth_token' in r)), 'git file must not carry auth_token');
  const target = gitRows[0];
  const sentinel = `bs-token-${process.pid}`;
  const get = async () => (await pool.query(
    'SELECT base_url, auth_token FROM ai_providers WHERE sync_uuid = $1', [target.sync_uuid])).rows[0];
  seedAll1('ai_providers');
  const orig = await get();
  assert.ok(orig, 'provider from git is missing after the first seed');
  try {
    await pool.query('UPDATE ai_providers SET auth_token = $2 WHERE sync_uuid = $1', [target.sync_uuid, sentinel]);
    await editRow(pool, 'ai_providers', (await pool.query('SELECT id FROM ai_providers WHERE sync_uuid = $1', [target.sync_uuid])).rows[0].id,
      'base_url', 'http://bs.invalid/edit');
    seedAll1('ai_providers');
    const after = await get();
    assert.strictEqual(after.base_url, target.base_url, 'seed did not run: base_url not reset to git');
    assert.strictEqual(after.auth_token === sentinel, true, 'a local token was overwritten or cleared by the seed');
    const others = await pool.query(
      'SELECT count(*)::int AS n, count(auth_token)::int AS withtoken FROM ai_providers WHERE sync_uuid <> $1', [target.sync_uuid]);
    assert.ok(others.rows[0].n > 0);
    assert.strictEqual(others.rows[0].withtoken, 0);
  } finally {
    await pool.query('UPDATE ai_providers SET auth_token = $2, base_url = $3 WHERE sync_uuid = $1',
      [target.sync_uuid, orig.auth_token, orig.base_url]);
  }
});

function seedAll1(id) {
  const r = cli('seed', id);
  assert.match(r.out, new RegExp(`^${id} ok `, 'm'), `${id}: ${r.out}${r.err}`);
}

dbTest('preview predicts a refusal', async (t, pool) => {
  // A git row whose by-uuid reference resolves nowhere: apply refuses it as
  // missing_ref. Nothing in the DB is changed; only the sync dir is a temp copy.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-sync-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const doc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'seeds', 'sync', 'tile_types.json'), 'utf8'));
  const victim = doc.tables.tile_types.find((r) => r.ai_provider_id);
  victim.ai_provider_id = '00000000-0000-4000-8000-00000000b10c';
  fs.writeFileSync(path.join(dir, 'tile_types.json'), JSON.stringify(doc));
  const env = { SEED_SYNC_DIR: dir };
  const tables = ['tile_types', 'ai_providers', 'seed_export_runs', 'seed_row_hashes'];
  const before = await fingerprint(pool, tables);
  const p = cli('preview', 'tile_types', env);
  const m = /^tile_types preview (\{.*\})$/m.exec(p.out);
  assert.ok(m, p.out + p.err);
  assert.ok(JSON.parse(m[1]).blocked >= 1, p.out);
  assert.match(p.err, /^warn tile_types missing_ref /m);
  const s = cli('seed', 'tile_types', env);
  assert.strictEqual(s.status, 2, s.out + s.err);
  assert.match(s.out, /^tile_types refused:missing_ref /m);
  assert.deepStrictEqual(await fingerprint(pool, tables), before);
});

const GIT_WINS = ['--resolve=git', '--git-wins'];

dbTest('git-wins overwrites a board edit whose baseline still matches git', async (t, pool) => {
  seedAll1('tile_types');
  const row = (await pool.query('SELECT id, color FROM tile_types ORDER BY id LIMIT 1')).rows[0];
  const colorOf = async () => (await pool.query('SELECT color FROM tile_types WHERE id = $1', [row.id])).rows[0].color;
  try {
    // Edit only; the baseline (= git's hash) is kept, so the row is 'not_exported'.
    await pool.query('UPDATE tile_types SET color = $2 WHERE id = $1', [row.id, 'bs_gw_edit']);
    const plain = cli('seed', 'tile_types');
    assert.match(plain.out, /^tile_types ok /m, plain.out + plain.err);
    assert.strictEqual(await colorOf(), 'bs_gw_edit', 'without the flag the edited row must stay');

    const pv = /^tile_types preview (\{.*\})$/m.exec(cli('preview', 'tile_types', {}, GIT_WINS).out);
    assert.ok(pv && JSON.parse(pv[1]).overwrite >= 1);
    const noflag = /^tile_types preview (\{.*\})$/m.exec(cli('preview', 'tile_types').out);
    assert.strictEqual(JSON.parse(noflag[1]).overwrite, 0);

    const gw = cli('seed', 'tile_types', {}, GIT_WINS);
    assert.match(gw.out, /^tile_types ok /m, gw.out + gw.err);
    assert.strictEqual(await colorOf(), row.color, 'git-wins did not restore git\'s value');
  } finally {
    await pool.query('UPDATE tile_types SET color = $2 WHERE id = $1', [row.id, row.color]);
  }
});

dbTest('git-wins never deletes a row that exists only on this database', async (t, pool) => {
  const name = `bs_only_here_${process.pid}`;
  seedAll1('tile_types');
  try {
    await pool.query("INSERT INTO tile_types (name, color) VALUES ($1, '#010203')", [name]);
    const gw = cli('seed', 'tile_types', {}, GIT_WINS);
    assert.match(gw.out, /^tile_types ok /m, gw.out + gw.err);
    const left = await pool.query('SELECT 1 FROM tile_types WHERE name = $1', [name]);
    assert.strictEqual(left.rowCount, 1, 'git-wins deleted a local-only row');
    const pv = /^tile_types preview (\{.*\})$/m.exec(cli('preview', 'tile_types', {}, GIT_WINS).out);
    assert.strictEqual(JSON.parse(pv[1]).remove, 0);
  } finally {
    await pool.query('DELETE FROM tile_types WHERE name = $1', [name]);
  }
});
