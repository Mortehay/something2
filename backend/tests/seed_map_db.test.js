const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { applyMapSpec, GRID_SPACING } = require('../scripts/seed-map.js');

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
      chunk_size: 64, biomes: [], biome_cell: 32,
      allowed_creature_types: [], is_entry: true, entry_spawn: { x: 32, y: 32 } },
    { key: 'b', name: 'zzTestBeta', grid: [6, -3], seed: 992, width: 64, height: 64,
      chunk_size: 64, biomes: [], biome_cell: 32,
      allowed_creature_types: [], is_entry: false,
      village: { min_row: 10, min_col: 10, width: 4, height: 3, gate_edge: 'S',
                 spawn_x: 1150, spawn_y: 1150 } },
  ],
  links: [{ from: 'a', edge: 'E', to: 'b' }],
});

async function cleanup(pool) {
  await pool.query(
    "DELETE FROM worlds WHERE name IN ('zzTestAlpha','zzTestBeta','zzTestPopA','zzTestPopB')",
  ).catch(() => {});
}

// Snapshot whichever world is currently is_entry (0 or 1 of them, per the
// validator's own invariant), run fn, then restore exactly that snapshot --
// both UPDATEs scoped by id, the same idiom applyMapSpec itself uses at
// scripts/seed-map.js's own "set is_entry LAST" step. Never leaves the real
// dev DB's entry world flipped just because a test happened to run.
async function withEntryPreserved(pool, fn) {
  const before = await pool.query('SELECT id FROM worlds WHERE is_entry = true');
  const beforeId = before.rows[0]?.id ?? null;
  try {
    return await fn();
  } finally {
    // Single atomic UPDATE, not two separate ones: a crash between "clear
    // every is_entry" and "set it back on beforeId" used to be able to leave
    // the database with ZERO entry worlds. COALESCE(id = $1, false) keeps
    // the SET expression a plain boolean (never SQL NULL) when beforeId is
    // null -- is_entry is NOT NULL, so assigning NULL would throw.
    await pool.query(
      'UPDATE worlds SET is_entry = COALESCE(id = $1, false) WHERE is_entry = true OR id = $1',
      [beforeId],
    );
  }
}

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
      assert.deepEqual(result, { worlds: 2, links: 1, villages: 1, portalGuards: 0, creatures: 0 },
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
test('every shipped spec applies cleanly', async (t) => {
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
      assert.deepEqual(second, { ...first, villages: 0 },
        `${s.name}: re-applying should not re-create villages, worlds, or links`);
    }

    // hub-vale is the one shipped spec with a village AND all four compass
    // edges from a single hub -- exercise both the village wiring and the
    // graph_x/graph_y sign convention against real, checked-in data instead
    // of only the synthetic east-west fixture above.
    const hubVale = results['hub-vale'];
    assert.ok(hubVale, 'expected backend/seeds/maps/hub-vale.map.json to exist and be named "hub-vale"');
    assert.equal(hubVale.first.villages, villageAlreadyExisted ? 0 : 1,
      'hub-vale declares one village; applyMapSpec must report creating it exactly once, ever');

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
      chunk_size: 64, biomes: [], biome_cell: 32,
      allowed_creature_types: ['Slime'], is_entry: true, entry_spawn: { x: 32, y: 32 } },
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
