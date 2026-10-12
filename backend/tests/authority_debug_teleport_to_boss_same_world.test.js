const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const { attachAuthority } = require('../src/authority/server.js');

// SOMET-623: teleport_to_boss used the cross-world `transition` frame
// unconditionally -- pendingArrivals + a `transition` telling the client to
// enter the world it is already in. When the admin is already standing in
// the boss's world that frame is a no-op (joinPolicy/the client ignore a
// transition into the current world), so the admin had to walk to the arena
// by hand. The fix (backend/src/authority/server.js, 'teleport_to_boss'
// branch) detects the same-world case and repositions the player directly
// instead: a plain x/y assignment plus persist(), mirroring the death-respawn
// "Same world is the common case" branch a few hundred lines up in the same
// file. These tests exercise that branch end-to-end over a real (fake-pool)
// authority socket, plus the pre-existing cross-world path and two edge cases
// named in the ticket: a dead/missing boss, and a boss standing on a tile
// with no walkable neighbour.
//
// Harness copied from authority_debug_world_boss_gate.test.js.

const SECRET = 'test-secret';

function token(u) { return jwt.sign({ user_id: u, tv: 1 }, SECRET, { algorithm: 'HS256' }); }

function makePool(role = 'admin') {
  const calls = [];
  const pool = {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/FROM worlds WHERE id/i.test(sql)) {
        return { rows: [{
          id: 'w1', seed: '1', chunk_size: 64, width: 10, height: 10,
          is_entry: null, entry_spawn: null, biomes: [], biome_cell: null,
          level_min: 1, level_max: 5,
        }] };
      }
      if (/token_version.*FROM users WHERE/i.test(sql)) return { rows: [{ token_version: 1, role }] };
      if (/FROM characters/i.test(sql)) return { rows: [{ id: Number(params[0]) || 1, entity_type_id: 1 }] };
      if (/FROM worlds w WHERE w\.id/i.test(sql)) return { rows: [{ is_entry: true, allows_fast_travel: false, visited: false, visited_any: false, last_world: null }] };
      if (/FROM tile_types/i.test(sql)) return { rows: [{ name: 'grass', walkable: true, speed: 1 }] };
      if (/rowCount/.test(sql)) return { rows: [], rowCount: 0 };
      if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) return { rows: [], rowCount: 0 };
      return { rows: [] };
    },
  };
  pool.connect = async () => ({ query: pool.query, release: () => {} });
  return pool;
}

async function boot(role = 'admin') {
  const pool = makePool(role);
  const server = http.createServer();
  const handle = attachAuthority(server, pool, {
    jwtSecret: SECRET, tickMs: 20, creatureBroadcastEvery: 2, creatureFlushMs: 100,
  });
  await new Promise((r) => server.listen(0, r));
  const url = `ws://127.0.0.1:${server.address().port}/authority`;
  const ws = new WebSocket(`${url}?token=${encodeURIComponent(token(1))}`);
  const frames = [];
  ws.on('message', (d) => frames.push(JSON.parse(d)));
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', character_id: 1, world_id: 'w1' }));
  await waitFor(() => frames.some((f) => f.type === 'joined'));
  return { pool, server, handle, ws, frames };
}

async function waitFor(pred, ms = 3000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function close({ ws, handle, server }) { ws.close(); handle.close(); server.close(); }

// Puts the manager into the shape the 'teleport_to_boss' handler reads:
// state 'active', an activeWorldId, and (optionally) a live creature in that
// world's sim. Mirrors what worldBoss.js's own forceSpawn leaves behind,
// without going through the full spawn flow (which needs a seeded catalog).
function primeBoss(handle, { worldId, bossX, bossY, addLiveCreature = true }) {
  const mgr = handle._worldBossManager;
  mgr.state = 'active';
  mgr.activeWorldId = worldId;
  mgr.activeArenaName = 'Test Arena';
  mgr.activeWorldName = 'Test World';
  mgr.targetSpawnX = bossX;
  mgr.targetSpawnY = bossY;
  mgr.currentBoss = { name: 'Test Boss', _playerDamage: new Map() };
  mgr.bossCreatureId = 'boss-1';
  if (addLiveCreature) {
    const entry = handle.worlds.get(worldId);
    entry.world.creatures.addCreatures([
      { id: 'boss-1', type: 'test_boss', x: bossX, y: bossY, hp: 9999, name: 'Test Boss', bossTier: 1, quietSpawn: true },
    ]);
  }
}

test('teleport_to_boss, same world: repositions the player near the boss, no transition frame', async () => {
  const h = await boot('admin');
  try {
    const entry = h.handle.worlds.get('w1');
    const livePlayer = entry.world.getPlayer('1');
    assert.ok(livePlayer, 'admin player must exist in w1 after join');
    // Snapshot plain values, not the live object -- getPlayer() returns the
    // SAME mutable player the handler edits in place, so holding a reference
    // here would silently pick up the post-teleport position too.
    const before = { x: livePlayer.x, y: livePlayer.y };

    primeBoss(h.handle, { worldId: 'w1', bossX: 500, bossY: 500 });

    const framesBefore = h.frames.length;
    h.ws.send(JSON.stringify({ type: 'debugWorldBoss', action: 'teleport_to_boss' }));
    await waitFor(() => h.frames.slice(framesBefore).some((f) => f.type === 'announcement' && f.kind === 'boss_teleport'));
    await new Promise((r) => setTimeout(r, 50));

    const after = h.frames.slice(framesBefore);
    assert.deepEqual(after.filter((f) => f.type === 'transition'), [], 'same-world teleport must not send a transition frame');

    const p = entry.world.getPlayer('1');
    const dist = Math.hypot(p.x - 500, p.y - 500);
    assert.ok(dist <= 120, `player should land within ~1 offset step of the boss, got dist=${dist} (x=${p.x}, y=${p.y})`);
    assert.ok(!(p.x === before.x && p.y === before.y), 'player position must actually change');

    const write = h.pool.calls.find((c) => /INSERT INTO world_players/i.test(c.sql) && c.params[1] === 1);
    assert.ok(write, 'teleport_to_boss (same world) must persist the new position');
    assert.equal(write.params[2], p.x);
    assert.equal(write.params[3], p.y);
  } finally { close(h); }
});

test('teleport_to_boss, same world, boss missing/dead: falls back to the arena point without crashing', async () => {
  const h = await boot('admin');
  try {
    const entry = h.handle.worlds.get('w1');
    primeBoss(h.handle, { worldId: 'w1', bossX: 300, bossY: 300, addLiveCreature: false });
    // bossCreatureId points at a creature that is not (or no longer) in the sim.
    assert.equal(entry.world.creatures.get('boss-1'), undefined);

    const framesBefore = h.frames.length;
    h.ws.send(JSON.stringify({ type: 'debugWorldBoss', action: 'teleport_to_boss' }));
    await waitFor(() => h.frames.slice(framesBefore).some((f) => f.type === 'announcement' && f.kind === 'boss_teleport'));
    await new Promise((r) => setTimeout(r, 50));

    assert.deepEqual(h.frames.slice(framesBefore).filter((f) => f.type === 'error'), [], 'a missing live boss must not error');
    const p = entry.world.getPlayer('1');
    const dist = Math.hypot(p.x - 300, p.y - 300);
    assert.ok(dist <= 120, `player should still land near the arena point, got dist=${dist}`);
  } finally { close(h); }
});

test('teleport_to_boss, same world, boss on a tile with no walkable neighbour: lands on the boss point, does not throw', async () => {
  const h = await boot('admin');
  try {
    const entry = h.handle.worlds.get('w1');
    primeBoss(h.handle, { worldId: 'w1', bossX: 640, bossY: 640 });

    const realIsWalkable = entry.world.map.isWalkable.bind(entry.world.map);
    entry.world.map.isWalkable = () => false; // every tile blocked -- no safe neighbour exists
    try {
      const framesBefore = h.frames.length;
      h.ws.send(JSON.stringify({ type: 'debugWorldBoss', action: 'teleport_to_boss' }));
      await waitFor(() => h.frames.slice(framesBefore).some((f) => f.type === 'announcement' && f.kind === 'boss_teleport'));
      await new Promise((r) => setTimeout(r, 50));

      assert.deepEqual(h.frames.slice(framesBefore).filter((f) => f.type === 'error'), [], 'an all-blocked map must not error or crash the socket');
      const p = entry.world.getPlayer('1');
      // knockbackWithFallback's documented all-or-nothing guarantee: with no
      // walkable candidate at any retry distance, it returns the origin point
      // unmoved -- here, the boss's own position -- rather than throwing or
      // silently doing nothing.
      assert.equal(Math.round(p.x), 640);
      assert.equal(Math.round(p.y), 640);
    } finally {
      entry.world.map.isWalkable = realIsWalkable;
    }
  } finally { close(h); }
});

test('teleport_to_boss, cross world: still uses the transition frame (regression guard)', async () => {
  const h = await boot('admin');
  try {
    primeBoss(h.handle, { worldId: 'w2', bossX: 200, bossY: 200, addLiveCreature: false });

    const framesBefore = h.frames.length;
    h.ws.send(JSON.stringify({ type: 'debugWorldBoss', action: 'teleport_to_boss' }));
    await waitFor(() => h.frames.slice(framesBefore).some((f) => f.type === 'transition'));

    const t = h.frames.slice(framesBefore).find((f) => f.type === 'transition');
    assert.equal(t.toWorldId, 'w2');
    assert.equal(t.arriveX, 280); // 200 + 80, unchanged from the pre-existing cross-world math
    assert.equal(t.arriveY, 280);
  } finally { close(h); }
});
