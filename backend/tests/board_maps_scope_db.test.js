const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Pool } = require('pg');
const { withEntryPreserved } = require('./helpers/entryWorld.js');
const { withDatabase, recreate, drop, migrate, seed } = require('../scripts/testdb.js');
const { playerTables, scopedFingerprint } = require('./helpers/playerScope.js');

// SOMET-722. The tab's "Apply maps" runs, on the board, `SPEC=<name> node scripts/seed-map.js` for
// p5-descent and then vale-region. This runs the same command (the real script, as a child process)
// against the scratch database and proves what the confirm dialog promises: accounts, characters,
// items and passives are untouched, vale-region leaves Vale Crossing as the entry world, and a
// character standing in a world is still standing in a world that exists.
//
// The file applies the maps to its OWN database, created on TEST_DATABASE_URL's server, migrated and
// seeded here and dropped in t.after: seeding the shared database moved the entry world and the
// catalogs under every other test file running in parallel. Never game_db.
const BASE_URL = process.env.TEST_DATABASE_URL;
let DB_URL = null; // the private database, set once it exists
const SCRIPT = path.join(__dirname, '..', 'scripts', 'seed-map.js');
const MAPS = path.join(__dirname, '..', 'seeds', 'maps');
// The order the tab uses. vale-region LAST: p5-descent otherwise takes the entry world.
const SPECS = ['p5-descent', 'vale-region'];

function dbName(url) {
  let name;
  try { name = decodeURIComponent(new URL(url).pathname.replace(/^\//, '')); } catch { name = ''; }
  if (!name) throw new Error('TEST_DATABASE_URL is unparseable or names no database; refusing');
  return name;
}

const readSpec = (name) => JSON.parse(fs.readFileSync(path.join(MAPS, `${name}.map.json`), 'utf8'));

function applyMap(name) {
  const r = spawnSync(process.execPath, [SCRIPT], {
    env: { ...process.env, DATABASE_URL: DB_URL, SPEC: name }, encoding: 'utf8', timeout: 20 * 60 * 1000,
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

test('applying p5-descent then vale-region leaves players alone and Vale Crossing as the entry world', { timeout: 40 * 60 * 1000 }, async (t) => {
  if (!BASE_URL) {
    const msg = 'TEST_DATABASE_URL not set -- skipping to avoid touching a real database (board maps scope)';
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  assert.notStrictEqual(dbName(BASE_URL), 'game_db', 'TEST_DATABASE_URL points at the dev database game_db; refusing');
  const name = `game_test_bm_${process.pid}`;
  const target = { name, url: withDatabase(BASE_URL, name), adminUrl: withDatabase(BASE_URL, 'postgres') };
  assert.ok(/test/.test(name) && name !== dbName(BASE_URL));
  let pool = null;
  // End the pool BEFORE dropping: DROP ... FORCE would otherwise kill its idle clients (uncaught error).
  t.after(async () => { if (pool) await pool.end().catch(() => {}); await drop(target).catch((e) => console.error(`could not drop ${name}: ${e.message}`)); });
  await recreate(target);
  DB_URL = target.url;
  migrate(target);
  seed(target);
  pool = new Pool({ connectionString: DB_URL, max: 4, connectionTimeoutMillis: 3000 });
  pool.on('error', () => {});

  const specs = SPECS.map(readSpec);
  const specWorldNames = specs.flatMap((s) => s.worlds.map((w) => w.name));
  const expectedBosses = specs.flatMap((s) => s.worlds).filter((w) => w.boss).length;
  assert.strictEqual(expectedBosses, 6, 'the two specs author six dungeon bosses');
  const standIn = specs[1].worlds.find((w) => !w.is_entry).name;

  const stamp = `bm_${process.pid}`;
  let userId = null;
  try {
    // A scratch database that has never had the maps cannot say what "kept" means.
    const known = await pool.query('SELECT name FROM worlds WHERE name = ANY($1::text[])', [specWorldNames]);
    assert.ok(known.rowCount > 0, 'scratch DB has none of the spec worlds; run seed-map once first');

    userId = (await pool.query(
      `INSERT INTO users (username, password_hash) VALUES ($1, 'x') RETURNING id`, [stamp])).rows[0].id;
    const ent = (await pool.query(
      'SELECT entity_type_id AS id, variant FROM character_appearances ORDER BY entity_type_id, variant LIMIT 1')).rows[0];
    assert.ok(ent, 'scratch DB has no character_appearances; run seed-catalogs.js');
    const ch = (await pool.query(
      `INSERT INTO characters (user_id, slot, name, entity_type_id, appearance_variant)
       VALUES ($1, 1, $2, $3, $4) RETURNING id`, [userId, stamp, ent.id, ent.variant])).rows[0].id;
    await pool.query(
      `INSERT INTO player_items (character_id, item_type_id, quantity)
       SELECT $1, id, 3 FROM item_types ORDER BY id LIMIT 2`, [ch]);
    await pool.query(
      `INSERT INTO character_passives (character_id, node_id) SELECT $1, id FROM passive_nodes ORDER BY id LIMIT 3`, [ch]);
    // The character stands in a world one of the specs owns, and in one neither spec names.
    const spot = async (name) => (await pool.query('SELECT id FROM worlds WHERE name = $1', [name])).rows[0];
    const inSpec = await spot(standIn);
    assert.ok(inSpec, `scratch DB has no world ${standIn}`);
    const outside = (await pool.query('SELECT id, name FROM worlds WHERE name <> ALL($1::text[]) ORDER BY name LIMIT 1', [specWorldNames])).rows[0];
    await pool.query('INSERT INTO world_players (world_id, character_id, x, y) VALUES ($1, $2, 7, 9)', [inSpec.id, ch]);
    if (outside) await pool.query('INSERT INTO world_players (world_id, character_id, x, y) VALUES ($1, $2, 11, 13)', [outside.id, ch]);

    const players = await playerTables(pool);
    const before = await scopedFingerprint(pool, players, userId, ch);
    for (const tb of ['users', 'characters', 'player_items', 'character_passives', 'world_players']) {
      assert.ok(before[tb] && before[tb].n >= 1, `${tb} fixture rows are not compared`);
    }
    assert.ok(before.player_items.n >= 2 && before.character_passives.n >= 3 && before.world_players.n >= (outside ? 2 : 1));
    const worldsBefore = (await pool.query('SELECT count(*)::int AS n FROM worlds')).rows[0].n;

    await withEntryPreserved(pool, async () => {
      const entry = async () => (await pool.query('SELECT name FROM worlds WHERE is_entry = true ORDER BY name')).rows.map((r) => r.name);
      const first = applyMap(SPECS[0]);
      assert.strictEqual(first.status, 0, first.out + first.err);
      assert.match(first.out, /^applied p5-descent: /m);
      // Why the order is fixed: the first spec takes the entry world, the last one gives it to Vale Crossing.
      assert.deepStrictEqual(await entry(), ['The Catacombs: Entry']);
      const second = applyMap(SPECS[1]);
      assert.strictEqual(second.status, 0, second.out + second.err);
      assert.match(second.out, /^applied vale-region: /m);
      assert.deepStrictEqual(await entry(), ['Vale Crossing'], 'Vale Crossing is the entry world, and the only one');
    });

    // The fixture's own rows in every player table are byte-for-byte what they were.
    assert.deepStrictEqual(await scopedFingerprint(pool, players, userId, ch), before);
    // ...and the character's worlds are still real worlds: nothing was removed from under it.
    const standing = (await pool.query(
      `SELECT w.name FROM world_players p JOIN worlds w ON w.id = p.world_id WHERE p.character_id = $1 ORDER BY w.name`, [ch])).rows;
    assert.strictEqual(standing.length, outside ? 2 : 1);
    assert.ok(standing.some((r) => r.name === standIn));
    const worldsAfter = (await pool.query('SELECT count(*)::int AS n FROM worlds')).rows[0].n;
    assert.ok(worldsAfter >= worldsBefore, `no world is deleted by seed-map (${worldsBefore} -> ${worldsAfter})`);
    // Six of the worlds the two specs own carry a dungeon boss.
    const bosses = (await pool.query(
      `SELECT count(*)::int AS n FROM worlds WHERE name = ANY($1::text[])
          AND dungeon_boss IS NOT NULL AND dungeon_boss::text <> 'null'`, [specWorldNames])).rows[0].n;
    assert.strictEqual(bosses, 6);
  } finally {
    if (userId !== null) {
      await pool.query('DELETE FROM world_players WHERE character_id IN (SELECT id FROM characters WHERE user_id = $1)', [userId]).catch(() => {});
      await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    }
  }
});
