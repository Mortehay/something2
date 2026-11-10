// Amber Stance through the real authority (attachAuthority with amber: true),
// a fake pool and a real WebSocket client -- the portal_blocking_live.test.js
// harness. No DB.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const { attachAuthority, AMBER_REFUSAL } = require('../src/authority/server.js');
const teleportCast = require('../src/authority/teleportCast.js');

const SECRET = 'test-secret-amber-live';
const token = (u) => jwt.sign({ user_id: u, tv: 1 }, SECRET, { algorithm: 'HS256' });

const open = [];
test.afterEach(() => { while (open.length) { try { open.pop().close(); } catch { /* closed */ } } });

function boot(pool, opts) {
  return new Promise((resolve) => {
    const server = http.createServer();
    const handle = attachAuthority(server, pool, { jwtSecret: SECRET, tickMs: 20, creatureBroadcastEvery: 2, creatureFlushMs: 10000, ...opts });
    open.push({ close() { handle.close(); if (server.listening) server.close(); } });
    server.listen(0, () => resolve({ url: `ws://127.0.0.1:${server.address().port}/authority`, handle }));
  });
}
function connect(url, uid) {
  const ws = new WebSocket(`${url}?token=${encodeURIComponent(token(uid))}`);
  open.push({ close() { ws.terminate(); } });
  return ws;
}
function nextMsg(ws, pred, label) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => { ws.off('message', on); reject(new Error(`timeout waiting for ${label}`)); }, 3000);
    function on(data) {
      const m = JSON.parse(data);
      if (pred(m)) { clearTimeout(to); ws.off('message', on); resolve(m); }
    }
    ws.on('message', on);
  });
}
const ofType = (t) => (m) => m.type === t;
function collect(ws, type, ms) {
  return new Promise((resolve) => {
    const out = [];
    const on = (data) => { const m = JSON.parse(data); if (m.type === type) out.push(m); };
    ws.on('message', on);
    setTimeout(() => { ws.off('message', on); resolve(out); }, ms);
  });
}

// One world w1 with an unguarded portal at (1050,1050) -> w2.
function fakePool() {
  function route(sql, params) {
    if (/FROM characters/i.test(sql)) return { rows: [{ id: Number(params[0]), entity_type_id: 1 }] };
    if (/FROM worlds w WHERE w\.id/i.test(sql)) return { rows: [{ is_entry: true, allows_fast_travel: false, visited: false, visited_any: false, last_world: null }] };
    if (/FROM worlds WHERE id/i.test(sql)) return { rows: [{ id: 'w1', seed: '1', chunk_size: 8 }] };
    if (/FROM tile_types/i.test(sql)) return { rows: [{ name: 'grass', walkable: true, speed: 1 }] };
    if (/token_version.*FROM users WHERE/i.test(sql)) return { rows: [{ token_version: 1 }] };
    if (/FROM item_types/i.test(sql)) {
      return { rows: [{ id: 1, name: 'dagger', category: 'weapon', slot: 'main_hand', two_handed: false, kind: 'melee',
        damage: 8, cooldown: 0.3, reach: 80, arc_width: 6.3, range: null, projectile_speed: null,
        projectile_radius: null, pierce: null, mana_cost: 0, element: null, defense: null, resistances: null }] };
    }
    if (/FROM player_items/i.test(sql)) return { rows: [{ id: 'i1', item_type_id: 1 }] };
    if (/SELECT gold FROM users/i.test(sql)) return { rows: [{ gold: 0 }] };
    if (/FROM player_progression/i.test(sql) && !/^\s*INSERT/i.test(sql)) {
      return { rows: [{ user_id: '1', experience: '0', level: 1, stat_points: 0,
        strength: 5, dexterity: 5, constitution: 5, intelligence: 5, wisdom: 5, charisma: 5 }] };
    }
    if (/FROM map_links ml JOIN worlds/i.test(sql)) {
      return { rows: [{ id: 'link-1', edge: 'PORTAL', to_world_id: 'w2', to_width: 20, to_height: 20,
        from_x: 1050, from_y: 1050, to_x: 550, to_y: 550 }] };
    }
    return { rows: [] };
  }
  const pool = { query: async (sql, params) => route(sql, params) };
  pool.connect = async () => ({ query: async (sql, params) => route(sql, params), release() {} });
  return pool;
}

async function joinSealed() {
  const { url, handle } = await boot(fakePool(), { amber: true });
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', character_id: 1, world_id: 'w1' }));
  await nextMsg(ws, ofType('joined'), 'joined');
  const entry = handle.worlds.get('w1');
  const p = entry.world.getPlayer('1');
  return { ws, handle, entry, p };
}

// Ends the seal through the real client frames: ready, then break.
async function breakOut(ws, entry, p) {
  const a = p.amber.arrival;
  ws.send(JSON.stringify({ type: 'amberReady', arrival: a }));
  ws.send(JSON.stringify({ type: 'amberBreak', arrival: a }));
  const deadline = Date.now() + 2000;
  while (p.amber) {
    if (Date.now() > deadline) throw new Error('amberReady/amberBreak frames did not end the seal');
    await new Promise((r) => setTimeout(r, 10));
  }
}

// Stands the player at top-left (x,y) until the radius-1 chunk neighbourhood
// the portal check needs has loaded (re-placing every poll, as the portal
// tests' settleOnPortalTile does).
async function standAt(entry, p, x, y) {
  const deadline = Date.now() + 3000;
  const cx = Math.floor(Math.floor(x / 100) / 8), cy = Math.floor(Math.floor(y / 100) / 8);
  for (;;) {
    let all = true;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (!entry.loadedChunks.has(`${cx + dx},${cy + dy}`)) all = false;
    p.x = x; p.y = y;
    if (all) return;
    if (Date.now() > deadline) throw new Error('chunks did not load');
    await new Promise((r) => setTimeout(r, 15));
  }
}

test('a joined player is sealed and the snapshot says so', async () => {
  const { ws, p } = await joinSealed();
  assert.ok(p.amber, 'join sealed the player (amber: true reached the world)');
  const snap = await nextMsg(ws, (m) => m.type === 'snapshot' || m.type === 'state' || Array.isArray(m.players), 'a snapshot');
  const me = snap.players.find((x) => String(x.id) === '1');
  assert.ok(me && me.amber && me.amber.a === p.amber.arrival);
});

test('a portal under a sealed player does not fire; it fires once the seal is broken', async () => {
  const { ws, entry, p } = await joinSealed();
  // Collect from BEFORE the first step onto the tile: a transition fired
  // while the chunks were still loading must count as a leak too.
  const leakWatch = collect(ws, 'transition', 3300);
  await standAt(entry, p, 1050 - p.width / 2, 1050 - p.height / 2);
  // The watch runs 3.3 s in all: at least 300 ms (15 ticks) on the tile.
  const leaked = await leakWatch;
  assert.deepEqual(leaked, [], 'no transition while sealed');
  assert.equal(p.x, 1050 - p.width / 2, 'still standing on the portal');
  const waiting = nextMsg(ws, ofType('transition'), 'transition after the seal');
  await breakOut(ws, entry, p);
  const t = await waiting;
  assert.equal(t.toWorldId, 'w2');
});

test('world-object use, attack and skill are refused with amber while sealed', async () => {
  const { ws, entry, p } = await joinSealed();
  ws.send(JSON.stringify({ type: 'openbank' }));
  const e = await nextMsg(ws, ofType('error'), 'openbank refusal');
  assert.equal(e.message, AMBER_REFUSAL);
  ws.send(JSON.stringify({ type: 'attack', ax: 1, ay: 0 }));
  const ar = await nextMsg(ws, ofType('attackrefused'), 'attackrefused');
  assert.equal(ar.reason, 'amber');
  ws.send(JSON.stringify({ type: 'castSkill', skillId: 'mag_fireball', targetX: 0, targetY: 0, ax: 1, ay: 0 }));
  const sr = await nextMsg(ws, ofType('skillRefused'), 'skillRefused');
  assert.equal(sr.reason, 'amber');

  // Control: the same frame, unsealed, reaches the handler's own logic.
  await breakOut(ws, entry, p);
  ws.send(JSON.stringify({ type: 'openbank' }));
  const e2 = await nextMsg(ws, ofType('error'), 'openbank after the seal');
  assert.equal(e2.message, 'no bank nearby');
});

test('dying with a teleport cast running cancels it with reason amber on respawn', async () => {
  const { ws, entry, p } = await joinSealed();
  await breakOut(ws, entry, p);
  teleportCast.beginCast(p, Date.now());
  // The killing blow lands AFTER this tick's cast check (creature and
  // projectile damage resolve later in the tick than checkCast), so the
  // cast's own 'hurt' interrupt has not seen it: model that by recording the
  // cast's last-seen hp as 0. Then only the respawn path can cancel it.
  p._teleportCast.hp = 0;
  const cancelled = nextMsg(ws, ofType('teleportCancelled'), 'teleportCancelled');
  p.hp = 0;
  const m = await cancelled;
  assert.equal(m.reason, 'amber');
  assert.ok(p.amber, 'the respawn sealed the player');
  assert.equal(teleportCast.isCasting(p), false);
});
