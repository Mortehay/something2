const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { commitCreatureDeath } = require('../src/authority/loot');
const { enqueueDeficit } = require('../src/services/creatureRespawn');

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

// A minimal `entry`. commitCreatureDeath reaches into `entry` in four places
// and only one of them is unguarded:
//
//   entry.creatureTypeIds.get(dead.type)  -- loot.js:131, NO null guard, so
//       this field MUST be present or every test here dies with a TypeError.
//       An empty Map makes spawnDrops return at its `entityTypeId == null`
//       check (loot.js:132), so no drop rows are written and
//       entry.world.groundItems is never touched.
//   entry.behaviorDrops / entry.creatureGold / entry.behaviorGold -- all
//       guarded with `&&`, so omitting them yields no drops and zero gold.
//   entry.goldItemTypeId -- guarded with `!= null`.
//   entry.world.getPlayer -- only reached when killerUserId != null.
//
// A null killer skips the XP branch entirely, which is what keeps this test
// about the respawn queue and not about progression.
function fakeEntry(worldId) {
  return {
    worldId,
    world: { getPlayer: () => null },
    creatureTypeIds: new Map(),
  };
}

// Creates a world we own outright, so nothing here touches shared content.
// NEVER run destructive statements against existing rows in this database.
//
// `seed` is NOT NULL with no default and MUST be supplied -- terrain is a
// function of (seed, size), so a world with no seed is not merely untidy, it
// cannot generate. `name` is likewise NOT NULL and is randomised so parallel
// runs of this suite cannot collide.
async function makeWorld(pool) {
  const r = await pool.query(
    `INSERT INTO worlds (name, seed, width, height, density, chunk_size)
     VALUES ($1, 4242, 96, 96, 'normal', 32) RETURNING id`,
    [`respawn-test-${Date.now()}-${Math.random()}`],
  );
  return r.rows[0].id;
}

test('killing a wild creature queues exactly one respawn', { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const worldId = await makeWorld(pool);
    const c = await pool.query(
      `INSERT INTO world_creatures (world_id, type, x, y, hp, facing, level, damage, defense)
       VALUES ($1,'Wolf',1234,5678,20,'S',4,7,2) RETURNING id`,
      [worldId],
    );

    const res = await commitCreatureDeath(pool, fakeEntry(worldId), c.rows[0].id, { killerUserId: null });
    assert.notEqual(res, null);

    const q = await pool.query(
      'SELECT type, x, y, level FROM creature_respawns WHERE world_id = $1', [worldId],
    );
    assert.equal(q.rowCount, 1);
    assert.equal(q.rows[0].type, 'Wolf');
    assert.equal(q.rows[0].x, 1234);
    assert.equal(q.rows[0].y, 5678);
    assert.equal(q.rows[0].level, 4);

    await pool.query('DELETE FROM worlds WHERE id = $1', [worldId]); // cascades
  } finally {
    await pool.end();
  }
});

test('killing a guard queues nothing', { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const worldId = await makeWorld(pool);
    // home_x/home_y set = a guard. This is the structural marker every guard
    // kind shares; a type-name filter would miss a portal or vault guard,
    // which can be any ordinary creature type (e.g. a 'Wolf' portal guard).
    const c = await pool.query(
      `INSERT INTO world_creatures (world_id, type, x, y, hp, facing, level, damage, defense, home_x, home_y)
       VALUES ($1,'Wolf',100,100,20,'S',4,7,2,100,100) RETURNING id`,
      [worldId],
    );

    await commitCreatureDeath(pool, fakeEntry(worldId), c.rows[0].id, { killerUserId: null });

    const q = await pool.query('SELECT 1 FROM creature_respawns WHERE world_id = $1', [worldId]);
    assert.equal(q.rowCount, 0);

    await pool.query('DELETE FROM worlds WHERE id = $1', [worldId]);
  } finally {
    await pool.end();
  }
});

test('a queued respawn is not due immediately', { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const worldId = await makeWorld(pool);
    const c = await pool.query(
      `INSERT INTO world_creatures (world_id, type, x, y, hp, facing, level, damage, defense)
       VALUES ($1,'Wolf',10,10,20,'S',1,5,0) RETURNING id`,
      [worldId],
    );
    await commitCreatureDeath(pool, fakeEntry(worldId), c.rows[0].id, { killerUserId: null });

    const due = await pool.query(
      'SELECT 1 FROM creature_respawns WHERE world_id = $1 AND respawn_at <= now()', [worldId],
    );
    // 30s in the future, so a sweep running right now must not pick it up.
    assert.equal(due.rowCount, 0);

    await pool.query('DELETE FROM worlds WHERE id = $1', [worldId]);
  } finally {
    await pool.end();
  }
});

// The buildWorldGenConfig shape placeMapCreatures needs. A single grass tile
// type makes every tile legal, so placement never fails for terrain reasons
// and the test is about the arithmetic, not the sampler.
function fakeWorldConfig() {
  return {
    width: 96, height: 96, levelMin: 1, levelMax: 5,
    tileTypes: [{ name: 'grass', walkable: true }],
    villages: [], doorways: [], biomes: [],
  };
}

test('the backstop enqueues the gap between target and live population', { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const worldId = await makeWorld(pool);
    await pool.query(
      // allowed_creature_types is jsonb (migration 1714440027000), not
      // text[] -- Postgres does not implicitly cast text[] to jsonb, so
      // ARRAY['Wolf']::text[] fails with "column ... is of type jsonb but
      // expression is of type text[]". A jsonb array literal is what every
      // other writer in this codebase uses (worldPopulation.js, index.js).
      `UPDATE worlds SET allowed_creature_types = '["Wolf"]'::jsonb WHERE id = $1`, [worldId],
    );
    const row = (await pool.query('SELECT * FROM worlds WHERE id = $1', [worldId])).rows[0];

    // 96x96 at 'normal' (18 per 1000 tiles) targets 166 scattered creatures.
    // Math: 18 * 9216 / 1000 = 165.888 ≈ 166.
    // Hand-typed from the shipped tier table, NOT recomputed from
    // resolveDensity -- deriving it from the code under test would make this
    // assertion true for any tier values at all.
    const enqueued = await enqueueDeficit(pool, { worldRow: row, world: fakeWorldConfig() });
    assert.equal(enqueued, 166);

    const q = await pool.query('SELECT count(*)::int AS n FROM creature_respawns WHERE world_id = $1', [worldId]);
    assert.equal(q.rows[0].n, 166);

    await pool.query('DELETE FROM worlds WHERE id = $1', [worldId]);
  } finally {
    await pool.end();
  }
});

test('the backstop enqueues nothing for a world already at target', { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const worldId = await makeWorld(pool);
    await pool.query(
      `UPDATE worlds SET allowed_creature_types = '["Wolf"]'::jsonb WHERE id = $1`, [worldId],
    );
    // 60 live wild creatures, well short of the 166 target (166 - 60 = 106 deficit).
    for (let i = 0; i < 60; i += 1) {
      await pool.query(
        `INSERT INTO world_creatures (world_id, type, x, y, hp, facing, level, damage, defense)
         VALUES ($1,'Wolf',$2,$2,20,'S',1,5,0)`, [worldId, 100 + i],
      );
    }
    const row = (await pool.query('SELECT * FROM worlds WHERE id = $1', [worldId])).rows[0];

    assert.equal(await enqueueDeficit(pool, { worldRow: row, world: fakeWorldConfig() }), 106);

    await pool.query('DELETE FROM worlds WHERE id = $1', [worldId]);
  } finally {
    await pool.end();
  }
});

test('already-pending respawns count against the deficit', { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const worldId = await makeWorld(pool);
    await pool.query(
      `UPDATE worlds SET allowed_creature_types = '["Wolf"]'::jsonb WHERE id = $1`, [worldId],
    );
    // 50 kills already in flight. Target is 166, so deficit = 166 - 50 = 116.
    // Without subtracting these pending spawns the world would be filled
    // and then filled again as each pending row comes due.
    for (let i = 0; i < 50; i += 1) {
      await pool.query(
        `INSERT INTO creature_respawns (world_id, type, x, y, level, respawn_at)
         VALUES ($1,'Wolf',$2,$2,1, now())`, [worldId, 100 + i],
      );
    }
    const row = (await pool.query('SELECT * FROM worlds WHERE id = $1', [worldId])).rows[0];

    assert.equal(await enqueueDeficit(pool, { worldRow: row, world: fakeWorldConfig() }), 116);

    await pool.query('DELETE FROM worlds WHERE id = $1', [worldId]);
  } finally {
    await pool.end();
  }
});

test('a world with no allowed creature types enqueues nothing', { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  try {
    const worldId = await makeWorld(pool); // allowed_creature_types left empty
    const row = (await pool.query('SELECT * FROM worlds WHERE id = $1', [worldId])).rows[0];

    // SOMET-315's empty worlds must stay empty: there is no legal creature to
    // place, and enqueueing rows that can never resolve would build a queue
    // that fails on every sweep forever.
    assert.equal(await enqueueDeficit(pool, { worldRow: row, world: fakeWorldConfig() }), 0);

    await pool.query('DELETE FROM worlds WHERE id = $1', [worldId]);
  } finally {
    await pool.end();
  }
});

// No database needed -- pure source-text guard, not gated on `url`.
//
// Precedent: spawn_portal_fallback.test.js's "loadSpawn actually supplies
// portals and isWalkable". The failure this catches is inertness with zero
// coverage from the DB tests above: enqueueDeficit(pool, { worldRow: row,
// ... }) reads row.density and row.allowed_creature_types, but `row` there
// is whatever loadWorld's own SELECT names -- NOT `SELECT *`. The DB tests
// above build worldRow themselves via `SELECT * FROM worlds`, so none of
// them would notice if loadWorld's real SELECT stopped naming these columns.
// Delete either one from that SELECT and every test in this repo still
// passes while the load-time backstop silently enqueues 0 forever in
// production -- the exact defect this task's brief shipped with (see the
// comment directly above the SELECT this test reads) and the exact class of
// bug SOMET-288 already shipped once for safe_road_radius/safe_rects.
// No database needed -- the second source-text guard, same reasoning as the one
// below and the same failure class: an edit that every existing test still
// passes for, while the feature quietly stops working.
//
// Swap `client` for the bare `pool` at commitCreatureDeath's
// `INSERT INTO creature_respawns` and the death still commits, the row is still
// written, and every DB test above still passes -- because they only look at
// the happy path. What is lost is atomicity: the INSERT would run in its own
// implicit transaction, so a failure in the XP award or the drop roll (both of
// which follow it) rolls the DELETE back and leaves an orphan respawn row, and
// a failure of the INSERT itself leaves a committed death with no replacement
// queued -- the exact permanent population leak SOMET-309 exists to fix.
//
// Scoped to commitCreatureDeath's body: loot.js has many other pool.query and
// client.query calls, so a whole-file search would prove nothing.
test('commitCreatureDeath enqueues the respawn inside the death transaction', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/authority/loot.js'), 'utf8');
  const start = src.indexOf('async function commitCreatureDeath(');
  assert.ok(start !== -1, 'could not locate commitCreatureDeath');
  const end = src.indexOf('\nasync function spawnDrops(', start);
  assert.ok(end !== -1, 'could not locate the end of commitCreatureDeath');
  const body = src.slice(start, end);

  const m = /await\s+(\w+)\.query\(\s*`INSERT INTO creature_respawns/.exec(body);
  assert.ok(m, 'commitCreatureDeath must issue the creature_respawns INSERT itself');
  assert.equal(
    m[1], 'client',
    'the respawn INSERT must go through the transaction client, not the bare pool',
  );

  // ...and it must sit between the BEGIN and the COMMIT, not after the
  // transaction has already closed.
  const begin = body.indexOf("client.query('BEGIN')");
  const commit = body.indexOf("client.query('COMMIT')");
  const insert = body.indexOf('INSERT INTO creature_respawns');
  assert.ok(begin !== -1, 'could not locate BEGIN');
  assert.ok(commit !== -1, 'could not locate COMMIT');
  assert.ok(begin < insert, 'the respawn INSERT must come after BEGIN');
  assert.ok(insert < commit, 'the respawn INSERT must come before COMMIT');
});

test('loadWorld selects density and allowed_creature_types for the load-time backstop', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/authority/server.js'), 'utf8');
  const start = src.indexOf('async function loadWorld(');
  assert.ok(start !== -1, 'could not locate loadWorld');
  const body = src.slice(start, src.indexOf('\n  }\n', start));
  const m = /pool\.query\('SELECT ([^']+) FROM worlds WHERE id = \$1'/.exec(body);
  assert.ok(m, 'could not locate the worlds SELECT inside loadWorld');
  const columns = m[1].split(',').map((c) => c.trim());
  assert.ok(columns.includes('density'), 'loadWorld must select density');
  assert.ok(
    columns.includes('allowed_creature_types'),
    'loadWorld must select allowed_creature_types',
  );
});
