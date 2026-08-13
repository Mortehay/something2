// Waypoint travel, driven through the running authority (SOMET-293).
//
// WHY THIS HARNESS AND NOT A UNIT TEST. A test that calls the handler directly
// proves the handler works and proves nothing about whether the running
// authority routes a `travel` frame to it, whether `entry.waypoints` is
// populated on the socket's own world, or whether the arrival the handler wrote
// is the one the next join actually uses. Those are the joints this slice is
// made of, and this repo's recorded failures (SOMET-249, SOMET-286) are all
// joints that no test crossed. Same harness waypoint_activation_live.test.js
// and portal_blocking_live.test.js use.
//
// The end-to-end case below reconnects and JOINS the destination world, which is
// the only way to prove pendingArrivals and the `transition` leg meet: the
// travel handler writes the arrival, the client's rejoin reads it, and if either
// half is wrong the join is refused and the player sits on a dead canvas.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const { attachAuthority } = require('../src/authority/server.js');

const SECRET = 'test-secret-waypoint-travel';
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
// "Nothing arrived" needs a bounded wait, unlike the positive cases which poll
// until their frame lands. Every negative assertion below is paired with a
// positive one (the player is really where the test put them, the refusal really
// was sent) so a zero can never pass for the wrong reason.
async function noMsg(ws, type, ms = 300) {
  let seen = null;
  const onMsg = (data) => { const m = JSON.parse(data); if (m.type === type) seen = m; };
  ws.on('message', onMsg);
  await new Promise((r) => setTimeout(r, ms));
  ws.off('message', onMsg);
  return seen;
}

const CHARACTER = 7;
// Two worlds, one waypoint each, both on tile (10,10) of their own world so the
// arithmetic is easy to read. Travel between them is the feature.
const HOME = { world: 'w1', id: 'wp-home', x: 1050, y: 1050 };
const AWAY = { world: 'w2', id: 'wp-away', x: 2050, y: 3050 };

// `activated` is the set of waypoint ids this character has lit, and it is what
// the fake pool answers waypointTravelFacts from -- so a test can put the player
// on a waypoint they have NOT lit, which the live tick loop would otherwise fix
// within a tick by activating it.
function fakeTravelPool({ activated = [HOME.id, AWAY.id], waypointsByWorld = null } = {}) {
  const calls = [];
  const lit = new Set(activated);
  const byWorld = waypointsByWorld ?? {
    w1: [{ id: HOME.id, world_id: 'w1', x: HOME.x, y: HOME.y, name: 'Home Waystone', map_link_id: null }],
    w2: [{ id: AWAY.id, world_id: 'w2', x: AWAY.x, y: AWAY.y, name: 'Away Waystone', map_link_id: null }],
  };
  const allWaypoints = () => Object.values(byWorld).flat();

  function route(sql, params) {
    if (/FROM characters/i.test(sql)) return { rows: [{ id: Number(params[0]), entity_type_id: 1 }] };
    // joinPolicyFacts, answered as hostilely as a working test allows.
    //
    // `last_world` is 'w1' for EVERY world asked about, because it is a fact
    // about the character rather than about the world -- that is what the real
    // query returns, and it is what lets the opening join into w1 succeed on the
    // `resume` leg. For w2 it authorizes nothing: not entry, not flagged, not
    // visited, and history closes first-join. So the ONLY thing that can get
    // this character into w2 is a waypoint trip followed by `transition`. If the
    // handler were leaning on `resume`, or on the deleted `fast-travel`, these
    // tests would still be green -- which is why the destination is a world the
    // character has no other claim on at all.
    if (/FROM worlds w WHERE w\.id/i.test(sql)) {
      return { rows: [{ is_entry: false, allows_fast_travel: false, visited: false, visited_any: true, last_world: 'w1' }] };
    }
    // The travel loader. Answered from the same waypoint rows loadWorld is
    // served, so a destination this fake pool never loaded cannot be travelled
    // to either -- the two views of the table agree by construction.
    if (/FROM waypoints wp WHERE wp\.id/i.test(sql)) {
      const [characterId, destId, originId] = params;
      const wp = allWaypoints().find((w) => w.id === destId);
      if (!wp) return { rows: [] };
      assert.equal(characterId, CHARACTER, 'the travel loader must be keyed on the joined character');
      return { rows: [{
        ...wp,
        destination_activated: lit.has(destId),
        origin_activated: originId != null && lit.has(originId),
      }] };
    }
    // Echoes the requested id back, so loadWorld's canonicalId is the world the
    // caller asked for and the second world can be loaded at all.
    if (/FROM worlds WHERE id/i.test(sql)) return { rows: [{ id: params[0], seed: '1', chunk_size: 8 }] };
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
    if (/FROM waypoints WHERE world_id/i.test(sql)) return { rows: byWorld[params[0]] ?? [] };
    // Activation, which the tick loop fires the moment the player stands on a
    // waypoint. It must NOT feed back into `lit`: the whole point of the
    // unlit-origin case is to hold the database's answer still while the player
    // stands there.
    if (/INSERT INTO character_waypoints/i.test(sql)) return { rows: [], rowCount: 1 };
    // Fog of war. Routed explicitly rather than left to the fallthrough below,
    // because a test asserting this write happened must not be able to pass
    // against a pool that never understood the query -- an unrouted INSERT and
    // a routed one are indistinguishable from `{rows: []}`.
    if (/INSERT INTO character_visited_worlds/i.test(sql)) return { rows: [], rowCount: 1 };
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

// Join w1 and stand the player at (x,y) in world pixels, by CENTRE -- the same
// point the tick loop and the travel handler both derive the tile from.
async function joinAt(pool, { x, y }, worldId = 'w1') {
  const { url, handle } = await bootWith(pool);
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', character_id: CHARACTER, world_id: worldId }));
  await nextMsg(ws, 'joined');
  const entry = handle.worlds.get(worldId);
  const p = entry.world.getPlayer('1');
  p.x = x - p.width / 2;
  p.y = y - p.height / 2;
  return { ws, handle, entry, p, url };
}

test('travelling between two lit waypoints transitions to the destination TILE', async () => {
  const pool = fakeTravelPool();
  const { ws } = await joinAt(pool, { x: HOME.x, y: HOME.y });

  ws.send(JSON.stringify({ type: 'travel', waypointId: AWAY.id }));
  const t = await nextMsg(ws, 'transition');

  // The VALUES, not just the frame type. A transition that named the right
  // world but the wrong point would land the player at a world spawn, which is
  // exactly the world-granularity behaviour this slice replaces.
  assert.equal(t.toWorldId, 'w2');
  assert.equal(t.arriveX, AWAY.x);
  assert.equal(t.arriveY, AWAY.y);
});

test('the rejoin after a travel is authorized and lands on the arrival point', async () => {
  // THE JOINT. The travel handler writes pendingArrivals and the client
  // reconnects; if either half is wrong the join is refused (joinPolicyFacts
  // above is deliberately hostile, so nothing else could allow it) and the
  // player sits on a canvas that never receives `joined`.
  const pool = fakeTravelPool();
  const { ws, url, handle } = await joinAt(pool, { x: HOME.x, y: HOME.y });

  ws.send(JSON.stringify({ type: 'travel', waypointId: AWAY.id }));
  const t = await nextMsg(ws, 'transition');
  ws.close();

  const ws2 = connect(url, 1);
  await new Promise((r) => ws2.on('open', r));
  ws2.send(JSON.stringify({ type: 'join', character_id: CHARACTER, world_id: t.toWorldId }));
  const joined = await nextMsg(ws2, 'joined');

  assert.equal(joined.spawn.x, AWAY.x, 'the player must arrive on the destination waypoint, not at a spawn');
  assert.equal(joined.spawn.y, AWAY.y);
  // And it really is the other world's sim, not a second shard of the first.
  assert.ok(handle.worlds.has('w2'));
});

// Every recorded visit for `worldId`, matched on the INSERT and not on the
// table name. joinPolicyFacts' own SELECT mentions character_visited_worlds
// twice, so a regex over the table alone matches on EVERY travel attempt --
// including the refused ones -- and would pass with the write deleted.
function visitsTo(pool, worldId) {
  return pool.matching(/INSERT INTO character_visited_worlds/i)
    .filter((c) => c.params[1] === worldId);
}

test('a waypoint trip records the destination as visited', async () => {
  // The write is fire-and-forget and nothing on the wire reflects it, which is
  // the exact shape that has shipped inert in this repo before. It is also not
  // covered by visited_worlds_db.test.js's source guard: that one asserts a
  // `recordVisit(` appears within 600 characters of each `type: 'transition'`
  // push, which a call inside an `if (false)` would satisfy just as well.
  //
  // Ordering is deterministic, not a race: the fake pool pushes onto `calls`
  // synchronously in the first statement of `query`, and the handler calls
  // recordVisit synchronously after `send`. So the call is recorded before the
  // frame this test awaits has crossed the socket.
  const pool = fakeTravelPool();
  const { ws } = await joinAt(pool, { x: HOME.x, y: HOME.y });

  // The join records w1 on its own. Only w2 can come from the travel handler --
  // this character has no other way into that world (see joinPolicyFacts above).
  assert.equal(visitsTo(pool, 'w2').length, 0, 'nothing may have visited w2 before the trip');

  ws.send(JSON.stringify({ type: 'travel', waypointId: AWAY.id }));
  await nextMsg(ws, 'transition');

  const dest = visitsTo(pool, 'w2');
  assert.equal(dest.length, 1, 'a committed waypoint trip must record the destination as visited');
  assert.equal(dest[0].params[0], CHARACTER, 'the visit must be recorded for the travelling character');
  // Paired positive: the join's own visit really is in `calls` too, so the
  // filter above is discriminating between worlds rather than finding nothing.
  assert.equal(visitsTo(pool, 'w1').length, 1);
});

test('a refused trip records nothing', async () => {
  // The other half of the assertion above. A recordVisit hoisted above the
  // verdict would still pass that test and would hand out fog-of-war for a
  // world the player was just refused -- a read of the world graph earned by
  // asking for it.
  const pool = fakeTravelPool({ activated: [HOME.id] });
  const { ws } = await joinAt(pool, { x: HOME.x, y: HOME.y });

  ws.send(JSON.stringify({ type: 'travel', waypointId: AWAY.id }));
  await nextMsg(ws, 'error');

  assert.equal(visitsTo(pool, 'w2').length, 0);
  // Paired positive: the refusal really did go down the travel path (the
  // destination was looked up), so the zero above is not "nothing happened".
  assert.equal(pool.matching(/FROM waypoints wp WHERE wp\.id/).length, 1);
});

test('travel is refused when the player is not standing on a waypoint', async () => {
  const pool = fakeTravelPool();
  // Tile (5,5): far from HOME's (10,10), and no waypoint is authored there.
  const { ws, entry, p } = await joinAt(pool, { x: 550, y: 550 });

  ws.send(JSON.stringify({ type: 'travel', waypointId: AWAY.id }));
  const err = await nextMsg(ws, 'error');
  assert.match(err.message, /cannot travel/);

  // The paired positives: the player really was off-waypoint, and no transition
  // followed the refusal.
  assert.equal(entry.waypoints.get(`${Math.floor((p.y + p.height / 2) / 100)},`
    + `${Math.floor((p.x + p.width / 2) / 100)}`), undefined);
  assert.equal(await noMsg(ws, 'transition'), null);
});

test('travel is refused from a waypoint this character has not lit', async () => {
  // The origin exists and the player is standing exactly on it -- only the
  // ACTIVATION is missing. Live, this is the window between stepping on a
  // waypoint and the fire-and-forget INSERT landing (or failing); as a rule it
  // is what stops a character reaching a network it has not walked.
  const pool = fakeTravelPool({ activated: [AWAY.id] });
  const { ws, entry, p } = await joinAt(pool, { x: HOME.x, y: HOME.y });

  ws.send(JSON.stringify({ type: 'travel', waypointId: AWAY.id }));
  await nextMsg(ws, 'error');

  // Paired positive: the player IS on the origin waypoint's tile, so the refusal
  // is about activation and not about position.
  assert.ok(entry.waypoints.get(`${Math.floor((p.y + p.height / 2) / 100)},`
    + `${Math.floor((p.x + p.width / 2) / 100)}`));
  assert.equal(await noMsg(ws, 'transition'), null);
});

test('travel is refused to a waypoint this character has not lit', async () => {
  // Acceptance criterion 4's server half: the popup renders an unactivated
  // waypoint distinctly and will not select it, and the server refuses it even
  // if the client does.
  const pool = fakeTravelPool({ activated: [HOME.id] });
  const { ws } = await joinAt(pool, { x: HOME.x, y: HOME.y });

  ws.send(JSON.stringify({ type: 'travel', waypointId: AWAY.id }));
  await nextMsg(ws, 'error');
  assert.equal(await noMsg(ws, 'transition'), null);
});

test('an unknown waypoint id is refused without killing the session', async () => {
  const pool = fakeTravelPool();
  const { ws } = await joinAt(pool, { x: HOME.x, y: HOME.y });

  ws.send(JSON.stringify({ type: 'travel', waypointId: 'wp-does-not-exist' }));
  await nextMsg(ws, 'error');
  assert.equal(await noMsg(ws, 'transition'), null);

  // The socket must survive a bad frame -- and still work. A handler that threw
  // out of its op chain would leave the session alive but permanently wedged,
  // which is worse than a disconnect because the player sees no reason for it.
  assert.equal(ws.readyState, WebSocket.OPEN);
  ws.send(JSON.stringify({ type: 'travel', waypointId: AWAY.id }));
  const t = await nextMsg(ws, 'transition');
  assert.equal(t.toWorldId, 'w2');
});

test('same-world travel between two lit waypoints works', async () => {
  // Two waypoints in one world is ordinary waypoint behaviour, and it is the
  // case where the join cascade would have had an opinion: the player's newest
  // world_players row is the world they are standing in, so `resume` would
  // authorize the trip regardless of activation. It goes down the same path as
  // any other trip.
  const pool = fakeTravelPool({
    activated: [HOME.id, 'wp-second'],
    waypointsByWorld: {
      w1: [
        { id: HOME.id, world_id: 'w1', x: HOME.x, y: HOME.y, name: 'Home Waystone', map_link_id: null },
        { id: 'wp-second', world_id: 'w1', x: 2050, y: 2050, name: 'Second Waystone', map_link_id: null },
      ],
    },
  });
  const { ws } = await joinAt(pool, { x: HOME.x, y: HOME.y });

  ws.send(JSON.stringify({ type: 'travel', waypointId: 'wp-second' }));
  const t = await nextMsg(ws, 'transition');
  assert.equal(t.toWorldId, 'w1');
  assert.equal(t.arriveX, 2050);
  assert.equal(t.arriveY, 2050);
});

test('a travel frame from a socket that never joined does nothing', async () => {
  // ws.worldId is unset, so there is no world, no player and no position to
  // authorize against. It must not throw out of the dispatch table.
  const pool = fakeTravelPool();
  const { url } = await bootWith(pool);
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));

  ws.send(JSON.stringify({ type: 'travel', waypointId: AWAY.id }));
  assert.equal(await noMsg(ws, 'transition'), null);
  assert.equal(ws.readyState, WebSocket.OPEN);
  // Nothing was even asked of the database on this path.
  assert.equal(pool.matching(/FROM waypoints wp WHERE wp\.id/).length, 0);
});
