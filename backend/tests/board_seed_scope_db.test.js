const test = require('node:test');
const assert = require('node:assert');
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
const dbName = (url) => { try { return new URL(url).pathname.replace(/^\//, ''); } catch { return ''; } };

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

function cli(cmd, group) {
  const r = spawnSync(process.execPath, [SCRIPT, cmd, `--group=${group}`, '--resolve=git'], {
    env: { ...process.env, DATABASE_URL: DB_URL }, encoding: 'utf8',
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
    assert.match(r.out, new RegExp(`^${id} preview \\{"add":\\d+,"change":\\d+,"remove":\\d+,"overwrite":\\d+\\}$`, 'm'), r.out + r.err);
  }
  assert.deepStrictEqual(await fingerprint(pool, tables), before);
});

dbTest('seeding leaves player tables unchanged', async (t, pool) => {
  const stamp = `bs_${process.pid}`;
  let userId = null;
  try {
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

    const players = await playerTables(pool);
    const before = await fingerprint(pool, players);
    assert.ok(before.users.n >= 1 && before.characters.n >= 1 && before.player_items.n >= 2 && before.character_passives.n >= 3);
    for (const id of BOARD_SEED_GROUPS) {
      const r = cli('seed', id);
      assert.match(r.out, new RegExp(`^${id} ok `, 'm'), `${id}: ${r.out}${r.err}`);
    }
    assert.deepStrictEqual(await fingerprint(pool, players), before);
  } finally {
    if (userId !== null) await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  }
});

dbTest('ai_providers seeds with no token', async (t, pool) => {
  const r = cli('seed', 'ai_providers');
  assert.match(r.out, /^ai_providers ok /m, r.out + r.err);
  const { rows } = await pool.query('SELECT count(*)::int AS n, count(auth_token)::int AS withtoken FROM ai_providers');
  assert.ok(rows[0].n > 0);
  assert.strictEqual(rows[0].withtoken, 0);
});
