// backend/tests/villageScreenBudget_db.test.js
//
// SOMET-282 — the LIVE village invariants, read straight off the database.
//
// villageScreenBudget.test.js proves the RULES are right and that both
// validators enforce them. It cannot prove anything about the rows that were
// written before the rules existed: the three p5-descent hubs shipped as 6x5
// (108% of the screen budget) and the entry world shipped with no village at
// all. Only migration 1714440175000 moves those, and nothing else would notice
// if it had not run.
//
// Every derived position here is recomputed with the REAL helper functions
// (villageMerchantPost / villageGatePosts / villageGeometryError) and compared
// against the stored columns, rather than compared against the literals the
// migration wrote. A literals-vs-literals test would agree with a wrong
// migration.
//
// SELECT-only. Nothing here writes, so it is safe against the dev database and
// needs no TEST_DATABASE_URL gate -- but it does skip (rather than fail) when
// no database is reachable at all.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

const { villageMerchantPost, villageGatePosts } = require('../src/services/mapService.js');
const { villageGeometryError, villageSizeError, GUARD_TYPE } = require('../src/services/villages.js');

const TILE = 100;
const DB_URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://user:password@localhost:15432/game_db';

async function openPool(t, why) {
  const pool = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 2000, max: 2 });
  try {
    await pool.query('SELECT 1');
    return pool;
  } catch (err) {
    await pool.end().catch(() => {});
    const msg = `NO DATABASE at ${DB_URL} -- ${why} is UNVERIFIED (${err.message})`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return null;
  }
}

const VILLAGES_SQL = `
  SELECT w.name AS world, w.is_entry, w.entry_spawn,
         v.world_id, v.min_row, v.min_col, v.width, v.height, v.gate_edge,
         v.spawn_x, v.spawn_y, v.merchant_x, v.merchant_y
    FROM villages v JOIN worlds w ON w.id = v.world_id
   ORDER BY w.name`;

// The camelCase shape villageMerchantPost / villageGatePosts read (fetchVillages'
// mapping), built from the snake_case row.
const boxOf = (r) => ({
  minRow: r.min_row, minCol: r.min_col, width: r.width, height: r.height, gateEdge: r.gate_edge,
});
const tileOf = (x, y) => `${Math.floor(y / TILE)},${Math.floor(x / TILE)}`;

test('every live village fits the on-screen size budget', async (t) => {
  const pool = await openPool(t, 'the live village size limit');
  if (!pool) return;
  try {
    const rows = (await pool.query(VILLAGES_SQL)).rows;
    // The size check runs BEFORE the count guard on purpose: an over-budget
    // hub must fail this test by NAME, not by "there are fewer villages than
    // expected", or the message sends the next reader to the wrong problem.
    for (const r of rows) {
      assert.equal(
        villageSizeError({ width: r.width, height: r.height }), null,
        `${r.world}: ${r.width}x${r.height} is over the screen budget`,
      );
    }
    // Non-vacuity.
    assert.ok(rows.length >= 5,
      `expected at least the five live villages (4 pre-existing + the entry world's), got ${rows.length}`);
  } finally {
    await pool.end();
  }
});

test('every live village has a legal spawn and merchant/guard posts matching its box', async (t) => {
  const pool = await openPool(t, 'the live village geometry');
  if (!pool) return;
  try {
    const rows = (await pool.query(VILLAGES_SQL)).rows;
    const guards = (await pool.query(
      'SELECT world_id, home_x, home_y FROM world_creatures WHERE type = $1 ORDER BY home_x, home_y',
      [GUARD_TYPE],
    )).rows;

    for (const r of rows) {
      const box = boxOf(r);

      // 1. The spawn passes the same gate a new village would have to pass.
      assert.equal(
        villageGeometryError({
          min_row: r.min_row, min_col: r.min_col, width: r.width, height: r.height,
          gate_edge: r.gate_edge, spawn_x: Number(r.spawn_x), spawn_y: Number(r.spawn_y),
        }),
        null,
        `${r.world}: stored spawn (${r.spawn_x},${r.spawn_y}) is not a legal interior spawn for its box`,
      );

      // 2. The stored merchant post is what villageMerchantPost derives.
      const merchant = villageMerchantPost(box);
      assert.deepEqual(
        { x: Number(r.merchant_x), y: Number(r.merchant_y) }, merchant,
        `${r.world}: merchant_x/y disagrees with villageMerchantPost for a `
        + `${r.width}x${r.height} ${r.gate_edge}-gate box at (${r.min_row},${r.min_col})`,
      );

      // 3. The two guards stand on the posts villageGatePosts derives.
      const expected = villageGatePosts(box).map((p) => `${p.x},${p.y}`).sort();
      const actual = guards.filter((g) => g.world_id === r.world_id)
        .map((g) => `${Number(g.home_x)},${Number(g.home_y)}`).sort();
      assert.deepEqual(actual, expected,
        `${r.world}: guard home posts disagree with villageGatePosts for its box`);

      // 4. Spawn, merchant and both guard posts are four DISTINCT tiles. Not a
      //    universal truth about villages -- a 3x3 box has a one-tile interior
      //    and every post clamps onto it -- but it is true of every box that
      //    has ever been authored here, and it is what stops a shrink from
      //    silently parking the player on top of the merchant.
      const tiles = [
        tileOf(Number(r.spawn_x), Number(r.spawn_y)),
        tileOf(merchant.x, merchant.y),
        ...villageGatePosts(box).map((p) => tileOf(p.x, p.y)),
      ];
      assert.equal(new Set(tiles).size, 4,
        `${r.world}: spawn/merchant/guard posts collide -- tiles ${JSON.stringify(tiles)}`);
    }
  } finally {
    await pool.end();
  }
});

test('the entry world has a village and its entry_spawn IS that village spawn', async (t) => {
  const pool = await openPool(t, "the entry world's village");
  if (!pool) return;
  try {
    const entries = (await pool.query(
      'SELECT id, name, entry_spawn FROM worlds WHERE is_entry = true')).rows;
    assert.equal(entries.length, 1, `expected exactly one is_entry world, got ${entries.length}`);
    const entry = entries[0];

    const v = (await pool.query(
      `SELECT min_row, min_col, width, height, gate_edge, spawn_x, spawn_y
         FROM villages WHERE world_id = $1`, [entry.id])).rows;
    assert.equal(v.length, 1,
      `the entry world "${entry.name}" must have exactly one village (SOMET-153's original criterion), got ${v.length}`);

    // The point of the whole half: these two numbers are the same number.
    assert.ok(entry.entry_spawn, `${entry.name} has no entry_spawn`);
    assert.deepEqual(
      { x: Number(entry.entry_spawn.x), y: Number(entry.entry_spawn.y) },
      { x: Number(v[0].spawn_x), y: Number(v[0].spawn_y) },
      `${entry.name}: entry_spawn must equal the village spawn -- a player's first `
      + 'join and their respawn point have to be the same tile',
    );

    // ...and that shared point has to be a legal interior tile, not merely equal.
    assert.equal(
      villageGeometryError({
        min_row: v[0].min_row, min_col: v[0].min_col, width: v[0].width, height: v[0].height,
        gate_edge: v[0].gate_edge, spawn_x: Number(entry.entry_spawn.x), spawn_y: Number(entry.entry_spawn.y),
      }),
      null,
      `${entry.name}: entry_spawn is not inside the village interior`,
    );
  } finally {
    await pool.end();
  }
});

test('no hostile stands inside any village footprint', async (t) => {
  const pool = await openPool(t, 'the village-footprint invariant');
  if (!pool) return;
  try {
    // The epic's invariant, stated as a query: inside a village box, the only
    // creature is a Village Guard.
    const bad = (await pool.query(
      `SELECT w.name AS world, c.type, c.x, c.y
         FROM world_creatures c
         JOIN villages v ON v.world_id = c.world_id
         JOIN worlds w ON w.id = c.world_id
        WHERE c.type <> $1
          AND floor(c.x / ${TILE}) BETWEEN v.min_col AND v.min_col + v.width - 1
          AND floor(c.y / ${TILE}) BETWEEN v.min_row AND v.min_row + v.height - 1`,
      [GUARD_TYPE],
    )).rows;
    assert.deepEqual(bad, [],
      `${bad.length} non-guard creature(s) are standing inside a village box: ${JSON.stringify(bad)}`);

    // Non-vacuity: the query above proves nothing if there are no villages, or
    // no creatures in the villages' worlds at all.
    const scope = (await pool.query(
      `SELECT count(DISTINCT v.id)::int AS villages, count(c.id)::int AS creatures
         FROM villages v LEFT JOIN world_creatures c ON c.world_id = v.world_id`)).rows[0];
    assert.ok(scope.villages >= 5, `expected >= 5 villages in scope, got ${scope.villages}`);
    assert.ok(scope.creatures > 0, 'no creatures in any village world -- the check above is vacuous');
  } finally {
    await pool.end();
  }
});
