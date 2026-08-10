const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

// character_visited_worlds (1714440160000) was created EMPTY. Visits are only
// recorded from that migration forward, so every character that predates
// SOMET-256 shows "You have not been anywhere yet" permanently -- even though
// world_players already records exactly which worlds it has stood in. Live
// evidence when this was found: the admin account's character had 10
// world_players rows and 0 visit rows.
//
// Missed in review because verification used a freshly-created character, for
// which an empty map is the correct answer. The fixture hid the bug.
const MIGRATION = '1714440162000_backfill_visited_worlds.js';
const mig = require(`../migrations/${MIGRATION}`);

function fakePgm() {
  const order = [];
  return { order, sql: (s) => order.push(s), func: (s) => ({ __func: s }) };
}

const emitted = (fn) => { const pgm = fakePgm(); fn(pgm); return pgm.order.join('\n'); };

test('up backfills from world_players', () => {
  const sql = emitted(mig.up);
  assert.match(sql, /INSERT INTO character_visited_worlds/i);
  assert.match(sql, /FROM world_players/i);
  assert.match(sql, /ON CONFLICT/i, 're-running the migration must be a no-op');
});

test('it carries the recorded time forward, not the migration time', () => {
  const sql = emitted(mig.up);
  // now() would claim every character first saw every world at the instant the
  // migration ran, which is both false and identical for every row -- it would
  // destroy any ordering the data still has.
  assert.doesNotMatch(sql, /now\(\)/i, 'must not stamp rows with the migration time');
  assert.match(sql, /updated_at/, 'must carry world_players.updated_at into first_seen_at');
});

test('down is deliberately empty', () => {
  // A rollback cannot distinguish a backfilled row from one earned by playing
  // after the migration ran, and deleting the latter would destroy real
  // history. Asserted so the emptiness reads as a decision, not an omission.
  assert.deepEqual(emitted(mig.down), '');
});

const url = process.env.TEST_DATABASE_URL;

test('every world a character has stood in becomes a visit', { skip: !url ? 'no TEST_DATABASE_URL' : false }, async (t) => {
  const pool = new Pool({ connectionString: url });
  t.after(() => pool.end());

  const tag = `zzBackfill-${process.pid}`;
  const sql = [];
  mig.up({ sql: (s) => sql.push(s), func: (s) => ({ __func: s }) });

  await pool.query(
    "INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'player') ON CONFLICT (username) DO NOTHING",
    [tag]);
  const userId = (await pool.query('SELECT id FROM users WHERE username = $1', [tag])).rows[0].id;
  try {
    const cls = (await pool.query("SELECT id FROM entity_types WHERE name = 'Warrior'")).rows[0];
    const c = (await pool.query(
      'INSERT INTO characters (user_id, slot, name, entity_type_id) VALUES ($1, 1, $2, $3) RETURNING id',
      [userId, `${tag}-char`, cls.id])).rows[0];
    const worlds = (await pool.query('SELECT id FROM worlds ORDER BY name LIMIT 2')).rows;

    // Two worlds, distinct timestamps, mirroring a character that played in
    // both before the visited table existed.
    await pool.query(
      `INSERT INTO world_players (world_id, character_id, x, y, updated_at)
       VALUES ($1, $2, 5, 5, now() - interval '2 days')`, [worlds[0].id, c.id]);
    await pool.query(
      `INSERT INTO world_players (world_id, character_id, x, y, updated_at)
       VALUES ($1, $2, 6, 6, now() - interval '1 day')`, [worlds[1].id, c.id]);

    assert.equal(
      (await pool.query('SELECT count(*)::int n FROM character_visited_worlds WHERE character_id = $1', [c.id])).rows[0].n,
      0, 'precondition: no visits before the backfill');

    for (const stmt of sql) await pool.query(stmt);

    const rows = (await pool.query(
      `SELECT v.world_id, v.first_seen_at, wp.updated_at
         FROM character_visited_worlds v
         JOIN world_players wp ON wp.character_id = v.character_id AND wp.world_id = v.world_id
        WHERE v.character_id = $1 ORDER BY v.first_seen_at`, [c.id])).rows;

    assert.equal(rows.length, 2, 'both occupied worlds must become visits');
    for (const r of rows) {
      assert.deepEqual(r.first_seen_at, r.updated_at,
        'first_seen_at must carry the world_players timestamp, not the migration time');
    }

    // Idempotent: the real migration may be re-run, and a second pass must not
    // duplicate or move timestamps.
    for (const stmt of sql) await pool.query(stmt);
    const after = (await pool.query(
      'SELECT count(*)::int n FROM character_visited_worlds WHERE character_id = $1', [c.id])).rows[0].n;
    assert.equal(after, 2, 're-running must not duplicate rows');
  } finally {
    await pool.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
  }
});
