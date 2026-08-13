const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { validateMapSpec } = require('../seeds/mapSpec.js');

// ---------------------------------------------------------------------------
// At most ONE travel landmark per world (SOMET-300).
//
// TWO enforcement points, deliberately, because they catch different mistakes:
//
//   - The map-spec validator catches an AUTHORING error at seed time, with a
//     message naming the world. That is the mistake a person actually makes.
//   - The unique index catches everything else -- a hand-written INSERT, a
//     migration, a future service that upserts. A validator alone is a rule
//     that only applies to people who use the front door.
//
// Every validator case asserts the SPECIFIC error text, not `errors.length > 0`,
// for the reason map_spec_waypoints.test.js gives: a count-only assertion passes
// when the spec is rejected for an entirely unrelated reason, which in a
// hand-built fixture is the likely outcome of a typo.
// ---------------------------------------------------------------------------

function baseSpec(over = {}) {
  return {
    name: 'one-portal-test',
    worlds: [
      {
        key: 'surface', name: 'OP Surface', seed: '1', grid: [0, 0],
        width: 40, height: 40, is_entry: true, ...over,
      },
    ],
    links: [],
  };
}

test('a world declaring two portals is rejected, and the message names it', () => {
  // validateMapSpec returns the error ARRAY itself, not { errors }.
  const errors = validateMapSpec(baseSpec({
    waypoints: [
      { x: 1050, y: 1050, name: 'OP One' },
      { x: 2050, y: 2050, name: 'OP Two' },
    ],
  }));
  const hit = errors.find((e) => /surface/.test(e) && /one/i.test(e));
  assert.ok(hit, `expected a one-per-world error naming "surface", got:\n${errors.join('\n')}`);
});

test('a world declaring exactly one portal still validates', () => {
  // The guard against writing a rule that rejects everything -- a validator that
  // refused one portal as well as two would pass the test above for the wrong
  // reason and break every shipped spec.
  const errors = validateMapSpec(baseSpec({
    waypoints: [{ x: 1050, y: 1050, name: 'OP Only' }],
  }));
  assert.deepStrictEqual(errors, []);
});

test('one standalone portal plus one flagged staircase in the same world is rejected', () => {
  // THE CASE THE FIRST VERSION OF THIS RULE MISSED. A world gets a landmark from
  // two authoring routes -- the standalone `waypoints` array and an
  // `is_waypoint: true` portal departing from it -- and counting only the array
  // let a spec declare one of each. That is two landmarks on one map: exactly
  // what the ticket removes, waved through by the validator and caught only by
  // waypoints_world_unique at seed time with a raw constraint error.
  const errors = validateMapSpec({
    name: 'one-portal-both-routes',
    worlds: [
      {
        key: 'surface', name: 'OP Surface', seed: '1', grid: [0, 0],
        width: 40, height: 40, is_entry: true,
        waypoints: [{ x: 1050, y: 1050, name: 'OP Stone' }],
      },
      {
        key: 'deep', name: 'OP Deep', seed: '2', width: 20, height: 20, is_entry: false,
      },
    ],
    links: [{
      kind: 'portal', from: 'surface', to: 'deep',
      from_x: 2050, from_y: 2050, to_x: 550, to_y: 550,
      is_waypoint: true, waypoint_name: 'OP Stair',
    }],
  });
  const hit = errors.find((e) => /surface/.test(e) && /at most\s+one/i.test(e));
  assert.ok(hit, `expected a one-per-world error naming "surface", got:\n${errors.join('\n')}`);
});

test('a world declaring no portals still validates', () => {
  // 86 of ~90 live worlds have none.
  const errors = validateMapSpec(baseSpec());
  assert.deepStrictEqual(errors, []);
});

// --- the database half -------------------------------------------------------

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

const TAG = `opw-${process.pid}-${Date.now()}`;

test('the database refuses a second portal in the same world', async (t) => {
  if (!dbReady(t, 'the one-portal-per-world index')) return;
  const created = [];
  try {
    const w = await pool.query(
      `INSERT INTO worlds (name, seed, graph_x, graph_y, level_min, level_max)
       VALUES ($1, 1, 900, 900, 1, 1) RETURNING id`, [`${TAG}-world`]);
    created.push(w.rows[0].id);

    await pool.query('INSERT INTO waypoints (world_id, x, y, name) VALUES ($1, 1050, 1050, $2)',
      [w.rows[0].id, `${TAG}-first`]);

    // A DIFFERENT tile, so this is refused by the one-per-WORLD rule and not by
    // the pre-existing one-per-TILE index (waypoints_world_tile_unique). Without
    // a distinct tile this test would pass on the old constraint and prove
    // nothing about the new one.
    await assert.rejects(
      () => pool.query('INSERT INTO waypoints (world_id, x, y, name) VALUES ($1, 2050, 2050, $2)',
        [w.rows[0].id, `${TAG}-second`]),
      (err) => /waypoints_world_unique/.test(err.message) || err.code === '23505',
      'a second portal in the same world must be refused by the database',
    );
  } finally {
    for (const id of created) await pool.query('DELETE FROM worlds WHERE id = $1', [id]).catch(() => {});
  }
});

test('every live world satisfies the ceiling', async (t) => {
  if (!dbReady(t, 'the live one-portal-per-world state')) return;
  // Proves the constraint is satisfiable by SHIPPED data, not merely by an empty
  // table -- the index would have refused to build otherwise, but this states
  // the property in a form a reader can check.
  const r = await pool.query(
    `SELECT w.name, count(*)::int AS n FROM waypoints wp
       JOIN worlds w ON w.id = wp.world_id
      GROUP BY w.name HAVING count(*) > 1`);
  assert.deepStrictEqual(r.rows, [], 'a live world holds more than one portal');
});
