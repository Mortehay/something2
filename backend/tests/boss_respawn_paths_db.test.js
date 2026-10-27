// SOMET-609 (S9). Neither legacy respawn path may turn a boss-tier type into a
// plain persisted wild creature: commitCreatureDeath queues nothing for one,
// and respawnDueCreatures drops a stray queued row instead of inserting it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { commitCreatureDeath } = require('../src/authority/loot');
const { respawnDueCreatures } = require('../src/services/creatureRespawn');
const { withFixtureWorld } = require('./helpers/fixtureWorld');

const url = process.env.TEST_DATABASE_URL;
const skip = !url ? 'no TEST_DATABASE_URL' : false;
const WORLD_CFG = { tileTypes: [{ name: 'grass' }], width: 96, height: 96, levelMin: 1, levelMax: 5 };

test('commitCreatureDeath queues no respawn for a boss-tier type, still queues for a wild one', { skip }, async () => {
  const pool = new Pool({ connectionString: url, max: 3 });
  try {
    await withFixtureWorld(pool, async (worldId) => {
      const ins = async (type) => (await pool.query(
        `INSERT INTO world_creatures (world_id, type, x, y, hp, facing, level, damage, defense)
         VALUES ($1,$2,500,500,10,'S',7,5,0) RETURNING id`, [worldId, type])).rows[0].id;
      const entry = { worldId, world: { getPlayer: () => null }, creatureTypeIds: new Map() };
      await commitCreatureDeath(pool, entry, await ins('The Bone Regent'), { killerUserId: null });
      await commitCreatureDeath(pool, entry, await ins('Wolf'), { killerUserId: null });
      const q = await pool.query('SELECT type FROM creature_respawns WHERE world_id = $1 ORDER BY type', [worldId]);
      assert.deepEqual(q.rows.map((r) => r.type), ['Wolf']);
    }, { prefix: 'zzS9loot' });
  } finally {
    await pool.end();
  }
});

test('respawnDueCreatures drops a queued boss-tier row and inserts no creature', { skip }, async () => {
  const pool = new Pool({ connectionString: url, max: 3 });
  try {
    await withFixtureWorld(pool, async (worldId) => {
      await pool.query(
        `INSERT INTO creature_respawns (world_id, type, x, y, level, respawn_at)
         VALUES ($1,'The Bone Regent',500,500,7, now() - interval '1 second')`, [worldId]);
      const n = await respawnDueCreatures(pool, {
        loadedWorldIds: [worldId], getWorld: () => WORLD_CFG, getPlayers: () => [],
      });
      assert.equal(n, 0);
      const wc = await pool.query('SELECT count(*)::int AS n FROM world_creatures WHERE world_id = $1', [worldId]);
      assert.equal(wc.rows[0].n, 0, 'no plain persisted boss');
      const cr = await pool.query('SELECT count(*)::int AS n FROM creature_respawns WHERE world_id = $1', [worldId]);
      assert.equal(cr.rows[0].n, 0, 'the stray row is dropped, not retried forever');
    }, { prefix: 'zzS9sweep' });
  } finally {
    await pool.end();
  }
});
