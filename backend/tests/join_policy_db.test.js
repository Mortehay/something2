const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const { joinPolicyFacts } = require('../src/services/joinPolicy.js');

// The loader half of the join authorization rule (Plan B slice 3).
// join_policy.test.js covers the decision; this covers the facts it decides on,
// which is where a wrong join, a wrong column name or a silently-null boolean
// would turn a correct rule into a wrong answer.

// A source-text pair check, not a behavioural one, because the failure it
// guards is a DRIFT between two files: services/characters.js tells the client
// which world to resume into, joinPolicy.js decides whether that resume is
// allowed. Both answer "which world was this character in last", and if they
// ever pick different rows the client offers a world the server refuses -- and
// a refused join never sends `joined`, so the player sits on a canvas that
// never starts. Cheap to keep aligned, expensive to debug once apart.
test('both "last world" queries pick the same row', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  const ORDERING = /FROM world_players[\s\S]{0,120}ORDER BY\s+(?:wp\.)?updated_at DESC LIMIT 1/i;
  assert.match(read('src/services/characters.js'), ORDERING);
  assert.match(read('src/services/joinPolicy.js'), ORDERING);
});

const url = process.env.TEST_DATABASE_URL;

test('joinPolicyFacts', { skip: !url ? 'no TEST_DATABASE_URL' : false }, async (t) => {
  const pool = new Pool({ connectionString: url });
  const tag = `zzJoinPolicy-${process.pid}`;

  // ONE after-hook that cleans up and THEN closes the pool. Split across two
  // hooks -- `t.after(() => pool.end())` registered first, the deletes second --
  // node runs them in registration order, so every cleanup query ran against a
  // closed pool and threw into its own `.catch(() => {})`. The tests passed and
  // left throwaway users and flagged worlds behind in the shared database,
  // where another test file's `count(*) WHERE allows_fast_travel` then read
  // them as live content. The error is deliberately logged rather than
  // swallowed, so the next leak announces itself.
  t.after(async () => {
    try {
      await pool.query('DELETE FROM users WHERE username = $1', [tag]);
      await pool.query('DELETE FROM worlds WHERE name LIKE $1', [`${tag}-%`]);
    } catch (e) {
      console.error('join_policy_db cleanup failed -- fixtures left behind:', e.message);
    } finally {
      await pool.end();
    }
  });

  let userId; let charId; let plain; let flagged;

  await pool.query(
    "INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'player') ON CONFLICT (username) DO NOTHING",
    [tag]);
  userId = (await pool.query('SELECT id FROM users WHERE username = $1', [tag])).rows[0].id;

  // Fixture worlds of this test's own, never the shared map: the flag is the
  // thing under test and flipping it on a real world would change what live
  // characters can reach.
  const mkWorld = async (name, flag) => (await pool.query(
    'INSERT INTO worlds (name, seed, allows_fast_travel) VALUES ($1, 1, $2) RETURNING id',
    [`${tag}-${name}`, flag])).rows[0].id;

  const cls = (await pool.query("SELECT id FROM entity_types WHERE name = 'Warrior'")).rows[0];
  charId = (await pool.query(
    'INSERT INTO characters (user_id, slot, name, entity_type_id) VALUES ($1, 1, $2, $3) RETURNING id',
    [userId, `${tag}-char`, cls.id])).rows[0].id;
  plain = await mkWorld('plain', false);
  flagged = await mkWorld('flagged', true);

  await t.test('a world that does not exist yields null, not a permissive blank', async () => {
    // mayJoin refuses on null. A loader that returned an all-false object here
    // would be indistinguishable from a real unreachable world, which is the
    // same refusal -- but one that returned {} would read every flag as
    // undefined and could not be told apart from a query that broke.
    assert.equal(await joinPolicyFacts(pool, charId, '00000000-0000-0000-0000-000000000000'), null);
  });

  await t.test('a fresh character has no history and no visits', async () => {
    const f = await joinPolicyFacts(pool, charId, plain);
    assert.equal(f.visited, false);
    assert.equal(f.hasHistory, false);
    assert.equal(f.lastWorldId, null);
    assert.equal(f.allowsFastTravel, false);
  });

  await t.test('the flag is read per world, not per character', async () => {
    assert.equal((await joinPolicyFacts(pool, charId, flagged)).allowsFastTravel, true);
    assert.equal((await joinPolicyFacts(pool, charId, plain)).allowsFastTravel, false);
  });

  await t.test('a visit is seen for that world only', async () => {
    await pool.query(
      'INSERT INTO character_visited_worlds (character_id, world_id) VALUES ($1, $2)',
      [charId, flagged]);
    assert.equal((await joinPolicyFacts(pool, charId, flagged)).visited, true);
    const other = await joinPolicyFacts(pool, charId, plain);
    assert.equal(other.visited, false, 'a visit elsewhere must not unlock this world');
    // ...but it IS history, which closes the first-join allowance.
    assert.equal(other.hasHistory, true);
  });

  await t.test('lastWorldId follows the most recent world_players row', async () => {
    await pool.query(
      `INSERT INTO world_players (world_id, character_id, x, y, updated_at)
       VALUES ($1, $2, 5, 5, now() - interval '2 days')`, [flagged, charId]);
    await pool.query(
      `INSERT INTO world_players (world_id, character_id, x, y, updated_at)
       VALUES ($1, $2, 6, 6, now() - interval '1 hour')`, [plain, charId]);
    // The newer row wins. Ordered by updated_at rather than by insertion, so
    // this asserts the ORDER BY and not just "some row came back".
    assert.equal((await joinPolicyFacts(pool, charId, plain)).lastWorldId, plain);
    assert.equal((await joinPolicyFacts(pool, charId, flagged)).lastWorldId, plain,
      'the last world is a fact about the character, not about the world asked for');
  });

  await t.test('a character with only a world_players row still has history', async () => {
    // The backfill (Plan A) gives every such character visit rows, but a
    // character whose visit rows were removed must not get the first-join
    // allowance back -- that is a free trip to any flagged world.
    const c2 = (await pool.query(
      'INSERT INTO characters (user_id, slot, name, entity_type_id) VALUES ($1, 2, $2, $3) RETURNING id',
      [userId, `${tag}-char2`, cls.id])).rows[0].id;
    await pool.query(
      'INSERT INTO world_players (world_id, character_id, x, y) VALUES ($1, $2, 1, 1)',
      [plain, c2]);
    const f = await joinPolicyFacts(pool, c2, flagged);
    assert.equal(f.visited, false);
    assert.equal(f.hasHistory, true);
  });
});
