const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const { attachAuthority } = require('../src/authority/server.js');

const SECRET = 'test-secret';

// Pool: world w1 (chunk_size 8), grass tiles, one is_creature type, one
// pre-existing creature near chunk (0,0). Chunk insert reports 0 rows (already
// materialized) so spawn is skipped and the load path is exercised directly.
// Player spawn: user 1 at world center (chunk 0,0 area); user 2 persisted far away.
function fakePool() {
  const updates = [];
  return {
    updates,
    query: async (sql, params) => {
      if (/FROM worlds WHERE id/i.test(sql)) return { rows: [{ id: 'w1', seed: '1', chunk_size: 8 }] };
      if (/FROM tile_types/i.test(sql)) return { rows: [{ name: 'grass', walkable: true, speed: 1 }] };
      if (/FROM entity_types WHERE is_creature/i.test(sql)) return { rows: [{ name: 'Wolf', color: '#c0392b', hp: 10 }] };
      if (/INSERT INTO world_chunks/i.test(sql)) return { rows: [], rowCount: 0 }; // already materialized
      if (/FROM world_players WHERE/i.test(sql)) {
        const uid = params[1];
        if (uid === '2') return { rows: [{ x: 100000, y: 100000 }] }; // far away
        return { rows: [] }; // user 1 → default center
      }
      if (/FROM world_creatures/i.test(sql)) {
        // bbox load: return the wolf only for chunk (0,0) span [0,800).
        const xMin = params[1];
        if (xMin === 0) return { rows: [{ id: 'wolf1', type: 'Wolf', x: 380, y: 380, hp: 10, facing: 'S', color: '#c0392b' }] };
        return { rows: [] };
      }
      if (/UPDATE world_creatures/i.test(sql)) { updates.push(params); return { rows: [] }; }
      if (/INSERT INTO world_players/i.test(sql)) return { rows: [] };
      return { rows: [] };
    },
  };
}

function token(u) { return jwt.sign({ user_id: u }, SECRET, { algorithm: 'HS256' }); }
function bootWith(pool) {
  return new Promise((resolve) => {
    const server = http.createServer();
    const handle = attachAuthority(server, pool, {
      jwtSecret: SECRET, tickMs: 20, creatureBroadcastEvery: 2, creatureFlushMs: 100,
    });
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

test('a joined player receives its neighborhood creatures and they roam', async () => {
  const { url, handle, server } = await bootWith(fakePool());
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  await nextMsg(ws, 'joined');

  // Collect a couple of creature messages; the wolf should appear and move.
  let first = null, moved = null;
  for (let i = 0; i < 40 && !moved; i++) {
    const m = await nextMsg(ws, 'creatures');
    const w = m.creatures.find((c) => c.id === 'wolf1');
    if (w && !first) first = { ...w };
    if (w && first && (w.x !== first.x || w.y !== first.y)) moved = w;
  }
  assert.ok(first, 'wolf appeared in a creatures message');
  assert.ok(moved, 'wolf roamed over ticks');
  ws.close(); handle.close(); server.close();
});

test('AOI: a far player does not receive the wolf', async () => {
  const { url, handle, server } = await bootWith(fakePool());
  const ws = connect(url, 2); // persisted far away
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  await nextMsg(ws, 'joined');
  let sawWolf = false;
  for (let i = 0; i < 10; i++) {
    const m = await nextMsg(ws, 'creatures');
    if (m.creatures.some((c) => c.id === 'wolf1')) sawWolf = true;
  }
  assert.equal(sawWolf, false, 'far player must not see the near wolf');
  ws.close(); handle.close(); server.close();
});

test('dirty creatures are flushed with UPDATEs', async () => {
  const pool = fakePool();
  const { url, handle, server } = await bootWith(pool);
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  await nextMsg(ws, 'joined');
  // Let it roam + hit the 100ms creature flush a few times.
  for (let i = 0; i < 20; i++) await nextMsg(ws, 'creatures');
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(pool.updates.length > 0, 'creature positions were flushed via UPDATE');
  ws.close(); handle.close(); server.close();
});
