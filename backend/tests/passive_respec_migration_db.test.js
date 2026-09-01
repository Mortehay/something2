// backend/tests/passive_respec_migration_db.test.js
//
// SOMET-524. The free-respec migration that runs ahead of the passive tree v2
// forced reseed.
//
// The migration has already run by the time this file executes, so it is
// re-applied here against a fixture of this test's OWN making. That is the
// only honest way to test it: asserting against whatever the shared database
// happened to contain would pass or fail on unrelated state.

const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const fs = require('node:fs');
const path = require('node:path');

const url = process.env.TEST_DATABASE_URL;
const skip = !url
  ? 'no TEST_DATABASE_URL -- refusing to mutate a real database (this test writes characters)'
  : false;

// The migration body, extracted and run directly. Requiring the migration
// module and calling exports.up with a stub `pgm` is what keeps this a test of
// the SHIPPED sql rather than of a copy pasted into the test -- a copy would
// keep passing after the migration was edited.
const MIGRATION = path.join(__dirname, '..', 'migrations', '1714440521000_passive_tree_v2_respec.js');

test('passive tree v2 respec migration', { skip }, async (t) => {
  const pool = new Pool({ connectionString: url, max: 4 });
  const made = { users: [] };
  t.after(async () => {
    // client.release() does NOT roll back; characters and player_progression
    // both cascade from users, so deleting the users is the whole cleanup.
    if (made.users.length) {
      await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [made.users]);
    }
    await pool.end();
  });

  const { up } = require(MIGRATION);
  const runMigration = () => up({ db: { query: (sql) => pool.query(sql) } });

  // A character with `alloc` allocations and `banked` points already in hand.
  // `withProgression: false` reproduces the state 3 of 26 real characters are
  // in: allocations but NO player_progression row, because loadProgression
  // creates that row lazily on first read.
  async function makeCharacter({ alloc, banked, withProgression = true }) {
    const u = await pool.query(
      "INSERT INTO users (username, password_hash) VALUES ($1,'x') RETURNING id",
      [`respec_${Math.random().toString(36).slice(2, 10)}`],
    );
    made.users.push(u.rows[0].id);
    // slot and entity_type_id are NOT NULL with no default; entity_type_id is
    // taken from the seeded catalog rather than hardcoded, so this fixture
    // survives a re-seed that renumbers the classes.
    const c = await pool.query(
      `INSERT INTO characters (user_id, slot, name, entity_type_id)
       VALUES ($1, 1, $2, (SELECT id FROM entity_types ORDER BY id LIMIT 1))
       RETURNING id`,
      [u.rows[0].id, `c_${Math.random().toString(36).slice(2, 8)}`],
    );
    const id = c.rows[0].id;
    if (withProgression) {
      await pool.query(
        'INSERT INTO player_progression (character_id, passive_points) VALUES ($1,$2)',
        [id, banked],
      );
    }
    if (alloc > 0) {
      await pool.query(
        `INSERT INTO character_passives (character_id, node_id)
         SELECT $1, id FROM passive_nodes WHERE kind = 'minor' ORDER BY id LIMIT $2`,
        [id, alloc],
      );
    }
    return id;
  }

  const points = async (id) => {
    const r = await pool.query('SELECT passive_points FROM player_progression WHERE character_id=$1', [id]);
    return r.rows.length ? r.rows[0].passive_points : null;
  };
  const allocations = async (id) => {
    const r = await pool.query('SELECT count(*)::int n FROM character_passives WHERE character_id=$1', [id]);
    return r.rows[0].n;
  };

  await t.test('refunds exactly the rows each character held', async () => {
    const spender = await makeCharacter({ alloc: 5, banked: 2 });
    const saver = await makeCharacter({ alloc: 0, banked: 7 });
    const fresh = await makeCharacter({ alloc: 0, banked: 0 });

    await runMigration();

    // PER CHARACTER, not in aggregate: an aggregate check passes on a
    // migration that moves points between characters.
    assert.equal(await points(spender), 7, '2 banked + 5 refunded');
    assert.equal(await allocations(spender), 0);
    assert.equal(await points(saver), 7, 'a character with no allocations is unchanged');
    assert.equal(await points(fresh), 0);
  });

  // The case an earlier draft got wrong. It DELETEd these rows unrefunded,
  // destroying points nobody was ever credited for.
  await t.test('creates a progression row for a character that has none', async () => {
    const orphan = await makeCharacter({ alloc: 3, banked: 0, withProgression: false });
    assert.equal(await points(orphan), null, 'precondition: no progression row');

    await runMigration();

    assert.equal(await points(orphan), 3, 'the refund must create the row, not drop the points');
    assert.equal(await allocations(orphan), 0);
  });

  await t.test('is idempotent -- a second run refunds nothing', async () => {
    const c = await makeCharacter({ alloc: 4, banked: 1 });
    await runMigration();
    assert.equal(await points(c), 5);
    await runMigration();
    assert.equal(await points(c), 5, 'a second run must not refund again');
    await runMigration();
    assert.equal(await points(c), 5);
  });

  await t.test('leaves no allocation behind anywhere', async () => {
    await makeCharacter({ alloc: 6, banked: 0 });
    await makeCharacter({ alloc: 2, banked: 3, withProgression: false });
    await runMigration();
    const r = await pool.query('SELECT count(*)::int n FROM character_passives');
    assert.equal(r.rows[0].n, 0, 'the reseed must not find a stale allocation');
  });
});
