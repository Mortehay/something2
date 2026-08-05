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

test('a guard-blocked portal refuses transfer and knocks the player back', async () => {
  const pool = fakePortalPool();
  const { url, handle, server } = await bootWith(pool);
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  const joined = await nextMsg(ws, 'joined');
  assert.ok(joined.spawn, 'joined message must include a spawn point to walk from');

  // Walk the player directly onto the portal tile (1050,1050) via a raw
  // world-state mutation -- movement input itself is covered elsewhere;
  // this test is about what happens once a player IS on the tile.
  const world = handle.worlds.get('w1').world;
  const p = world.getPlayer('1');
  p.x = 1050 - p.width / 2; p.y = 1050 - p.height / 2;

  const blocked = await nextMsg(ws, 'portalBlocked');
  assert.equal(blocked.message, 'Guards block the way.');

  await new Promise((r) => setTimeout(r, 60)); // let the same tick's knockback land
  assert.ok(Math.abs((p.x + p.width / 2) - 1050) > 1 || Math.abs((p.y + p.height / 2) - 1050) > 1,
    'the player must have been pushed off the exact portal tile');

  const transitions = await collectMsgs(ws, 'transition', 150);
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

  const p = world.getPlayer('1');
  p.x = 1050 - p.width / 2; p.y = 1050 - p.height / 2;

  const t = await nextMsg(ws, 'transition');
  assert.deepStrictEqual(
    { toWorldId: t.toWorldId, arriveX: t.arriveX, arriveY: t.arriveY },
    { toWorldId: 'w2', arriveX: 550, arriveY: 550 });

  ws.close(); handle.close(); server.close();
});
