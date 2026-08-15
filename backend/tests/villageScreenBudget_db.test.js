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
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const { villageMerchantPost, villageGatePosts } = require('../src/services/mapService.js');
const { villageGeometryError, villageSizeError, GUARD_TYPE } = require('../src/services/villages.js');
const { withAdvisoryLock } = require('./helpers/advisoryLock.js');
const { ENTRY_LOCK_KEY } = require('./helpers/entryWorld.js');

// SOMET-351. Every test below asserts an invariant over the WHOLE live
// database -- every village, the single is_entry world, every creature standing
// in any village box. Six other files apply a map spec, which creates a
// throwaway world with its own village, its own hostiles and its own is_entry
// claim, and then deletes it. Each of those wraps its apply in
// withEntryPreserved, holding ENTRY_LOCK_KEY across the whole
// save -> apply -> restore window.
//
// The writers were already serialized correctly. This file was the one
// participant that never asked for the lock, so it read the database mid-apply:
// a fixture world holding is_entry, its village stamped, its hostiles scattered
// but not yet penned. That is not load-sensitivity -- load only widens the
// window. Running this file concurrently with seed_map_db.test.js alone
// reproduced it 5 times out of 5, and on "no hostile stands inside any village
// footprint" rather than on the entry-world assertion that had been surfacing.
//
// Taking the SAME key is the whole fix. As advisoryLock.js puts it, a lock only
// serializes those who ask for it. This stays read-only: it acquires the lock
// and runs SELECTs, never a save/restore, which is why it calls
// withAdvisoryLock directly rather than withEntryPreserved.
//
// Deliberately NOT filtered by fixture name (a `zz%` prefix): that would make
// this file blind to any real world a future spec happens to name badly, and it
// would not help the entry-world assertion at all -- during an apply the
// fixture legitimately IS the entry world, whatever it is called.
const readingLiveWorld = (pool, fn) => withAdvisoryLock(pool, ENTRY_LOCK_KEY, fn);

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

// SOMET-353. The AUTHORED worlds -- every world name the checked-in specs
// declare. Tests 1, 2 and 4 below are about authored content and say so in
// their own comments ("it is true of every box that has ever been authored
// here"), but they were querying whatever happened to be in the database.
//
// That is not the same thing. Other test files create legal-but-different
// villages: zzTestBeta's is 4x3, the smallest box the validator allows, whose
// interior is a single row -- so its spawn, merchant and both guard posts
// necessarily clamp onto two tiles instead of four. The "four DISTINCT tiles"
// assertion then fails on a fixture that is perfectly valid, and the assertion
// itself already documents that it is not a universal truth about villages.
//
// SOMET-351's lock does not close this and cannot: those fixtures exist
// legitimately outside every lock window (cleanup runs after the
// withEntryPreserved block, and a crashed test can leave one behind for good).
// Serializing against a fixture's whole lifetime would need teardown moved
// inside the lock at 22 call sites across 4 files, and would still lose to a
// crash.
//
// Naming the subject positively is both simpler and stronger. This is NOT a
// `zz%` name filter -- it is an allowlist derived from the specs themselves, so
// a real world a future spec adds is covered automatically, and a real world
// someone names `zzSomething` would still be checked.
const SPEC_WORLD_NAMES = (() => {
  const dir = path.join(__dirname, '..', 'seeds', 'maps');
  const names = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.map.json'))) {
    const spec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const w of spec.worlds || []) names.push(w.name);
  }
  return names;
})();

const VILLAGES_SQL = `
  SELECT w.name AS world, w.is_entry, w.entry_spawn,
         v.world_id, v.min_row, v.min_col, v.width, v.height, v.gate_edge,
         v.spawn_x, v.spawn_y, v.merchant_x, v.merchant_y
    FROM villages v JOIN worlds w ON w.id = v.world_id
   WHERE w.name = ANY($1)
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
    await readingLiveWorld(pool, async () => {
      const rows = (await pool.query(VILLAGES_SQL, [SPEC_WORLD_NAMES])).rows;
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
    });
  } finally {
    await pool.end();
  }
});

test('every live village has a legal spawn and merchant/guard posts matching its box', async (t) => {
  const pool = await openPool(t, 'the live village geometry');
  if (!pool) return;
  try {
    await readingLiveWorld(pool, async () => {
    const rows = (await pool.query(VILLAGES_SQL, [SPEC_WORLD_NAMES])).rows;
    // Non-vacuity, and the only one of these four tests that lacked it: every
    // assertion below lives inside the `for` loop, so zero rows is a silent
    // pass. Caught by mutating SPEC_WORLD_NAMES to [] -- tests 1 and 4 went red
    // on their own guards and this one stayed green while checking nothing.
    assert.ok(rows.length >= 5,
      `expected at least the five authored villages, got ${rows.length} -- `
      + 'the geometry checks below are vacuous without them');
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
    });
  } finally {
    await pool.end();
  }
});

test('the entry world has a village and its entry_spawn IS that village spawn', async (t) => {
  const pool = await openPool(t, "the entry world's village");
  if (!pool) return;
  try {
    await readingLiveWorld(pool, async () => {
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
    });
  } finally {
    await pool.end();
  }
});

test('nothing is PLACED inside a village footprint except its guards', async (t) => {
  const pool = await openPool(t, 'the village-footprint placement invariant');
  if (!pool) return;
  try {
    await readingLiveWorld(pool, async () => {
    // SOMET-352. This used to assert that no hostile STANDS inside a village
    // box, on any row in world_creatures. That is not an invariant this system
    // maintains, and the test was unfalsifiable red: nothing in the codebase is
    // wrong when it fires.
    //
    // Measured, not argued. Thornbriar Reach held a Bat and a Skeleton inside
    // its box, frozen there for hours. Joining a character so the world
    // actually ticked resolved it without a single code change:
    //
    //   BEFORE     intruders=2   guards at 4852,4200 (both, stacked)
    //   AFTER 10s  intruders=2   guards at 4780,4200  <- closing
    //   AFTER 20s  intruders=0   guards at 4637/4639,4200
    //   AFTER 45s  intruders=0   guards at 4585,4233 / 4564,4264 <- separated
    //
    // The guards cleared them in ~20s and then spread back out, so the stacking
    // was transient convergence on one target rather than a defect either.
    //
    // WHY the old assertion could not hold: worldPopulation.js refuses village
    // tiles when PLACING, but creatures.js has no village check for hostiles at
    // all -- its only village references concern guards. The wall ring has one
    // deliberately walkable gate, so a wandering hostile strolling in is legal
    // behaviour. And a world only ticks while someone is in it, so
    // world_creatures is a frozen snapshot that can preserve a mid-incursion
    // moment indefinitely for any world nobody is visiting.
    //
    // So the guarantee is about PLACEMENT, and that is what is asserted now:
    // nothing is ANCHORED inside a village box except its guards. home_x/home_y
    // is the anchor seeding writes -- village guards (insertVillageGuards) and
    // penned creatures (the pen pass, whose boxes validateMapSpec already
    // forbids from overlapping a village). A wandering intruder has home NULL,
    // which is exactly what the two Thornbriar hostiles had. This still fails
    // loudly if a seeding change ever parks a creature in a village, which is
    // the regression the epic actually cared about.
    const bad = (await pool.query(
      `SELECT w.name AS world, c.type, c.home_x, c.home_y
         FROM world_creatures c
         JOIN villages v ON v.world_id = c.world_id
         JOIN worlds w ON w.id = c.world_id
        WHERE c.type <> $1 AND w.name = ANY($2)
          AND c.home_x IS NOT NULL AND c.home_y IS NOT NULL
          AND floor(c.home_x / ${TILE}) BETWEEN v.min_col AND v.min_col + v.width - 1
          AND floor(c.home_y / ${TILE}) BETWEEN v.min_row AND v.min_row + v.height - 1`,
      [GUARD_TYPE, SPEC_WORLD_NAMES],
    )).rows;
    assert.deepEqual(bad, [],
      `${bad.length} non-guard creature(s) are ANCHORED inside a village box: ${JSON.stringify(bad)}`);

    // Non-vacuity: the query above proves nothing if there are no villages, or
    // no creatures in the villages' worlds at all.
    const scope = (await pool.query(
      `SELECT count(DISTINCT v.id)::int AS villages, count(c.id)::int AS creatures
         FROM villages v
         JOIN worlds w ON w.id = v.world_id
         LEFT JOIN world_creatures c ON c.world_id = v.world_id
        WHERE w.name = ANY($1)`, [SPEC_WORLD_NAMES])).rows[0];
    assert.ok(scope.villages >= 5, `expected >= 5 villages in scope, got ${scope.villages}`);
    assert.ok(scope.creatures > 0, 'no creatures in any village world -- the check above is vacuous');

    // The anchor check is only meaningful if anchored non-guard creatures exist
    // somewhere to be caught. Without this the WHERE clause could match nothing
    // for the wrong reason -- e.g. if the pen pass stopped writing home_x at
    // all -- and this test would go green while covering nothing.
    const anchored = (await pool.query(
      `SELECT count(*)::int AS n FROM world_creatures
        WHERE type <> $1 AND home_x IS NOT NULL`, [GUARD_TYPE])).rows[0];
    assert.ok(anchored.n > 0,
      'no non-guard creature anywhere carries a home anchor -- the placement check above is vacuous');

    // Transient intruders are REPORTED, never asserted on: a hostile that walked
    // in through the gate is legal, and the guards clear it. Printed so a real
    // pattern (say, dozens across many villages, or one that never clears)
    // is still visible to a human reading the output.
    const standing = (await pool.query(
      `SELECT w.name AS world, c.type
         FROM world_creatures c
         JOIN villages v ON v.world_id = c.world_id
         JOIN worlds w ON w.id = c.world_id
        WHERE c.type <> $1 AND w.name = ANY($2)
          AND floor(c.x / ${TILE}) BETWEEN v.min_col AND v.min_col + v.width - 1
          AND floor(c.y / ${TILE}) BETWEEN v.min_row AND v.min_row + v.height - 1`,
      [GUARD_TYPE, SPEC_WORLD_NAMES],
    )).rows;
    if (standing.length) {
      console.log(`  note: ${standing.length} hostile(s) currently standing inside a village box `
        + `(${[...new Set(standing.map((s) => s.world))].join(', ')}) -- expected and transient; `
        + 'guards clear them ~20s after the world next ticks.');
    }
    });
  } finally {
    await pool.end();
  }
});
