const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const { World } = require('../src/authority/world.js');
const { attachAuthority } = require('../src/authority/server.js');

// ---------------------------------------------------------------------------
// Part 1: World.resolveDeaths() -- pure, no DB, no server. This is the
// contract server.js's tick loop relies on: resolveDeaths() must REPORT who
// it just respawned, and must never report the same death twice.
// ---------------------------------------------------------------------------

function stubMap() { return { isWalkable: () => true, speedAt: () => 1, chunkSize: 8 }; }

test('resolveDeaths reports who died', () => {
  const w = new World(stubMap());
  w.addPlayer('u1', { x: 0, y: 0 });
  w.addPlayer('u2', { x: 50, y: 50 });
  w.getPlayer('u1').hp = -10; // u2 stays alive

  const died = w.resolveDeaths();

  assert.deepStrictEqual(died, ['u1']);
});

test('resolveDeaths reports nobody when nobody died', () => {
  const w = new World(stubMap());
  w.addPlayer('u1', { x: 0, y: 0 });
  w.addPlayer('u2', { x: 50, y: 50 });

  const died = w.resolveDeaths();

  assert.deepStrictEqual(died, []);
});

// This is the ENTIRE guarantee server.js's onPlayerDeath relies on for
// "fires once, not once per tick spent dead": resolveDeaths() heals the
// player to full hp in the same pass it reports them, so the very next call
// sees hp > 0 and cannot report them again. It is not a lock or a dedup set
// -- it holds only because respawn happens synchronously, in the same
// function, before any caller could possibly call resolveDeaths() again.
test('resolveDeaths does not re-report the same death on a later call -- it already healed them', () => {
  const w = new World(stubMap());
  w.addPlayer('u1', { x: 0, y: 0 });
  w.getPlayer('u1').hp = -10;

  assert.deepStrictEqual(w.resolveDeaths(), ['u1'], 'first call reports the death');
  assert.deepStrictEqual(w.resolveDeaths(), [], 'the same death must not be reported twice');
});

// ---------------------------------------------------------------------------
// Part 2: the live session, through the real server (attachAuthority) and a
// mocked pool. Mirrors progression_kill_xp.test.js's Part 2/withConnect
// pattern: `.connect()` returns a DISTINCT client object (own call log, own
// release counter) rather than literally `{ query: pool.query, release: () =>
// {} }`, so a bug that routed a query onto the wrong connection would be
// visible here -- not merely indistinguishable, as Task 6's review found.
//
// applyDeath (progressionStore.js) never calls pool.connect() at all (no
// transaction -- a single UPDATE), so these tests exercise it purely through
// `pool.query`; `.connect()` is only present because chunk activation
// (server.js's activateChunk) needs it to boot a session at all.
// ---------------------------------------------------------------------------

const SECRET = 'test-secret-progression-death';
function token(u) { return jwt.sign({ user_id: u, tv: 1 }, SECRET, { algorithm: 'HS256' }); }

// attachAuthority runs several unref'd-nothing setInterval timers; a test
// that throws (an assertion failure counts) before reaching its own
// `handle.close(); server.close()` leaks them, and node:test will not exit
// the process while a timer is armed -- every OTHER test still reports, but
// the run itself hangs at the very end instead of exiting. Same hazard (and
// same fix) as authority_server.test.js's openResources/afterEach.
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

// Minimal pool sufficient to join a session (mirrors authority_server.test.js's
// fakePool()) plus a stateful player_progression row that applyDeath's real
// read/compute/write round trip runs against for real. FROM player_items
// returns a non-empty inventory so join skips grantStartingLoadout entirely
// (matching authority_server.test.js's own fakePool, which does the same for
// the same reason) -- nothing about death depends on the weapon catalog.
// `route()` is the ONE place SQL is matched to a canned answer. Both
// `pool.query` and each client's `query` call it directly and log to their
// OWN call array -- neither delegates to the other's already-instrumented
// wrapper. (An earlier draft had `client.query` call `pool.query` for its
// routing, which also re-recorded the call into `pool.calls` -- so a query
// applyDeath issued once via its client showed up twice under `matching()`.
// Exactly the "can the mock even tell client.query from pool.query" hazard
// Task 6's review raised, in a new shape: not indistinguishable, but
// double-counted.)
function fakeDeathPool(row) {
  function route(sql, params) {
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
    // SOMET-260: join now resolves the character before anything else, and a
    // fake pool that falls through to rows:[] refuses the join -- which makes the
    // test HANG waiting for 'joined' rather than fail. Answer it explicitly.
    if (/FROM characters/i.test(sql)) return { rows: [{ id: Number(params[0]), entity_type_id: 1 }] };
    // Plan B slice 3: the join policy's world+visit lookup, which now runs
    // on every join. Falling through to rows:[] refuses it, and the test
    // then HANGS waiting for 'joined' rather than failing. is_entry with no
    // history is the first-join leg -- what these fixtures actually are.
    if (/FROM worlds w WHERE w\.id/i.test(sql)) return { rows: [{ is_entry: true, allows_fast_travel: false, visited: false, visited_any: false, last_world: null }] };
    if (/FROM player_items/i.test(sql)) return { rows: [{ id: 'i1', item_type_id: 1 }] };
    if (/FROM player_equipment/i.test(sql)) return { rows: [] };
    if (/SELECT gold FROM users/i.test(sql)) return { rows: [{ gold: 0 }] };
    if (/^\s*INSERT INTO player_progression/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/^\s*UPDATE player_progression/i.test(sql)) {
      row.experience = Number(params[1]);
      return { rows: [{ ...row, experience: String(row.experience) }], rowCount: 1 };
    }
    if (/FROM player_progression/i.test(sql)) return { rows: [{ ...row, experience: String(row.experience) }], rowCount: 1 };
    return { rows: [] };
  }
  const calls = [];
  const pool = {
    calls,
    matching(re) {
      return [...calls, ...pool.clients.flatMap((c) => c.calls)].filter((c) => re.test(c.sql));
    },
    query: async (sql, params) => { calls.push({ sql, params }); return route(sql, params); },
  };
  pool.clients = [];
  pool.connect = async () => {
    const clientCalls = [];
    const client = {
      calls: clientCalls,
      released: 0,
      query: async (sql, params) => { clientCalls.push({ sql, params }); return route(sql, params); },
      release: () => { client.released += 1; },
    };
    pool.clients.push(client);
    return client;
  };
  return pool;
}

// Kills the LIVE player directly (hp <= 0), the same shortcut
// progression_kill_xp.test.js's mid-death test uses -- combat itself is
// already covered elsewhere; here it's just the trigger for resolveDeaths().
function kill(handle, userId) {
  const world = handle.worlds.get('w1').world;
  world.getPlayer(userId).hp = -5;
}

// Level 4's floor is xpFloor(4) = 100*3*4/2 = 600, and level 4 is WORTH
// 100*4 = 400. The roll is pinned at 0.5, i.e. 5.25% of the band, so the loss
// is floor(0.0525 * 400) = floor(21) = 21 -> 655-21 = 634. Experience starts
// 55 XP into the level, comfortably above 21, so the never-de-level clamp is
// not what produces this number. Deliberately non-round so a formula that
// used the progress instead of the level's worth, the wrong end of the band,
// or skipped the floor() would land somewhere else.
test('dying costs a rolled fraction of the level\'s worth (literal, live path)', async () => {
  const row = {
    user_id: '1', experience: 655, level: 4, stat_points: 0,
    strength: 5, dexterity: 5, constitution: 5, intelligence: 5, wisdom: 5, charisma: 5,
  };
  const pool = fakeDeathPool(row);
  const { url, handle, server } = await bootWith(pool, { rng: () => 0.5 });
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', character_id: 1, world_id: 'w1' }));
  await nextMsg(ws, 'joined');

  const progressionP = nextMsg(ws, 'progression');
  kill(handle, '1');
  const prog = await progressionP;

  assert.strictEqual(prog.lost, 21, 'floor(0.0525 * 400)');
  assert.strictEqual(prog.progression.experience, 634);
  assert.strictEqual(prog.progression.level, 4, 'death never changes level directly');

  // Respawn (the unrelated, pre-existing heal-to-full path) still ran too.
  let healed = false;
  for (let i = 0; i < 40 && !healed; i++) {
    const s = await nextMsg(ws, 'state');
    const me = s.players.find((p) => p.id === '1');
    if (me && me.hp === me.maxHp) healed = true;
  }
  assert.ok(healed, 'the existing respawn-to-full behavior must be unaffected by the penalty');

  ws.close(); handle.close(); server.close();
});

// Every OTHER live-path death test pins the draw by passing `rng`, which
// leaves the production default -- attachAuthority's `opts.rng || Math.random`
// at server.js:113, threaded into applyDeath -- as the one branch none of them
// execute. That is this branch's signature failure mode in a fresh place: a
// stub standing in for the very wiring under test. Booting with no `rng` at
// all is the only way to prove the unpinned path actually runs end to end and
// lands inside the documented band.
//
// The assertions here are properties, not literals, because the draw is
// genuinely unpinned -- the literal coverage lives in the pinned test above
// and in player_stats.test.js. Level 3 is worth 100*3 = 300, so the band is
// floor(0.005 * 300) = 1 through floor(0.10 * 300) = 30; starting 200 XP into
// the level keeps the never-de-level clamp out of the result entirely, so a
// loss of 0 would mean the roll never happened rather than that it was capped.
test('the unpinned production roll runs and stays inside the band (live path)', async () => {
  const row = {
    user_id: '1', experience: 500, level: 3, stat_points: 0,
    strength: 5, dexterity: 5, constitution: 5, intelligence: 5, wisdom: 5, charisma: 5,
  };
  const pool = fakeDeathPool(row);
  const { url, handle, server } = await bootWith(pool); // no rng: Math.random
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', character_id: 1, world_id: 'w1' }));
  await nextMsg(ws, 'joined');

  const progressionP = nextMsg(ws, 'progression');
  kill(handle, '1');
  const prog = await progressionP;

  assert.ok(prog.lost >= 1 && prog.lost <= 30,
    `the unpinned roll escaped the 0.5%-10% band for a level worth 300: ${prog.lost}`);
  assert.strictEqual(prog.progression.experience, 500 - prog.lost,
    'the pushed experience must match the loss the same message reported');
  assert.strictEqual(Number(row.experience), 500 - prog.lost,
    'the persisted row must match too -- not just the wire message');
  assert.strictEqual(prog.progression.level, 3, 'death never changes level directly');

  ws.close(); handle.close(); server.close();
});

// Exactly on a level floor: zero progress into the level, so the documented
// clamp (xp can never fall below xpFloor(level)) means zero loss AND no
// de-level. Level 3 (not 1) so "never de-levels" is a real claim, not
// trivially true because level 1 is already the floor of everything.
test('dying at a level floor costs nothing and never de-levels', async () => {
  const row = {
    user_id: '1', experience: 300, level: 3, stat_points: 2,
    strength: 6, dexterity: 5, constitution: 5, intelligence: 5, wisdom: 5, charisma: 5,
  };
  const pool = fakeDeathPool(row);
  const { url, handle, server } = await bootWith(pool, { rng: () => 0.5 });
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', character_id: 1, world_id: 'w1' }));
  await nextMsg(ws, 'joined');

  kill(handle, '1');
  // Confirm the death actually got processed (respawned to full) before
  // asserting on the absence of a push -- otherwise "no progression message"
  // could just mean the tick hasn't run yet.
  let healed = false;
  for (let i = 0; i < 40 && !healed; i++) {
    const s = await nextMsg(ws, 'state');
    const me = s.players.find((p) => p.id === '1');
    if (me && me.hp === me.maxHp) healed = true;
  }
  assert.ok(healed, 'death must still resolve (respawn) even though the penalty is zero');

  const pushes = await collectMsgs(ws, 'progression', 150);
  assert.deepStrictEqual(pushes, [], 'zero loss must not push a progression message at all');
  assert.strictEqual(row.experience, 300, 'experience must not move');
  assert.strictEqual(
    pool.matching(/^\s*UPDATE player_progression/i).length, 0,
    'applyDeath must not even issue the UPDATE when lost <= 0',
  );

  ws.close(); handle.close(); server.close();
});

// Level 5's floor is 1000 and it is worth 100*5 = 500; a pinned 0.5 draw
// costs floor(0.0525 * 500) = floor(26.25) = 26, against 30 XP of progress.
// Non-base stats and a nonzero stat_points prove the UPDATE genuinely only
// ever touches `experience` -- if it touched anything else, these would move.
test('dying does not change allocated stats or spent points', async () => {
  const row = {
    user_id: '1', experience: 1030, level: 5, stat_points: 4,
    strength: 8, dexterity: 6, constitution: 7, intelligence: 9, wisdom: 5, charisma: 5,
  };
  const pool = fakeDeathPool(row);
  const { url, handle, server } = await bootWith(pool, { rng: () => 0.5 });
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', character_id: 1, world_id: 'w1' }));
  await nextMsg(ws, 'joined');

  const progressionP = nextMsg(ws, 'progression');
  kill(handle, '1');
  const prog = await progressionP;

  assert.strictEqual(prog.lost, 26);
  assert.strictEqual(prog.progression.experience, 1004);
  assert.strictEqual(prog.progression.stat_points, 4, 'spent points must not move');
  assert.strictEqual(prog.progression.strength, 8);
  assert.strictEqual(prog.progression.dexterity, 6);
  assert.strictEqual(prog.progression.constitution, 7);
  assert.strictEqual(prog.progression.intelligence, 9);
  assert.strictEqual(prog.progression.wisdom, 5);
  assert.strictEqual(prog.progression.charisma, 5);

  ws.close(); handle.close(); server.close();
});

// The required "fires once, not once per tick spent dead" test. tickMs is 20
// here, so several hundred ms spans many ticks; if resolveDeaths() re-reported
// the same death (or onPlayerDeath were called more than once for it) this
// would see more than one progression push and more than one UPDATE.
test('the death penalty fires exactly once per death, not once per tick spent dead', async () => {
  const row = {
    user_id: '1', experience: 655, level: 4, stat_points: 0,
    strength: 5, dexterity: 5, constitution: 5, intelligence: 5, wisdom: 5, charisma: 5,
  };
  const pool = fakeDeathPool(row);
  const { url, handle, server } = await bootWith(pool, { rng: () => 0.5 });
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', character_id: 1, world_id: 'w1' }));
  await nextMsg(ws, 'joined');

  const collected = collectMsgs(ws, 'progression', 400); // ~20 ticks at tickMs=20
  kill(handle, '1');
  const pushes = await collected;

  assert.strictEqual(pushes.length, 1, 'exactly one progression push for one death');
  assert.strictEqual(pushes[0].lost, 21);
  assert.strictEqual(
    pool.matching(/^\s*UPDATE player_progression/i).length, 1,
    'exactly one UPDATE must land, however many ticks the player briefly sat at hp<=0',
  );
  assert.strictEqual(row.experience, 634, 'the single write must be the one expected value, not applied twice');

  ws.close(); handle.close(); server.close();
});

// "Handle the socket being gone" -- entry.sockets can lose this player's
// socket between the death being detected and applyDeath's promise
// resolving (exactly the race onCreatureDeath already documents for kills).
// Simulated directly: rip the socket out of entry.sockets right as the kill
// happens, so onPlayerDeath's `entry.sockets.get(userId)` reliably misses,
// then prove the death commit still completes (the mocked UPDATE lands) and
// nothing crashes -- the connection this test keeps around for pinging
// afterwards is proof the process (and this world's tick loop) survived.
test('a death penalty commit finishing after the socket is gone does not throw', async () => {
  const row = {
    user_id: '1', experience: 655, level: 4, stat_points: 0,
    strength: 5, dexterity: 5, constitution: 5, intelligence: 5, wisdom: 5, charisma: 5,
  };
  const pool = fakeDeathPool(row);
  const { url, handle, server } = await bootWith(pool, { rng: () => 0.5 });
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', character_id: 1, world_id: 'w1' }));
  await nextMsg(ws, 'joined');

  const entry = handle.worlds.get('w1');
  entry.sockets.delete('1'); // simulate "socket vanished" without removing the player from the sim
  kill(handle, '1');

  // Give the tick loop + applyDeath's (instant, mocked) promise time to run.
  await new Promise((r) => setTimeout(r, 150));

  assert.strictEqual(row.experience, 634, 'the death commit must still complete with no socket to push to');
  assert.strictEqual(
    pool.matching(/^\s*UPDATE player_progression/i).length, 1,
    'still exactly one write despite the missing socket',
  );

  // The process/tick-loop is provably still alive: a fresh session can still
  // join the same world right after.
  const ws2 = connect(url, 2);
  await new Promise((r) => ws2.on('open', r));
  ws2.send(JSON.stringify({ type: 'join', character_id: 1, world_id: 'w1' }));
  const joined2 = await nextMsg(ws2, 'joined');
  assert.strictEqual(joined2.type, 'joined');

  ws.close(); ws2.close(); handle.close(); server.close();
});
