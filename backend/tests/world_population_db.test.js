const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { populateWorld } = require('../src/services/worldPopulation');

const URL = process.env.DATABASE_URL;
const describeDb = URL ? test : test.skip;

// Fixture worlds are named zzPop* and deleted by name, unconditionally, in a
// finally. Never delete by an id captured mid-test: if the test fails before
// the capture, the row leaks into the shared dev database forever.
const FIXTURES = ['zzPopHorde', 'zzPopDead', 'zzPopNoAllowlist'];

async function cleanup(pool) {
  await pool.query('DELETE FROM worlds WHERE name = ANY($1::text[])', [FIXTURES]);
}

// Only creature types that EXIST in the dev catalog. Inventing a name makes
// every assertion below vacuous -- the biome intersection would come back
// empty and the world would be legitimately unpopulated.
const ALLOWED = ['Skeleton', 'Bat'];

async function makeWorld(pool, name, density, allowedNames = ALLOWED) {
  const r = await pool.query(
    `INSERT INTO worlds (name, seed, chunk_size, width, height, density,
                         allowed_creature_types, biomes, biome_cell, level_min, level_max)
     VALUES ($1, 4242, 32, 64, 64, $2, $3::jsonb, $4::jsonb, 16, 3, 5)
     RETURNING *`,
    [name, density, JSON.stringify(allowedNames), JSON.stringify(['Deep Forest'])],
  );
  return r.rows[0];
}

describeDb('populateWorld fills an empty world from its density tier', async () => {
  const pool = new Pool({ connectionString: URL });
  try {
    await cleanup(pool);
    const world = await makeWorld(pool, 'zzPopHorde', 'horde');
    const client = await pool.connect();
    let result;
    try {
      await client.query('BEGIN');
      result = await populateWorld(client, world, { rngSeed: 99 });
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    // horde on 64x64: 49 scattered + 4 packs of 5-8. Packs may ship short on
    // a map with unwalkable terrain, so assert a floor, not an exact total --
    // but assert the SCATTER exactly, which is not subject to short packs.
    assert.equal(result.scattered, 49);
    assert.ok(result.packed >= 20, `packed ${result.packed} >= 20`);
    assert.equal(result.total, result.scattered + result.packed);

    const rows = await pool.query(
      'SELECT count(*)::int AS n FROM world_creatures WHERE world_id = $1', [world.id]);
    assert.equal(rows.rows[0].n, result.total);
  } finally {
    await cleanup(pool);
    await pool.end();
  }
});

describeDb('populateWorld persists the resolved scatter count to creature_count', async () => {
  const pool = new Pool({ connectionString: URL });
  try {
    await cleanup(pool);
    const world = await makeWorld(pool, 'zzPopHorde', 'horde');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await populateWorld(client, world, { rngSeed: 7 });
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const r = await pool.query('SELECT creature_count FROM worlds WHERE id = $1', [world.id]);
    assert.equal(r.rows[0].creature_count, 49);
  } finally {
    await cleanup(pool);
    await pool.end();
  }
});

describeDb('a repopulate converges rather than duplicating', async () => {
  const pool = new Pool({ connectionString: URL });
  try {
    await cleanup(pool);
    const world = await makeWorld(pool, 'zzPopHorde', 'horde');
    const run = async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const r = await populateWorld(client, world, { rngSeed: 55 });
        await client.query('COMMIT');
        return r;
      } finally { client.release(); }
    };
    const first = await run();
    const second = await run();
    assert.equal(first.total, second.total);
    const rows = await pool.query(
      'SELECT count(*)::int AS n FROM world_creatures WHERE world_id = $1', [world.id]);
    assert.equal(rows.rows[0].n, second.total);
  } finally {
    await cleanup(pool);
    await pool.end();
  }
});

describeDb('guards survive a repopulate', async () => {
  const pool = new Pool({ connectionString: URL });
  try {
    await cleanup(pool);
    const world = await makeWorld(pool, 'zzPopHorde', 'horde');
    await pool.query(
      `INSERT INTO world_creatures (world_id, type, x, y, hp, facing, home_x, home_y)
       VALUES ($1, 'Village Guard', 550, 550, 30, 'S', 550, 550)`, [world.id]);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await populateWorld(client, world, { rngSeed: 3 });
      await client.query('COMMIT');
    } finally { client.release(); }
    const g = await pool.query(
      `SELECT count(*)::int AS n FROM world_creatures
       WHERE world_id = $1 AND type = 'Village Guard'`, [world.id]);
    assert.equal(g.rows[0].n, 1);
  } finally {
    await cleanup(pool);
    await pool.end();
  }
});

// Covers the gap found wiring populateWorld into applyMapSpec (SOMET-246
// Task 6): a portal guard is an ordinary hostile entity_types row (e.g.
// 'Wolf', see seed_map_portals.test.js) marked structural only by
// blocks_portal_id, NOT by type = 'Village Guard' or faction = 'guard'. A
// delete that only spared `type <> 'Village Guard'` deleted it on every
// repopulate. blocks_portal_id references map_links, so this fixture inserts
// a throwaway link row to get a real id rather than faking one.
describeDb('a portal guard survives a repopulate even though its type is an ordinary hostile', async () => {
  const pool = new Pool({ connectionString: URL });
  try {
    await cleanup(pool);
    const world = await makeWorld(pool, 'zzPopHorde', 'horde');
    const link = await pool.query(
      `INSERT INTO map_links (from_world_id, edge, to_world_id, from_x, from_y, to_x, to_y)
       VALUES ($1, 'PORTAL', $1, 100, 100, 200, 200) RETURNING id`, [world.id]);
    await pool.query(
      `INSERT INTO world_creatures (world_id, type, x, y, hp, facing, home_x, home_y, blocks_portal_id)
       VALUES ($1, 'Wolf', 100, 100, 12, 'S', 100, 100, $2)`, [world.id, link.rows[0].id]);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await populateWorld(client, world, { rngSeed: 3 });
      await client.query('COMMIT');
    } finally { client.release(); }
    const g = await pool.query(
      `SELECT count(*)::int AS n FROM world_creatures
       WHERE world_id = $1 AND blocks_portal_id = $2`, [world.id, link.rows[0].id]);
    assert.equal(g.rows[0].n, 1, 'the portal guard was deleted by the population pass');
  } finally {
    await cleanup(pool);
    await pool.end();
  }
});

describeDb('the dead tier leaves a world genuinely empty', async () => {
  const pool = new Pool({ connectionString: URL });
  try {
    await cleanup(pool);
    const world = await makeWorld(pool, 'zzPopDead', 'dead');
    const client = await pool.connect();
    let result;
    try {
      await client.query('BEGIN');
      result = await populateWorld(client, world, { rngSeed: 11 });
      await client.query('COMMIT');
    } finally { client.release(); }
    assert.equal(result.total, 0);
  } finally {
    await cleanup(pool);
    await pool.end();
  }
});

// Covers the gap the Task 4 review found: allowed_creature_types = [] (the
// column's own default -- migration 1714440027000_bounded_worlds.js:16) with
// a non-dead density used to still write creature_count = density.scatterCount
// (49 for horde) before the empty-allowlist early return, leaving the admin
// UI showing a nonzero count over a genuinely empty map. Density is 'horde'
// specifically so scatterCount is nonzero -- against the old write-before-
// checking ordering this assertion would see 49, not 0.
describeDb('an empty allowlist zeroes creature_count rather than leaving a stale value', async () => {
  const pool = new Pool({ connectionString: URL });
  try {
    await cleanup(pool);
    const world = await makeWorld(pool, 'zzPopNoAllowlist', 'horde', []);
    const client = await pool.connect();
    let result;
    try {
      await client.query('BEGIN');
      result = await populateWorld(client, world, { rngSeed: 21 });
      await client.query('COMMIT');
    } finally { client.release(); }
    assert.equal(result.total, 0);

    const r = await pool.query('SELECT creature_count FROM worlds WHERE id = $1', [world.id]);
    assert.equal(r.rows[0].creature_count, 0);

    const rows = await pool.query(
      'SELECT count(*)::int AS n FROM world_creatures WHERE world_id = $1', [world.id]);
    assert.equal(rows.rows[0].n, 0);
  } finally {
    await cleanup(pool);
    await pool.end();
  }
});
