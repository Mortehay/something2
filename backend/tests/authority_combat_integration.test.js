const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const { attachAuthority } = require('../src/authority/server.js');

const SECRET = 'test-secret';

// World w1 (chunk_size 8 → chunk (0,0) center 400,400). One wolf near the
// player's spawn so it aggros. chunk insert rowCount 0 (already materialized).
function fakePool() {
  const deletes = [];
  return {
    deletes,
    query: async (sql, params) => {
      if (/FROM worlds WHERE id/i.test(sql)) return { rows: [{ id: 'w1', seed: '1', chunk_size: 8 }] };
      if (/FROM tile_types/i.test(sql)) return { rows: [{ name: 'grass', walkable: true, speed: 1 }] };
      if (/FROM entity_types WHERE is_creature/i.test(sql)) return { rows: [{ name: 'Wolf', color: '#c00', hp: 5 }] };
      // Dagger tuned as an omnidirectional hit (arc_width = full circle) so this
      // integration test doesn't depend on the player's facing at attack time.
      if (/FROM weapon_types/i.test(sql)) {
        return { rows: [
          { id: 1, name: 'dagger', kind: 'melee', damage: 10, cooldown: 0.3, reach: 90, arc_width: Math.PI * 2,
            range: null, projectile_speed: null, projectile_radius: null, pierce: null, mana_cost: 0, element: null },
        ] };
      }
      if (/INSERT INTO world_chunks/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/FROM world_players WHERE/i.test(sql)) return { rows: [] }; // spawn = center 400,400
      // DELETE check must come before the generic bbox-SELECT check below:
      // the DELETE SQL text also contains the substring "FROM world_creatures".
      if (/DELETE FROM world_creatures/i.test(sql)) { deletes.push(params[0]); return { rows: [] }; }
      if (/FROM world_creatures/i.test(sql)) {
        // bbox load for chunk (0,0): a wolf ~10px from the player center.
        if (params[1] === 0) return { rows: [{ id: 'wolf1', type: 'Wolf', x: 410, y: 400, hp: 5, facing: 'S', color: '#c00' }] };
        return { rows: [] };
      }
      if (/UPDATE world_creatures/i.test(sql)) return { rows: [] };
      if (/INSERT INTO world_players/i.test(sql)) return { rows: [] };
      return { rows: [] };
    },
  };
}
function token(u) { return jwt.sign({ user_id: u }, SECRET, { algorithm: 'HS256' }); }
function bootWith(pool) {
  return new Promise((resolve) => {
    const server = http.createServer();
    const handle = attachAuthority(server, pool, { jwtSecret: SECRET, tickMs: 20, creatureBroadcastEvery: 2, creatureFlushMs: 10000 });
    server.listen(0, () => resolve({ url: `ws://127.0.0.1:${server.address().port}/authority`, handle, server }));
  });
}
function connect(url, uid) { return new WebSocket(`${url}?token=${encodeURIComponent(token(uid))}`); }
function nextMsg(ws, type) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`timeout ${type}`)), 3000);
    ws.on('message', function onMsg(data) {
      const m = JSON.parse(data);
      if (!type || m.type === type) { clearTimeout(to); ws.off('message', onMsg); resolve(m); }
    });
  });
}

test('an adjacent aggro creature damages the player (state.hp drops)', async () => {
  const { url, handle, server } = await bootWith(fakePool());
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  const joined = await nextMsg(ws, 'joined');
  let hurt = false;
  for (let i = 0; i < 60 && !hurt; i++) {
    const s = await nextMsg(ws, 'state');
    const me = s.players.find((p) => p.id === '1');
    if (me && me.hp < me.maxHp) hurt = true;
  }
  assert.ok(hurt, 'player took contact damage');
  ws.close(); handle.close(); server.close();
});

test('attack kills an adjacent creature (DELETE issued, gone from creatures)', async () => {
  const pool = fakePool();
  const { url, handle, server } = await bootWith(pool);
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  await nextMsg(ws, 'joined');
  // Chunk activation (DB roundtrip) races the first broadcast — the first
  // 'creatures' message is always empty because recomputeActive() kicks off
  // activateChunk() (async) and broadcastCreatures() runs synchronously right
  // after, before that promise resolves. Wait for a broadcast that actually
  // contains the wolf before attacking.
  let loaded = false;
  for (let i = 0; i < 20 && !loaded; i++) {
    const m = await nextMsg(ws, 'creatures');
    if (m.creatures.some((c) => c.id === 'wolf1')) loaded = true;
  }
  assert.ok(loaded, 'wolf loaded before attack');
  // Two attacks (5 hp wolf, 10 dmg) — one is enough; cooldown-safe with a gap.
  ws.send(JSON.stringify({ type: 'attack' }));
  let gone = false;
  for (let i = 0; i < 40 && !gone; i++) {
    const m = await nextMsg(ws, 'creatures');
    if (!m.creatures.some((c) => c.id === 'wolf1')) gone = true;
  }
  assert.ok(gone, 'wolf removed after attack');
  assert.ok(pool.deletes.includes('wolf1'), 'DELETE issued for the killed creature');
  ws.close(); handle.close(); server.close();
});
