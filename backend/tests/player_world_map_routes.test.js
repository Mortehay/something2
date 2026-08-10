const { test, before, after } = require('node:test');
const assert = require('node:assert');

// Set the secret before requiring the app / signing any token.
require('./helpers/auth.js');
const request = require('supertest');
const { Pool } = require('pg');

const { app, __setPool } = require('../src/index.js');
const { signToken } = require('../src/auth/tokens.js');

// ---------------------------------------------------------------------------
// GET /api/player/world-map -- the player's fog-of-war map (SOMET-263).
//
// The property this file exists to guard is NEGATIVE: an unvisited world's
// name must not reach the client. That is not something a component can be
// trusted with -- a component-side filter still ships the name to the browser,
// where the network tab shows it -- so the withholding happens at the API and
// is asserted here, against the SERIALISED body rather than against a named
// field. A name leaking through some other field (a `label`, a stray row spread
// into the payload) is exactly the failure the field-shaped assertion would
// miss.
//
// Harness copied from progression_routes.test.js: route-protection walk with no
// database, then functional tests gated on TEST_DATABASE_URL alone -- no
// DATABASE_URL fallback, so a bare `npm test` on a machine with a working dev
// database can never reach the second half and mutate it.
// ---------------------------------------------------------------------------

test('the route is behind an auth guard', () => {
  const stack = app._router && app._router.stack;
  assert.ok(stack, 'could not locate the app router stack');
  const layer = stack.find((l) => l.route && l.route.path === '/api/player/world-map');
  assert.ok(layer, 'GET /api/player/world-map is not registered');
  assert.ok(
    layer.route.stack.some((h) => h.handle && h.handle.isAuthGuard),
    'the player world map must not be reachable without a token',
  );
  // And specifically NOT the admin guard -- this route exists precisely so a
  // player can read a map, and an adminGuard here would 403 every real user.
  assert.ok(
    !layer.route.stack.some((h) => h.handle && h.handle.isAdminGuard),
    'the player world map must not require an admin role',
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
  } catch (err) {
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

const TAG = `pwm-${process.pid}-${Date.now()}`;
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

// Worlds are the fixture that MUST be cleaned up: unlike users they are shared
// content, and a leftover throwaway world shows up in the admin map. Every
// world created here is tracked and deleted in the finally below; map_links and
// character_visited_worlds cascade off it.
async function createTestWorld(pool, created, { name, x, y, fastTravel = false }) {
  const r = await pool.query(
    `INSERT INTO worlds (name, seed, graph_x, graph_y, level_min, level_max, allows_fast_travel)
     VALUES ($1, 1, $2, $3, 1, 3, $4) RETURNING id`,
    [name, x, y, fastTravel]);
  created.push(r.rows[0].id);
  return r.rows[0].id;
}

// Goes through the REAL setLink, not a hand-rolled one-way INSERT. Every link
// this app creates is bidirectional -- setLink writes (from,edge,to) and its
// mirror (to,opposite,from), and all 180 rows in the dev database are
// reciprocated -- so a fixture that inserted a single row would be a fixture
// shaped to make the endpoint pass. The mirror is precisely what makes
// deduplication necessary.
const { setLink } = require('../src/services/mapLinks.js');

async function link(pool, from, to, edge) {
  await setLink(pool, from, edge, to);
}

async function cleanup(pool, { users = [], worlds = [] }) {
  for (const id of users) {
    await pool.query('DELETE FROM users WHERE id = $1', [id]).catch(() => {});
  }
  for (const id of worlds) {
    await pool.query('DELETE FROM worlds WHERE id = $1', [id]).catch(() => {});
  }
}

function authed(userId) {
  return {
    Authorization: `Bearer ${signToken({
      userId, username: `pwm-${userId}`, role: 'player', tokenVersion: 1,
    })}`,
  };
}

test('unauthenticated requests are refused', async (t) => {
  if (!dbReady(t, 'the 401 path')) return;
  const res = await request(app).get('/api/player/world-map').query({ character_id: 1 });
  assert.equal(res.status, 401);
});

test('a character_id belonging to another account is refused', async (t) => {
  if (!dbReady(t, 'the cross-account 403')) return;
  const users = [];
  const worlds = [];
  try {
    const victim = await createTestUser(dbPool);
    const attacker = await createTestUser(dbPool);
    users.push(victim, attacker);
    const victimChar = await createTestCharacter(dbPool, victim);
    const w = await createTestWorld(dbPool, worlds, { name: uniq('world'), x: 0, y: 0 });
    await dbPool.query(
      'INSERT INTO character_visited_worlds (character_id, world_id) VALUES ($1, $2)',
      [victimChar, w]);

    const res = await request(app).get('/api/player/world-map')
      .query({ character_id: victimChar }).set(authed(attacker));

    assert.equal(res.status, 403);
    // Not merely "not 200": the refusal must not leak the map it refused.
    assert.doesNotMatch(JSON.stringify(res.body), new RegExp(TAG),
      'a refused request must not return any part of the other account\'s map');
  } finally {
    await cleanup(dbPool, { users, worlds });
  }
});

test('a missing character_id is a 400, not a 403', async (t) => {
  if (!dbReady(t, 'the missing-parameter path')) return;
  const users = [];
  try {
    const user = await createTestUser(dbPool);
    users.push(user);
    const res = await request(app).get('/api/player/world-map').set(authed(user));
    assert.equal(res.status, 400);
  } finally {
    await cleanup(dbPool, { users });
  }
});

test('a character that has visited nothing gets an empty map', async (t) => {
  if (!dbReady(t, 'the fresh-character path')) return;
  const users = [];
  try {
    const user = await createTestUser(dbPool);
    users.push(user);
    const character = await createTestCharacter(dbPool, user);

    const res = await request(app).get('/api/player/world-map')
      .query({ character_id: character }).set(authed(user));

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.worlds, []);
    assert.deepEqual(res.body.links, []);
    assert.deepEqual(res.body.unvisited, []);
    assert.equal(res.body.currentWorldId, null);
  } finally {
    await cleanup(dbPool, { users });
  }
});

// The main shape test. Topology:
//
//   A --E--> B --E--> C --E--> D
//   (A, B visited; C linked-but-unvisited; D two hops out)
//
// so one assertion set covers: visited worlds carry their names, a link with
// both ends visited is returned, a link with one unvisited end is NOT, the
// unvisited neighbour appears as a bare stub, and the two-hop world is absent
// entirely.
test('the map is fogged: visited worlds named, neighbours anonymous, the rest absent', async (t) => {
  if (!dbReady(t, 'the fog-of-war shape -- the whole point of this endpoint')) return;
  const users = [];
  const worlds = [];
  try {
    const user = await createTestUser(dbPool);
    users.push(user);
    const character = await createTestCharacter(dbPool, user);

    const nameA = uniq('Avisited');
    const nameB = uniq('Bvisited');
    const nameC = uniq('Cneighbour');
    const nameD = uniq('Dfaraway');
    const a = await createTestWorld(dbPool, worlds, { name: nameA, x: 0, y: 0 });
    const b = await createTestWorld(dbPool, worlds, { name: nameB, x: 1, y: 0 });
    const c = await createTestWorld(dbPool, worlds, { name: nameC, x: 2, y: 0 });
    const d = await createTestWorld(dbPool, worlds, { name: nameD, x: 3, y: 0 });
    await link(dbPool, a, b, 'E');
    await link(dbPool, b, c, 'E');
    await link(dbPool, c, d, 'E');

    for (const w of [a, b]) {
      await dbPool.query(
        'INSERT INTO character_visited_worlds (character_id, world_id) VALUES ($1, $2)',
        [character, w]);
    }
    await dbPool.query(
      'INSERT INTO world_players (world_id, character_id, x, y) VALUES ($1, $2, 10, 10)',
      [b, character]);

    const res = await request(app).get('/api/player/world-map')
      .query({ character_id: character }).set(authed(user));
    assert.equal(res.status, 200);
    const body = res.body;
    const serialised = JSON.stringify(body);

    assert.deepEqual(body.worlds.map((w) => w.id).sort(), [a, b].sort());
    assert.deepEqual(body.worlds.map((w) => w.name).sort(), [nameA, nameB].sort(),
      'a visited world must come back WITH its name');

    // ONE edge for the A<->B pair, not one per stored mirror row. setLink
    // wrote both A--E-->B and B--W-->A and both ends are visited, so the naive
    // query returns two rows and the graph would draw a doubled edge. Which
    // direction survives depends on uuid ordering, so this asserts the pair and
    // the edge's consistency with its own stated direction rather than pinning
    // a direction that random ids decide.
    assert.equal(body.links.length, 1,
      `the A<->B pair must appear once, not once per mirror row (got ${JSON.stringify(body.links)})`);
    const [l] = body.links;
    assert.deepEqual([l.from, l.to].sort(), [a, b].sort(),
      'the only link must be the one whose both ends are visited');
    assert.equal(l.edge, l.from === a ? 'E' : 'W',
      'the edge label must describe the direction the link is reported in');

    // id, the world it hangs off, and the compass edge -- the last so the map
    // can place the stub, and because "there is an exit east" is something the
    // player can already see standing in B. Asserted with deepEqual so any
    // FOURTH field added later fails here rather than quietly shipping.
    assert.deepEqual(body.unvisited, [{ id: c, from: b, edge: 'E' }],
      'the unvisited neighbour must be a bare stub: id, source and edge, nothing more');

    // The assertion this file exists for. Written against the whole serialised
    // body, so a name leaking through ANY field fails -- not just through
    // unvisited[0].name.
    assert.doesNotMatch(serialised, new RegExp(nameC),
      "an unvisited neighbour's name must not appear anywhere in the response");
    assert.doesNotMatch(serialised, new RegExp(nameD),
      'a world two hops out must not appear anywhere in the response');
    assert.ok(!serialised.includes(d), 'a world two hops out must not appear even as an id');

    assert.equal(body.currentWorldId, b);
  } finally {
    await cleanup(dbPool, { users, worlds });
  }
});

// Plan B slice 3. The flag is what makes a node clickable, so it has to reach
// the client -- but only for worlds the character has actually been to.
test('the travel flag is emitted for visited worlds and withheld from stubs', async (t) => {
  if (!dbReady(t, 'the fast-travel flag on the wire')) return;
  const users = [];
  const worlds = [];
  try {
    const user = await createTestUser(dbPool);
    users.push(user);
    const character = await createTestCharacter(dbPool, user);

    const hubName = uniq('Hub');
    const roomName = uniq('Room');
    // hub: visited AND a travel target. room: visited, NOT a target (the
    // dungeon-interior case). beyond: unvisited and flagged, which is the leak
    // this test is really about.
    const hub = await createTestWorld(dbPool, worlds, { name: hubName, x: 0, y: 0, fastTravel: true });
    const room = await createTestWorld(dbPool, worlds, { name: roomName, x: 1, y: 0, fastTravel: false });
    const beyond = await createTestWorld(dbPool, worlds, { name: uniq('Beyond'), x: 2, y: 0, fastTravel: true });
    await link(dbPool, hub, room, 'E');
    await link(dbPool, room, beyond, 'E');
    for (const w of [hub, room]) {
      await dbPool.query(
        'INSERT INTO character_visited_worlds (character_id, world_id) VALUES ($1, $2)',
        [character, w]);
    }

    const res = await request(app).get('/api/player/world-map')
      .query({ character_id: character }).set(authed(user));
    assert.equal(res.status, 200);

    const byName = Object.fromEntries(res.body.worlds.map((w) => [w.name, w]));
    assert.equal(byName[hubName].allows_fast_travel, true);
    // Both directions: a test that only ever saw `true` would pass against a
    // hardcoded field, and the whole mechanic is that SOME worlds are not
    // targets.
    assert.equal(byName[roomName].allows_fast_travel, false);

    // The stub stays bare. `beyond` is flagged, so if the field ever reached
    // the unvisited list it would tell the player which unexplored door leads
    // somewhere worth going -- the same class of leak as its name.
    assert.deepEqual(res.body.unvisited, [{ id: beyond, from: room, edge: 'E' }]);
  } finally {
    await cleanup(dbPool, { users, worlds });
  }
});

test("one character's exploration does not reveal the map to its sibling", async (t) => {
  if (!dbReady(t, 'per-character isolation')) return;
  const users = [];
  const worlds = [];
  try {
    const user = await createTestUser(dbPool);
    users.push(user);
    const explorer = await createTestCharacter(dbPool, user, 1);
    const stayHome = await createTestCharacter(dbPool, user, 2);
    const name = uniq('Explored');
    const w = await createTestWorld(dbPool, worlds, { name, x: 0, y: 0 });
    await dbPool.query(
      'INSERT INTO character_visited_worlds (character_id, world_id) VALUES ($1, $2)',
      [explorer, w]);

    const seen = await request(app).get('/api/player/world-map')
      .query({ character_id: explorer }).set(authed(user));
    const unseen = await request(app).get('/api/player/world-map')
      .query({ character_id: stayHome }).set(authed(user));

    assert.deepEqual(seen.body.worlds.map((x) => x.name), [name]);
    assert.deepEqual(unseen.body.worlds, [],
      'the fog is per character, not per account -- both characters belong to the same user here');
    assert.doesNotMatch(JSON.stringify(unseen.body), new RegExp(name));
  } finally {
    await cleanup(dbPool, { users, worlds });
  }
});
