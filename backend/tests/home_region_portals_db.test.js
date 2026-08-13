const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

// ---------------------------------------------------------------------------
// The eight home-region portal rows (SOMET-299), asserted against LIVE rows.
//
// Why live rows and not a fixture: the whole point of this slice is that the
// starting village has a portal a player can walk to. A fixture proves the
// INSERT statement is well-formed and says nothing about whether the shipped
// database has them, which is the only question that matters here -- the same
// distinction home_region_db.test.js draws for villages and pens.
//
// The rows arrive by TWO routes and this file deliberately does not care which:
// Old Trailhead <-> Windwatch Pass comes from spine-descent.map.json, the other
// three pairs from migration 1714440250000, because the home region spans two
// map specs and a spec link cannot cross them. A test that only checked the
// spec would silently pass while six of the eight rows were missing.
// ---------------------------------------------------------------------------

const DB_URL = process.env.TEST_DATABASE_URL || 'postgres://user:password@localhost:15432/game_db';

let pool = null;

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  const p = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 2000, max: 4 });
  try { await p.query('SELECT 1'); pool = p; } catch { await p.end().catch(() => {}); }
});
after(async () => { if (pool) await pool.end().catch(() => {}); });

function dbReady(t, what) {
  if (!process.env.TEST_DATABASE_URL) {
    const m = `TEST_DATABASE_URL not set -- ${what} is UNVERIFIED on this run`;
    if (process.env.CI) assert.fail(m);
    t.skip(m); return false;
  }
  if (!pool) {
    const m = `NO DATABASE at ${DB_URL} -- ${what} is UNVERIFIED`;
    if (process.env.CI) assert.fail(m);
    t.skip(m); return false;
  }
  return true;
}

// [fromWorld, fromX, fromY, toWorld, toX, toY] -- every row, both directions,
// spelled out rather than derived from the migration's own table. A test that
// imported the migration's PORTALS array would agree with it by construction
// and could never catch a wrong coordinate.
const EXPECTED = [
  ['Old Trailhead', 3150, 3650, 'Thornbriar Reach', 2850, 3050],
  ['Thornbriar Reach', 2850, 3050, 'Old Trailhead', 3150, 3650],

  ['Old Trailhead', 3550, 3650, 'Windwatch Pass', 3950, 2950],
  ['Windwatch Pass', 3950, 2950, 'Old Trailhead', 3550, 3650],

  ['Thornbriar Reach', 3350, 3050, 'Windwatch Pass', 4350, 2950],
  ['Windwatch Pass', 4350, 2950, 'Thornbriar Reach', 3350, 3050],

  ['Old Trailhead', 3750, 3650, 'The Catacombs: Entry', 3050, 3350],
  ['The Catacombs: Entry', 3050, 3350, 'Old Trailhead', 3750, 3650],
];

async function homeRegionPortals() {
  const r = await pool.query(
    `SELECT f.name AS from_name, ml.from_x, ml.from_y,
            t.name AS to_name, ml.to_x, ml.to_y, ml.is_waypoint, ml.id
       FROM map_links ml
       JOIN worlds f ON f.id = ml.from_world_id
       JOIN worlds t ON t.id = ml.to_world_id
      WHERE ml.edge = 'PORTAL'
        AND (f.name IN ('Old Trailhead','Thornbriar Reach','Windwatch Pass')
          OR t.name IN ('Old Trailhead','Thornbriar Reach','Windwatch Pass'))
      ORDER BY f.name, ml.from_x, ml.from_y`);
  return r.rows;
}

test('all eight home-region portal rows exist, in both directions', async (t) => {
  if (!dbReady(t, 'the home-region portals')) return;
  const rows = await homeRegionPortals();
  const actual = rows.map((r) => [r.from_name, Number(r.from_x), Number(r.from_y),
    r.to_name, Number(r.to_x), Number(r.to_y)]);
  const key = (a) => a.join('|');
  const have = new Set(actual.map(key));

  for (const want of EXPECTED) {
    assert.ok(have.has(key(want)),
      `missing portal ${want[0]} (${want[1]},${want[2]}) -> ${want[3]} (${want[4]},${want[5]})`);
  }
  // ...and nothing extra, so a stray hand-made row shows up here rather than in
  // a player's village.
  assert.strictEqual(actual.length, EXPECTED.length,
    `expected exactly ${EXPECTED.length} home-region portal rows, found ${actual.length}:\n`
      + actual.map(key).join('\n'));
});

test('a portal pad never lands on its own village gate column', async (t) => {
  if (!dbReady(t, 'portal pad placement')) return;
  // villageGatePoint puts an S gate at minCol + floor(width/2) and the generator
  // carves the road out of the gate down that column. A portal there would warp
  // a player the instant they left their own village.
  const gates = await pool.query(
    `SELECT w.name, v.min_col + (v.width / 2) AS gate_col, v.min_row, v.height, v.gate_edge
       FROM villages v JOIN worlds w ON w.id = v.world_id
      WHERE w.name IN ('Old Trailhead','Thornbriar Reach','Windwatch Pass')`);
  const rows = await homeRegionPortals();
  for (const g of gates.rows) {
    assert.strictEqual(g.gate_edge, 'S', `${g.name}: this assertion assumes an S gate`);
    for (const p of rows.filter((r) => r.from_name === g.name)) {
      const col = Math.floor(Number(p.from_x) / 100);
      assert.notStrictEqual(col, Number(g.gate_col),
        `${g.name}: portal at column ${col} sits on the gate road out of the village`);
    }
  }
});

test('every home-region portal source tile is walkable', async (t) => {
  if (!dbReady(t, 'portal tile walkability')) return;
  // A portal on an unwalkable tile is unreachable, which is the same outcome as
  // not shipping it -- and would look identical to a working feature in every
  // row-counting test above.
  const { buildWorldGenConfig } = require('../src/services/worldGenConfig.js');
  const { loadTileTypes } = require('../src/services/tileTypes.js');
  const { loadBiomes } = require('../src/services/biomes.js');
  const { generateRegion } = require('../src/services/mapService.js');
  const { fetchVillages } = require('../src/services/villages.js');

  const tileTypes = await loadTileTypes(pool);
  const rows = await homeRegionPortals();
  const byWorld = new Map();
  for (const r of rows) {
    if (!byWorld.has(r.from_name)) byWorld.set(r.from_name, []);
    byWorld.get(r.from_name).push(r);
  }

  for (const [name, portals] of byWorld) {
    const w = (await pool.query('SELECT * FROM worlds WHERE name = $1', [name])).rows[0];
    const villages = await fetchVillages(pool, w.id);
    let biomes = [];
    try { biomes = await loadBiomes(pool, w.biomes); } catch { biomes = []; }
    const doorways = (await pool.query(
      "SELECT edge FROM map_links WHERE from_world_id = $1 AND edge <> 'PORTAL'", [w.id]))
      .rows.map((r) => r.edge);
    const world = buildWorldGenConfig({ row: w, tileTypes, doorways, villages, biomes });

    for (const p of portals) {
      const row = Math.floor(Number(p.from_y) / 100);
      const col = Math.floor(Number(p.from_x) / 100);
      const tile = generateRegion(world, row, col, 1, 1)[0][0];
      assert.ok(tileTypes[tile] && tileTypes[tile].walkable,
        `${name}: portal at (${col},${row}) is on '${tile}', which is not walkable`);
    }
  }
});

test('every home-region portal tile is reachable from a doorway', async (t) => {
  if (!dbReady(t, 'portal navigability')) return;
  // Walkable is not the same as reachable: a walkable tile sealed behind a ring
  // of cave_wall passes the check above and is still a portal no player can ever
  // stand on. assertNavigable is the same function seed-map runs at apply time,
  // fed the same requiredTiles shape it builds -- every portal SOURCE tile in a
  // world and every ARRIVAL tile landing in it.
  const { assertNavigable } = require('../src/services/navigability.js');
  const { buildWorldGenConfig } = require('../src/services/worldGenConfig.js');
  const { loadTileTypes } = require('../src/services/tileTypes.js');
  const { loadBiomes } = require('../src/services/biomes.js');
  const { fetchVillages } = require('../src/services/villages.js');

  const tileTypes = await loadTileTypes(pool);
  const names = ['Old Trailhead', 'Windwatch Pass', 'Thornbriar Reach', 'The Catacombs: Entry'];

  for (const name of names) {
    const w = (await pool.query('SELECT * FROM worlds WHERE name = $1', [name])).rows[0];
    assert.ok(w, `${name} is missing from this database`);
    const villages = await fetchVillages(pool, w.id);
    let biomes = [];
    try { biomes = await loadBiomes(pool, w.biomes); } catch { biomes = []; }
    const doorways = (await pool.query(
      "SELECT edge FROM map_links WHERE from_world_id = $1 AND edge <> 'PORTAL'", [w.id]))
      .rows.map((r) => r.edge);
    const world = buildWorldGenConfig({ row: w, tileTypes, doorways, villages, biomes });

    const required = [];
    for (const r of (await pool.query(
      "SELECT from_x, from_y FROM map_links WHERE from_world_id = $1 AND edge = 'PORTAL'", [w.id])).rows) {
      required.push({ row: Math.floor(r.from_y / 100), col: Math.floor(r.from_x / 100), what: 'portal source' });
    }
    for (const r of (await pool.query(
      "SELECT to_x, to_y FROM map_links WHERE to_world_id = $1 AND edge = 'PORTAL'", [w.id])).rows) {
      required.push({ row: Math.floor(r.to_y / 100), col: Math.floor(r.to_x / 100), what: 'portal arrival' });
    }
    assert.ok(required.length > 0, `${name} should have portal tiles to check`);
    assert.deepStrictEqual(assertNavigable(world, required), [],
      `${name}: a portal tile is unreachable`);
  }
});

test('no home-region portal is flagged is_waypoint while a creature guards it', async (t) => {
  if (!dbReady(t, 'the guarded-portal rule')) return;
  // The load-bearing rule from the home-region spec (SOMET-292): making a
  // guarded portal a waypoint drops a traveller straight past the guard. None
  // of the eight is guarded today, so this is a standing guard against whoever
  // adds one later rather than a check on what shipped.
  const r = await pool.query(
    `SELECT f.name, ml.from_x, ml.from_y
       FROM map_links ml
       JOIN worlds f ON f.id = ml.from_world_id
      WHERE ml.edge = 'PORTAL' AND ml.is_waypoint = true
        AND EXISTS (SELECT 1 FROM world_creatures wc WHERE wc.blocks_portal_id = ml.id)`);
  assert.deepStrictEqual(r.rows, [],
    'a guarded portal is flagged as a waypoint -- that bypasses the guard entirely');
});
