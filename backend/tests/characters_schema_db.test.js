const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

// Every fixture below is zz-prefixed and removed by name in a finally block.
// Nothing in this file touches a real account, a real character, or a catalog
// row -- a reviewer once wiped entity_types with an unscoped DELETE while
// "testing" a seeder.
test('characters schema', { skip: !url ? 'no database URL' : false }, async (t) => {
  const pool = new Pool({ connectionString: url });
  t.after(() => pool.end());

  const warrior = (await pool.query("SELECT id FROM entity_types WHERE name = 'Warrior'")).rows[0].id;

  async function withUser(username, fn) {
    await pool.query(
      "INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'player') ON CONFLICT (username) DO NOTHING",
      [username]);
    const id = (await pool.query('SELECT id FROM users WHERE username = $1', [username])).rows[0].id;
    try { return await fn(id); }
    finally { await pool.query('DELETE FROM users WHERE username = $1', [username]); }
  }

  await t.test('a ninth character is refused by the database', async () => {
    await withUser('zzSlotCap', async (userId) => {
      for (let slot = 1; slot <= 8; slot += 1) {
        await pool.query(
          'INSERT INTO characters (user_id, slot, name, entity_type_id) VALUES ($1, $2, $3, $4)',
          [userId, slot, `zzSlotCap${slot}`, warrior]);
      }
      await assert.rejects(
        () => pool.query(
          'INSERT INTO characters (user_id, slot, name, entity_type_id) VALUES ($1, 9, $2, $3)',
          [userId, 'zzSlotCap9', warrior]),
        /characters_slot_check/);
      // And re-using an occupied slot is refused too -- the CHECK alone would
      // let an application bug write slot 1 nine times.
      await assert.rejects(
        () => pool.query(
          'INSERT INTO characters (user_id, slot, name, entity_type_id) VALUES ($1, 1, $2, $3)',
          [userId, 'zzSlotCapDupe', warrior]),
        /characters_user_slot_unique/);
      const n = await pool.query('SELECT count(*)::int AS n FROM characters WHERE user_id = $1', [userId]);
      assert.equal(n.rows[0].n, 8);
    });
  });

  await t.test('character names are globally unique and case-insensitive', async () => {
    await withUser('zzNameA', async (a) => {
      await withUser('zzNameB', async (b) => {
        await pool.query(
          'INSERT INTO characters (user_id, slot, name, entity_type_id) VALUES ($1, 1, $2, $3)',
          [a, 'zzGorm', warrior]);
        await assert.rejects(
          () => pool.query(
            'INSERT INTO characters (user_id, slot, name, entity_type_id) VALUES ($1, 1, $2, $3)',
            [b, 'ZZGORM', warrior]),
          /characters_name_unique/);
      });
    });
  });

  await t.test('deleting a character cascades all five state tables', async () => {
    await withUser('zzCascade', async (userId) => {
      const charId = (await pool.query(
        'INSERT INTO characters (user_id, slot, name, entity_type_id) VALUES ($1, 1, $2, $3) RETURNING id',
        [userId, 'zzCascadeChar', warrior])).rows[0].id;
      const worldId = (await pool.query('SELECT id FROM worlds LIMIT 1')).rows[0].id;
      await pool.query(
        'INSERT INTO world_players (world_id, character_id, x, y) VALUES ($1, $2, 10, 20)',
        [worldId, charId]);
      await pool.query('INSERT INTO player_progression (character_id) VALUES ($1)', [charId]);
      await pool.query(
        'INSERT INTO player_binds (character_id, world_id, x, y) VALUES ($1, $2, 10, 20)',
        [charId, worldId]);

      await pool.query('DELETE FROM characters WHERE id = $1', [charId]);

      for (const table of ['world_players', 'player_progression', 'player_binds']) {
        const r = await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE character_id = $1`, [charId]);
        assert.equal(r.rows[0].n, 0, `${table} should have cascaded away`);
      }
    });
  });

  await t.test('deleting the account cascades its characters', async () => {
    let charId;
    await withUser('zzAccountCascade', async (userId) => {
      charId = (await pool.query(
        'INSERT INTO characters (user_id, slot, name, entity_type_id) VALUES ($1, 1, $2, $3) RETURNING id',
        [userId, 'zzAccountCascadeChar', warrior])).rows[0].id;
    });
    const r = await pool.query('SELECT count(*)::int AS n FROM characters WHERE id = $1', [charId]);
    assert.equal(r.rows[0].n, 0);
  });

  await t.test('deleting a character frees its slot for reuse', async () => {
    await withUser('zzReuse', async (userId) => {
      const first = (await pool.query(
        'INSERT INTO characters (user_id, slot, name, entity_type_id) VALUES ($1, 3, $2, $3) RETURNING id',
        [userId, 'zzReuseA', warrior])).rows[0].id;
      await pool.query('DELETE FROM characters WHERE id = $1', [first]);
      await pool.query(
        'INSERT INTO characters (user_id, slot, name, entity_type_id) VALUES ($1, 3, $2, $3)',
        [userId, 'zzReuseB', warrior]);
      const r = await pool.query('SELECT slot FROM characters WHERE user_id = $1', [userId]);
      assert.deepEqual(r.rows.map((x) => x.slot), [3]);
    });
  });

  await t.test('users no longer carries starting_loadout_granted_at', async () => {
    const r = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'starting_loadout_granted_at'`);
    assert.equal(r.rows.length, 0, 'the column moved to characters');
  });

  await t.test('no state table still carries user_id', async () => {
    const r = await pool.query(
      `SELECT table_name FROM information_schema.columns
        WHERE column_name = 'user_id'
          AND table_name IN ('world_players','player_binds','player_progression','player_items','player_equipment')
        ORDER BY table_name`);
    assert.deepEqual(r.rows.map((x) => x.table_name), []);
  });

  await t.test('every state row is reachable through a character', async () => {
    // The backfill's actual guarantee, asserted against the live database
    // rather than against the migration's source text. An orphan here means
    // the re-key dropped ownership of real player state.
    for (const table of ['world_players', 'player_binds', 'player_progression', 'player_items', 'player_equipment']) {
      const r = await pool.query(
        `SELECT count(*)::int AS n FROM ${table} t
          WHERE NOT EXISTS (SELECT 1 FROM characters c WHERE c.id = t.character_id)`);
      assert.equal(r.rows[0].n, 0, `${table} has rows pointing at no character`);
    }
  });

  await t.test('no slot-1 character is named after a DIFFERENT account', async () => {
    // This subtest used to assert that at least one backfilled character still
    // existed. That is a property of the environment, not of the schema: the
    // backfill (migration 1714440092000) only gave a character to users that
    // already held player state, so a database with no such users legitimately
    // has zero of them. The assertion passed on the long-lived dev database and
    // failed on every fresh one -- backwards, and it checked nothing on either,
    // since the WHERE clause already forced name = username (SOMET-455).
    //
    // It cannot be rewritten as a fixture that re-runs the backfill: that
    // migration re-keyed every state table to character_id and dropped user_id,
    // so "a user holding state with no character" is no longer constructible.
    //
    // What IS checkable on any database is the collision the migration's own
    // comment calls impossible by construction -- a slot-1 character wearing
    // some OTHER account's username. characters_name_unique does not prevent
    // it: an account that never made a character leaves its username free for
    // someone else's character to take, and a future backfill over these rows
    // would then hand that account a name it cannot have.
    const r = await pool.query(
      `SELECT c.name AS character_name, owner.username AS owner, u.username AS impersonated
         FROM characters c
         JOIN users owner ON owner.id = c.user_id
         JOIN users u ON u.username = c.name AND u.id <> c.user_id
        WHERE c.slot = 1
        ORDER BY c.name`);
    assert.deepEqual(r.rows, [],
      'a slot-1 character carries another account\'s username');
  });
});
