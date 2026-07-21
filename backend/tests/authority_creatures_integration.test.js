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
      if (/token_version FROM users WHERE/i.test(sql)) return { rows: [{ token_version: 1 }] }; // matches token()'s tv:1 → passes the on-connect version check
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

// Same as fakePool but the world_creatures bbox SELECT for chunk (0,0) throws
// once (simulating a transient pg error) before succeeding on the next call.
// Used to prove a failed chunk activation is retried on a later recompute
// instead of being permanently marked active with no creatures loaded.
function fakePoolFlaky() {
  let thrown = false;
  return {
    query: async (sql, params) => {
      if (/FROM worlds WHERE id/i.test(sql)) return { rows: [{ id: 'w1', seed: '1', chunk_size: 8 }] };
      if (/token_version FROM users WHERE/i.test(sql)) return { rows: [{ token_version: 1 }] }; // matches token()'s tv:1 → passes the on-connect version check
      if (/FROM tile_types/i.test(sql)) return { rows: [{ name: 'grass', walkable: true, speed: 1 }] };
      if (/FROM entity_types WHERE is_creature/i.test(sql)) return { rows: [{ name: 'Wolf', color: '#c0392b', hp: 10 }] };
      if (/INSERT INTO world_chunks/i.test(sql)) return { rows: [], rowCount: 0 }; // already materialized
      if (/FROM world_players WHERE/i.test(sql)) return { rows: [] }; // user 1 → default center
      if (/FROM world_creatures/i.test(sql)) {
        // bbox load: chunk (0,0) spans x in [0,800) AND y in [0,800). Neighbor
        // chunks like (0,-1)/(-1,0) share one of those bounds (xMin or yMin
        // === 0) but not both, so checking only xMin would let a neighbor's
        // one-time throw get consumed before it reaches chunk (0,0).
        const [xMin, , yMin] = [params[1], params[2], params[3]];
        if (xMin === 0 && yMin === 0) {
          if (!thrown) { thrown = true; throw new Error('transient pg error'); }
          return { rows: [{ id: 'wolf1', type: 'Wolf', x: 380, y: 380, hp: 10, facing: 'S', color: '#c0392b' }] };
        }
        return { rows: [] };
      }
      if (/UPDATE world_creatures/i.test(sql)) return { rows: [] };
      if (/INSERT INTO world_players/i.test(sql)) return { rows: [] };
      return { rows: [] };
    },
  };
}

function token(u) { return jwt.sign({ user_id: u, tv: 1 }, SECRET, { algorithm: 'HS256' }); }
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

// The second half of the loader trap: loadCreatureTypes has its own guard
// test, but the per-chunk world_creatures join is what actually feeds
// CreatureSim.addCreatures. Dropping et.defense/et.resistances from it loads
// them as undefined, every creature spawns with an inert `mit`, and every
// maths test still passes. The fake pool ignores the SQL text, so assert on it.
test('the chunk creature load SELECTs the columns CreatureSim maps into `mit`', async () => {
  const sqls = [];
  const base = fakePool();
  const pool = { query: async (sql, params) => { sqls.push(sql); return base.query(sql, params); } };
  const { url, handle, server } = await bootWith(pool);
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  await nextMsg(ws, 'joined');
  await nextMsg(ws, 'creatures');

  const sel = sqls.find((s) => /SELECT/i.test(s) && /FROM world_creatures/i.test(s));
  assert.ok(sel, 'chunk activation must SELECT from world_creatures');
  for (const col of ['defense', 'resistances']) {
    assert.ok(new RegExp(`\\b${col}\\b`).test(sel),
      `the world_creatures load must SELECT ${col} — without it every creature's mit is inert`);
  }
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

test('a transiently failed chunk activation is retried, not stuck unloaded', async () => {
  const { url, handle, server } = await bootWith(fakePoolFlaky());
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  await nextMsg(ws, 'joined');

  // The wolf's chunk (0,0) fails its first activation attempt. Because
  // recomputeActive runs synchronously before the (async) activateChunk
  // promise can settle, the very next creatures broadcast can never include
  // it — so the first message is guaranteed wolf-free regardless of timing.
  const firstMsg = await nextMsg(ws, 'creatures');
  assert.ok(
    !firstMsg.creatures.some((c) => c.id === 'wolf1'),
    'wolf must not appear in the first creatures message (transient load failure)'
  );

  // Old (buggy) behavior: the chunk key is marked active before load and
  // never retried, so the wolf would never appear. New behavior: activation
  // is gated on loadedChunks, so recomputeActive retries every cycle until
  // it succeeds. Poll for up to ~1.5s (many 5Hz-ish recompute cycles here).
  let sawWolf = false;
  const start = Date.now();
  while (!sawWolf && Date.now() - start < 1500) {
    const m = await nextMsg(ws, 'creatures');
    sawWolf = m.creatures.some((c) => c.id === 'wolf1');
  }
  assert.ok(sawWolf, 'wolf must appear via retry within 1.5s of the transient failure');

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
