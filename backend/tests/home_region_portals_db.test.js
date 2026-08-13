const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

// ---------------------------------------------------------------------------
// ONE travel landmark per home-region map (SOMET-300), asserted against LIVE
// rows.
//
// This file used to assert the OPPOSITE: that eight walk-through portal rows
// existed across the three home worlds (SOMET-299). Testing those in a browser
// showed the real problem -- the game had grown two mechanics for one idea. The
// waypoint network already required standing on a landmark, already hid
// undiscovered ones and already authorised every trip server-side; the portal
// pad beside it was a second, competing answer. SOMET-300 deletes the pad and
// keeps the network.
//
// So the assertions invert: NO portal row may touch a home-region world, and
// each of the three must hold exactly one waypoint. Kept as one file rather
// than deleted, because "the pad is gone" is a property worth holding forever
// -- a future map spec or migration could quietly put it back.
//
// Why live rows and not a fixture: the same reason as before. A fixture proves
// a statement is well-formed and says nothing about what the shipped database
// contains, which is the only question that matters here.
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

const HOME_WORLDS = ['Old Trailhead', 'Thornbriar Reach', 'Windwatch Pass'];

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

test('no walk-through portal touches a home-region world', async (t) => {
  if (!dbReady(t, 'the home-region portal removal')) return;
  const rows = await homeRegionPortals();
  assert.deepStrictEqual(
    rows.map((r) => `${r.from_name} (${r.from_x},${r.from_y}) -> ${r.to_name}`),
    [],
    'a home-region map still has a walk-through portal -- SOMET-300 made the '
      + 'waypoint network the only travel mechanic, so a pad here is the second '
      + 'mechanic coming back',
  );
});

test('each home-region world holds exactly one travel landmark', async (t) => {
  if (!dbReady(t, 'one portal per home-region map')) return;
  // The ceiling is enforced by waypoints_world_unique (SOMET-300); this asserts
  // the shipped data actually sits at one rather than zero, so "one per map"
  // cannot be satisfied by having none at all.
  const r = await pool.query(
    `SELECT w.name, count(wp.id)::int AS n
       FROM worlds w LEFT JOIN waypoints wp ON wp.world_id = w.id
      WHERE w.name = ANY($1::text[])
      GROUP BY w.name ORDER BY w.name`,
    [HOME_WORLDS]);
  assert.deepStrictEqual(
    r.rows.map((x) => [x.name, x.n]),
    [['Old Trailhead', 1], ['Thornbriar Reach', 1], ['Windwatch Pass', 1]],
  );
});

// The walkability and navigability tests that used to sit here are DELETED, not
// skipped. Both iterated the home-region portal rows; with those rows gone the
// first would have looped zero times and passed while asserting nothing, and the
// second would have failed on its own "there must be tiles to check" guard. A
// test whose subject no longer exists is not a test. The properties they held --
// a portal tile must be walkable and reachable -- still apply to whoever authors
// the next one, and belong with that work rather than as an empty loop here.

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
