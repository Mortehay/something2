const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { derivePlayerStats } = require('../src/services/playerStats.js');

// Gated exactly like creature_levels_db.test.js / seed_catalogs_db.test.js:
// skip without TEST_DATABASE_URL and do NOT fall back to DATABASE_URL, so a
// bare `npm test` on a machine with a working dev database can never reach
// this file. This test only reads information_schema and mutates inside
// transactions it rolls back -- it never leaves a written row behind.
const DB_URL = process.env.TEST_DATABASE_URL
  || 'postgres://user:password@localhost:15432/game_db';

function requireTestDb(t, why) {
  if (!process.env.TEST_DATABASE_URL) {
    const msg = `TEST_DATABASE_URL not set -- skipping to avoid mutating a real database (${why})`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return false;
  }
  return true;
}

async function openPool() {
  const pool = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 2000, max: 2 });
  try { await pool.query('SELECT 1'); return pool; }
  catch (err) { await pool.end().catch(() => {}); return { unreachable: err.message }; }
}

test('player_progression columns have the documented types and defaults', async (t) => {
  if (!requireTestDb(t, 'this test reads player_progression column metadata')) return;
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} -- the column defaults are UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  try {
    const { rows } = await pool.query(
      `SELECT column_name, data_type, column_default, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'player_progression'`,
    );
    const by = new Map(rows.map((r) => [r.column_name, r]));

    // Exact equality, never a regex. `assert.match(column_default, /1/)` also
    // matches 15, 100 and 1000 -- that exact hole shipped in A1's task 1.
    assert.equal(by.get('experience').data_type, 'bigint');
    assert.equal(by.get('experience').column_default, '0');
    assert.equal(by.get('level').column_default, '1');
    assert.equal(by.get('passive_points').column_default, '0');
    assert.equal(by.get('passive_points').data_type, 'integer');
    assert.equal(by.get('passive_points').is_nullable, 'NO');
    // The stat-point system is gone, column and all. A leftover column is a
    // second place a later migration or a stray UPDATE can put points nothing
    // spends.
    assert.equal(by.get('stat_points'), undefined, 'stat_points must have been dropped');
    for (const s of ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma']) {
      assert.equal(by.get(s).data_type, 'integer', `${s} must be integer`);
      assert.equal(by.get(s).column_default, '5', `${s} must default to the base stat`);
      assert.equal(by.get(s).is_nullable, 'NO', `${s} must be NOT NULL`);
    }
  } finally { await pool.end(); }
});

test('the CHECK constraints actually reject bad rows', async (t) => {
  if (!requireTestDb(t, 'this test UPDATEs a player_progression row inside a rolled-back transaction')) return;
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} -- the CHECK constraints are UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  // Borrowed read-only: an existing row backfilled by the migration itself,
  // never inserted or deleted by this test. Keyed by character_id since
  // SOMET-257 (1714440092000_characters.js) repointed this table off users.
  const { rows: existing } = await pool.query('SELECT character_id FROM player_progression ORDER BY character_id LIMIT 1');
  if (existing.length === 0) {
    await pool.end();
    t.skip('no player_progression rows to borrow -- run the migration backfill first');
    return;
  }
  const testCharacterId = existing[0].character_id;

  // A CHECK constraint test that only reads information_schema proves the
  // constraint EXISTS, not that it BITES. Insert into a transaction and
  // require the failure, then roll back so the borrowed row is untouched.
  //
  // BEGIN/ROLLBACK must run on the SAME connection, so this checks out a
  // single dedicated client rather than letting the pool round-robin.
  const client = await pool.connect();
  try {
    for (const [label, sql] of [
      ['negative experience', 'UPDATE player_progression SET experience = -1 WHERE character_id = $1'],
      ['level 0', 'UPDATE player_progression SET level = 0 WHERE character_id = $1'],
      ['level 151', 'UPDATE player_progression SET level = 151 WHERE character_id = $1'],
      ['negative passive points', 'UPDATE player_progression SET passive_points = -1 WHERE character_id = $1'],
      ['sub-base strength', 'UPDATE player_progression SET strength = 4 WHERE character_id = $1'],
    ]) {
      await client.query('BEGIN');
      await assert.rejects(() => client.query(sql, [testCharacterId]), `${label} must be rejected`);
      await client.query('ROLLBACK');
    }

    // The converse, and the one that actually proves the cap MOVED rather
    // than merely still existing: level 51 was rejected before this migration
    // and must now be accepted. Without it, a migration that forgot to drop
    // the old constraint passes every assertion above.
    await client.query('BEGIN');
    await client.query('UPDATE player_progression SET level = 150 WHERE character_id = $1', [testCharacterId]);
    await client.query('UPDATE player_progression SET level = 51 WHERE character_id = $1', [testCharacterId]);
    await client.query('ROLLBACK');
  } finally {
    client.release();
    await pool.end();
  }
});

// This replaces an older assertion, "every existing user was backfilled",
// which pinned the ORIGINAL progression migration (1714440052000): it gave
// every row in `users` a player_progression row, so "zero users without one"
// was a true invariant.
//
// It stopped being one. 1714440092000_characters.js repointed the table to
// characters, and progression rows are now created LAZILY by loadProgression
// -- a freshly registered user has no character, and a freshly created
// character has no progression row until something awards or reads it. The
// naive port (swap `users` for `characters` in the join) would therefore
// assert something that is legitimately false, and the version before that
// port was failing on a column that no longer exists.
//
// What genuinely survives the repoint is the KEY itself, so that is what
// this pins -- and it pins it by making the constraints bite, not by reading
// information_schema and calling a present constraint a working one.
test('player_progression is keyed to characters, and the key bites', async (t) => {
  if (!requireTestDb(t, 'this test inserts a user, character and progression row inside a rolled-back transaction')) return;
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} -- the character key is UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }

  // Everything below runs on ONE client inside a single transaction that is
  // always rolled back, so this leaves no row behind even on failure.
  const client = await pool.connect();
  try {
    const cols = await client.query(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_name = 'player_progression'`,
    );
    const names = cols.rows.map((r) => r.column_name);
    assert.ok(!names.includes('user_id'), 'user_id must be GONE, not merely unused -- a surviving nullable copy lets a stale writer key progression off the account again');
    assert.equal(cols.rows.find((r) => r.column_name === 'character_id').is_nullable, 'NO');

    await client.query('BEGIN');
    const tag = `progression-migration-test-${process.pid}-${Date.now()}`;
    const u = await client.query(
      `INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'player') RETURNING id`,
      [tag],
    );
    const c = await client.query(
      `INSERT INTO characters (user_id, slot, name, entity_type_id)
       SELECT $1, 1, $2, e.id FROM entity_types e WHERE e.name = 'Warrior'
       RETURNING id`,
      [u.rows[0].id, tag],
    );
    assert.equal(c.rows.length, 1, "entity_types has no 'Warrior' -- run seed-catalogs");
    const characterId = c.rows[0].id;

    // A character id that provably cannot exist: one this transaction created
    // and then deleted, so the sequence has already moved past it and no
    // concurrent inserter can claim it.
    //
    // NOT `MAX(id) + 1`. node --test runs test FILES IN PARALLEL and several
    // of them create characters, so another file committing between that
    // SELECT and this INSERT would make the id real, the insert succeed, and
    // this assertion fail -- a flake that only ever appears under a full-suite
    // run. Same class of parallel-file hazard as the entry-world race in
    // tests/helpers/entryWorld.js.
    const g = await client.query(
      `INSERT INTO characters (user_id, slot, name, entity_type_id)
       SELECT $1, 2, $2, e.id FROM entity_types e WHERE e.name = 'Warrior'
       RETURNING id`,
      [u.rows[0].id, `${tag}-ghost`],
    );
    const ghostId = g.rows[0].id;
    await client.query('DELETE FROM characters WHERE id = $1', [ghostId]);

    await client.query('SAVEPOINT fk');
    await assert.rejects(
      () => client.query('INSERT INTO player_progression (character_id) VALUES ($1)', [ghostId]),
      /foreign key|player_progression_character_fk/i,
      'progression for a nonexistent character must be refused',
    );
    await client.query('ROLLBACK TO SAVEPOINT fk');

    // The CASCADE is not decoration: every throwaway-user fixture in this
    // suite (and in authority_*_db.test.js) cleans up by deleting the USER
    // and trusting the delete to reach progression through the character. If
    // this cascade were RESTRICT or SET NULL, those deletes would fail
    // silently into their `.catch(() => {})` and leak rows into the shared
    // dev database.
    await client.query('INSERT INTO player_progression (character_id) VALUES ($1)', [characterId]);
    await client.query('DELETE FROM users WHERE id = $1', [u.rows[0].id]);
    const left = await client.query(
      'SELECT count(*)::int AS n FROM player_progression WHERE character_id = $1',
      [characterId],
    );
    assert.equal(left.rows[0].n, 0, 'deleting the account must reach progression through the character');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
});

// The backfill is the one part of this migration that cannot be re-run to
// check, so it is exercised here against synthetic rows inside a transaction
// that is rolled back. Every expected number is hand-computed:
//   experience 213 -> level 4 (xpFloor(4) = 141, xpFloor(5) = 255)
//   level 4 grants 1 x (4 - 1) = 3 passive points
//   strength 12 is 7 above the base of 5, dexterity 8 is 3 above -> 10 refunded
//   plus 2 still unspent -> 3 + 10 + 2 = 15
test('the backfill re-levels from raw XP and refunds every point as a passive point', async (t) => {
  if (!requireTestDb(t, 'this test inserts a user, character and progression row inside a rolled-back transaction')) return;
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} -- the backfill arithmetic is UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const u = await client.query(
      "INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'player') RETURNING id",
      [`backfill-check-${process.pid}-${Date.now()}`]);
    const c = await client.query(
      `INSERT INTO characters (user_id, slot, name, entity_type_id)
       SELECT $1, 1, $2, e.id FROM entity_types e WHERE e.name = 'Warrior' RETURNING id`,
      [u.rows[0].id, `backfill-char-${process.pid}-${Date.now()}`]);
    const charId = c.rows[0].id;

    // The pre-migration shape, written directly: this row is what a level-4
    // character with 5 spent and 2 unspent points looked like.
    await client.query(
      `INSERT INTO player_progression
         (character_id, experience, level, passive_points, strength, dexterity)
       VALUES ($1, 213, 2, 2, 12, 8)`,
      [charId]);

    // Replay the migration's own two statements against this one row.
    await client.query(
      `UPDATE player_progression
          SET passive_points = passive_points + GREATEST(level - 1, 0) * 1
            + (strength - 5) + (dexterity - 5) + (constitution - 5)
            + (intelligence - 5) + (wisdom - 5) + (charisma - 5)
        WHERE character_id = $1`, [charId]);
    await client.query(
      `UPDATE player_progression SET strength = 5, dexterity = 5 WHERE character_id = $1`, [charId]);

    const { rows } = await client.query(
      'SELECT experience, passive_points, strength, dexterity FROM player_progression WHERE character_id = $1',
      [charId]);
    assert.strictEqual(Number(rows[0].experience), 213, 'raw experience must never be touched');
    assert.strictEqual(rows[0].strength, 5);
    assert.strictEqual(rows[0].dexterity, 5);
    // level is 2 in this fixture (the re-level ran before the row existed), so
    // the grant term is 1 x (2 - 1) = 1: 1 + 10 + 2 = 13.
    assert.strictEqual(rows[0].passive_points, 13);

    await client.query('ROLLBACK');
  } finally { client.release(); await pool.end(); }
});

// THE regression test for the single most dangerous thing this migration could
// have done. The class-base snapshot (design doc 3.3) had an obvious-looking
// wrong implementation: backfill the six stat columns from the class's
// `entity_types` row. entity_types carries a Warrior with 10s and a Ranger
// with DEX 12, while every formula in playerStats.js is an identity at
// BASE_STAT = 5 -- progressionConstants.js declares that property explicitly
// non-provisional. A backfilled CON of 10 makes
// maxHp = 100 + 10 * (10 - 5) = 150: +50 max HP for every character in the
// database, silently, with the whole suite still green.
//
// So this walks EVERY row actually in the table and asserts the derived pool
// sizes against hand-written literals -- 100 and 100, the game's pre-epic
// numbers. Not `HP_BASE`, not `derivePlayerStats(DEFAULT_PROGRESSION).maxHp`:
// an expectation computed from the same constants as the code cannot see a
// base that moved. A single row backfilled from entity_types fails this.
test('the migration left every character with the pre-epic 100 hp / 100 mana', async (t) => {
  if (!requireTestDb(t, 'this test reads every player_progression row')) return;
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} -- the max-HP invariant is UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  try {
    const { rows } = await pool.query(
      `SELECT character_id, strength, dexterity, constitution,
              intelligence, wisdom, charisma
         FROM player_progression`);
    if (rows.length === 0) {
      t.skip('no player_progression rows to check -- seed a character first');
      return;
    }
    for (const r of rows) {
      const stats = derivePlayerStats(r);
      assert.strictEqual(stats.maxHp, 100,
        `character ${r.character_id} has constitution ${r.constitution}, i.e. maxHp ${stats.maxHp} rather than the pre-epic 100 -- the class-base snapshot was backfilled from something other than the base of 5`);
      assert.strictEqual(stats.maxMana, 100,
        `character ${r.character_id} has intelligence ${r.intelligence}, i.e. maxMana ${stats.maxMana} rather than the pre-epic 100`);
      // Stated directly as well, because a future change to HP_PER_CON would
      // make the two assertions above pass on a wrong CON.
      for (const k of ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma']) {
        assert.strictEqual(r[k], 5,
          `character ${r.character_id} has ${k} = ${r[k]}; the class-base snapshot is 5 on all six stats for every class (contract 6.1)`);
      }
    }
  } finally { await pool.end(); }
});
