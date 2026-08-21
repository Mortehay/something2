const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { applyMapSpec, GRID_SPACING } = require('../scripts/seed-map.js');
const { withEntryPreserved } = require('./helpers/entryWorld.js');
const { activateWaypoint } = require('../src/services/waypoints.js');
const { createCharacter, listPlayableClasses } = require('../src/services/characters.js');

const DB_URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://user:password@localhost:15432/game_db';

async function openPool() {
  const pool = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 2000, max: 2 });
  try { await pool.query('SELECT 1'); return pool; }
  catch (err) { await pool.end().catch(() => {}); return { unreachable: err.message }; }
}

// A throwaway spec whose world names are unlikely to collide with real data.
//
// validateMapSpec (seeds/mapSpec.js, added in the earlier "validate map specs
// against their grid embedding" task) requires EXACTLY one world with
// is_entry: true -- a spec with zero fails validation. So this fixture cannot
// use is_entry: false on every world the way an earlier draft of this test
// did. zzTestAlpha is marked is_entry: true instead, and the test below wraps
// the apply in withEntryPreserved() to save/restore whichever world was
// really is_entry before the test ran (there IS a live entry world in the dev
// DB this runs against, e.g. "Old Trailhead") -- applyMapSpec's own is_entry
// step (index.js:1542's rule: setting one clears every other) would otherwise
// silently steal is_entry from the developer's real map and never give it
// back, since cleanup() below only deletes the zzTest rows.
//
// Grid is [5, -3] / [6, -3] rather than [0, 0] / [1, 0] deliberately: at the
// origin, Number(null) === 0 too, so a graph_x/graph_y column that was never
// written at all (NULL) would silently satisfy an `=== 0` assertion. Off the
// origin, a NULL column fails loudly (Number(null) !== 1100 or -660) instead
// of coincidentally matching.
//
// zzTestBeta also declares a village: this fixture is torn down by cleanup()
// on every run (villages/world_creatures cascade from worlds via FK), so the
// village-creation path -- villages row, gate guards, merchant stock -- gets
// re-verified from scratch every run. The hub-vale checks in the "shipped
// spec" test below can't do that: that test never tears down what it seeds,
// so past the first-ever run against a given database, hub-vale's village
// already exists and its checks are only reading prior runs' residue.
const spec = () => ({
  name: 'zz-test-fixture',
  topology: 'spine',
  worlds: [
    { key: 'a', name: 'zzTestAlpha', grid: [5, -3], seed: 991, width: 64, height: 64,
      // Tile-center of a 64x64 world (col/row 32), not the wall-ring corner
      // {x:32,y:32} this used to be: stampBounds always walls the outer ring
      // of a bounded world regardless of biome, so a spawn at pixel (32,32)
      // -- tile (0,0) -- sits ON that wall and is unreachable by
      // construction. Harmless before this task's navigability check
      // existed; SOMET-247 Task 5 makes it a hard failure, same as it would
      // be for a real shipped spec.
      //
      // biomes: ['Deep Forest'], not []: with no biome declared, sampleTerrain
      // falls back to the FULL non-structural tile catalog (mapService.js's
      // worldConfig, "pre-biome behaviour, preserved bit-for-bit"), which now
      // includes cave_wall/rubble/chasm alongside the pre-existing water --
      // four impassable tile names banded in by noise. That makes an empty
      // biomes list a per-seed coin flip for whether the doorway and the
      // entry spawn land in the same connected region (seed 993 in
      // populationSpec below happened to land on the wrong side of it; this
      // fixture's seed 991 happened not to). Deep Forest's terrain_tiles
      // (leafs/highgrass/earth) are all walkable, so declaring it removes the
      // coin flip instead of relying on a seed that happens to get lucky.
      chunk_size: 64, biomes: ['Deep Forest'], biome_cell: 32,
      allowed_creature_types: [], is_entry: true, entry_spawn: { x: 3200, y: 3200 } },
    { key: 'b', name: 'zzTestBeta', grid: [6, -3], seed: 992, width: 64, height: 64,
      chunk_size: 64, biomes: [], biome_cell: 32,
      allowed_creature_types: [], is_entry: false,
      village: { key: 'beta-village', min_row: 10, min_col: 10, width: 4, height: 3,
                 gate_edge: 'S', spawn_x: 1150, spawn_y: 1150 } },
  ],
  links: [{ from: 'a', edge: 'E', to: 'b' }],
});

async function cleanup(pool) {
  await pool.query(
    // Union of every slice's fixture worlds: leaving one out strands rows that
    // the next run's uniqueness checks then trip over.
    "DELETE FROM worlds WHERE name IN ('zzTestAlpha','zzTestBeta','zzTestPopA','zzTestPopB',"
    + "'zzTestVilA','zzTestMultiVillage','zzTestWpA','zzTestWpB','zzTestPenWorld')",
  ).catch(() => {});
  await pool.query("DELETE FROM users WHERE username = 'zzTestWpUser'").catch(() => {});
}

// Snapshot whichever world is currently is_entry (0 or 1 of them, per the
// validator's own invariant), run fn, then restore exactly that snapshot --
// both UPDATEs scoped by id, the same idiom applyMapSpec itself uses at
// scripts/seed-map.js's own "set is_entry LAST" step. Never leaves the real
// dev DB's entry world flipped just because a test happened to run.

test('applying a spec twice produces identical rows', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} (${pool.unreachable}) — map applier is UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  try {
    await cleanup(pool);
    const s = spec();
    await withEntryPreserved(pool, async () => {
      const result = await applyMapSpec(pool, s);
      // creatures is 0 here, not merely omitted -- both zzTestAlpha and
      // zzTestBeta declare allowed_creature_types: [], so populateWorld's own
      // early-return path (no allowed types -> nothing placed) is what should
      // fire, not a wiring bug that skipped calling it altogether. The
      // "seeding populates every world with creatures" test below is what
      // proves the non-empty path actually places rows.
      assert.deepEqual(
        result,
        // waypoints and penCreatures are 0 for the same reason creatures is:
        // this spec authors none, so each counter must report that the applier
        // RAN that pass and found nothing -- not that the pass is missing
        // (SOMET-292, SOMET-289). An exact-shape assertion is the point: a
        // counter silently dropped from the return value is a pass that wrote
        // nothing.
        // villagesMoved is 0 for the same reason (SOMET-312): on a first seed
        // every village is CREATED, so a non-zero here would mean the applier
        // had counted a creation as a move.
        // linksRemoved is [] for the same reason, and is a LIST rather than a
        // count (SOMET-355): a removed doorway changes the shape of the graph
        // players navigate, so the applier has to be able to name which one.
        // The empty array here is the both-halves statement -- this spec's two
        // worlds have exactly the one link it declares, so the prune pass ran
        // and correctly found nothing undeclared to remove.
        { worlds: 2, links: 1, villages: 1, villagesMoved: 0, portalGuards: 0, creatures: 0,
          vaultChests: 0, waypoints: 0, waypointsRemoved: 0, linksRemoved: [], penCreatures: 0 },
        'applyMapSpec must report exactly what it wrote, not just resolve');

      // Correctness rule 3: is_entry must actually be set on the spec's
      // declared entry world, globally -- not merely "not thrown". An
      // applier that dropped the is_entry step entirely would still pass
      // every other assertion in this test (see FINDING 2 mutation below).
      const entryRow = await pool.query('SELECT name FROM worlds WHERE is_entry = true');
      assert.deepEqual(entryRow.rows.map((r) => r.name), ['zzTestAlpha'],
        'applyMapSpec must set is_entry on the spec\'s declared entry world, and only that world');

      const q = `SELECT name, seed, width, height, graph_x, graph_y FROM worlds
                 WHERE name LIKE 'zzTest%' ORDER BY name`;
      const first = await pool.query(q);
      const firstLinks = await pool.query(
        `SELECT ml.edge, wf.name AS from_name, wt.name AS to_name FROM map_links ml
           JOIN worlds wf ON wf.id = ml.from_world_id
           JOIN worlds wt ON wt.id = ml.to_world_id
          WHERE wf.name LIKE 'zzTest%' ORDER BY wf.name, ml.edge`);

      // Correctness rule "village wiring": zzTestBeta's village, guards, and
      // (transitively, via createVillage) merchant stock must exist -- and
      // because this whole fixture is deleted by cleanup() every run, this
      // is a from-scratch check every time, not residue from a prior run.
      const villageRow = await pool.query(
        `SELECT v.id FROM villages v JOIN worlds w ON w.id = v.world_id WHERE w.name = 'zzTestBeta'`);
      assert.equal(villageRow.rowCount, 1,
        'applyMapSpec must have called createVillage for zzTestBeta, not just counted it');
      const guardRow = await pool.query(
        `SELECT count(*)::int AS n FROM world_creatures wc
           JOIN worlds w ON w.id = wc.world_id
          WHERE w.name = 'zzTestBeta' AND wc.type = 'Village Guard'`);
      assert.equal(guardRow.rows[0].n, 2,
        'createVillage should have placed two gate guards for zzTestBeta');

      const second = await applyMapSpec(pool, s);
      assert.deepEqual(second, { ...result, villages: 0 },
        'the second apply must not report re-creating the village (idempotent), but worlds/links still match');
      const secondRows = await pool.query(q);
      const secondLinks = await pool.query(
        `SELECT ml.edge, wf.name AS from_name, wt.name AS to_name FROM map_links ml
           JOIN worlds wf ON wf.id = ml.from_world_id
           JOIN worlds wt ON wt.id = ml.to_world_id
          WHERE wf.name LIKE 'zzTest%' ORDER BY wf.name, ml.edge`);

      assert.equal(first.rowCount, 2, 'both worlds should exist after the first apply');
      assert.deepEqual(secondRows.rows, first.rows, 'second apply changed the world rows');
      assert.deepEqual(secondLinks.rows, firstLinks.rows, 'second apply duplicated links');
      // setLink mirrors, so one spec link becomes two rows.
      assert.equal(firstLinks.rowCount, 2, 'the mirror edge was not written');
      // Confirm the mirror actually points back (b:W -> a), not just that the
      // row count happens to be 2 -- an applier that wrote the same edge twice
      // instead of mirroring it would also pass a bare rowCount check.
      assert.deepEqual(
        firstLinks.rows.map((r) => `${r.from_name}:${r.edge}->${r.to_name}`).sort(),
        ['zzTestAlpha:E->zzTestBeta', 'zzTestBeta:W->zzTestAlpha'],
        'setLink should have written the forward edge and its mirror',
      );

      // graph_x/graph_y must be derived from grid * GRID_SPACING with NO sign
      // flip: alpha sits at [5,-3] and beta at [6,-3], one cell east. Off the
      // canvas origin so a NULL column (Number(null) === 0) can't coincide
      // with the expected value at [0,0]. See tests/seed_map.test.js for the
      // North/South sign case this fixture's east-west link can't exercise.
      const byName = Object.fromEntries(first.rows.map((r) => [r.name, r]));
      assert.equal(typeof byName.zzTestAlpha.graph_x, 'number', 'graph_x must not be NULL');
      assert.equal(typeof byName.zzTestAlpha.graph_y, 'number', 'graph_y must not be NULL');
      assert.equal(Number(byName.zzTestAlpha.graph_x), 5 * GRID_SPACING);
      assert.equal(Number(byName.zzTestAlpha.graph_y), -3 * GRID_SPACING);
      assert.equal(Number(byName.zzTestBeta.graph_x), 6 * GRID_SPACING);
      assert.equal(Number(byName.zzTestBeta.graph_y), -3 * GRID_SPACING);
    });
  } finally { await cleanup(pool); await pool.end(); }
});

test('a spec that fails a DB constraint mid-apply rolls back completely', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} (${pool.unreachable}) — rollback is UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  try {
    await cleanup(pool);
    // This spec PASSES validateMapSpec -- the validator never bounds-checks
    // chunk_size -- but zzTestBeta's chunk_size overflows the `integer`
    // (int4) column Postgres actually declared it as, so the INSERT for the
    // SECOND world throws. That's the point: the "fails validation" test
    // above throws inside applyMapSpec BEFORE pool.connect() is ever called,
    // so the transaction/catch/ROLLBACK branch never executes there. This is
    // the only test that exercises it. Confirmed manually first (safe, rolled
    // back on purpose): `BEGIN; INSERT ... chunk_size=999999999999; ROLLBACK;`
    // against the compose Postgres produced "ERROR: integer out of range".
    const bad = {
      name: 'zz-test-fixture-rollback',
      topology: 'spine',
      worlds: [
        { key: 'a', name: 'zzTestAlpha', grid: [5, -3], seed: 991, width: 64, height: 64,
          chunk_size: 64, biomes: [], biome_cell: 32,
          allowed_creature_types: [], is_entry: true, entry_spawn: { x: 32, y: 32 } },
        { key: 'b', name: 'zzTestBeta', grid: [6, -3], seed: 992, width: 64, height: 64,
          chunk_size: 999999999999, biomes: [], biome_cell: 32,
          allowed_creature_types: [], is_entry: false },
      ],
      links: [{ from: 'a', edge: 'E', to: 'b' }],
    };
    await assert.rejects(() => applyMapSpec(pool, bad), /range|integer/i);
    // zzTestAlpha was inserted (and committed, if there were no transaction)
    // BEFORE zzTestBeta's INSERT threw. If the whole apply isn't one
    // transaction, zzTestAlpha survives here even though the spec as a whole
    // failed -- exactly the "half-built map" correctness rule 2 forbids.
    const r = await pool.query("SELECT name FROM worlds WHERE name LIKE 'zzTest%'");
    assert.deepEqual(r.rows, [], 'a DB-constraint failure on a later world left an earlier world committed');
  } finally { await cleanup(pool); await pool.end(); }
});

test('a spec that fails validation writes nothing', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} — validation-abort is UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  try {
    await cleanup(pool);
    const bad = spec();
    bad.links[0].edge = 'N';   // contradicts the grid
    await assert.rejects(() => applyMapSpec(pool, bad), /edge N|invalid spec/i);
    const r = await pool.query("SELECT 1 FROM worlds WHERE name LIKE 'zzTest%'");
    assert.equal(r.rowCount, 0, 'an invalid spec wrote worlds anyway');
    const links = await pool.query(
      `SELECT 1 FROM map_links ml JOIN worlds w ON w.id = ml.from_world_id WHERE w.name LIKE 'zzTest%'`);
    assert.equal(links.rowCount, 0, 'an invalid spec wrote links anyway');
  } finally { await cleanup(pool); await pool.end(); }
});

// This test intentionally never tears down the data it seeds (see the note above
// the test suite: the idempotency checks for hub-vale's village depend on state
// persisting across runs). That is safe and desirable against a dedicated test
// database, but unacceptable against a developer's working database (it stacks
// worlds and flips is_entry to a different world than the developer had).
// Other tests in this file clean up with cleanup() in a finally, so they are
// safe against any database. This one must be gated: it only runs if
// TEST_DATABASE_URL is explicitly set.
// SLOW ON PURPOSE, AND THE REASON npm test ALLOWS 180s. This applies EVERY
// checked-in spec for real -- 86 worlds across vale-region and p5-descent,
// terrain, creatures and all -- and takes ~80s on a developer machine. Under
// the old 60s cap it timed out, and a timeout CANCELS THE WHOLE FILE, so the
// other fifteen tests here silently stopped running in every full-suite run.
// The per-test timeout below documents the need; the cap that actually
// governs a file is the runner's, in package.json.
test('every shipped spec applies cleanly', { timeout: 300000 }, async (t) => {
  // Gate ABOVE the CI check, not below it: a CI environment that sets
  // DATABASE_URL (so pool.unreachable would be false) but not
  // TEST_DATABASE_URL must still fail loudly here, not skip. The old order
  // returned via t.skip() before process.env.CI was ever consulted, so under
  // that CI configuration the only end-to-end proof that shipped specs apply
  // silently skipped instead of failing.
  if (!process.env.TEST_DATABASE_URL) {
    const msg = 'TEST_DATABASE_URL not set -- skipping to avoid mutating a real database (this test never tears down)';
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} — shipped specs are UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  const dir = path.join(__dirname, '..', 'seeds', 'maps');
  try {
    // withEntryPreserved, like EVERY other applyMapSpec call in this file --
    // this test was the one exception, and that exception is SOMET-265's
    // deterministic cause, not a race.
    //
    // applyMapSpec CLEARS is_entry everywhere before setting the spec's own.
    // hub-vale.map.json currently THROWS partway through (world "mire" is
    // sealed -- SOMET-273), so the clear lands and the set never does, and
    // the run ends with ZERO entry worlds. Auto-join then has nowhere to send
    // a player with no last world, which is the "I can't log in to the map"
    // symptom. Reproduced live on 2026-08-11: a full `npm test` with
    // TEST_DATABASE_URL set left the shared dev database with no entry world,
    // and `node scripts/dungeon/restore-entry.js "Old Trailhead"` put it back.
    //
    // The restore is in withEntryPreserved's `finally`, so it runs on the
    // throwing path -- which is the only path that matters here.
    await withEntryPreserved(pool, async () => {
    // This test intentionally never tears down what it seeds (see the note
    // above the test suite), so on a re-run against the same DB, hub-vale's
    // village will already exist -- the applier's `existing.rowCount === 0`
    // idempotency check then correctly reports 0 new villages, not 1. Check
    // what's there BEFORE applying so the assertion below is correct whether
    // this is the very first run against this database or the fiftieth.
    const villageAlreadyExisted = (await pool.query(
      `SELECT 1 FROM villages v JOIN worlds w ON w.id = v.world_id WHERE w.name = 'Vale Crossing'`,
    )).rowCount > 0;

    const results = {};
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.map.json'))) {
      const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const first = await applyMapSpec(pool, s);          // must not throw
      const second = await applyMapSpec(pool, s);          // idempotent
      results[s.name] = { spec: s, first, second };
      // NOT tautological: applyMapSpec (scripts/seed-map.js) counts
      // worlds/links from real loop iterations completed, not by echoing
      // spec.worlds.length/spec.links.length back unconditionally. A
      // regression that silently skipped an element inside either loop
      // (stray `continue`, an off-by-one slice) would make these diverge
      // from the spec's own length instead of trivially matching it.
      assert.equal(first.worlds, s.worlds.length, `${s.name}: reported world count doesn't match the spec`);
      assert.equal(first.links, s.links.length, `${s.name}: reported link count doesn't match the spec`);
      // penCreatures is pinned to 0 on the SECOND apply for the same reason
      // villages is, and it is not a weakening: insertPenCreatures is guarded
      // per world the way createVillage is, so a re-apply that re-stocked a pen
      // would report 20 here and still fail. Only the first-ever apply against
      // a given database reports a non-zero -- which is exactly the case this
      // assertion used to get wrong, silently, because it had only ever run
      // against a database whose pens already existed (SOMET-355).
      assert.deepEqual(second, { ...first, villages: 0, penCreatures: 0 },
        `${s.name}: re-applying should not re-create villages, pens, worlds, or links`);
    }

    // hub-vale is the one shipped spec with a village AND all four compass
    // edges from a single hub -- exercise both the village wiring and the
    // graph_x/graph_y sign convention against real, checked-in data instead
    // of only the synthetic east-west fixture above.
    // SOMET-355: hub-vale is now the `vale_` region of the merged `vale-region`
    // spec. Vale Crossing is still the one world with a village AND all four
    // compass edges, so this paragraph checks exactly what it always did.
    const valeRegion = results['vale-region'];
    assert.ok(valeRegion, 'expected backend/seeds/maps/vale-region.map.json to exist and be named "vale-region"');
    assert.equal(valeRegion.first.villages, villageAlreadyExisted ? 0 : 1,
      'vale-region declares one village; applyMapSpec must report creating it exactly once, ever');

    const villageRow = await pool.query(
      `SELECT v.id FROM villages v JOIN worlds w ON w.id = v.world_id WHERE w.name = 'Vale Crossing'`);
    assert.equal(villageRow.rowCount, 1,
      'applyMapSpec must have called createVillage for the hub world, not just counted it');

    const guardRow = await pool.query(
      `SELECT count(*)::int AS n FROM world_creatures wc
         JOIN worlds w ON w.id = wc.world_id
        WHERE w.name = 'Vale Crossing' AND wc.type = 'Village Guard'`);
    assert.equal(guardRow.rows[0].n, 2,
      'createVillage should have placed two gate guards; an applier that skipped createVillage would leave none');

    const positions = await pool.query(
      `SELECT name, graph_x, graph_y FROM worlds
        WHERE name IN ('Vale Crossing','Thornbriar Reach','Sunscar Flats','Rimehollow','Blackfen Sinks')`);
    const byName = Object.fromEntries(positions.rows.map((r) => [r.name, r]));
    // hub is at grid [0,0]; forest [1,0] East; dunes [-1,0] West;
    // frozen [0,-1] North; mire [0,1] South (see hub-vale.map.json).
    assert.equal(Number(byName['Vale Crossing'].graph_x), 0);
    assert.equal(Number(byName['Vale Crossing'].graph_y), 0);
    assert.ok(Number(byName['Thornbriar Reach'].graph_x) > 0, 'East neighbour must land at +x');
    assert.ok(Number(byName['Sunscar Flats'].graph_x) < 0, 'West neighbour must land at -x');
    assert.ok(Number(byName['Rimehollow'].graph_y) < 0,
      'North neighbour must land at -y (screen-up) — a sign flip here mirrors the World Map tab vertically');
    assert.ok(Number(byName['Blackfen Sinks'].graph_y) > 0,
      'South neighbour must land at +y (screen-down)');
    });
  } finally { await pool.end(); }
});

// A throwaway spec dedicated to the population pass, separate from `spec()`
// above -- that fixture's two worlds both declare allowed_creature_types: [],
// which is exactly the case populateWorld early-returns 0 for (see the
// "creatures: 0" note on the "applying a spec twice" test), so it can never
// exercise the non-empty placement path. 'Slime' is a real, non-guard
// entity_types row already used the same way by hub-vale.map.json.
const populationSpec = () => ({
  name: 'zz-test-population-fixture',
  topology: 'spine',
  worlds: [
    { key: 'a', name: 'zzTestPopA', grid: [9, -3], seed: 993, width: 64, height: 64,
      // Tile-center (32,32), not the wall-ring corner -- see the matching
      // comment on spec() above.
      //
      // biomes: ['Meadow'], not []: 'Deep Forest' (used on spec()'s zzTestAlpha,
      // where allowed_creature_types is [] so it can't matter) would work for
      // walkability but its creature_types is ['Wolf','Bat','Skeleton'] --
      // creatureTileCandidates (mapService.js) intersects a world's allowlist
      // with the local biome's creature_types once ANY biome is declared, so
      // pairing it with allowed_creature_types: ['Slime'] below would zero out
      // every placement and make "seeding populates every world with
      // creatures" vacuous. Meadow's terrain_tiles (grass/highgrass/earth) are
      // all walkable AND its creature_types includes 'Slime'.
      chunk_size: 64, biomes: ['Meadow'], biome_cell: 32,
      allowed_creature_types: ['Slime'], is_entry: true, entry_spawn: { x: 3200, y: 3200 } },
    { key: 'b', name: 'zzTestPopB', grid: [10, -3], seed: 994, width: 64, height: 64,
      chunk_size: 64, biomes: [], biome_cell: 32,
      allowed_creature_types: ['Slime'], is_entry: false },
  ],
  links: [{ from: 'a', edge: 'E', to: 'b' }],
});

// The defect this whole sub-project exists to fix: before P1, applyMapSpec
// wrote creature_count onto the row and placed nothing, so every seeded world
// arrived empty. Assert creatures ON THE GROUND, not the returned count --
// a return value can be right while the INSERT never happened.
test('seeding populates every world with creatures', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} (${pool.unreachable}) — population is UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  try {
    await cleanup(pool);
    const s = populationSpec();
    await withEntryPreserved(pool, async () => {
      const result = await applyMapSpec(pool, s);
      assert.ok(result.creatures > 0, `expected creatures, got ${result.creatures}`);

      const rows = await pool.query(
        `SELECT w.name, count(wc.id)::int AS n
           FROM worlds w LEFT JOIN world_creatures wc ON wc.world_id = w.id
          WHERE w.name = ANY($1::text[])
          GROUP BY w.name`,
        [s.worlds.map((w) => w.name)],
      );
      assert.equal(rows.rows.length, s.worlds.length);
      for (const r of rows.rows) {
        assert.ok(r.n > 0, `world ${r.name} is empty`);
      }
    });
  } finally {
    await cleanup(pool);
    await pool.end();
  }
});

// SOMET-246 final review, finding 1. applyMapSpec used to run its population
// loop BEFORE the village loop, so on a first seed populateWorld's
// fetchVillages returned [] and creatureTileCandidates' "not inside a village"
// exclusion never fired -- hostiles landed on the village footprint and
// createVillage then stamped walls around them. It also made seeding
// non-idempotent, because the first apply rejection-samples against no village
// and every later apply samples against one, which shifts the shared RNG
// stream for every placement after the first rejected draw.
//
// The fixture below is pinned, not arbitrary. Verified against the OLD
// ordering (population loop above the village loop, the code as of 7f25c73):
// seed 991 with this village puts hostiles inside the footprint and makes 10
// of 16 creature rows move between the first and second apply, so both
// assertions below genuinely fail there. A neighbouring seed (1234) does NOT
// collide and passes either way -- which is exactly why the seed is fixed.
//
// SOMET-282 RE-PIN. The box used to be 8x6 at (20,20), chosen as "the maximum
// size VILLAGE_LIMITS allows" to widen the target. 8x6 is no longer legal:
// VILLAGE_LIMITS.maxSum caps width + height at 10 tiles (the on-screen
// budget), so applyMapSpec now rejects the whole spec before it seeds
// anything. The replacement is 6x4 -- a legal sum-10 box -- MOVED to (24,20)
// rather than left at (20,20), because a smaller box in the same place would
// have covered fewer of the seed's hostiles and quietly weakened the fixture
// into a vacuous pass. Re-pinned by replaying placeMapCreatures/
// placeCreaturePacks for seed 991 with `villages: []` (exactly what the old
// broken ordering fed them) and taking the 6x4 window covering the most
// hostiles: 3 at (24,20), versus 1 for the old 8x6 box at (20,20). The
// fixture is therefore STRONGER than the one it replaces, not weaker.
//
// `density` is still deliberately NOT authored: the world lands on the
// 'normal' default like every shipped spec does.
const VILLAGE_BOX = { min_row: 24, min_col: 20, width: 6, height: 4 };
const villagePopulationSpec = () => ({
  name: 'zz-test-village-population-fixture',
  topology: 'spine',
  worlds: [
    { key: 'a', name: 'zzTestVilA', grid: [12, -3], seed: 991, width: 64, height: 64,
      // biomes: ['Meadow'], not [], for the same reason populationSpec above
      // names it -- plus one this fixture cares about more. `biomes: []` makes
      // the generator band the ENTIRE global tile catalog, which P3 just grew
      // by 30 tiles including three impassable ones (cave_wall / rubble /
      // chasm) and which will grow again. Whether this world's entry spawn is
      // walkable, and whether hostiles have anywhere to stand, would then be a
      // property of the tile catalog rather than of this fixture -- a coin flip
      // re-tossed by every future tile someone adds, silently turning the
      // placement assertions below vacuous (or red) for reasons that have
      // nothing to do with village/population ordering. Meadow's three terrain
      // tiles are all walkable and its creature_types includes 'Slime', which
      // matches allowed_creature_types below.
      chunk_size: 64, biomes: ['Meadow'], biome_cell: 32,
      // entry_spawn IS the village spawn below, not the map centre it used to
      // be: world `a` is is_entry, and SOMET-335's validator gate refuses an
      // entry world whose entry_spawn is not the spawn of a village it
      // declares. Nothing in this fixture's assertions depends on the two
      // being different -- it is about village/population ordering.
      allowed_creature_types: ['Slime'], is_entry: true, entry_spawn: { x: 2150, y: 2550 },
      // Spawn is an interior tile of the box: rows 24..27, cols 20..25, so the
      // interior is rows 25..26, cols 21..24 and the S gate is at (row 27, col
      // 23). Tile (row 25, col 21) -> pixel centre (2150,2550), which is clear
      // of the merchant post (row 25, col 23) and both gate-guard posts (row
      // 26, cols 22 and 24). It used to read (2350,2650) = a tile outside the
      // box entirely -- harmless to this fixture's assertions but not a legal
      // village, and validateMapSpec now rejects it (SOMET-153).
      village: { key: 'pop-village', ...VILLAGE_BOX, gate_edge: 'S', spawn_x: 2150, spawn_y: 2550 } },
  ],
  links: [],
});

test('seeding a spec with a village is idempotent and keeps hostiles out of the village', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} (${pool.unreachable}) — village/population ordering is UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  // Non-guard creatures only: the two village gate guards are placed by
  // createVillage at fixed gate-post tiles and are irrelevant to the scatter
  // the ordering defect moves.
  const hostiles = `SELECT wc.x, wc.y, wc.type FROM world_creatures wc
       JOIN worlds w ON w.id = wc.world_id
      WHERE w.name = 'zzTestVilA' AND wc.type <> 'Village Guard'
      ORDER BY wc.x, wc.y, wc.type`;
  try {
    await cleanup(pool);
    const s = villagePopulationSpec();
    await withEntryPreserved(pool, async () => {
      await applyMapSpec(pool, s);
      const first = (await pool.query(hostiles)).rows;
      // Non-vacuity: an apply that placed nothing would satisfy both
      // assertions below trivially.
      assert.ok(first.length > 0, 'the fixture placed no hostiles — both assertions below would be vacuous');

      const inside = first.filter((r) => {
        const col = Math.floor(Number(r.x) / 100);
        const row = Math.floor(Number(r.y) / 100);
        return row >= VILLAGE_BOX.min_row && row < VILLAGE_BOX.min_row + VILLAGE_BOX.height
          && col >= VILLAGE_BOX.min_col && col < VILLAGE_BOX.min_col + VILLAGE_BOX.width;
      });
      assert.deepEqual(inside, [],
        'a hostile was placed inside the village footprint — population ran before the village existed');

      await applyMapSpec(pool, s);
      const second = (await pool.query(hostiles)).rows;
      assert.deepEqual(second, first,
        're-applying an unchanged spec moved the creatures — seeding is not idempotent');
    });
  } finally {
    await cleanup(pool);
    await pool.end();
  }
});

// Retrofitting a world's biomes changes its terrain, and world_chunks caches
// generated terrain. Without this, a re-pointed world serves stale chunks.
test('seeding clears cached chunks for worlds it writes', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} (${pool.unreachable}) — chunk-cache clearing is UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  try {
    await cleanup(pool);
    await withEntryPreserved(pool, () => applyMapSpec(pool, populationSpec()));
    const ids = await pool.query(
      'SELECT id FROM worlds WHERE name = ANY($1::text[])',
      [populationSpec().worlds.map((w) => w.name)]);
    // Plant a chunk, then re-seed and confirm it is gone.
    await pool.query(
      `INSERT INTO world_chunks (world_id, cx, cy, data) VALUES ($1, 0, 0, '[]'::jsonb)
       ON CONFLICT (world_id, cx, cy) DO NOTHING`, [ids.rows[0].id]);
    const before = await pool.query(
      'SELECT count(*)::int AS n FROM world_chunks WHERE world_id = $1', [ids.rows[0].id]);
    assert.equal(before.rows[0].n, 1, 'fixture must have planted a chunk');

    await withEntryPreserved(pool, () => applyMapSpec(pool, populationSpec()));
    const after = await pool.query(
      'SELECT count(*)::int AS n FROM world_chunks WHERE world_id = $1', [ids.rows[0].id]);
    assert.equal(after.rows[0].n, 0);
  } finally {
    await cleanup(pool);
    await pool.end();
  }
});

// A world whose biome bands nothing but impassable terrain must fail the seed
// rather than ship a dungeon nobody can enter.
test('seeding refuses a world sealed by its own terrain', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} (${pool.unreachable}) — sealed-world guard is UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  try {
    await cleanup(pool);
    // creature_types is ["Slime"] -- the type populationSpec's worlds allow --
    // and NOT empty. This fixture is about TERRAIN sealing a world, and
    // validateMapSpec now rejects an allowlist no declared biome admits
    // (SOMET-315) before the navigability check ever runs. An empty roster here
    // would make the spec fail for the wrong reason and this test would assert
    // the wrong guard while still looking green on the regex.
    await pool.query(
      `INSERT INTO biomes (name, terrain_tiles, flora_types, creature_types, palette, art_style, exclusions, color)
       VALUES ('zzSealed', '["cave_wall"]'::jsonb, '[]'::jsonb, '["Slime"]'::jsonb, '[]'::jsonb, '', '', '#000000')
       ON CONFLICT (name) DO UPDATE SET terrain_tiles = EXCLUDED.terrain_tiles,
                                        creature_types = EXCLUDED.creature_types`);
    const spec = populationSpec();
    spec.worlds.forEach((w) => { w.biomes = ['zzSealed']; });
    await assert.rejects(
      () => withEntryPreserved(pool, () => applyMapSpec(pool, spec)),
      // Three wordings, one refusal. assertNavigable reports a doorway it
      // cannot reach ("unreachable"), a required tile off the map ("outside
      // the map"), or a world whose reachable share falls under
      // MIN_REACHABLE_FRACTION ("effectively sealed") -- which is the one this
      // all-cave_wall fixture produces now that the doorway carve leaves a
      // small pocket behind. Matching only the first two let SOMET-349 turn
      // this test red for the right reason and look like the wrong one.
      /unreachable|outside the map|effectively sealed/,
    );
  } finally {
    await cleanup(pool);
    await pool.query(`DELETE FROM biomes WHERE name = 'zzSealed'`);
    await pool.end();
  }
});

// ---------------------------------------------------------------------------
// Waypoints through the real applier (SOMET-292 review, findings 1-3).
//
// Everything below reads ROWS BACK. The first version of this coverage was a
// source grep for /upsertWaypoint/ in seed-map.js, which the surviving `require`
// line alone satisfied: the reviewer replaced both upsert calls and the
// `UPDATE map_links SET is_waypoint` with no-ops and the DB suite stayed green.
//
// The portal is at pixel (2550,2550) -- tile (25,25) of a 64x64 world, well
// inside the wall ring stampBounds stamps -- and lands at (550,550) in the
// portal-only world "b". Deep Forest's terrain tiles are all walkable, so
// navigability is a property of the fixture rather than of a lucky seed (see the
// matching note on spec() above).
const WP_PORTAL = { from_x: 2550, from_y: 2550, to_x: 550, to_y: 550 };
const WP_STONE = { x: 1250, y: 850, name: 'zzTestWp Old Well' };
const WP_STAIR_NAME = 'zzTestWp Barrow Stair';

// `stoneWorld` exists for the guarded-staircase case, which must drop its stone
// on world A's staircase TILE to collide with it. Everything else keeps the
// stone in B, so A's flagged staircase and B's stone are one landmark each and
// the spec stays legal under the SOMET-300 ceiling.
const waypointSpec = ({ guard = false, flagged = true, stone = WP_STONE, stoneWorld = 'b' } = {}) => {
  const portal = { kind: 'portal', from: 'a', to: 'b', ...WP_PORTAL };
  if (guard) portal.guard = { creature_type: 'Wolf', count: 2 };
  if (flagged) { portal.is_waypoint = true; portal.waypoint_name = WP_STAIR_NAME; }
  const a = {
    key: 'a', name: 'zzTestWpA', grid: [14, -3], seed: 995, width: 64, height: 64,
    chunk_size: 64, biomes: ['Deep Forest'], biome_cell: 32,
    allowed_creature_types: [], is_entry: true, entry_spawn: { x: 3200, y: 3200 },
  };
  const b = {
    // No grid: reachable only through the portal, which is exactly the shape
    // a real dungeon has.
    key: 'b', name: 'zzTestWpB', seed: 996, width: 20, height: 20,
    chunk_size: 20, biomes: ['Deep Forest'], biome_cell: 10,
    allowed_creature_types: [], is_entry: false,
  };
  // The standalone stone lives in world B, the flagged staircase in world A.
  //
  // It used to put BOTH in world A, which SOMET-300 made an illegal spec: a
  // world may hold at most one travel landmark, counting the standalone
  // `waypoints` array and any is_waypoint portal departing from it. Splitting
  // them keeps this fixture covering BOTH authoring routes -- which is its whole
  // job -- while staying legal. WP_STONE's tile (12,8) is inside B's 20x20.
  if (stone) (stoneWorld === 'a' ? a : b).waypoints = [stone];
  return {
    name: 'zz-test-waypoint-fixture',
    topology: 'spine',
    worlds: [a, b],
    links: [portal],
  };
};

// The forward portal row and its mirror, by the tile each departs from.
async function wpLinks(pool) {
  const r = await pool.query(
    `SELECT ml.id, ml.is_waypoint, w.name AS world
       FROM map_links ml JOIN worlds w ON w.id = ml.from_world_id
      WHERE w.name LIKE 'zzTestWp%' AND ml.edge = 'PORTAL' ORDER BY w.name`);
  return { forward: r.rows.find((x) => x.world === 'zzTestWpA'),
           mirror: r.rows.find((x) => x.world === 'zzTestWpB') };
}

async function wpRows(pool) {
  const r = await pool.query(
    `SELECT wp.id, wp.name, wp.x, wp.y, wp.map_link_id, w.name AS world
       FROM waypoints wp JOIN worlds w ON w.id = wp.world_id
      WHERE w.name LIKE 'zzTestWp%' ORDER BY wp.name`);
  return r.rows;
}

test('seeding writes the waypoints a spec authors', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} (${pool.unreachable}) — waypoint seeding is UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  try {
    await cleanup(pool);
    await withEntryPreserved(pool, async () => {
      const result = await applyMapSpec(pool, waypointSpec());
      assert.equal(result.waypoints, 2, 'one standalone waypoint and one flagged staircase');

      const { forward, mirror } = await wpLinks(pool);
      assert.ok(forward && mirror, 'the portal and its mirror must both exist');
      assert.equal(forward.is_waypoint, true, 'the flag never reached the link the spec flagged');
      assert.equal(mirror.is_waypoint, false,
        'only the departure side is authored — flagging the mirror drops a traveller past a guard');

      // Positions, world, and the FORWARD link id: map_link_id pointing at the
      // mirror (or at nothing) is the wiring mistake a count check cannot see.
      assert.deepEqual(
        (await wpRows(pool)).map((r) => ({
          name: r.name, x: r.x, y: r.y, world: r.world, link: r.map_link_id })),
        [
          { name: WP_STAIR_NAME, x: 2550, y: 2550, world: 'zzTestWpA', link: forward.id },
          { name: WP_STONE.name, x: 1250, y: 850, world: 'zzTestWpB', link: null },
        ]);
    });
  } finally { await cleanup(pool); await pool.end(); }
});

test('re-seeding a moved waypoint converges, keeps activations, and leaves no ghost', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} (${pool.unreachable}) — waypoint convergence is UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  try {
    await cleanup(pool);
    await withEntryPreserved(pool, async () => {
      await applyMapSpec(pool, waypointSpec());
      const before = (await wpRows(pool)).find((r) => r.name === WP_STONE.name);

      // A player lights it, exactly as the tick loop would.
      const classes = await listPlayableClasses(pool);
      await pool.query(
        "INSERT INTO users (username, password_hash, role) VALUES ('zzTestWpUser', 'x', 'player')");
      const userId = (await pool.query(
        "SELECT id FROM users WHERE username = 'zzTestWpUser'")).rows[0].id;
      const character = await createCharacter(
        pool, userId, 'zzTestWpChar', classes.find((c) => c.name === 'Warrior').id);
      await activateWaypoint(pool, character.id, before.id);

      // Slice B's first edit: nudge the waypoint, keep its name.
      const moved = await applyMapSpec(pool, waypointSpec({
        stone: { ...WP_STONE, x: 1750, y: 1250 } }));   // tile (17,12): still inside B's 20x20
      assert.equal(moved.waypointsRemoved, 0, 'a rename-free move must not delete anything');

      const rows = await wpRows(pool);
      assert.equal(rows.length, 2, 'the old tile still carries a ghost waypoint');
      const after = rows.find((r) => r.name === WP_STONE.name);
      assert.equal(after.id, before.id, 'the move re-created the waypoint instead of moving it');
      assert.deepEqual([after.x, after.y], [1750, 1250]);
      const act = await pool.query(
        'SELECT count(*)::int AS n FROM character_waypoints WHERE waypoint_id = $1', [before.id]);
      assert.equal(act.rows[0].n, 1, 're-seeding erased a player\'s activation');

      // Un-authoring both of them takes the flag AND the rows back off: the
      // registry is what the runtime reads, so a row nobody authors any more is
      // still a live travel target.
      const dropped = await applyMapSpec(pool, waypointSpec({ flagged: false, stone: null }));
      assert.equal(dropped.waypoints, 0);
      assert.equal(dropped.waypointsRemoved, 2);
      assert.deepEqual(await wpRows(pool), []);
      assert.equal((await wpLinks(pool)).forward.is_waypoint, false,
        'removing the key from a spec must take the flag back off');
    });
  } finally { await cleanup(pool); await pool.end(); }
});

test('a guarded staircase cannot end up a waypoint, whatever the spec says', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} (${pool.unreachable}) — the guarded-portal rule is UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  try {
    await cleanup(pool);
    await withEntryPreserved(pool, async () => {
      // (a) The flag comes first, the guard second. Two edits, each clean to the
      // validator: v1 flags an unguarded staircase, v2 guards it and drops the
      // flag. The applier used to set is_waypoint = false and insert the guards
      // while leaving the registry row -- and the registry row is what the
      // authority reads.
      await applyMapSpec(pool, waypointSpec({ stone: null }));
      assert.equal((await wpRows(pool)).length, 1, 'v1 must have authored the staircase waypoint');

      const guarded = await applyMapSpec(pool, waypointSpec({ guard: true, flagged: false, stone: null }));
      assert.equal(guarded.portalGuards, 2, 'v2 must actually place the guard pack');
      assert.deepEqual(await wpRows(pool), [],
        'the guard landed on a staircase that still had a waypoint on it');

      const guardRows = await pool.query(
        `SELECT count(*)::int AS n FROM world_creatures wc JOIN worlds w ON w.id = wc.world_id
          WHERE w.name = 'zzTestWpA' AND wc.blocks_portal_id IS NOT NULL`);
      assert.equal(guardRows.rows[0].n, 2, 'the guards must be live rows for the cases below to mean anything');
    });

    // (b) The guard goes away in the SPEC and stays in the DATABASE.
    // worldPopulation deliberately spares `blocks_portal_id IS NOT NULL`, so
    // dropping `guard:` from a spec does not remove the creatures. The validator
    // builds its guarded-tile set from the spec text and sees nothing to reject.
    await assert.rejects(
      () => withEntryPreserved(pool, () => applyMapSpec(pool, waypointSpec({ stone: null }))),
      /guarded by Wolf/,
      'a re-flagged staircase whose guards are still alive must abort the apply');
    assert.deepEqual(await wpRows(pool), [], 'the aborted apply left a waypoint behind');
    assert.equal((await wpLinks(pool)).forward.is_waypoint, false,
      'the aborted apply committed the flag');

    // The same bypass spelled without the flag: a standalone waypoint dropped on
    // the staircase's own tile is walked onto, lit, and travelled to.
    await assert.rejects(
      () => withEntryPreserved(pool, () => applyMapSpec(pool, waypointSpec({
        flagged: false, stoneWorld: 'a',
        stone: { x: 2599, y: 2599, name: 'zzTestWp Sneaky Stone' } }))),
      /Sneaky Stone.*guarded by Wolf/s);
    assert.deepEqual(await wpRows(pool), []);
  } finally { await cleanup(pool); await pool.end(); }
});

// allows_fast_travel, seeded for real rather than asserted from source text
// (Plan B slice 1). The half-wiring this guards against: a column present in
// the INSERT but missing from the ON CONFLICT SET works on a fresh database
// and then silently stops updating on every re-seed, so the spec and the live
// row drift apart with nothing failing.
test('allows_fast_travel round-trips through a real seed, both directions', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} (${pool.unreachable}) — fast-travel seeding is UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  const flagOf = async (name) => (await pool.query(
    'SELECT allows_fast_travel FROM worlds WHERE name = $1', [name])).rows[0]?.allows_fast_travel;
  try {
    await cleanup(pool);
    await withEntryPreserved(pool, async () => {
      // One world opts in, the other omits the key entirely.
      const s = spec();
      s.worlds[0].allows_fast_travel = true;
      delete s.worlds[1].allows_fast_travel;
      await applyMapSpec(pool, s);

      assert.equal(await flagOf('zzTestAlpha'), true, 'an opted-in world must be seeded true');
      assert.equal(await flagOf('zzTestBeta'), false,
        'a world that omits the key must be false, never null or true');

      // Now take it away. The spec is the source of truth, so removing the key
      // must turn the flag back OFF -- a world must not stay permanently
      // travellable because it once was. This is the assertion that fails if
      // the ON CONFLICT SET is missing.
      const s2 = spec();
      delete s2.worlds[0].allows_fast_travel;
      await applyMapSpec(pool, s2);

      assert.equal(await flagOf('zzTestAlpha'), false,
        're-seeding without the key must clear the flag (ON CONFLICT SET missing?)');
    });
  } finally {
    await cleanup(pool);
    await pool.end().catch(() => {});
  }
});

// Review finding (Important 2): no DB-backed fixture in this file ever used a
// plural `villages:` array with more than one entry, so
// `for (const v of specVillages) { await createVillage(...) }` in
// scripts/seed-map.js had never actually executed with 2+ elements -- only
// read by inspection. This world declares two non-overlapping, legal boxes
// (same shapes as map_spec_validate.test.js's VILLAGE_A/VILLAGE_B) so both
// createVillage calls run for real.
//
// Also carries safe_road_radius/safe_rects (review finding Important 3,
// folded in here per the reviewer's suggestion): no existing DB test proved
// the ON CONFLICT SET actually re-asserts these two columns the way
// "allows_fast_travel round-trips through a real seed" proves it for that
// column.
// Only the APPLIER's own warnings. populateWorld writes to the same stream (its
// scatter under-delivery line) and names the same world, so matching on the
// world name alone would let an unrelated warning satisfy an assertion about
// this one. Shared by the two village-convergence tests below.
const captureSeedWarnings = async (fn) => {
  const lines = [];
  const real = console.warn;
  console.warn = (...args) => { lines.push(args.join(' ')); };
  try { await fn(); } finally { console.warn = real; }
  return lines.filter((l) => l.startsWith('seed-map:'));
};

const MULTI_VILLAGE_A = { key: 'north', min_row: 10, min_col: 10, width: 6, height: 4,
  gate_edge: 'S', spawn_x: 1150, spawn_y: 1150 };
const MULTI_VILLAGE_B = { key: 'south', min_row: 30, min_col: 30, width: 6, height: 4,
  gate_edge: 'S', spawn_x: 3150, spawn_y: 3150 };
const multiVillageSpec = ({ safe = false, villages = [MULTI_VILLAGE_A, MULTI_VILLAGE_B] } = {}) => ({
  name: 'zz-test-multi-village-fixture',
  topology: 'spine',
  worlds: [
    {
      key: 'a', name: 'zzTestMultiVillage', grid: [15, -3], seed: 995, width: 64, height: 64,
      chunk_size: 64, biomes: ['Meadow'], biome_cell: 32,
      allowed_creature_types: [], is_entry: true,
      // MULTI_VILLAGE_A's spawn tile (row 11, col 11). It used to be tile
      // (5,5), chosen to sit clear of both village boxes -- a shape SOMET-335
      // made illegal for an is_entry world, which must start the player IN a
      // village it declares. A is used rather than B because the `oneVillage()`
      // variant below drops B, and both variants have to stay valid.
      entry_spawn: { x: 1150, y: 1150 },
      villages,
      ...(safe ? {
        safe_road_radius: 3,
        safe_rects: [{ min_row: 0, min_col: 0, width: 2, height: 2 }],
      } : {}),
    },
  ],
  links: [],
});

test('a world with two villages creates both, idempotently, and safe-territory columns round-trip', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} (${pool.unreachable}) — multi-village seeding is UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  const safeColsOf = async (name) => (await pool.query(
    'SELECT safe_road_radius, safe_rects FROM worlds WHERE name = $1', [name])).rows[0];
  try {
    await cleanup(pool);
    const s = multiVillageSpec({ safe: true });
    await withEntryPreserved(pool, async () => {
      const result = await applyMapSpec(pool, s);
      assert.equal(result.villages, 2,
        'applyMapSpec must report creating both villages, not just the first');

      const villageRows = await pool.query(
        `SELECT v.min_row, v.min_col, v.width, v.height FROM villages v
           JOIN worlds w ON w.id = v.world_id
          WHERE w.name = 'zzTestMultiVillage' ORDER BY v.min_row`);
      assert.equal(villageRows.rowCount, 2,
        'both villages must exist as real rows, not just be counted');
      assert.equal(Number(villageRows.rows[0].min_row), MULTI_VILLAGE_A.min_row);
      assert.equal(Number(villageRows.rows[1].min_row), MULTI_VILLAGE_B.min_row);

      // Two gate guards per village -- an applier that silently dropped the
      // second village would leave 2, not 4.
      const guardRow = await pool.query(
        `SELECT count(*)::int AS n FROM world_creatures wc
           JOIN worlds w ON w.id = wc.world_id
          WHERE w.name = 'zzTestMultiVillage' AND wc.type = 'Village Guard'`);
      assert.equal(guardRow.rows[0].n, 4,
        'two villages should each get two gate guards');

      const safeAfterFirst = await safeColsOf('zzTestMultiVillage');
      assert.equal(safeAfterFirst.safe_road_radius, 3);
      assert.deepEqual(safeAfterFirst.safe_rects, [{ min_row: 0, min_col: 0, width: 2, height: 2 }]);

      // Idempotent: villages are matched to the spec by their key (SOMET-312),
      // so re-applying must not create a third/fourth village, must not report
      // a move, and must not double the guard count.
      const second = await applyMapSpec(pool, s);
      assert.equal(second.villages, 0,
        're-applying an unchanged spec must not report re-creating either village');
      assert.equal(second.villagesMoved, 0,
        're-applying an UNCHANGED spec must not report moving anything either — a move '
        + 'reported here would mean the applier cannot tell an unchanged box from a moved one');
      const villageRowsAfter = await pool.query(
        `SELECT count(*)::int AS n FROM villages v
           JOIN worlds w ON w.id = v.world_id WHERE w.name = 'zzTestMultiVillage'`);
      assert.equal(villageRowsAfter.rows[0].n, 2, 'second apply duplicated a village');
      const guardRowAfter = await pool.query(
        `SELECT count(*)::int AS n FROM world_creatures wc
           JOIN worlds w ON w.id = wc.world_id
          WHERE w.name = 'zzTestMultiVillage' AND wc.type = 'Village Guard'`);
      assert.equal(guardRowAfter.rows[0].n, 4, 'second apply duplicated a gate guard');

      // Now remove the safe-territory keys entirely and re-seed. The spec is
      // the source of truth (same rule allows_fast_travel follows): deleting
      // the keys must take the world back to the column defaults, not leave
      // it permanently safe because it once opted in. This is the assertion
      // that fails if the ON CONFLICT SET for these two columns is missing.
      const s2 = multiVillageSpec({ safe: false });
      await applyMapSpec(pool, s2);
      const safeAfterSecond = await safeColsOf('zzTestMultiVillage');
      assert.equal(safeAfterSecond.safe_road_radius, 0,
        're-seeding without safe_road_radius must clear it back to 0 (ON CONFLICT SET missing?)');
      assert.deepEqual(safeAfterSecond.safe_rects, [],
        're-seeding without safe_rects must clear it back to [] (ON CONFLICT SET missing?)');
    });
  } finally {
    await cleanup(pool);
    await pool.end().catch(() => {});
  }
});

// SOMET-288 review finding 3, as re-answered by SOMET-312.
//
// Villages used to be the ONE authored thing a re-seed did not converge: every
// column on `worlds` is re-asserted via ON CONFLICT SET (safe_road_radius and
// safe_rects included, proved just above), but a world that already held any
// village was skipped whole. An author who added a village to a seeded world
// (SOMET-289) got a clean exit code and no second village; SOMET-288's answer
// was to make that no-op WARN, because "a village has no identity beyond its
// box" and creating "the missing ones" could not be written safely.
//
// It has one now -- `key` -- so the no-op is gone and this asserts the
// convergence that replaced it. The refusal has not disappeared, it has moved
// to the case that is genuinely ambiguous: see the "cannot be untangled" test
// below, which is what stops this from being a licence to guess.
test('adding a village to an already-seeded world creates it, matched by key', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} (${pool.unreachable}) — village convergence is UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  const villageRows = async () => (await pool.query(
    `SELECT v.spec_key, v.min_row FROM villages v JOIN worlds w ON w.id = v.world_id
      WHERE w.name = 'zzTestMultiVillage' ORDER BY v.min_row`)).rows;

  try {
    await cleanup(pool);
    await withEntryPreserved(pool, async () => {
      const oneVillage = () => multiVillageSpec({ villages: [MULTI_VILLAGE_A] });

      const firstRunWarnings = await captureSeedWarnings(async () => {
        const first = await applyMapSpec(pool, oneVillage());
        assert.equal(first.villages, 1, 'the first seed must create the village');
      });
      assert.deepEqual(firstRunWarnings, [],
        'a first seed creates every village it declares — warning there is pure noise');
      assert.deepEqual(await villageRows(), [{ spec_key: 'north', min_row: MULTI_VILLAGE_A.min_row }],
        'the created village must carry its spec key, or nothing can find it again');

      // Control: an UNCHANGED spec re-applied is a legitimate no-op and must
      // stay quiet, or a warning means nothing when it does fire.
      const unchangedWarnings = await captureSeedWarnings(() => applyMapSpec(pool, oneVillage()));
      assert.deepEqual(unchangedWarnings, [],
        're-applying an unchanged spec must not warn');

      // The real case: the spec now declares two villages, the world has one.
      // "north" is matched by key and left alone; "south" is missing and is
      // created. No warning, because nothing is ambiguous.
      const grownWarnings = await captureSeedWarnings(async () => {
        const grown = await applyMapSpec(pool, multiVillageSpec());
        assert.equal(grown.villages, 1, 'the village the spec added must be CREATED, not skipped');
        assert.equal(grown.villagesMoved, 0,
          'the village that did not move must not be reported as moved');
      });
      assert.deepEqual(grownWarnings, [],
        'adding a village is unambiguous — matched by key, so there is nothing to warn about');

      assert.deepEqual(await villageRows(), [
        { spec_key: 'north', min_row: MULTI_VILLAGE_A.min_row },
        { spec_key: 'south', min_row: MULTI_VILLAGE_B.min_row },
      ], 'both villages must exist as real rows, each under its own spec key');

      // Four guards, not two: the created village brought its own pair, and the
      // pre-existing one did not lose or duplicate its own.
      const guards = await pool.query(
        `SELECT count(*)::int AS n FROM world_creatures wc JOIN worlds w ON w.id = wc.world_id
          WHERE w.name = 'zzTestMultiVillage' AND wc.type = 'Village Guard'`);
      assert.equal(guards.rows[0].n, 4, 'each village must hold exactly two gate guards');
    });
  } finally {
    await cleanup(pool);
    await pool.end().catch(() => {});
  }
});

// SOMET-312 — the case the applier must still REFUSE.
//
// Convergence by key is safe because the key is an identity. Take it away and
// there is nothing left to reason with, so the applier must decline rather than
// pair rows off in array order: an unkeyed row is adopted only when the pairing
// is forced (one spec entry, one row). Two unkeyed rows against one declaration
// is a genuine ambiguity, and guessing there is the exact mistake this ticket
// is about, one level up.
test('villages that cannot be untangled are refused, loudly, and left alone', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} (${pool.unreachable}) — the ambiguity refusal is UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  const boxes = async () => (await pool.query(
    `SELECT v.min_row FROM villages v JOIN worlds w ON w.id = v.world_id
      WHERE w.name = 'zzTestMultiVillage' ORDER BY v.min_row`)).rows.map((r) => Number(r.min_row));

  try {
    await cleanup(pool);
    await withEntryPreserved(pool, async () => {
      await applyMapSpec(pool, multiVillageSpec());          // two villages, both keyed
      assert.deepEqual(await boxes(), [MULTI_VILLAGE_A.min_row, MULTI_VILLAGE_B.min_row],
        'the fixture must start with BOTH villages, or the ambiguity below never arises');

      // Strip the keys: this is what a database seeded before SOMET-312 looks
      // like. Written through SQL rather than by seeding, because there is no
      // longer any code path that produces an unkeyed seeded village -- which
      // is the point: the state exists in the wild, not in this repo.
      await pool.query(
        `UPDATE villages SET spec_key = NULL
          WHERE world_id = (SELECT id FROM worlds WHERE name = 'zzTestMultiVillage')`);

      // One declaration, two unkeyed rows, and the declaration's box matches
      // NEITHER of them -- so the exact-box adoption cannot fire either.
      //
      // Shifted by one tile rather than moved across the map, because this
      // world is is_entry and SOMET-335 pins its entry_spawn to a village spawn
      // it declares: rows 9..12 / cols 9..14 still holds spawn tile (11,11), so
      // the box genuinely differs from both live rows while the spec stays
      // valid and this test keeps failing for the reason it is named for.
      const moved = { ...MULTI_VILLAGE_A, min_row: 9, min_col: 9 };
      const warnings = await captureSeedWarnings(async () => {
        const n = await applyMapSpec(pool, multiVillageSpec({ villages: [moved] }));
        assert.equal(n.villages, 0, 'nothing may be created while the pairing is ambiguous');
        assert.equal(n.villagesMoved, 0, 'nothing may be moved while the pairing is ambiguous');
      });

      assert.equal(warnings.length, 1, `expected exactly one warning, got ${JSON.stringify(warnings)}`);
      assert.match(warnings[0], /zzTestMultiVillage/, 'the warning must name the world');
      assert.match(warnings[0], /cannot be\s+deduced/, 'the warning must say why nothing was applied');
      assert.match(warnings[0], /"north"/, 'the warning must name the spec village left unapplied');

      assert.deepEqual(await boxes(), [MULTI_VILLAGE_A.min_row, MULTI_VILLAGE_B.min_row],
        'both live rows must be exactly where they were — a refusal that still wrote something '
        + 'would be worse than the silent skip it replaced');
    });
  } finally {
    await cleanup(pool);
    await pool.end().catch(() => {});
  }
});

// --- SOMET-289: the applier's own pen pass ---------------------------------
//
// home_region_db.test.js proves the LIVE rows, which migration 1714440201000
// wrote. This proves the OTHER path that seats pen creatures -- applyMapSpec --
// because the two are separate code and only one of them is exercised by a
// re-seed. The same class of split worldPopulation.js was created to end.
//
// The pen is deliberately placed INSIDE the safe road corridor
// (safe_road_radius 3, and the box straddles the map centre where the lattice
// runs). creatureTileCandidates refuses a safe tile for ANY type, so if pens
// ever get routed back through the ordinary placer this comes out empty.
//
// The fixture ALSO declares a vault chest, and that is not decoration. The
// chest pass runs BEFORE the pen pass and insertVaultChest writes a homed,
// non-guard, non-portal row -- byte-for-byte the shape the pen pass's first
// idempotency guard treated as "this world is already penned". With that guard,
// this spec seated 0 pen creatures on its very first apply and exited 0. The
// chest tile (5,5) sits outside every pen box, so only a guard that tests the
// ANCHOR against the authored boxes gets this right.
const PEN_SPEC = () => ({
  name: 'zz-test-pen-fixture',
  topology: 'spine',
  worlds: [
    {
      key: 'a', name: 'zzTestPenWorld', grid: [17, -3], seed: 993,
      width: 64, height: 64, chunk_size: 64,
      biomes: ['Meadow'], biome_cell: 32,
      // Non-empty, so populateWorld really scatters hostiles and its opening
      // DELETE really runs. With [] it early-returns before the delete and the
      // survival half of this test would be vacuous.
      allowed_creature_types: ['Slime'],
      is_entry: true,
      // This fixture MUST carry a village, and entry_spawn MUST be that
      // village's spawn. validateMapSpec requires exactly one is_entry world,
      // so a fixture spec has to claim it -- and while it does, any test file
      // running in parallel against this shared database sees zzTestPenWorld as
      // THE entry world. villageScreenBudget_db.test.js asserts the entry world
      // has a village whose spawn is entry_spawn (SOMET-153's criterion), and
      // failed on exactly that when this fixture had neither. withEntryPreserved
      // restores the real entry world afterwards, but it cannot close the window
      // while the apply is running.
      entry_spawn: { x: 1150, y: 1150 },
      village: { key: 'pen-village', min_row: 10, min_col: 10, width: 6, height: 4,
                 gate_edge: 'S', spawn_x: 1150, spawn_y: 1150 },
      level_band: [1, 2],
      safe_road_radius: 3,
      chest: { x: 550, y: 550, guard_creature_type: 'Wolf', level: 3 },
      pens: [{
        min_row: 30, min_col: 30, width: 6, height: 5,
        creature_type: 'Woodland Swarm', count: 5, level: 1,
      }],
    },
  ],
  links: [],
});

test('applyMapSpec seats pen creatures, and populateWorld does not eat them', async (t) => {
  const pool = await openPool();
  if (pool.unreachable) {
    const msg = `NO DATABASE at ${DB_URL} (${pool.unreachable}) — pen seeding is UNVERIFIED`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return;
  }
  try {
    await cleanup(pool);
    await withEntryPreserved(pool, async () => {
      const result = await applyMapSpec(pool, PEN_SPEC());
      assert.equal(result.penCreatures, 5, 'the pen pass did not seat the authored count');

      // The chest guard really was written, and really does look like a penned
      // creature everywhere except its anchor. Asserted rather than assumed: if
      // the chest pass ever stopped writing a homed row, the pen assertion above
      // would still pass and would silently stop covering this regression.
      assert.equal(result.vaultChests, 1, 'the fixture chest was not seeded');
      const chestGuard = (await pool.query(
        `SELECT c.home_x, c.home_y, c.blocks_portal_id FROM world_creatures c
           JOIN worlds w ON w.id = c.world_id
          WHERE w.name = 'zzTestPenWorld' AND c.type = 'Wolf'`)).rows;
      assert.equal(chestGuard.length, 1, 'expected exactly the chest guard');
      assert.ok(chestGuard[0].home_x !== null && chestGuard[0].blocks_portal_id === null,
        'the chest guard is not the homed non-guard non-portal row this test is about');
      assert.ok(Math.floor(Number(chestGuard[0].home_y) / 100) < 30,
        'the chest guard is anchored inside the pen box, so it no longer stands for '
        + 'the row the old guard confused with a penned creature');
      // populateWorld runs AFTER the pen pass inside the same transaction, and
      // its opening DELETE spares only guards, portal guards and home_x rows.
      assert.ok(result.creatures > 0,
        'no hostiles were scattered, so the DELETE this test is about barely ran');

      const penned = (await pool.query(
        `SELECT c.x, c.y, c.home_x, c.home_y, c.level FROM world_creatures c
           JOIN worlds w ON w.id = c.world_id
          WHERE w.name = 'zzTestPenWorld' AND c.type = 'Woodland Swarm'`)).rows;
      assert.equal(penned.length, 5,
        'penned creatures did not survive populateWorld in the same transaction');
      for (const c of penned) {
        assert.ok(c.home_x !== null && c.home_y !== null, 'a penned creature has no home anchor');
        const row = Math.floor(Number(c.home_y) / 100);
        const col = Math.floor(Number(c.home_x) / 100);
        assert.ok(row >= 30 && row <= 34 && col >= 30 && col <= 35,
          `penned creature anchored at (${row},${col}), outside the authored pen`);
        assert.equal(c.level, 1);
      }

      // Idempotent: a second apply must not stack a second set on top.
      const second = await applyMapSpec(pool, PEN_SPEC());
      assert.equal(second.penCreatures, 0, 're-seeding seated a duplicate set of pen creatures');
      const after = (await pool.query(
        `SELECT count(*)::int AS n FROM world_creatures c JOIN worlds w ON w.id = c.world_id
          WHERE w.name = 'zzTestPenWorld' AND c.type = 'Woodland Swarm'`)).rows[0].n;
      assert.equal(after, 5, 'a re-seed changed the pen population');
    });
  } finally {
    await cleanup(pool);
    await pool.end();
  }
});
