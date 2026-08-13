// Logging back in while standing ON a portal tile (SOMET-299 follow-up).
//
// WHY THIS EXISTS. `_arrivalTile` -- the compass-doorway latch -- is set on
// EVERY join (authority/server.js, the block just before the joined frame).
// `_lastPortalTile`, the portal equivalent, is set only `if (spawn.viaDoorway)`.
// So a character who logs out standing on a portal tile resumes with no portal
// latch at all and is warped on its first tick, before it can move.
//
// That is precisely the bug SOMET-271 fixed on the doorway path, whose comment
// records the reasoning: "a character's saved position in a world is very often
// the doorway it walked out through, so arriving there threw it straight back."
// A portal pad outside every home-region village gate (SOMET-299) makes the
// portal version of that far more reachable -- it is now ordinary ground a new
// player idles on, not a staircase deep in a dungeon.
//
// Driven through a real attachAuthority, because the whole question is what the
// TICK LOOP does with a resumed player; a unit test of planPortalTransition
// would assert the pure function's contract and say nothing about whether the
// join path ever arms the latch it reads.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const { attachAuthority } = require('../src/authority/server.js');

const SECRET = 'test-secret-portal-resume';
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
function waitFor(ws, type, ms) {
  return new Promise((resolve) => {
    const to = setTimeout(() => resolve(null), ms);
    ws.on('message', function onMsg(data) {
      const m = JSON.parse(data);
      if (m.type === type) { clearTimeout(to); ws.off('message', onMsg); resolve(m); }
    });
  });
}

// The portal sits on tile (30,28); the saved position is that same tile, which
// is what "logged out standing on the portal" means.
const PORTAL_X = 2850, PORTAL_Y = 3050;

function fakePool({ savedX = PORTAL_X, savedY = PORTAL_Y } = {}) {
  const calls = [];
  function route(sql, params) {
    if (/FROM characters/i.test(sql)) return { rows: [{ id: Number(params[0]), entity_type_id: 1 }] };
    if (/FROM worlds w WHERE w\.id/i.test(sql)) {
      return { rows: [{ is_entry: true, allows_fast_travel: false, visited: true, visited_any: true, last_world: 'w1' }] };
    }
    if (/FROM worlds WHERE id/i.test(sql)) return { rows: [{ id: 'w1', seed: '1', chunk_size: 8 }] };
    if (/FROM tile_types/i.test(sql)) return { rows: [{ name: 'grass', walkable: true, speed: 1 }] };
    if (/token_version.*FROM users WHERE/i.test(sql)) return { rows: [{ token_version: 1 }] };
    // THE SAVED POSITION. This is the resume path: the player is put back
    // exactly where it logged out, which here is the portal's own tile.
    if (/FROM world_players WHERE/i.test(sql)) return { rows: [{ x: savedX, y: savedY }] };
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
        id: 'pl-1', edge: 'PORTAL', to_world_id: 'w2', to_width: 64, to_height: 64,
        to_name: 'Somewhere Else', from_x: PORTAL_X, from_y: PORTAL_Y, to_x: 500, to_y: 500,
      }] };
    }
    if (/FROM villages WHERE/i.test(sql)) return { rows: [] };
    if (/FROM waypoints WHERE world_id/i.test(sql)) return { rows: [] };
    if (/FROM character_waypoints WHERE character_id/i.test(sql)) return { rows: [] };
    if (/FROM world_creatures wc/i.test(sql)) return { rows: [] };
    if (/FROM world_items/i.test(sql)) return { rows: [] };
    return { rows: [] };
  }
  const pool = {
    calls,
    query: async (sql, params) => { calls.push({ sql, params }); return route(sql, params); },
  };
  pool.connect = async () => ({
    query: async (sql, params) => { calls.push({ sql, params }); return route(sql, params); },
    release() {},
  });
  return pool;
}


// Placing the player and waiting for the chunk neighbourhood planPortalTransition
// requires. Copied from portal_blocking_live.test.js, which documents why the
// anchor is the player's TOP-LEFT (x - width/2), not the centre: at a chunk
// boundary the two disagree by a whole chunk and the gate would demand a chunk
// recomputeActive never loads. PORTAL_X/Y here sit well inside a chunk, so the
// two anchors agree.
function chunkNeighborhoodKeys(x, y, chunkSize) {
  const gCol = Math.floor(x / 100), gRow = Math.floor(y / 100);
  const cx = Math.floor(gCol / chunkSize), cy = Math.floor(gRow / chunkSize);
  const keys = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) keys.push(`${cx + dx},${cy + dy}`);
  return keys;
}

async function settleOnTile(entry, playerId, x, y, chunkSize, timeoutMs = 3000) {
  const p = entry.world.getPlayer(playerId);
  const keys = chunkNeighborhoodKeys(x - p.width / 2, y - p.height / 2, chunkSize);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    p.x = x - p.width / 2; p.y = y - p.height / 2;
    if (keys.every((k) => entry.loadedChunks.has(k))) return p;
    if (Date.now() > deadline) {
      throw new Error(`chunk neighborhood for (${x},${y}) did not load: missing ${
        keys.filter((k) => !entry.loadedChunks.has(k)).join(', ')}`);
    }
    await new Promise((r) => setTimeout(r, 15));
  }
}

// POSITIVE CONTROL, and the reason the negative test below is worth anything.
//
// planPortalTransition refuses for several reasons that have nothing to do with
// the arrival latch -- an unloaded chunk neighbourhood is one. If the tick loop
// simply could not fire a transition in this harness within the window, the
// negative test would pass no matter what the latch did. This proves the
// machinery IS armed and firing here: a player who walks onto the same tile
// warps.
test('the harness can fire a portal transition at all -- walking onto the tile warps', async () => {
  const { url, handle } = await bootWith(fakePool({ savedX: 100, savedY: 100 }));
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', character_id: 7, world_id: 'w1' }));
  await waitFor(ws, 'joined', 3000);

  const entry = handle.worlds.get('w1');
  // Step onto the portal tile the way walking does, once the chunk gate is open.
  await settleOnTile(entry, '1', PORTAL_X, PORTAL_Y, 8);

  const t = await waitFor(ws, 'transition', 2000);
  assert.ok(t, 'the portal never fired -- the negative test below would prove nothing');
});

test('resuming ON a portal tile does not warp the player before they can move', async () => {
  const { url, handle } = await bootWith(fakePool());
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', character_id: 7, world_id: 'w1' }));
  const joined = await waitFor(ws, 'joined', 3000);
  assert.ok(joined, 'the join must succeed');
  assert.strictEqual(joined.spawn.viaDoorway, false,
    'this is the RESUME path -- if it ever becomes a doorway arrival the latch is armed and this test proves nothing');

  // Positive control: the player really is standing on the portal's tile, so a
  // "no transition" result cannot pass for the wrong reason.
  assert.strictEqual(Math.floor(joined.spawn.y / 100), Math.floor(PORTAL_Y / 100));
  assert.strictEqual(Math.floor(joined.spawn.x / 100), Math.floor(PORTAL_X / 100));

  // Open the chunk gate WITHOUT moving the player: settleOnTile re-places it on
  // the very tile resume already put it on. Without this the transition could
  // not fire for a reason that has nothing to do with the latch, and this
  // negative assertion would be worth nothing -- which is exactly what the
  // first version of this test was, until the positive control above caught it.
  const entry = handle.worlds.get('w1');
  await settleOnTile(entry, '1', PORTAL_X, PORTAL_Y, 8);

  // ~30 ticks at tickMs 20. Nothing to await for a negative, so wait it out.
  const t = await waitFor(ws, 'transition', 600);
  assert.strictEqual(t, null,
    'a player who logged out on a portal tile was teleported on resume, before touching a key');
});
