const { test, before, after } = require('node:test');
const assert = require('node:assert');

require('./helpers/auth.js');
const request = require('supertest');
const { Pool } = require('pg');

const { app, __setPool } = require('../src/index.js');
const { signToken } = require('../src/auth/tokens.js');
const { setLink, setPortalLink } = require('../src/services/mapLinks.js');

// ---------------------------------------------------------------------------
// Landmark counts on GET /api/player/world-map (SOMET-298).
//
// The World Map badges worlds that hold a waypoint or a portal. The POSITIVE
// property (a visited world reports its counts) is the feature; the NEGATIVE
// one is the property worth a test file. `unvisited` neighbours are deliberately
// reduced to { id, from, edge } by SOMET-263 precisely so the fog cannot leak a
// name -- and "that unexplored place is a travel hub" is the same shape of leak,
// which is why the route's own comment already refuses to emit
// allows_fast_travel for them. A landmark count is a strictly stronger hint,
// so it must never reach an unvisited stub either.
//
// Asserted against the SERIALISED body, not a named field: a count leaking
// through some other key is exactly what a field-shaped assertion would miss.
//
// Harness copied from player_world_map_routes.test.js.
// ---------------------------------------------------------------------------

const DB_URL = process.env.TEST_DATABASE_URL || 'postgres://user:password@localhost:15432/game_db';

function requireTestDb(t, why) {
  if (!process.env.TEST_DATABASE_URL) {
    const msg = `TEST_DATABASE_URL not set -- skipping to avoid mutating a real database (${why})`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return false;
  }
  return true;
}

let dbPool = null;

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  const p = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 2000, max: 4 });
  try {
    await p.query('SELECT 1');
    dbPool = p;
    __setPool(p);
  } catch {
    await p.end().catch(() => {});
  }
});

after(async () => {
  if (dbPool) await dbPool.end().catch(() => {});
});

function dbReady(t, what) {
  if (!requireTestDb(t, what)) return false;
  if (!dbPool) {
    const m = `NO DATABASE at ${DB_URL} -- ${what} is UNVERIFIED on this run`;
    if (process.env.CI) assert.fail(m);
    t.skip(m);
    return false;
  }
  return true;
}

const TAG = `wml-${process.pid}-${Date.now()}`;
let seq = 0;
const uniq = (what) => `${TAG}-${what}-${seq++}`;

async function createTestUser(pool) {
  const r = await pool.query(
    "INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'player') RETURNING id",
    [uniq('user')]);
  return r.rows[0].id;
}

async function createTestCharacter(pool, userId, slot = 1) {
  const r = await pool.query(
    `INSERT INTO characters (user_id, slot, name, entity_type_id)
     SELECT $1, $2, $3, e.id FROM entity_types e WHERE e.name = 'Warrior' RETURNING id`,
    [userId, slot, uniq('char')]);
  assert.ok(r.rows.length, 'fixture setup failed: no Warrior class in entity_types');
  return r.rows[0].id;
}

async function createTestWorld(pool, created, { name, x, y }) {
  const r = await pool.query(
    `INSERT INTO worlds (name, seed, graph_x, graph_y, level_min, level_max)
     VALUES ($1, 1, $2, $3, 1, 3) RETURNING id`,
    [name, x, y]);
  created.push(r.rows[0].id);
  return r.rows[0].id;
}

// signToken speaks camelCase (userId / tokenVersion), not the row's own column
// names -- a token built from { id, token_version } signs cleanly and then 401s.
function authed(userId) {
  return {
    Authorization: `Bearer ${signToken({
      userId, username: `wml-${userId}`, role: 'player', tokenVersion: 1,
    })}`,
  };
}

async function cleanup(pool, { users = [], worlds = [] }) {
  for (const id of users) await pool.query('DELETE FROM users WHERE id = $1', [id]).catch(() => {});
  // waypoints, map_links and character_visited_worlds all cascade off worlds.
  for (const id of worlds) await pool.query('DELETE FROM worlds WHERE id = $1', [id]).catch(() => {});
}

test('a visited world reports the landmarks it holds; an unvisited one reports nothing', async (t) => {
  if (!dbReady(t, 'world-map landmark counts')) return;
  const created = [];
  let userId = null;
  try {
    userId = await createTestUser(dbPool);
    const characterId = await createTestCharacter(dbPool, userId);

    const home = await createTestWorld(dbPool, created, { name: uniq('home'), x: 0, y: 0 });
    const beyond = await createTestWorld(dbPool, created, { name: uniq('beyond'), x: 1, y: 0 });

    // home -> beyond by compass, so `beyond` appears as an unvisited STUB.
    await setLink(dbPool, home, 'E', beyond);

    // One waypoint and one portal in the visited world. setPortalLink writes
    // the MIRROR as well, so this single call also puts a portal in the
    // UNVISITED world -- which is exactly the row the fog assertion below needs,
    // and the reason a second call would be wrong: it would mirror straight back
    // and give `home` two portals.
    await dbPool.query(
      'INSERT INTO waypoints (world_id, x, y, name) VALUES ($1, $2, $3, $4)',
      [home, 1050, 1050, uniq('wp')]);
    await setPortalLink(dbPool, home, 2050, 2050, beyond, 500, 500);

    await dbPool.query(
      'INSERT INTO character_visited_worlds (character_id, world_id) VALUES ($1, $2)',
      [characterId, home]);

    const res = await request(app)
      .get(`/api/player/world-map?character_id=${characterId}`)
      .set(authed(userId));
    assert.strictEqual(res.status, 200);

    const visitedRow = res.body.worlds.find((w) => w.id === home);
    assert.ok(visitedRow, 'the visited world must be in the payload');
    assert.strictEqual(Number(visitedRow.waypointCount), 1);
    // setPortalLink writes the mirror too, so `home` owns exactly the one
    // outgoing portal row created for it here.
    assert.strictEqual(Number(visitedRow.portalCount), 1);

    // The stub carries id/from/edge and nothing else.
    const stub = res.body.unvisited.find((u) => u.id === beyond);
    assert.ok(stub, 'the unvisited neighbour must still appear as a stub');
    assert.deepStrictEqual(Object.keys(stub).sort(), ['edge', 'from', 'id']);

    // And the unvisited world is not in `worlds` at all, so no count for it can
    // have travelled by any route.
    assert.strictEqual(res.body.worlds.some((w) => w.id === beyond), false);
  } finally {
    await cleanup(dbPool, { users: userId ? [userId] : [], worlds: created });
  }
});

test('a visited world with no landmarks reports zero, not a missing field', async (t) => {
  if (!dbReady(t, 'world-map zero landmark counts')) return;
  // A missing key and a zero are different to the client: `undefined > 0` is
  // false, so a dropped field would silently badge nothing and look like
  // "this world has no landmarks" forever.
  const created = [];
  let userId = null;
  try {
    userId = await createTestUser(dbPool);
    const characterId = await createTestCharacter(dbPool, userId);
    const bare = await createTestWorld(dbPool, created, { name: uniq('bare'), x: 5, y: 5 });
    await dbPool.query(
      'INSERT INTO character_visited_worlds (character_id, world_id) VALUES ($1, $2)',
      [characterId, bare]);

    const res = await request(app)
      .get(`/api/player/world-map?character_id=${characterId}`)
      .set(authed(userId));
    assert.strictEqual(res.status, 200);

    const row = res.body.worlds.find((w) => w.id === bare);
    assert.ok(Object.prototype.hasOwnProperty.call(row, 'waypointCount'), 'waypointCount must be present');
    assert.ok(Object.prototype.hasOwnProperty.call(row, 'portalCount'), 'portalCount must be present');
    assert.strictEqual(Number(row.waypointCount), 0);
    assert.strictEqual(Number(row.portalCount), 0);
  } finally {
    await cleanup(dbPool, { users: userId ? [userId] : [], worlds: created });
  }
});
