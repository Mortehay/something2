const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { populateWorld } = require('../src/services/worldPopulation');
const { buildWorldGenConfig } = require('../src/services/worldGenConfig');
const { worldConfig, collectPathCells, CREATURE_TILE_PX } = require('../src/services/mapService');
const { loadTileTypes } = require('../src/services/tileTypes');

const URL = process.env.DATABASE_URL;
const describeDb = URL ? test : test.skip;

// Fixture worlds are named zzSafe* and deleted BY NAME, unconditionally, in a
// finally. Never delete by an id captured mid-test: if the test fails before
// the capture, the row leaks into the shared dev database forever.
const FIXTURES = ['zzSafeRoads'];

async function cleanup(pool) {
  await pool.query('DELETE FROM worlds WHERE name = ANY($1::text[])', [FIXTURES]);
}

// Only creature types that EXIST in the dev catalog — inventing a name makes
// every assertion vacuous, because the world would be legitimately unpopulated.
const ALLOWED = ['Skeleton', 'Bat'];

describeDb('populateWorld places no hostile inside the safe road corridor', async () => {
  const pool = new Pool({ connectionString: URL });
  try {
    await cleanup(pool);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const w = await client.query(
        `INSERT INTO worlds (name, seed, chunk_size, width, height, density,
                             allowed_creature_types, biomes, biome_cell,
                             level_min, level_max, safe_road_radius)
         VALUES ('zzSafeRoads', 4242, 32, 64, 64, 'horde',
                 $1::jsonb, '[]'::jsonb, 16, 1, 2, 2)
         RETURNING *`,
        [JSON.stringify(ALLOWED)],
      );
      const row = w.rows[0];

      const result = await populateWorld(client, row, { rngSeed: 4242 });
      assert.ok(result.total > 0, 'populated nothing — this test would assert nothing');

      const tileTypes = await loadTileTypes(client);
      const cfg = worldConfig(buildWorldGenConfig({
        row, tileTypes, doorways: [], villages: [], biomes: [],
      }));
      const roads = collectPathCells(cfg, 0, 0, row.height, row.width);
      assert.ok(roads.size > 0, 'no carved roads — this test would assert nothing');

      const placed = await client.query(
        'SELECT x, y FROM world_creatures WHERE world_id = $1', [row.id]);
      for (const c of placed.rows) {
        const rr = Math.floor(Number(c.y) / CREATURE_TILE_PX);
        const cc = Math.floor(Number(c.x) / CREATURE_TILE_PX);
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            assert.ok(!roads.has(`${rr + dr},${cc + dc}`),
              `creature at tile (${rr},${cc}) is inside the radius-2 road corridor`);
          }
        }
      }
      // Rolled back: this test proves placement, it does not need to leave a
      // world behind. NOTE that client.release() does NOT roll back on its own
      // in this codebase — the explicit ROLLBACK is the thing that works.
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  } finally {
    await cleanup(pool);
    await pool.end();
  }
});
