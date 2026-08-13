// Waypoint activation, driven through the running authority (SOMET-292).
//
// WHY THIS HARNESS AND NOT A UNIT TEST. Slice E's whole risk is the shape
// SOMET-249 shipped: a table written by one loader and read by another that
// never sees it. A test that calls activateWaypoint directly proves the service
// works and proves nothing about whether the tick loop ever calls it. This boots
// a real attachAuthority against a fake pool, so the waypoint has to arrive
// through loadWorld's OWN query, the player has to be standing on it according
// to the tick loop's OWN tile arithmetic, and the write has to be issued by the
// tick loop itself. Same harness portal_blocking_live.test.js uses, for the same
// reason.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const { attachAuthority } = require('../src/authority/server.js');

const SECRET = 'test-secret-waypoint-activation';
function token(u) { return jwt.sign({ user_id: u, tv: 1 }, SECRET, { algorithm: 'HS256' }); }

const openResources = [];
test.afterEach(() => {
  while (openResources.length) {
    const r = openResources.pop();
    try { r.close(); } catch { /* already closed */ }
  }
});

function bootWith(pool, opts = {}) {
  return new Promise((resolve) => {
    const server = http.createServer();
    const handle = attachAuthority(server, pool, {
      jwtSecret: SECRET, tickMs: 20, creatureBroadcastEvery: 2, creatureFlushMs: 10000, ...opts,
    });
    openResources.push({ close() { handle.close(); if (server.listening) server.close(); } });
    server.listen(0, () => resolve({ url: `ws://127.0.0.1:${server.address().port}/authority`, handle }));
  });
}
function connect(url, uid) {
  const ws = new WebSocket(`${url}?token=${encodeURIComponent(token(uid))}`);
  openResources.push({ close() { ws.terminate(); } });
  return ws;
}
function nextMsg(ws, type, ms = 3000) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`timeout ${type}`)), ms);
    ws.on('message', function onMsg(data) {
      const m = JSON.parse(data);
      if (!type || m.type === type) { clearTimeout(to); ws.off('message', onMsg); resolve(m); }
    });
  });
}

const WAYPOINT_ID = 'wp-1';
const WAYPOINT_X = 1050, WAYPOINT_Y = 1050;   // tile (10,10)

// One world with one waypoint at (1050,1050) and no links, villages or
// creatures -- so the only thing the tick loop can do to this player is
// activate a waypoint, and any INSERT the fake pool records is attributable.
//
// `firstTimeRowCount` is a knob rather than a constant: the server must report
// whichever the DATABASE said, so the test has to be able to make the database
// say "already there".
function fakeWaypointPool({ firstTimeRowCount = 1, waypointRows = null } = {}) {
  const calls = [];
  function route(sql, params) {
    if (/FROM characters/i.test(sql)) return { rows: [{ id: Number(params[0]), entity_type_id: 1 }] };
    if (/FROM worlds w WHERE w\.id/i.test(sql)) {
      return { rows: [{ is_entry: true, allows_fast_travel: false, visited: false, visited_any: false, last_world: null }] };
    }
    if (/FROM worlds WHERE id/i.test(sql)) return { rows: [{ id: 'w1', seed: '1', chunk_size: 8 }] };
    if (/FROM tile_types/i.test(sql)) return { rows: [{ name: 'grass', walkable: true, speed: 1 }] };
    if (/token_version.*FROM users WHERE/i.test(sql)) return { rows: [{ token_version: 1 }] };
    if (/FROM world_players WHERE/i.test(sql)) return { rows: [] };
    if (/INSERT INTO world_players/i.test(sql)) return { rows: [] };
    if (/FROM player_binds WHERE/i.test(sql)) return { rows: [] };
    if (/FROM item_types/i.test(sql)) {
      return { rows: [
        { id: 1, name: 'dagger', category: 'weapon', slot: 'main_hand', two_handed: false, kind: 'melee',
          damage: 8, cooldown: 0.3, reach: 80, arc_width: 6.3, range: null, projectile_speed: null,
          projectile_radius: null, pierce: null, mana_cost: 0, element: null, defense: null, resistances: null },
      ] };
    }
    if (/FROM player_items/i.test(sql)) return { rows: [{ id: 'i1', item_type_id: 1 }] };
    if (/FROM player_equipment/i.test(sql)) return { rows: [] };
    if (/SELECT gold FROM users/i.test(sql)) return { rows: [{ gold: 0 }] };
    if (/^\s*INSERT INTO player_progression/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/FROM player_progression/i.test(sql)) {
      return { rows: [{ user_id: '1', experience: '0', level: 1, stat_points: 0,
        strength: 5, dexterity: 5, constitution: 5, intelligence: 5, wisdom: 5, charisma: 5 }] };
    }
    if (/FROM map_links ml JOIN worlds/i.test(sql)) return { rows: [] };
    if (/FROM villages WHERE/i.test(sql)) return { rows: [] };
    // THE loader under test. Keyed on world_id from the caller's own params, so
    // a loadWorld that asked for a different world would get nothing -- a mock
    // that returned this row regardless of its input would prove nothing about
    // which world the authority actually loaded.
    if (/FROM waypoints WHERE world_id/i.test(sql)) {
      if (params[0] !== 'w1') return { rows: [] };
      return { rows: waypointRows ?? [
        { id: WAYPOINT_ID, world_id: 'w1', x: WAYPOINT_X, y: WAYPOINT_Y, name: 'Trailhead Well', map_link_id: null },
      ] };
    }
    if (/INSERT INTO character_waypoints/i.test(sql)) {
      return { rows: [], rowCount: firstTimeRowCount };
    }
    if (/FROM world_creatures wc/i.test(sql)) return { rows: [] };
    if (/FROM world_items/i.test(sql)) return { rows: [] };
    return { rows: [] };
  }
  const pool = {
    calls,
    matching(re) { return calls.filter((c) => re.test(c.sql)); },
    query: async (sql, params) => { calls.push({ sql, params }); return route(sql, params); },
  };
  pool.connect = async () => ({
    query: async (sql, params) => { calls.push({ sql, params }); return route(sql, params); },
    release() {},
  });
  return pool;
}

async function joinAt(pool, { x, y }) {
  const { url, handle } = await bootWith(pool);
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', character_id: 7, world_id: 'w1' }));
  await nextMsg(ws, 'joined');
  const entry = handle.worlds.get('w1');
  const p = entry.world.getPlayer('1');   // players are keyed by the token's user id, as a string
  // Position by CENTRE, matching how the tick loop derives the player's tile.
  p.x = x - p.width / 2;
  p.y = y - p.height / 2;
  return { ws, handle, entry, p };
}

// The POSITIVE assertions here wait on a message (nextMsg polls the socket) and
// so cannot race. The NEGATIVE ones -- "no write happened" -- have nothing to
// wait for, so they sleep for ~10 ticks at tickMs 20 and then assert; each pairs
// the negative with a positive check that the player really was where the test
// put them, so a zero can never pass for the wrong reason.

test('the authority loads waypoints for the world it is running', async () => {
  const pool = fakeWaypointPool();
  const { entry } = await joinAt(pool, { x: 500, y: 500 });
  assert.equal(pool.matching(/FROM waypoints WHERE world_id/).length, 1,
    'loadWorld must read the waypoints table -- an unread table is an inert feature');
  assert.equal(entry.waypoints.size, 1);
  // Keyed "row,col" from the waypoint's pixels: 1050/100 -> 10 on both axes.
  assert.ok(entry.waypoints.has('10,10'),
    'the waypoint must be keyed by the same tile arithmetic the tick loop uses on the player');
});

test('walking onto a waypoint tile writes character_waypoints and tells the client', async () => {
  const pool = fakeWaypointPool();
  const { ws } = await joinAt(pool, { x: WAYPOINT_X, y: WAYPOINT_Y });

  const msg = await nextMsg(ws, 'waypointActivated');
  assert.equal(msg.waypoint.id, WAYPOINT_ID);
  assert.equal(msg.waypoint.name, 'Trailhead Well');
  assert.equal(msg.firstTime, true);

  const inserts = pool.matching(/INSERT INTO character_waypoints/);
  assert.equal(inserts.length, 1);
  // The PARAMS, not just that a matching statement was issued: a write with the
  // wrong character id lights the waypoint for somebody else and would pass a
  // statement-shape assertion unchanged.
  assert.deepEqual(inserts[0].params, [7, WAYPOINT_ID]);
});

test('standing on the waypoint for many ticks still writes once', async () => {
  // The throttle, and the reason this is safe on a hot path at all. Without it
  // a player who stops on a waypoint issues an INSERT every 20ms forever.
  const pool = fakeWaypointPool();
  const { ws, p } = await joinAt(pool, { x: WAYPOINT_X, y: WAYPOINT_Y });
  await nextMsg(ws, 'waypointActivated');

  const ticksAtStart = pool.matching(/INSERT INTO character_waypoints/).length;
  await new Promise((r) => setTimeout(r, 300));   // ~15 ticks at tickMs 20
  // Confirm the player really did stay on the tile -- otherwise "no further
  // writes" would be true for the wrong reason.
  assert.equal(Math.floor((p.y + p.height / 2) / 100), 10);
  assert.equal(Math.floor((p.x + p.width / 2) / 100), 10);
  assert.equal(pool.matching(/INSERT INTO character_waypoints/).length, ticksAtStart,
    'a player loitering on a waypoint must not cost a write per tick');
  assert.equal(ticksAtStart, 1);
});

test('stepping off and back on within a session does not re-write', async () => {
  const pool = fakeWaypointPool();
  const { ws, p } = await joinAt(pool, { x: WAYPOINT_X, y: WAYPOINT_Y });
  await nextMsg(ws, 'waypointActivated');

  p.x = 500 - p.width / 2; p.y = 500 - p.height / 2;
  await new Promise((r) => setTimeout(r, 100));
  p.x = WAYPOINT_X - p.width / 2; p.y = WAYPOINT_Y - p.height / 2;
  await new Promise((r) => setTimeout(r, 200));

  assert.equal(pool.matching(/INSERT INTO character_waypoints/).length, 1,
    'the session latch is per waypoint, not per visit');
});

test('a player who never touches the tile activates nothing', async () => {
  const pool = fakeWaypointPool();
  const { p } = await joinAt(pool, { x: 500, y: 500 });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(Math.floor((p.x + p.width / 2) / 100), 5, 'player drifted off the tile under test');
  assert.equal(pool.matching(/INSERT INTO character_waypoints/).length, 0);
});

test('firstTime reports what the database said, not what the server assumed', async () => {
  // rowCount 0 = ON CONFLICT DO NOTHING found the row already there, i.e. this
  // character lit this waypoint in an earlier session. A server that reported
  // firstTime off its own in-memory latch would say `true` here and slice F
  // would announce a discovery the player made last week.
  const pool = fakeWaypointPool({ firstTimeRowCount: 0 });
  const { ws } = await joinAt(pool, { x: WAYPOINT_X, y: WAYPOINT_Y });
  const msg = await nextMsg(ws, 'waypointActivated');
  assert.equal(msg.firstTime, false);
});

test('a world with no waypoints costs nothing and breaks nothing', async () => {
  const pool = fakeWaypointPool({ waypointRows: [] });
  const { entry, ws } = await joinAt(pool, { x: WAYPOINT_X, y: WAYPOINT_Y });
  assert.equal(entry.waypoints.size, 0);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(pool.matching(/INSERT INTO character_waypoints/).length, 0);
  assert.equal(ws.readyState, WebSocket.OPEN, 'the tick loop must still be alive');
});

test('there is no client message that can light a waypoint', async () => {
  // Activation is physical or it does not happen. A client-claimed activation
  // would be a free travel target once slice F lands -- the same shape of hole
  // joinPolicy exists to close, and the one thing about this feature that a
  // behavioural test can check now rather than after F ships.
  const pool = fakeWaypointPool();
  const { ws } = await joinAt(pool, { x: 500, y: 500 });
  for (const type of ['waypointActivated', 'activateWaypoint', 'waypoint']) {
    ws.send(JSON.stringify({ type, waypoint_id: WAYPOINT_ID, waypointId: WAYPOINT_ID, id: WAYPOINT_ID }));
  }
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(pool.matching(/INSERT INTO character_waypoints/).length, 0,
    'a waypoint must never be lit by a client claim');
});
