// SOMET-609 (S9). The map spec's per-world `boss` block reaches the authority
// through worlds.dungeon_boss. NULL = no boss; anything but a JSON object is a
// writer bug the column refuses (an array or a string would otherwise load as
// "no boss" silently).
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { withFixtureWorld } = require('./helpers/fixtureWorld');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL' : false;

test('worlds.dungeon_boss holds an object or NULL and refuses anything else', { skip }, async () => {
  const pool = new Pool({ connectionString: url, max: 2 });
  try {
    await withFixtureWorld(pool, async (worldId) => {
      const r0 = await pool.query('SELECT dungeon_boss FROM worlds WHERE id = $1', [worldId]);
      assert.equal(r0.rows[0].dungeon_boss, null, 'defaults to NULL');

      const boss = { entity: 'zzBoss', x: 4850, y: 5450, respawn_s: 900 };
      await pool.query('UPDATE worlds SET dungeon_boss = $2::jsonb WHERE id = $1', [worldId, JSON.stringify(boss)]);
      const r1 = await pool.query('SELECT dungeon_boss FROM worlds WHERE id = $1', [worldId]);
      assert.deepEqual(r1.rows[0].dungeon_boss, boss);

      for (const bad of ['[]', '"boss"', '42']) {
        await assert.rejects(
          pool.query('UPDATE worlds SET dungeon_boss = $2::jsonb WHERE id = $1', [worldId, bad]),
          /worlds_dungeon_boss_object_check/, `must reject ${bad}`);
      }
    }, { prefix: 'zzS9col' });
  } finally {
    await pool.end();
  }
});
