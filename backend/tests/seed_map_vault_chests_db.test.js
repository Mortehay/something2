const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { applyMapSpec } = require('../scripts/seed-map.js');
const { withEntryPreserved } = require('./helpers/entryWorld.js');

// Mirrors seed_map_db.test.js's DB setup exactly: same connection fallback,
// same graceful-skip-if-unreachable shape, same zz-prefix convention, and
// the same withEntryPreserved wrapper -- our spec below must declare exactly
// one is_entry: true world (mapSpec.js's validator requires it), and without
// this wrapper that would steal is_entry away from whatever world is really
// live-entry in this shared dev database and never give it back, since our
// own cleanup() only deletes this test's own zz-prefixed row.
const DB_URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://user:password@localhost:15432/game_db';

async function openPool() {
  const pool = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 2000, max: 2 });
  try { await pool.query('SELECT 1'); return pool; }
  catch (err) { await pool.end().catch(() => {}); return { unreachable: err.message }; }
}


async function cleanup(pool) {
  await pool.query("DELETE FROM worlds WHERE name = 'zz Vault Chest World'").catch(() => {});
}

// Wolf is the pre-existing baseline creature type this codebase's fixtures
// already reference read-only (see the "Biome data model" / "Creature
// levels A1" project memory) -- never mutated here, only looked up by name.
function spec() {
  return {
    name: 'zz-vault-chest-test',
    topology: 'spine',
    worlds: [{
      key: 'a', name: 'zz Vault Chest World', grid: [40, 40], seed: 501,
      width: 10, height: 10, chunk_size: 64, biomes: [], biome_cell: 32,
      allowed_creature_types: [], is_entry: true,
      chest: { x: 500, y: 500, guard_creature_type: 'Wolf', level: 3 },
    }],
    links: [],
  };
}

test('seeding a spec with a vault chest twice does not double the chest or its guard', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} (${pool.unreachable}) — vault chest seeding is UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  try {
    await cleanup(pool);
    const s = spec();
    await withEntryPreserved(pool, async () => {
      const first = await applyMapSpec(pool, s);
      assert.equal(first.vaultChests, 1, 'first apply must report the one authored chest as written');

      const second = await applyMapSpec(pool, s); // re-apply, must be a no-op for the chest
      assert.equal(second.vaultChests, 0, 're-applying an unchanged spec must write zero new chests');

      const world = await pool.query("SELECT id FROM worlds WHERE name = 'zz Vault Chest World'");
      const worldId = world.rows[0].id;

      const chests = await pool.query('SELECT * FROM world_chests WHERE world_id = $1', [worldId]);
      assert.equal(chests.rowCount, 1, 're-seeding must not create a second chest');
      assert.equal(chests.rows[0].kind, 'vault');
      assert.equal(chests.rows[0].state, 'locked');
      assert.equal(chests.rows[0].guard_level, 3);

      const guards = await pool.query(
        "SELECT * FROM world_creatures WHERE world_id = $1 AND type = 'Wolf'", [worldId],
      );
      assert.equal(guards.rowCount, 1, 're-seeding must not spawn a second guard');
      assert.equal(Number(guards.rows[0].home_x), 500, 'guard must be leashed to the chest tile');
      assert.equal(Number(guards.rows[0].home_y), 500, 'guard must be leashed to the chest tile');

      assert.deepEqual(
        chests.rows[0].guard_creature_ids, [guards.rows[0].id],
        'the chest must reference exactly its own guard',
      );
    });
  } finally {
    await cleanup(pool);
    await pool.end();
  }
});
