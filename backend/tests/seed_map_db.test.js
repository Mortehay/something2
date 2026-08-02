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
const spec = () => ({
  name: 'zz-test-fixture',
  topology: 'spine',
  worlds: [
    { key: 'a', name: 'zzTestAlpha', grid: [0, 0], seed: 991, width: 64, height: 64,
      chunk_size: 64, biomes: [], biome_cell: 32, creature_count: 0,
      allowed_creature_types: [], is_entry: true, entry_spawn: { x: 32, y: 32 } },
    { key: 'b', name: 'zzTestBeta', grid: [1, 0], seed: 992, width: 64, height: 64,
      chunk_size: 64, biomes: [], biome_cell: 32, creature_count: 2,
      allowed_creature_types: [], is_entry: false },
  ],
  links: [{ from: 'a', edge: 'E', to: 'b' }],
});

async function cleanup(pool) {
  await pool.query("DELETE FROM worlds WHERE name IN ('zzTestAlpha','zzTestBeta')").catch(() => {});
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
    if (beforeId != null) {
      await pool.query('UPDATE worlds SET is_entry = false WHERE is_entry = true AND id <> $1', [beforeId]);
      await pool.query('UPDATE worlds SET is_entry = true WHERE id = $1', [beforeId]);
    } else {
      await pool.query('UPDATE worlds SET is_entry = false WHERE is_entry = true');
    }
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
      assert.deepEqual(result, { worlds: 2, links: 1, villages: 0 },
        'applyMapSpec must report exactly what it wrote, not just resolve');

      const q = `SELECT name, seed, width, height, graph_x, graph_y FROM worlds
                 WHERE name LIKE 'zzTest%' ORDER BY name`;
      const first = await pool.query(q);
      const firstLinks = await pool.query(
        `SELECT ml.edge, wf.name AS from_name, wt.name AS to_name FROM map_links ml
           JOIN worlds wf ON wf.id = ml.from_world_id
           JOIN worlds wt ON wt.id = ml.to_world_id
          WHERE wf.name LIKE 'zzTest%' ORDER BY wf.name, ml.edge`);

      const second = await applyMapSpec(pool, s);
      assert.deepEqual(second, result, 'the second apply reported a different write than the first');
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
      // flip: alpha sits at [0,0] (canvas origin) and beta at [1,0], one cell
      // east. See tests/seed_map.test.js for the North/South sign case this
      // fixture's east-west links can't exercise.
      const byName = Object.fromEntries(first.rows.map((r) => [r.name, r]));
      assert.equal(Number(byName.zzTestAlpha.graph_x), 0);
      assert.equal(Number(byName.zzTestAlpha.graph_y), 0);
      assert.equal(Number(byName.zzTestBeta.graph_x), GRID_SPACING);
      assert.equal(Number(byName.zzTestBeta.graph_y), 0);
    });
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

test('every shipped spec applies cleanly', async (t) => {
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
