// The home region's waypoint rows, against the live database (SOMET-293).
//
// WHY THIS FILE EXISTS. Slice E shipped the waypoint mechanism and slice B
// authored the villages; neither authored a waypoint, so the live table was
// empty and travel had nothing to travel between. Slice F authors three -- one
// per home-region village -- in the checked-in specs, and moves the live rows by
// migration because `seed-map` cannot be run from this branch (it converges a
// whole spec, and this branch does not carry slice B's villages, so a run would
// prune them).
//
// A migration and a spec that are only "kept in step" by whoever edits them next
// drift. Both halves are therefore asserted against each other here, and in BOTH
// directions: every authored waypoint exists, and nothing else exists in the
// worlds these two specs own. A one-directional check passes with a stale row
// sitting in the table, which is precisely the state the runtime would honour --
// the authority reads this table, not the spec.
//
// The placement rule is asserted too, computed from the LIVE village rows with
// the real geometry helpers rather than restated as literals. "The interior tile
// immediately east of the spawn, between the spawn and the merchant" is the rule
// the coordinates came from; written out as three pairs of numbers it stops
// being checkable, and it silently stops being true the day slice B moves a
// village.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { villageGatePosts, villageMerchantPost } = require('../src/services/mapService');

const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

// The spec that owns the home region. It used to be TWO specs -- Thornbriar
// Reach in hub-vale, the other two in spine-descent -- which is why the
// migration resolves worlds by NAME rather than by spec: the region is a
// gameplay region, not a map file. SOMET-355 merged those specs (and
// loop-catacombs) into `vale-region`, so the region now sits in one file; the
// name-keyed resolution below is unchanged and still the right one.
const SPEC_NAMES = ['vale-region'];
const MAPS_DIR = path.join(__dirname, '..', 'seeds', 'maps');

const TILE = 100;
const tileOf = (x, y) => `${Math.floor(y / TILE)},${Math.floor(x / TILE)}`;

// Everything the checked-in specs say, keyed by world NAME -- the join key the
// migration uses, so the test resolves rows the same way the writer did.
function authoredWaypoints() {
  const byWorld = new Map();   // world name -> [{ x, y, name }]
  const worldNames = [];       // every world these specs own, waypoint or not
  for (const specName of SPEC_NAMES) {
    const spec = JSON.parse(fs.readFileSync(path.join(MAPS_DIR, `${specName}.map.json`), 'utf8'));
    for (const w of spec.worlds) {
      worldNames.push(w.name);
      if (Array.isArray(w.waypoints) && w.waypoints.length) byWorld.set(w.name, w.waypoints);
    }
  }
  return { byWorld, worldNames };
}

test('home region waypoints', { skip: !url ? 'no database URL' : false }, async (t) => {
  const pool = new Pool({ connectionString: url });
  t.after(() => pool.end());

  const { byWorld, worldNames } = authoredWaypoints();

  // Guards the test itself. Every assertion below is vacuously true against an
  // empty spec, and an empty spec is exactly what this slice started from -- so
  // a merge that drops the `waypoints` blocks must fail here rather than pass
  // three green checks over nothing.
  await t.test('the specs actually author waypoints', () => {
    assert.ok(byWorld.size >= 3,
      `expected the home region's three villages to carry a waypoint, found ${byWorld.size} worlds with one`);
  });

  await t.test('the live rows are exactly what the specs author', async () => {
    const r = await pool.query(
      `SELECT w.name AS world, wp.name, wp.x, wp.y
         FROM waypoints wp JOIN worlds w ON w.id = wp.world_id
        WHERE w.name = ANY($1::text[])`,
      [worldNames],
    );

    // Compared as (world, name, TILE) triples, not raw pixels: the tile is the
    // unit the tick loop keys on (waypointTileKey), so two rows agreeing to the
    // pixel is a stronger claim than the runtime actually makes, and two
    // disagreeing within one tile is not a defect the player could ever see.
    const live = new Set(r.rows.map((row) => `${row.world}|${row.name}|${tileOf(Number(row.x), Number(row.y))}`));
    const authored = new Set();
    for (const [world, wps] of byWorld) {
      for (const wp of wps) authored.add(`${world}|${wp.name}|${tileOf(wp.x, wp.y)}`);
    }

    const missing = [...authored].filter((k) => !live.has(k));
    // The direction that catches a stale row: a waypoint the specs no longer
    // author but the database still serves is a place the runtime will happily
    // let a player travel to.
    const extra = [...live].filter((k) => !authored.has(k));
    assert.deepEqual(missing, [], 'waypoints authored in a spec but missing from the database');
    assert.deepEqual(extra, [], 'waypoints in the database that no spec authors');
  });

  await t.test('each waypoint sits on a free interior tile of its village', async () => {
    const r = await pool.query(
      `SELECT w.name AS world, wp.name, wp.x, wp.y,
              v.min_row, v.min_col, v.width, v.height, v.gate_edge,
              v.spawn_x, v.spawn_y
         FROM waypoints wp
         JOIN worlds w ON w.id = wp.world_id
         LEFT JOIN villages v ON v.world_id = wp.world_id
        WHERE w.name = ANY($1::text[])`,
      [worldNames],
    );
    assert.ok(r.rows.length >= 3, 'expected at least the three home-region waypoints');

    for (const row of r.rows) {
      const where = `waypoint "${row.name}" in ${row.world}`;
      assert.ok(row.min_row != null, `${where}: no village row to place it in`);

      const v = {
        minRow: row.min_row, minCol: row.min_col,
        width: row.width, height: row.height, gateEdge: row.gate_edge,
      };
      const wpRow = Math.floor(Number(row.y) / TILE), wpCol = Math.floor(Number(row.x) / TILE);

      // Interior = the box minus its wall ring. A waypoint on the ring is a tile
      // stampVillage paints as wall, so it could never be walked onto -- the
      // same dead-row failure the spec validator's out-of-bounds rule prevents,
      // spelled differently.
      assert.ok(wpRow > v.minRow && wpRow < v.minRow + v.height - 1
             && wpCol > v.minCol && wpCol < v.minCol + v.width - 1,
        `${where} at tile (${wpRow},${wpCol}) is not inside the village interior `
        + `(rows ${v.minRow + 1}..${v.minRow + v.height - 2}, cols ${v.minCol + 1}..${v.minCol + v.width - 2})`);

      // The occupied posts, from the SAME helpers createVillage placed them
      // with. Re-deriving them here as literals would let this test agree with a
      // stale comment instead of with the village.
      const occupied = new Map([
        [tileOf(Number(row.spawn_x), Number(row.spawn_y)), 'the village spawn'],
        [tileOf(villageMerchantPost(v).x, villageMerchantPost(v).y), 'the merchant post'],
        ...villageGatePosts(v).map((p) => [tileOf(p.x, p.y), 'a gate-guard post']),
      ]);
      const clash = occupied.get(`${wpRow},${wpCol}`);
      assert.equal(clash, undefined,
        `${where} stands on ${clash} -- a waypoint has to be a tile a player can occupy`);
    }
  });
});
