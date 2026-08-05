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

// Mirrors planPortalTransition's own chunk-loaded gate (server.js), which
// review widened from "the portal's own chunk" to "the portal tile's full
// radius-1 chunk neighborhood" -- insertPortalGuards (dungeonGuards.js)
// spreads a pack up to +/-60px via RING_OFFSETS, enough to land a guard in
// an ADJACENT chunk when the portal sits near a chunk boundary.
function chunkNeighborhoodKeys(x, y, chunkSize) {
  const gCol = Math.floor(x / 100), gRow = Math.floor(y / 100);
  const cx = Math.floor(gCol / chunkSize), cy = Math.floor(gRow / chunkSize);
  const keys = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) keys.push(`${cx + dx},${cy + dy}`);
  }
  return keys;
}

// Repeatedly places the player exactly on (x,y) and polls entry.loadedChunks
// until the FULL radius-1 chunk neighborhood around that tile has finished
// loading. Re-placing on every poll undoes any knockback the (still
// loading) chunk gate applies in the meantime -- once the whole
// neighborhood is in, the final placement sticks and the caller's real
// assertions can proceed without a spurious fail-closed bump getting in the
// way first. Used by tests that are about guard liveness or the
// just-arrived latch specifically, NOT about the chunk-load race itself
// (which has its own dedicated repro tests below).
async function settleOnPortalTile(entry, playerId, x, y, chunkSize, timeoutMs = 3000) {
  const keys = chunkNeighborhoodKeys(x, y, chunkSize);
  const p = entry.world.getPlayer(playerId);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    p.x = x - p.width / 2; p.y = y - p.height / 2;
    if (keys.every((k) => entry.loadedChunks.has(k))) return p;
    if (Date.now() > deadline) {
      throw new Error(`chunk neighborhood for (${x},${y}) did not finish loading in time: missing ${
        keys.filter((k) => !entry.loadedChunks.has(k)).join(', ')}`);
    }
    await new Promise((r) => setTimeout(r, 15));
  }
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
      // Gates EVERY chunk's creature query uniformly (the whole radius-1
      // neighborhood, now that the gate covers it) -- releasing unblocks
      // them all at once, which is functionally equivalent to the
      // single-chunk case this was originally written against.
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

// Portal sits near a chunk boundary (own chunk (1,1), span 800px, so tile
// x=805 is 5px inside the [800,1600) chunk). Its guard, offset -60px west
// by insertPortalGuards' RING_OFFSETS, lands at x=745 -- INSIDE the
// ADJACENT chunk (0,1), a different chunk than the one the portal's own
// tile falls in. The two chunks activate via independent DB round-trips
// from the same recomputeActive pass: this fixture lets the portal's OWN
// chunk resolve immediately (empty, no guard there) while holding the
// guard's NEIGHBORING chunk's query open, so a single-chunk-only gate would
// wrongly consider the portal's world state "loaded" the moment its own
// chunk resolves and let a transition through before the guard is ever
// visible.
function fakeAdjacentChunkGuardPool() {
  const GUARD_ID = 'guard-1';
  let releaseGuardChunkQuery;
  const guardChunkGate = new Promise((resolve) => { releaseGuardChunkQuery = resolve; });
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
        from_x: 805, from_y: 1050, to_x: 550, to_y: 550,
      }] };
    }
    if (/FROM villages WHERE/i.test(sql)) return { rows: [] };
    if (/FROM world_creatures wc/i.test(sql)) {
      // params: [worldId, x1, x2, y1, y2]. The guard's chunk bounding box
      // (chunk (0,1)) is x in [0,800), y in [800,1600) -- the WEST neighbor
      // of the portal's own chunk (1,1), x in [800,1600), same y range.
      const [, x1, x2, y1, y2] = params;
      const isGuardChunk = x1 === 0 && x2 === 800 && y1 === 800 && y2 === 1600;
      if (isGuardChunk) {
        return guardChunkGate.then(() => ({ rows: [{
          id: GUARD_ID, type: 'Orc', x: 745, y: 1050, hp: 50, facing: 'S',
          home_x: 805, home_y: 1050, level: 3, damage: 10, blocks_portal_id: 'link-1',
          defense: 2, color: '#a33', resistances: {}, faction: 'guard',
        }] }));
      }
      return { rows: [] }; // every other chunk, including the portal's own, resolves immediately with no guard
    }
    if (/FROM world_items/i.test(sql)) return { rows: [] };
    return { rows: [] };
  }
  const pool = {
    guardId: GUARD_ID,
    releaseGuardChunkQuery: () => releaseGuardChunkQuery(),
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

  const entry = handle.worlds.get('w1');
  // Settle the player exactly on the portal tile only once its FULL chunk
  // neighborhood has finished loading. Without this, the FIRST evaluation
  // would be blocked by the separate chunk-loaded gate (Critical 1's fix)
  // regardless of guard state, and its knockback would shove the player off
  // the tile before the guard-liveness path ever got exercised in isolation
  // -- masking a broken isPortalBlocked check behind the chunk-load gate
  // instead of catching it. That race is covered on its own by the
  // dedicated race-repro tests below; this test isolates guard liveness
  // specifically.
  const p = await settleOnPortalTile(entry, '1', 1050, 1050, 8);

  // Start listening for a leaked transition from THIS moment, concurrently
  // with everything below -- not after portalBlocked resolves. The original
  // version of this test attached its leak-listener only after awaiting
  // portalBlocked, which (given the chunk-load race Critical 1 describes)
  // could resolve well after an earlier leaked transition had already come
  // and gone unseen. Starting here covers the whole window.
  const leakWatch = collectMsgs(ws, 'transition', 400);

  const blocked = await nextMsg(ws, 'portalBlocked');
  assert.equal(blocked.message, 'Guards block the way.');

  await new Promise((r) => setTimeout(r, 150)); // let the same tick's knockback land (generous margin over one tick's worth of real socket/scheduler latency)
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
  const entry = handle.worlds.get('w1');
  const guard = entry.world.creatures.creatures.get(pool.guardId);
  if (guard) guard.hp = 0;

  // Same isolation reasoning as the test above: settle onto the tile only
  // once the full chunk neighborhood is loaded, so this test is purely
  // about guard liveness, not the chunk-load race.
  await settleOnPortalTile(entry, '1', 1050, 1050, 8);

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
// Gap 2 repro (widened chunk-load gate): a guard placed by insertPortalGuards
// can land in a chunk ADJACENT to the portal's own chunk (RING_OFFSETS spread
// up to +/-60px). The gate must cover the whole radius-1 neighborhood, not
// just the single chunk under the portal tile -- otherwise a portal near a
// chunk boundary can still leak a transition while its guard's neighboring
// chunk is still loading, even though the portal's OWN chunk already
// resolved.
// ---------------------------------------------------------------------------
test('a portal must not leak a transition while a guard in an ADJACENT chunk has not finished loading', async () => {
  const pool = fakeAdjacentChunkGuardPool();
  const { url, handle, server } = await bootWith(pool);
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  await nextMsg(ws, 'joined');

  const entry = handle.worlds.get('w1');
  const p = entry.world.getPlayer('1');

  // Wait for every chunk in the portal tile's neighborhood EXCEPT the
  // guard's own (deliberately held open) to finish loading, WITHOUT ever
  // triggering the portal itself first. Park the player elsewhere INSIDE
  // the portal's own chunk (1,1) -- tile (1200,1200), far from the actual
  // trigger tile (805,1050) so portalLinks.get(...) never matches it -- so
  // recomputeActive requests that chunk's full radius-1 neighborhood (the
  // same one the portal's own tile would need) without ever evaluating
  // planPortalTransition as "on the tile" and risking a spurious blocked
  // branch.
  //
  // This sidesteps two separate masking effects that would otherwise hide
  // the real behaviour: (a) the portal's own chunk being transiently
  // unloaded too, right after the player first arrives there, which the
  // gate would ALSO correctly (for an unrelated reason) block on before the
  // guard-adjacency case is ever exercised, and (b) the 800ms cooldown that
  // first block would arm (_portalCdUntil), which silences every further
  // evaluation for the rest of this test's short observation window
  // regardless of which gate is active -- both were confirmed experimentally
  // to make an EARLIER version of this test pass identically whether the
  // widened neighborhood gate or the narrower single-chunk gate it replaced
  // was in effect.
  p.x = 1200 - p.width / 2; p.y = 1200 - p.height / 2;
  const guardKey = '0,1';
  const restOfNeighborhood = chunkNeighborhoodKeys(805, 1050, 8).filter((k) => k !== guardKey);
  const preloadDeadline = Date.now() + 2000;
  while (!restOfNeighborhood.every((k) => entry.loadedChunks.has(k))) {
    if (Date.now() > preloadDeadline) throw new Error('neighborhood (minus the guard\'s own chunk) did not pre-load in time');
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.ok(!entry.loadedChunks.has(guardKey), 'sanity: the guard\'s own chunk must still be pending at this point');

  const seenBlocked = [];
  const seenTransition = [];
  function onMsg(data) {
    const m = JSON.parse(data);
    if (m.type === 'portalBlocked') seenBlocked.push(m);
    if (m.type === 'transition') seenTransition.push(m);
  }
  ws.on('message', onMsg);

  // NOW step onto the portal tile for the first time -- every OTHER chunk
  // in the neighborhood is already loaded, so the only thing left pending
  // is the guard's own chunk. This is the precise case Gap 2 review called
  // out: the portal's own chunk (and everything else nearby) has already
  // resolved, but a guard placed in an ADJACENT chunk has not.
  p.x = 805 - p.width / 2; p.y = 1050 - p.height / 2;

  await new Promise((r) => setTimeout(r, 250)); // observe while the guard's chunk is still pending
  pool.releaseGuardChunkQuery();
  await new Promise((r) => setTimeout(r, 250)); // observe the settle once it resolves
  ws.off('message', onMsg);

  assert.ok(seenBlocked.length > 0,
    'sanity: the portal must have been observed as blocked at least once during this window');
  assert.deepStrictEqual(seenTransition, [],
    'must not leak a transition while a guard in a NEIGHBORING chunk has not finished loading, even though the portal\'s own chunk (and every other chunk in the neighborhood) already resolved');

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

  const entry1 = handle.worlds.get('w1');
  // Settle w1's portal chunk neighborhood before stepping onto the tile --
  // same isolation reasoning as the guard-liveness tests above: this test
  // is about the arrival-side latch, not the chunk-load race, so it
  // sidesteps that race rather than fighting it.
  await settleOnPortalTile(entry1, '1', 1050, 1050, 8);

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

  const entry2 = handle.worlds.get('w2');
  const p2 = entry2.world.getPlayer('1');
  const arriveX = p2.x, arriveY = p2.y;

  // Watch for BOTH message types, and track the player's own position, from
  // the moment of arrival, across a window long enough for w2's portal-tile
  // chunk neighborhood to finish loading (confirmed below). This is the
  // POSITIVE property that actually discriminates the latch fix: a
  // counterfactual run with the join-handler's `_lastPortalTile` write
  // (server.js, the block right after `entry.world.addPlayer` under
  // `spawn.viaDoorway`) deleted still passes an "assert no transition ever
  // arrived" check, because a freshly-loaded destination world starts with
  // an EMPTY entry.loadedChunks -- the separate (already-correct)
  // chunk-load gate independently blocks the very first tick regardless of
  // the latch, sends one portalBlocked, and knocks the player off the tile,
  // after which nothing is under them to fire again. "No transition" is
  // therefore true either way and proves nothing about the latch on its
  // own. What only holds if the latch is doing its job: the player is
  // STILL standing exactly at the arrival tile, with ZERO messages of any
  // kind, even once the chunk has had ample time to finish loading.
  const seenBlocked = [];
  const seenTransition = [];
  function onMsg(data) {
    const m = JSON.parse(data);
    if (m.type === 'portalBlocked') seenBlocked.push(m);
    if (m.type === 'transition') seenTransition.push(m);
  }
  ws2.on('message', onMsg);
  await new Promise((r) => setTimeout(r, 500));
  ws2.off('message', onMsg);

  const neighborhood = chunkNeighborhoodKeys(arriveX + p2.width / 2, arriveY + p2.height / 2, 8);
  assert.ok(neighborhood.every((k) => entry2.loadedChunks.has(k)),
    'sanity: the destination chunk neighborhood must have actually finished loading during the wait for this test to prove anything');

  assert.deepStrictEqual(seenBlocked, [], 'the arriving player must never receive a portalBlocked bounce');
  assert.deepStrictEqual(seenTransition, [], 'the arriving player must never receive a leaked transition either');
  assert.strictEqual(p2.x, arriveX,
    'the player must still be standing exactly at the arrival position -- proves the LATCH suppressed the portal, not a coincidentally-still-loading chunk gate');
  assert.strictEqual(p2.y, arriveY);

  ws2.close(); handle.close(); server.close();
});

test('a player who stands still on the arrival tile past the old cooldown window still does not bounce back', async () => {
  const pool = fakeMirroredPortalPool();
  const { url, handle, server } = await bootWith(pool);
  const ws1 = connect(url, 1);
  await new Promise((r) => ws1.on('open', r));
  ws1.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  await nextMsg(ws1, 'joined');

  const entry1 = handle.worlds.get('w1');
  await settleOnPortalTile(entry1, '1', 1050, 1050, 8); // let w1's portal chunk neighborhood settle, see note above
  await nextMsg(ws1, 'transition');
  ws1.close();

  const ws2 = connect(url, 1);
  await new Promise((r) => ws2.on('open', r));
  ws2.send(JSON.stringify({ type: 'join', world_id: 'w2' }));
  await nextMsg(ws2, 'joined');

  const entry2 = handle.worlds.get('w2');
  const p2 = entry2.world.getPlayer('1');
  const arriveX = p2.x, arriveY = p2.y;

  // Listen from THE MOMENT of arrival, spanning well past the OLD flat
  // cooldown window (1500ms) -- not just a tail window started after
  // sleeping past it. A tail-only listener would miss an EARLY leak
  // entirely: by 1700ms the destination chunk neighborhood is certainly
  // long finished loading (no deliberate delay in this fixture), so
  // without the latch a transition would fire almost immediately once that
  // (empty, unguarded) neighborhood resolves -- not conveniently at the
  // 1700ms mark -- and starting to listen only after that sleep would never
  // observe it.
  const seenBlocked = [];
  const seenTransition = [];
  function onMsg(data) {
    const m = JSON.parse(data);
    if (m.type === 'portalBlocked') seenBlocked.push(m);
    if (m.type === 'transition') seenTransition.push(m);
  }
  ws2.on('message', onMsg);
  await new Promise((r) => setTimeout(r, 1900));
  ws2.off('message', onMsg);

  assert.deepStrictEqual(seenBlocked, []);
  assert.deepStrictEqual(seenTransition, []);
  assert.strictEqual(p2.x, arriveX,
    'standing still past the old cooldown window must not trigger a bounce -- the latch only clears when the player actually moves off the tile');
  assert.strictEqual(p2.y, arriveY);

  ws2.close(); handle.close(); server.close();
});
