const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const { attachAuthority } = require('../src/authority/server.js');

// ---------------------------------------------------------------------------
// SOMET-294 -- "death returns you to the last village you entered, wherever it
// is."
//
// Everything here runs through the REAL attachAuthority tick loop against a
// mocked pool, for the reason this repo keeps re-learning (SOMET-249): a bind
// written by one path and read by another that never sees it is a feature that
// is green and inert. The two paths that matter are the tick loop's village
// block (which writes player_binds and moves the in-memory bind) and
// onPlayerDeath (which reads it). Both are driven live below; nothing here
// re-implements either.
//
// Harness shape (bootWith/connect/nextMsg/collectMsgs/openResources) is lifted
// deliberately from progression_death.test.js -- same server, same timer-leak
// hazard, and a second harness for the same thing would drift.
// ---------------------------------------------------------------------------

const SECRET = 'test-secret-village-bind-death';
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
    server.listen(0, () => resolve({ url: `ws://127.0.0.1:${server.address().port}/authority`, handle, server }));
  });
}
function connect(url, uid) {
  const ws = new WebSocket(`${url}?token=${encodeURIComponent(token(uid))}`);
  openResources.push({ close() { ws.terminate(); } });
  return ws;
}
function nextMsg(ws, type) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`timeout ${type}`)), 3000);
    ws.on('message', function onMsg(data) {
      const m = JSON.parse(data);
      if (!type || m.type === type) { clearTimeout(to); ws.off('message', onMsg); resolve(m); }
    });
  });
}
function collectMsgs(ws, type, ms) {
  return new Promise((resolve) => {
    const out = [];
    function onMsg(data) {
      const m = JSON.parse(data);
      if (m.type === type) out.push(m);
    }
    ws.on('message', onMsg);
    setTimeout(() => { ws.off('message', onMsg); resolve(out); }, ms);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Fixtures.
//
// Both villages sit far from the join spawn. chooseSpawn puts an unbounded
// world's arrival at (chunkSize * 100) / 2 = (400,400) for chunk_size 8, so a
// village anchored at tile row/col 10+ cannot be entered by accident on join --
// which matters, because an accidental footprint entry would produce a bind
// write nobody asked for and quietly satisfy the throttle assertions below.
// ---------------------------------------------------------------------------
const VILLAGE_A = {
  id: 'vA', min_row: 10, min_col: 10, width: 4, height: 4, gate_edge: 'S',
  spawn_x: 1150, spawn_y: 1150, merchant_x: 1250, merchant_y: 1150,
};
const VILLAGE_B = {
  id: 'vB', min_row: 20, min_col: 20, width: 4, height: 4, gate_edge: 'S',
  spawn_x: 2150, spawn_y: 2150, merchant_x: 2250, merchant_y: 2150,
};
// A point whose PLAYER CENTRE (top-left + 32) lands on an interior tile of the
// given village. The tick loop matches villages on the centre tile, so a
// fixture built off the top-left corner would silently miss the footprint.
const insideA = { x: 1118, y: 1118 };   // centre (1150,1150) -> tile row 11, col 11
const insideB = { x: 2118, y: 2118 };   // centre (2150,2150) -> tile row 21, col 21

// `bind` is the player_binds row this character holds, or null. `villages` maps
// a world id to the rows fetchVillages will return for it.
function fakePool({ bind = null, villages = {} } = {}) {
  const binds = [];      // every INSERT INTO player_binds, in order
  function route(sql, params) {
    if (/FROM worlds WHERE id/i.test(sql)) {
      // No width/height: an UNBOUNDED world, so chooseSpawn lands on the
      // chunk-centre default rather than a bounded world's middle tile.
      return { rows: [{ id: params[0], seed: '1', chunk_size: 8, is_entry: params[0] === 'w1' }] };
    }
    if (/FROM tile_types/i.test(sql)) {
      return { rows: [
        { name: 'grass', walkable: true, speed: 1 },
        // Village stamping looks these two up by name; without them the
        // generator has no wall/gate tile to stamp a footprint with.
        { name: 'wooden_wall', walkable: false, speed: 1 },
        { name: 'village_gate', walkable: true, speed: 1 },
      ] };
    }
    if (/token_version.*FROM users WHERE/i.test(sql)) return { rows: [{ token_version: 1 }] };
    if (/FROM world_players WHERE/i.test(sql)) return { rows: [] };
    if (/INSERT INTO world_players/i.test(sql)) return { rows: [] };
    if (/FROM player_binds WHERE/i.test(sql)) return { rows: bind ? [bind] : [] };
    if (/INSERT INTO player_binds/i.test(sql)) { binds.push(params); return { rows: [] }; }
    if (/FROM villages WHERE world_id/i.test(sql)) return { rows: villages[params[0]] || [] };
    if (/FROM item_types/i.test(sql)) {
      return { rows: [
        { id: 1, name: 'dagger', category: 'weapon', slot: 'main_hand', two_handed: false, kind: 'melee',
          damage: 8, cooldown: 0.3, reach: 80, arc_width: 6.3, range: null, projectile_speed: null,
          projectile_radius: null, pierce: null, mana_cost: 0, element: null, defense: null, resistances: null },
      ] };
    }
    if (/FROM characters/i.test(sql)) return { rows: [{ id: Number(params[0]), entity_type_id: 1 }] };
    if (/FROM worlds w WHERE w\.id/i.test(sql)) {
      // w1 is the entry world with no history -- the first-join leg. w2 is
      // reachable by NOTHING except a server-issued arrival: not entry, not
      // fast-travel, never visited, and not the last world (that is w1). If the
      // cross-world respawn ever stops enqueueing a pendingArrivals entry, the
      // rejoin in the test below is refused and the test fails rather than
      // quietly passing on some other leg of mayJoin.
      if (params[0] === 'w2') {
        return { rows: [{ is_entry: false, allows_fast_travel: false, visited: false, visited_any: true, last_world: 'w1' }] };
      }
      return { rows: [{ is_entry: true, allows_fast_travel: false, visited: false, visited_any: false, last_world: null }] };
    }
    if (/FROM player_items/i.test(sql)) return { rows: [{ id: 'i1', item_type_id: 1 }] };
    if (/FROM player_equipment/i.test(sql)) return { rows: [] };
    if (/SELECT gold FROM users/i.test(sql)) return { rows: [{ gold: 0 }] };
    if (/^\s*INSERT INTO player_progression/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/^\s*UPDATE player_progression/i.test(sql)) return { rows: [PROGRESSION], rowCount: 1 };
    if (/FROM player_progression/i.test(sql)) return { rows: [PROGRESSION], rowCount: 1 };
    return { rows: [] };
  }
  const calls = [];
  const pool = {
    calls, binds,
    matching(re) { return [...calls, ...pool.clients.flatMap((c) => c.calls)].filter((c) => re.test(c.sql)); },
    query: async (sql, params) => { calls.push({ sql, params }); return route(sql, params); },
  };
  pool.clients = [];
  pool.connect = async () => {
    const clientCalls = [];
    const client = {
      calls: clientCalls,
      query: async (sql, params) => { clientCalls.push({ sql, params }); return route(sql, params); },
      release: () => {},
    };
    pool.clients.push(client);
    return client;
  };
  return pool;
}
// Level 1 with zero progress: applyDeath's clamp means the XP penalty is a
// no-op, so nothing in these tests depends on the roll. The death itself is
// what is under test.
const PROGRESSION = {
  user_id: '1', experience: '0', level: 1, stat_points: 0,
  strength: 5, dexterity: 5, constitution: 5, intelligence: 5, wisdom: 5, charisma: 5,
};

function livePlayer(handle, worldId, userId = '1') {
  return handle.worlds.get(worldId).world.getPlayer(userId);
}
function kill(handle, worldId, userId = '1') { livePlayer(handle, worldId, userId).hp = -5; }

async function joinedSession(pool, opts, worldId = 'w1') {
  const booted = await bootWith(pool, opts);
  const ws = connect(booted.url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', character_id: 1, world_id: worldId }));
  await nextMsg(ws, 'joined');
  return { ...booted, ws };
}

// ---------------------------------------------------------------------------
// 1. Same-world death -- today's behaviour, unchanged.
// ---------------------------------------------------------------------------

test('a bind in the CURRENT world respawns you at it, with no world change', async () => {
  const pool = fakePool({ bind: { world_id: 'w1', x: VILLAGE_A.spawn_x, y: VILLAGE_A.spawn_y },
    villages: { w1: [VILLAGE_A] } });
  const { handle, ws } = await joinedSession(pool, {});

  const p = livePlayer(handle, 'w1');
  assert.notStrictEqual(p.x, VILLAGE_A.spawn_x, 'the player must not START on the bind point, or the test proves nothing');

  // Any transition at all would be the cross-world path firing when it must not.
  const transitions = collectMsgs(ws, 'transition', 300);
  kill(handle, 'w1');
  assert.deepStrictEqual(await transitions, [], 'a same-world death must not move the player between worlds');

  assert.strictEqual(p.x, VILLAGE_A.spawn_x, 'respawned at the bind point');
  assert.strictEqual(p.y, VILLAGE_A.spawn_y);
  assert.strictEqual(p.hp, p.maxHp, 'and healed to full');
});

// ---------------------------------------------------------------------------
// 2. No bind at all -- today's behaviour, unchanged.
// ---------------------------------------------------------------------------

test('a character with NO bind respawns at its join spawn, exactly as before', async () => {
  const pool = fakePool({ bind: null, villages: { w1: [VILLAGE_A] } });
  const { handle, ws } = await joinedSession(pool, {});

  const p = livePlayer(handle, 'w1');
  const joinX = p.x, joinY = p.y;
  p.x = 3000; p.y = 3000; // walk somewhere, then die there

  const transitions = collectMsgs(ws, 'transition', 300);
  kill(handle, 'w1');
  assert.deepStrictEqual(await transitions, [], 'no bind means nothing to travel to');

  assert.strictEqual(p.x, joinX, 'respawned at the join spawn');
  assert.strictEqual(p.y, joinY);
  assert.strictEqual(p.hp, p.maxHp);
});

// ---------------------------------------------------------------------------
// 3. Cross-world death -- the new leg. The heal must still be synchronous.
// ---------------------------------------------------------------------------

test('a bind in ANOTHER world heals you here and sends you there', async () => {
  const pool = fakePool({ bind: { world_id: 'w2', x: VILLAGE_B.spawn_x, y: VILLAGE_B.spawn_y },
    villages: { w2: [VILLAGE_B] } });   // w1 has no village: the bind stays elsewhere
  const { handle, ws } = await joinedSession(pool, {});

  const p = livePlayer(handle, 'w1');
  const transitionP = nextMsg(ws, 'transition');
  kill(handle, 'w1');
  const t = await transitionP;

  assert.strictEqual(t.toWorldId, 'w2');
  assert.strictEqual(t.arriveX, VILLAGE_B.spawn_x);
  assert.strictEqual(t.arriveY, VILLAGE_B.spawn_y);

  // THE risk this slice carries (spec Risks, third bullet): the once-per-death
  // guarantee rests on resolveDeaths() healing in the same pass. A cross-world
  // death that deferred the heal along with the relocation would leave the
  // player at hp<=0 until the client finished reconnecting -- and every tick in
  // between would report the death again.
  assert.strictEqual(p.hp, p.maxHp, 'the heal is synchronous even when the relocation is not');
  assert.ok(p.hp > 0);
  assert.deepStrictEqual([...p.effects.keys()], [], 'effects cleared, as on any other death');

  // visited_worlds_db.test.js pins "every transition push records its
  // destination" as source text; this proves the call actually runs and names
  // the right world, which a source-text guard cannot.
  await sleep(50);
  const visits = pool.matching(/INSERT INTO character_visited_worlds/i).map((c) => c.params[1]);
  assert.deepStrictEqual(visits, ['w1', 'w2'],
    'the join recorded w1; the death respawn must record w2, exactly once');
});

test('the cross-world arrival is authorized by the server, not by the client asking', async () => {
  const pool = fakePool({ bind: { world_id: 'w2', x: VILLAGE_B.spawn_x, y: VILLAGE_B.spawn_y },
    villages: { w2: [VILLAGE_B] } });
  const { url, handle, ws } = await joinedSession(pool, {});

  const transitionP = nextMsg(ws, 'transition');
  kill(handle, 'w1');
  await transitionP;
  ws.close();

  // The real client tears the socket down and reconnects to the destination.
  // w2's join-policy facts are rigged so EVERY other leg of mayJoin refuses it
  // (not entry, not fast-travel, never visited, last world is w1) -- so a
  // successful join here can only be the pendingArrivals entry the death just
  // enqueued.
  const ws2 = connect(url, 1);
  await new Promise((r) => ws2.on('open', r));
  ws2.send(JSON.stringify({ type: 'join', character_id: 1, world_id: 'w2' }));
  const joined = await nextMsg(ws2, 'joined');
  assert.strictEqual(joined.type, 'joined');

  const p2 = livePlayer(handle, 'w2');
  assert.strictEqual(p2.x, VILLAGE_B.spawn_x, 'and lands on the village, not on w2\'s generic spawn');
  assert.strictEqual(p2.y, VILLAGE_B.spawn_y);
  ws2.close();
});

// ---------------------------------------------------------------------------
// 4. The double-fire guarantee.
// ---------------------------------------------------------------------------

test('one cross-world death sends exactly ONE transition, however many ticks pass', async () => {
  const pool = fakePool({ bind: { world_id: 'w2', x: VILLAGE_B.spawn_x, y: VILLAGE_B.spawn_y },
    villages: { w2: [VILLAGE_B] } });
  const { handle, ws } = await joinedSession(pool, {});

  const collected = collectMsgs(ws, 'transition', 400); // ~20 ticks at tickMs=20
  kill(handle, 'w1');
  const transitions = await collected;

  assert.strictEqual(transitions.length, 1,
    'a relocation that escaped onPlayerDeath\'s once-per-death guarantee would re-send every tick and pin the player in a reconnect loop');
});

// The counterpart the test above cannot provide on its own: "exactly one" is
// also what a relocation that never fires at all would produce if the first
// assertion were `<= 1`. Two separate deaths must produce two transitions, so
// the mechanism is proven live rather than proven absent.
test('two separate cross-world deaths send two transitions', async () => {
  const pool = fakePool({ bind: { world_id: 'w2', x: VILLAGE_B.spawn_x, y: VILLAGE_B.spawn_y },
    villages: { w2: [VILLAGE_B] } });
  const { handle, ws } = await joinedSession(pool, {});

  const collected = collectMsgs(ws, 'transition', 500);
  kill(handle, 'w1');
  await sleep(150);
  kill(handle, 'w1');   // the player was healed by the first death; this is a second one
  const transitions = await collected;

  assert.strictEqual(transitions.length, 2, 'the relocation is per death, not a one-shot latch');
});

// ---------------------------------------------------------------------------
// 5. The throttle.
// ---------------------------------------------------------------------------

test('standing inside a village is ONE bind write, not one per tick', async () => {
  // bindWriteMinMs 0 removes the time gate entirely, so this test isolates the
  // identity gate: loitering must be one write on its own merits, not because a
  // timer happened to swallow the repeats.
  const pool = fakePool({ villages: { w1: [VILLAGE_A] } });
  const { handle } = await joinedSession(pool, { bindWriteMinMs: 0 });

  const p = livePlayer(handle, 'w1');
  p.x = insideA.x; p.y = insideA.y;
  await sleep(400); // ~20 ticks

  assert.strictEqual(pool.binds.length, 1, `a player parked at the gate wrote ${pool.binds.length} times`);
  assert.strictEqual(pool.binds[0][2], VILLAGE_A.spawn_x);
});

test('crossing between two villages is bounded by the write floor, and the LAST write wins', async () => {
  const pool = fakePool({ villages: { w1: [VILLAGE_A, VILLAGE_B] } });
  const { handle } = await joinedSession(pool, { bindWriteMinMs: 200 });

  const p = livePlayer(handle, 'w1');
  // Alternate footprints every ~tick for half a second. Without a time gate the
  // identity gate alone permits a write on every single crossing -- 25 of them,
  // which is what this test measured before the floor existed.
  let endedIn = null;
  for (let i = 0; i < 25; i++) {
    const [at, village] = i % 2 === 0 ? [insideA, VILLAGE_A] : [insideB, VILLAGE_B];
    p.x = at.x; p.y = at.y;
    endedIn = village;   // tracked, not re-derived: the parity of the last index is easy to get wrong
    await sleep(20);
  }
  await sleep(300); // let the trailing flush land

  assert.ok(pool.binds.length <= 4,
    `500ms of seam-walking at a 200ms floor must not produce ${pool.binds.length} writes`);
  assert.ok(pool.binds.length >= 2,
    'a floor that only ever writes once is not a throttle, it is a latch');
  const last = pool.binds[pool.binds.length - 1];
  assert.strictEqual(last[2], endedIn.spawn_x,
    'a suppressed write must be deferred and flushed, never dropped -- the durable bind has to be the village the player actually finished in');
  assert.strictEqual(last[3], endedIn.spawn_y);

  // And the IN-MEMORY bind is never throttled: whatever the DB write did, a
  // death right now must land in the village the player is standing in.
  assert.strictEqual(p.spawn.x, endedIn.spawn_x, 'the live respawn point tracks the footprint, not the write floor');
  assert.strictEqual(p.bind.x, endedIn.spawn_x);
  assert.strictEqual(p.bind.worldId, 'w1');
});

test('a bind still pending when the socket closes is flushed, not lost', async () => {
  const pool = fakePool({ villages: { w1: [VILLAGE_A, VILLAGE_B] } });
  const { handle, ws } = await joinedSession(pool, { bindWriteMinMs: 5000 });

  const p = livePlayer(handle, 'w1');
  p.x = insideA.x; p.y = insideA.y;
  await sleep(60);
  assert.strictEqual(pool.binds.length, 1, 'the first bind of a session is never delayed');

  p.x = insideB.x; p.y = insideB.y;   // inside the 5s floor: suppressed
  await sleep(60);
  assert.strictEqual(pool.binds.length, 1, 'the second crossing is inside the floor');

  ws.close();
  await sleep(200);
  assert.strictEqual(pool.binds.length, 2, 'disconnecting inside the floor must not lose the newer bind');
  assert.strictEqual(pool.binds[1][2], VILLAGE_B.spawn_x);
});
