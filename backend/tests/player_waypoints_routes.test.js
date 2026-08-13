const { test, before, after } = require('node:test');
const assert = require('node:assert');

// Set the secret before requiring the app / signing any token.
require('./helpers/auth.js');
const request = require('supertest');
const { Pool } = require('pg');

const { app, __setPool } = require('../src/index.js');
const { signToken } = require('../src/auth/tokens.js');
const { upsertWaypoint, activateWaypoint } = require('../src/services/waypoints.js');

// ---------------------------------------------------------------------------
// GET /api/player/waypoints -- the read API slice F consumes (SOMET-292).
//
// Two properties, one positive and one negative, and the negative is the one
// that needs guarding: a waypoint in a world this character has never entered
// must not reach the client, because slice F turns this list into travel
// targets. Asserted against the SERIALISED body rather than a named field --
// a name leaking through some other key is exactly what a field-shaped
// assertion misses.
//
// Harness copied from player_world_map_routes.test.js: a route-protection walk
// with no database, then functional tests gated on TEST_DATABASE_URL alone (no
// DATABASE_URL fallback, so a bare `npm test` cannot reach the half that writes
// rows).
// ---------------------------------------------------------------------------

test('the route is behind a player auth guard', () => {
  const stack = app._router && app._router.stack;
  assert.ok(stack, 'could not locate the app router stack');
  const layer = stack.find((l) => l.route && l.route.path === '/api/player/waypoints');
  assert.ok(layer, 'GET /api/player/waypoints is not registered');
  assert.ok(
    layer.route.stack.some((h) => h.handle && h.handle.isAuthGuard),
    'the waypoint list must not be reachable without a token',
  );
  // adminGuard here would 403 every real player -- this route exists for them.
  assert.ok(
    !layer.route.stack.some((h) => h.handle && h.handle.isAdminGuard),
    'the waypoint list must not require an admin role',
  );
});

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

const TAG = `pwp-${process.pid}-${Date.now()}`;
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

// Every world created here is tracked and deleted in the caller's finally;
// waypoints and character_waypoints cascade off it.
async function createTestWorld(pool, created, name) {
  const r = await pool.query(
    `INSERT INTO worlds (name, seed, chunk_size, width, height, level_min, level_max)
     VALUES ($1, '1', 8, 40, 40, 1, 3) RETURNING id`, [name]);
  created.push(r.rows[0].id);
  return r.rows[0].id;
}

// The REAL writer seed-map uses, not a hand-rolled INSERT: a fixture shaped by
// hand is a fixture shaped to make the endpoint pass.
async function addWaypoint(pool, worldId, x, y, name) {
  const client = await pool.connect();
  try { return await upsertWaypoint(client, { worldId, x, y, name }); }
  finally { client.release(); }
}

async function cleanup(pool, { users = [], worlds = [] }) {
  for (const id of users) await pool.query('DELETE FROM users WHERE id = $1', [id]).catch(() => {});
  for (const id of worlds) await pool.query('DELETE FROM worlds WHERE id = $1', [id]).catch(() => {});
}

function authed(userId) {
  return {
    Authorization: `Bearer ${signToken({
      userId, username: `pwp-${userId}`, role: 'player', tokenVersion: 1,
    })}`,
  };
}

test('unauthenticated requests are refused', async (t) => {
  if (!dbReady(t, 'the 401 path')) return;
  const res = await request(app).get('/api/player/waypoints').query({ character_id: 1 });
  assert.equal(res.status, 401);
});

test('a missing character_id is a 400', async (t) => {
  if (!dbReady(t, 'the missing-parameter path')) return;
  const users = [];
  try {
    const user = await createTestUser(dbPool);
    users.push(user);
    const res = await request(app).get('/api/player/waypoints').set(authed(user));
    assert.equal(res.status, 400);
  } finally {
    await cleanup(dbPool, { users });
  }
});

test('another account\'s character is refused, and the refusal leaks nothing', async (t) => {
  if (!dbReady(t, 'the cross-account 403')) return;
  const users = []; const worlds = [];
  try {
    const victim = await createTestUser(dbPool);
    const attacker = await createTestUser(dbPool);
    users.push(victim, attacker);
    const victimChar = await createTestCharacter(dbPool, victim);
    const w = await createTestWorld(dbPool, worlds, uniq('world'));
    const wp = await addWaypoint(dbPool, w, 250, 250, uniq('waypoint'));
    await dbPool.query(
      'INSERT INTO character_visited_worlds (character_id, world_id) VALUES ($1, $2)', [victimChar, w]);
    await activateWaypoint(dbPool, victimChar, wp.id);

    const res = await request(app).get('/api/player/waypoints')
      .query({ character_id: victimChar }).set(authed(attacker));

    // 403 and not 404: a 404 would make this an oracle for real character ids.
    assert.equal(res.status, 403);
    assert.doesNotMatch(JSON.stringify(res.body), new RegExp(TAG),
      'a refused request must not return any part of the other character\'s network');
  } finally {
    await cleanup(dbPool, { users, worlds });
  }
});

test('the list carries activated and known-but-unactivated waypoints, and withholds the rest',
  async (t) => {
    if (!dbReady(t, 'the payload shape slice F consumes')) return;
    const users = []; const worlds = [];
    try {
      const user = await createTestUser(dbPool);
      users.push(user);
      const character = await createTestCharacter(dbPool, user);

      const home = await createTestWorld(dbPool, worlds, uniq('home'));
      const unseen = await createTestWorld(dbPool, worlds, uniq('unseen'));
      const litName = uniq('lit');
      const darkName = uniq('dark');
      const hiddenName = uniq('hidden');
      const lit = await addWaypoint(dbPool, home, 250, 250, litName);
      await addWaypoint(dbPool, home, 950, 950, darkName);
      await addWaypoint(dbPool, unseen, 250, 250, hiddenName);
      await dbPool.query(
        'INSERT INTO character_visited_worlds (character_id, world_id) VALUES ($1, $2)',
        [character, home]);
      await activateWaypoint(dbPool, character, lit.id);

      const res = await request(app).get('/api/player/waypoints')
        .query({ character_id: character }).set(authed(user));
      assert.equal(res.status, 200);

      const byName = new Map(res.body.waypoints.map((w) => [w.name, w]));
      // Both halves. Slice F draws them differently and cannot build the popup
      // at all if only the activated ones arrive.
      assert.ok(byName.has(litName), 'the activated waypoint is missing');
      assert.ok(byName.has(darkName), 'the known-but-unactivated waypoint is missing');
      assert.equal(byName.get(litName).activated, true);
      assert.equal(byName.get(darkName).activated, false);

      // Every field the popup needs, asserted by value so a rename here shows up
      // as a failure in slice E rather than as an empty popup in slice F.
      const l = byName.get(litName);
      assert.equal(l.id, lit.id);
      assert.equal(l.worldId, home);
      assert.equal(l.x, 250);
      assert.equal(l.y, 250);
      assert.equal(l.mapLinkId, null);
      assert.ok(l.activatedAt, 'an activated waypoint must carry when it was lit');

      // The negative property, asserted against the serialised body: a waypoint
      // in a world this character has never entered must not reach the client
      // through ANY key, because slice F turns this list into travel targets.
      assert.doesNotMatch(JSON.stringify(res.body), new RegExp(hiddenName),
        'a waypoint in an unvisited world must be withheld by the query, not by the client');
    } finally {
      await cleanup(dbPool, { users, worlds });
    }
  });

test('a character that has been nowhere gets an empty list, not an error', async (t) => {
  if (!dbReady(t, 'the fresh-character path')) return;
  const users = [];
  try {
    const user = await createTestUser(dbPool);
    users.push(user);
    const character = await createTestCharacter(dbPool, user);
    const res = await request(app).get('/api/player/waypoints')
      .query({ character_id: character }).set(authed(user));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.waypoints, []);
  } finally {
    await cleanup(dbPool, { users });
  }
});

test('a non-numeric character_id is refused rather than crashing', async (t) => {
  if (!dbReady(t, 'the malformed-parameter path')) return;
  const users = [];
  try {
    const user = await createTestUser(dbPool);
    users.push(user);
    for (const bad of ['abc', "1 OR 1=1", '1e999']) {
      const res = await request(app).get('/api/player/waypoints')
        .query({ character_id: bad }).set(authed(user));
      assert.equal(res.status, 403, `character_id=${bad} was not refused`);
    }
  } finally {
    await cleanup(dbPool, { users });
  }
});
