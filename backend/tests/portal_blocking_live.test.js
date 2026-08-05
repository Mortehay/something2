// Same harness shape as progression_death.test.js: a real attachAuthority
// server, a fake pool with a stateful route(), a real WebSocket client.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const { attachAuthority } = require('../src/authority/server.js');

const SECRET = 'test-secret-portal-blocking';
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
    function onMsg(data) { const m = JSON.parse(data); if (m.type === type) out.push(m); }
    ws.on('message', onMsg);
    setTimeout(() => { ws.off('message', onMsg); resolve(out); }, ms);
  });
}

// One world (w1), a single guard at (1050,1050) blocking a portal that
// starts right there too -- so a freshly-joined player standing at spawn
// can walk one tile east to trigger it.
function fakePortalPool() {
  const GUARD_ID = 'guard-1';
  let guardHp = 50;
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
    if (/FROM player_items/i.test(sql)) return { rows: [{ id: 'i1', item_type_id: 1 }] };
    if (/FROM player_equipment/i.test(sql)) return { rows: [] };
    if (/SELECT gold FROM users/i.test(sql)) return { rows: [{ gold: 0 }] };
    if (/^\s*INSERT INTO player_progression/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/FROM player_progression/i.test(sql)) {
      return { rows: [{ user_id: '1', experience: '0', level: 1, stat_points: 0,
        strength: 5, dexterity: 5, constitution: 5, intelligence: 5, wisdom: 5, charisma: 5 }] };
    }
    if (/FROM map_links ml JOIN worlds/i.test(sql)) {
      return { rows: [{
        id: 'link-1', edge: 'PORTAL', to_world_id: 'w2', to_width: 20, to_height: 20,
        from_x: 1050, from_y: 1050, to_x: 550, to_y: 550,
      }] };
    }
    if (/FROM villages WHERE/i.test(sql)) return { rows: [] };
    if (/FROM world_creatures wc/i.test(sql)) {
      return { rows: [{
        id: GUARD_ID, type: 'Orc', x: 1050, y: 1050, hp: guardHp, facing: 'S',
        home_x: 1050, home_y: 1050, level: 3, damage: 10, blocks_portal_id: 'link-1',
        defense: 2, color: '#a33', resistances: {}, faction: 'guard',
      }] };
    }
    if (/FROM world_items/i.test(sql)) return { rows: [] };
    return { rows: [] };
  }
  const calls = [];
  const pool = {
    calls, guardId: GUARD_ID,
    killGuard() { guardHp = 0; },
    matching(re) { return calls.filter((c) => re.test(c.sql)); },
    query: async (sql, params) => { calls.push({ sql, params }); return route(sql, params); },
  };
  pool.clients = [];
  pool.connect = async () => {
    const clientCalls = [];
    const client = {
      calls: clientCalls, released: 0,
      query: async (sql, params) => { clientCalls.push({ sql, params }); return route(sql, params); },
      release() { client.released += 1; },
    };
    pool.clients.push(client);
    return client;
  };
  return pool;
}

// Same guard/portal layout as fakePortalPool, except the world_creatures
// SELECT that activateChunk issues for the guard's chunk never resolves
// until the test explicitly releases it -- reproducing the exact race
// review caught: the guard is alive in the DB from tick zero, but
// invisible to entry.world.creatures (and therefore to isPortalBlocked)
// until its chunk finishes loading, which is asynchronous and NOT
// guaranteed to finish before the next tick evaluates the portal.
function fakeRacyPortalPool() {
  const GUARD_ID = 'guard-1';
  let releaseCreatureQuery;
  const creatureGate = new Promise((resolve) => { releaseCreatureQuery = resolve; });
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
    if (/FROM player_items/i.test(sql)) return { rows: [{ id: 'i1', item_type_id: 1 }] };
    if (/FROM player_equipment/i.test(sql)) return { rows: [] };
    if (/SELECT gold FROM users/i.test(sql)) return { rows: [{ gold: 0 }] };
    if (/^\s*INSERT INTO player_progression/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/FROM player_progression/i.test(sql)) {
      return { rows: [{ user_id: '1', experience: '0', level: 1, stat_points: 0,
        strength: 5, dexterity: 5, constitution: 5, intelligence: 5, wisdom: 5, charisma: 5 }] };
    }
    if (/FROM map_links ml JOIN worlds/i.test(sql)) {
      return { rows: [{
        id: 'link-1', edge: 'PORTAL', to_world_id: 'w2', to_width: 20, to_height: 20,
        from_x: 1050, from_y: 1050, to_x: 550, to_y: 550,
      }] };
    }
    if (/FROM villages WHERE/i.test(sql)) return { rows: [] };
    if (/FROM world_creatures wc/i.test(sql)) {
      // Deferred: does not resolve until releaseCreatureQuery() is called.
      return creatureGate.then(() => ({ rows: [{
        id: GUARD_ID, type: 'Orc', x: 1050, y: 1050, hp: 50, facing: 'S',
        home_x: 1050, home_y: 1050, level: 3, damage: 10, blocks_portal_id: 'link-1',
        defense: 2, color: '#a33', resistances: {}, faction: 'guard',
      }] }));
    }
    if (/FROM world_items/i.test(sql)) return { rows: [] };
    return { rows: [] };
  }
  const pool = {
    guardId: GUARD_ID,
    releaseCreatureQuery: () => releaseCreatureQuery(),
    query: async (sql, params) => route(sql, params),
  };
  pool.connect = async () => ({
    query: async (sql, params) => route(sql, params),
    release() {},
  });
  return pool;
}

// Two worlds, a mirrored portal pair, NO guards. setPortalLink constructs a
// bidirectional pair where the mirror row's from_x/from_y equal the forward
// row's to_x/to_y (see mapLinks.js) -- so a player's arrival tile in w2 IS
// the w1-bound portal's own trigger tile.
function fakeMirroredPortalPool() {
  const WORLDS = {
    w1: { id: 'w1', seed: '1', chunk_size: 8 },
    w2: { id: 'w2', seed: '2', chunk_size: 8 },
  };
  const LINKS = {
    w1: [{ id: 'link-fwd', edge: 'PORTAL', to_world_id: 'w2', to_width: 20, to_height: 20,
      from_x: 1050, from_y: 1050, to_x: 550, to_y: 550 }],
    w2: [{ id: 'link-mirror', edge: 'PORTAL', to_world_id: 'w1', to_width: 20, to_height: 20,
      from_x: 550, from_y: 550, to_x: 1050, to_y: 1050 }],
  };
  function route(sql, params) {
    if (/FROM worlds WHERE id/i.test(sql)) {
      const row = WORLDS[params[0]];
      return { rows: row ? [row] : [] };
    }
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
    if (/FROM map_links ml JOIN worlds/i.test(sql)) return { rows: LINKS[params[0]] || [] };
    if (/FROM villages WHERE/i.test(sql)) return { rows: [] };
    if (/FROM world_creatures wc/i.test(sql)) return { rows: [] }; // no guards -- pure ping-pong repro
    if (/FROM world_items/i.test(sql)) return { rows: [] };
    return { rows: [] };
  }
  const pool = { query: async (sql, params) => route(sql, params) };
  pool.connect = async () => ({ query: async (sql, params) => route(sql, params), release() {} });
  return pool;
}

test('a guard-blocked portal refuses transfer and knocks the player back', async () => {
  const pool = fakePortalPool();
  const { url, handle, server } = await bootWith(pool);
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  const joined = await nextMsg(ws, 'joined');
  assert.ok(joined.spawn, 'joined message must include a spawn point to walk from');

  const world = handle.worlds.get('w1').world;
  // Let the portal's own chunk finish its natural (neighbor-of-spawn)
  // pre-load before stepping onto the tile. Without this, the FIRST
  // evaluation would be blocked by the separate chunk-loaded gate (Critical
  // 1's fix) regardless of guard state, and its knockback would shove the
  // player off the tile before the guard-liveness path ever got exercised
  // in isolation -- masking a broken isPortalBlocked check behind the
  // chunk-load gate instead of catching it. That race is covered on its own
  // by the dedicated race-repro test below; this test isolates guard
  // liveness specifically.
  await new Promise((r) => setTimeout(r, 150));

  // Walk the player directly onto the portal tile (1050,1050) via a raw
  // world-state mutation -- movement input itself is covered elsewhere;
  // this test is about what happens once a player IS on the tile.
  const p = world.getPlayer('1');
  p.x = 1050 - p.width / 2; p.y = 1050 - p.height / 2;

  // Start listening for a leaked transition from THIS moment, concurrently
  // with everything below -- not after portalBlocked resolves. The original
  // version of this test attached its leak-listener only after awaiting
  // portalBlocked, which (given the chunk-load race Critical 1 describes)
  // could resolve well after an earlier leaked transition had already come
  // and gone unseen. Starting here covers the whole window.
  const leakWatch = collectMsgs(ws, 'transition', 400);

  const blocked = await nextMsg(ws, 'portalBlocked');
  assert.equal(blocked.message, 'Guards block the way.');

  await new Promise((r) => setTimeout(r, 60)); // let the same tick's knockback land
  assert.ok(Math.abs((p.x + p.width / 2) - 1050) > 1 || Math.abs((p.y + p.height / 2) - 1050) > 1,
    'the player must have been pushed off the exact portal tile');

  const transitions = await leakWatch;
  assert.deepStrictEqual(transitions, [], 'a blocked portal must never send a transition message');

  ws.close(); handle.close(); server.close();
});

test('killing the guard unblocks the portal on the very next approach', async () => {
  const pool = fakePortalPool();
  const { url, handle, server } = await bootWith(pool);
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  await nextMsg(ws, 'joined');

  pool.killGuard();
  // Force a chunk reload isn't necessary: the guard's hp lives on the
  // in-memory creature object once loaded, so killing it here means the
  // NEXT world load would see hp 0 -- for this same live session, kill the
  // in-memory creature directly, mirroring how progression_death.test.js's
  // `kill()` helper kills a live player by mutating hp in place.
  const world = handle.worlds.get('w1').world;
  const guard = world.creatures.creatures.get(pool.guardId);
  if (guard) guard.hp = 0;

  // Let the portal's own chunk finish its (already in-flight, since it's a
  // neighbor of the spawn chunk in this fixture) load before stepping onto
  // the tile. Without this, the chunk-loaded gate (Critical 1's fix) would
  // itself produce one spurious fail-closed knockback on first contact --
  // which physically shoves the player OFF the tile before this test's
  // single manual placement ever gets evaluated against the (by-then-dead)
  // guard, hanging forever. That race is real gameplay behaviour and is
  // covered by the dedicated race-repro test below; this test is
  // specifically about guard liveness, so it sidesteps the race by waiting
  // for the natural pre-load to land first.
  await new Promise((r) => setTimeout(r, 150));

  const p = world.getPlayer('1');
  p.x = 1050 - p.width / 2; p.y = 1050 - p.height / 2;

  const t = await nextMsg(ws, 'transition');
  assert.deepStrictEqual(
    { toWorldId: t.toWorldId, arriveX: t.arriveX, arriveY: t.arriveY },
    { toWorldId: 'w2', arriveX: 550, arriveY: 550 });

  ws.close(); handle.close(); server.close();
});

// ---------------------------------------------------------------------------
// Critical 1 repro: a guard alive in the DB from tick zero, but whose chunk
// query is deliberately held open, must not let a transition leak through
// during the window before it resolves.
// ---------------------------------------------------------------------------
test('a portal must not leak a transition while its own chunk has not finished loading, even with a live guard in the DB', async () => {
  const pool = fakeRacyPortalPool();
  const { url, handle, server } = await bootWith(pool);
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  await nextMsg(ws, 'joined');

  const world = handle.worlds.get('w1').world;
  const p = world.getPlayer('1');
  p.x = 1050 - p.width / 2; p.y = 1050 - p.height / 2;

  // Watch for a leaked transition across the WHOLE window: while the
  // guard's chunk query is still pending (entry.world.creatures has nothing
  // in it for this chunk yet, so a guard-liveness-only check would see zero
  // creatures and wrongly fire a transition here) and for a beat after it
  // resolves. Not asserted: a second portalBlocked arriving after release --
  // the fail-closed knockback from the FIRST (pre-release) tick already
  // physically shoves the player off the tile, same as a real player who
  // bumps a portal a beat too early, so there is no guarantee they are still
  // standing on it once the guard becomes visible. The safety property this
  // test exists to prove is narrower and unconditional: no transition ever
  // leaks, at any point in this window.
  const leakWatch = collectMsgs(ws, 'transition', 500);

  // Confirms the fail-closed path actually fires, not just "nothing
  // happened yet" -- the portal must refuse before the guard is even
  // visible to isPortalBlocked.
  const blocked = await nextMsg(ws, 'portalBlocked');
  assert.equal(blocked.message, 'Guards block the way.');

  pool.releaseCreatureQuery();
  assert.deepStrictEqual(await leakWatch, [],
    'must not leak a transition at any point while the portal\'s own chunk had not finished loading, guard or no guard');

  ws.close(); handle.close(); server.close();
});

// ---------------------------------------------------------------------------
// Critical 2 repro: a mirrored, unguarded portal pair. Arriving on one side
// lands exactly on the OTHER side's own trigger tile by construction
// (setPortalLink). Without the just-arrived latch, the very next tick would
// bounce the player straight back before they could do anything.
// ---------------------------------------------------------------------------
test('a mirrored portal pair does not bounce the arriving player straight back', async () => {
  const pool = fakeMirroredPortalPool();
  const { url, handle, server } = await bootWith(pool);
  const ws1 = connect(url, 1);
  await new Promise((r) => ws1.on('open', r));
  ws1.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  await nextMsg(ws1, 'joined');

  const world1 = handle.worlds.get('w1').world;
  // Let w1's portal chunk finish its natural (neighbor-of-spawn) pre-load
  // before stepping onto the tile -- same reasoning as the guard-liveness
  // test above: this test is about the arrival-side latch, not the
  // chunk-load race (covered separately), so it sidesteps that race rather
  // than fighting it.
  await new Promise((r) => setTimeout(r, 150));
  const p1 = world1.getPlayer('1');
  p1.x = 1050 - p1.width / 2; p1.y = 1050 - p1.height / 2;

  const t = await nextMsg(ws1, 'transition');
  assert.deepStrictEqual({ toWorldId: t.toWorldId, arriveX: t.arriveX, arriveY: t.arriveY },
    { toWorldId: 'w2', arriveX: 550, arriveY: 550 });
  ws1.close();

  // Mirrors the real client: a transition tears down the old socket and
  // opens a fresh one against the destination world (GameShell.jsx's
  // onTransition -> handleEnterRef -> enterWorld). pendingArrivals (keyed by
  // userId, inside attachAuthority) is what carries the arrival spawn point
  // across this reconnect.
  // NB: reuse the SAME user id (1) as the arriving player, not a second
  // account -- connect()'s uid param feeds jwt's user_id claim, and
  // pendingArrivals is keyed by that same userId.
  const ws2 = connect(url, 1);
  await new Promise((r) => ws2.on('open', r));
  ws2.send(JSON.stringify({ type: 'join', world_id: 'w2' }));
  const joined2 = await nextMsg(ws2, 'joined');
  assert.deepStrictEqual({ x: joined2.spawn.x, y: joined2.spawn.y }, { x: 550, y: 550 },
    'sanity: the player must land exactly on the mirror portal\'s own tile for this to be a meaningful test');

  const leaked = await collectMsgs(ws2, 'transition', 400);
  assert.deepStrictEqual(leaked, [],
    'arriving exactly on a portal\'s own trigger tile must not immediately bounce the player back');

  ws2.close(); handle.close(); server.close();
});

test('a player who stands still on the arrival tile past the old cooldown window still does not bounce back', async () => {
  const pool = fakeMirroredPortalPool();
  const { url, handle, server } = await bootWith(pool);
  const ws1 = connect(url, 1);
  await new Promise((r) => ws1.on('open', r));
  ws1.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  await nextMsg(ws1, 'joined');

  const world1 = handle.worlds.get('w1').world;
  await new Promise((r) => setTimeout(r, 150)); // let w1's portal chunk pre-load, see note above
  const p1 = world1.getPlayer('1');
  p1.x = 1050 - p1.width / 2; p1.y = 1050 - p1.height / 2;
  await nextMsg(ws1, 'transition');
  ws1.close();

  const ws2 = connect(url, 1);
  await new Promise((r) => ws2.on('open', r));
  ws2.send(JSON.stringify({ type: 'join', world_id: 'w2' }));
  await nextMsg(ws2, 'joined');

  // The old mechanism was a flat timer (_portalCdUntil, 1500ms) that would
  // have expired by now with the player still standing on the exact same
  // tile -- proving the fix is a genuine position latch, not just a longer
  // delay before the same bounce.
  await new Promise((r) => setTimeout(r, 1700));
  const leaked = await collectMsgs(ws2, 'transition', 200);
  assert.deepStrictEqual(leaked, [],
    'standing still past the old cooldown window must not trigger a bounce -- the latch only clears when the player actually moves off the tile');

  ws2.close(); handle.close(); server.close();
});
