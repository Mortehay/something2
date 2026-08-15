const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { withFixtureWorld } = require('./helpers/fixtureWorld');

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

// SOMET-341. The whole value of withFixtureWorld is the ONE case the old
// inline pattern got wrong: a body that throws. A test that only exercises the
// happy path would pass just as well against `delete at the end of the try`,
// which is the code being removed -- so the throwing case below is the load
// bearing one, and the happy-path test underneath it exists only to show the
// helper is not cleaning up by simply never creating anything.
test('withFixtureWorld removes its world even when the body throws', { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    let created = null;
    await assert.rejects(
      withFixtureWorld(pool, async (worldId) => {
        created = worldId;
        throw new Error('boom'); // exactly what a failed assertion does
      }, { prefix: 'zzFixtureGuardThrow' }),
      /boom/,
    );

    // Anti-vacuity: if the body never ran, "the world is gone" is trivially
    // true and proves nothing about cleanup.
    assert.notEqual(created, null, 'the body never ran -- this test would pass vacuously');

    const q = await pool.query('SELECT 1 FROM worlds WHERE id = $1', [created]);
    assert.equal(q.rowCount, 0,
      'the fixture world outlived a throwing body -- its cleanup is not in a finally');
  } finally {
    await pool.end();
  }
});

test('withFixtureWorld creates a real world, returns the body value, and cascades', { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    let created = null;
    const returned = await withFixtureWorld(pool, async (worldId) => {
      created = worldId;
      // Prove the row is real and usable, not just an id -- and give the
      // cascade something to take with it.
      await pool.query(
        `INSERT INTO world_creatures (world_id, type, x, y, hp, facing, level, damage, defense)
         VALUES ($1,'Wolf',10,10,20,'S',1,5,0)`,
        [worldId],
      );
      const live = await pool.query('SELECT 1 FROM worlds WHERE id = $1', [worldId]);
      assert.equal(live.rowCount, 1, 'the world should exist while the body runs');
      return 'body-value';
    }, { prefix: 'zzFixtureGuardOk' });

    assert.equal(returned, 'body-value', 'the helper must pass the body value through');
    assert.notEqual(created, null);

    const w = await pool.query('SELECT 1 FROM worlds WHERE id = $1', [created]);
    assert.equal(w.rowCount, 0, 'the world should be gone after a successful body');
    const c = await pool.query('SELECT 1 FROM world_creatures WHERE world_id = $1', [created]);
    assert.equal(c.rowCount, 0, 'world_creatures should have cascaded with the world');
  } finally {
    await pool.end();
  }
});

// Two concurrent callers must not collide on a name, or the faster one deletes
// the slower one's world mid-test -- the exact cross-file interference
// SOMET-341 is about.
test('withFixtureWorld names are unique per call', { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const names = [];
    const collect = (_id, name) => { names.push(name); };
    await Promise.all([
      withFixtureWorld(pool, collect, { prefix: 'zzFixtureGuardRace' }),
      withFixtureWorld(pool, collect, { prefix: 'zzFixtureGuardRace' }),
      withFixtureWorld(pool, collect, { prefix: 'zzFixtureGuardRace' }),
    ]);
    assert.equal(names.length, 3);
    assert.equal(new Set(names).size, 3, `names collided: ${JSON.stringify(names)}`);
  } finally {
    await pool.end();
  }
});
