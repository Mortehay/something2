const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const { attachAuthority } = require('../src/authority/server.js');

const SECRET = 'test-secret';

// activateChunk (F-018 / SOMET-198) now takes a client from pool.connect()
// to wrap the world_chunks INSERT and the creature INSERTs it gates in one
// transaction, in addition to the plain pool.query() every fake pool here
// already answers. The fake pools in this file have no real transactional
// semantics to preserve (they don't assert on BEGIN/COMMIT/ROLLBACK), so a
// client that proxies straight back to the same `query` fn is a faithful
// stand-in.
function withConnect(pool) {
  pool.connect = async () => ({ query: pool.query, release: () => {} });
  return pool;
}

// Pool: world w1 (chunk_size 8), grass tiles, one is_creature type, one
// pre-existing creature near chunk (0,0). Chunk insert reports 0 rows (already
// materialized) so spawn is skipped and the load path is exercised directly.
// Player spawn: user 1 at world center (chunk 0,0 area); user 2 persisted far away.
function fakePool() {
  const updates = [];
  return withConnect({
    updates,
    query: async (sql, params) => {
      if (/FROM worlds WHERE id/i.test(sql)) return { rows: [{ id: 'w1', seed: '1', chunk_size: 8 }] };
      if (/token_version.*FROM users WHERE/i.test(sql)) return { rows: [{ token_version: 1 }] }; // matches token()'s tv:1 → passes the on-connect version check
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
  });
}

// Same as fakePool but the world_creatures bbox SELECT for chunk (0,0) throws
// once (simulating a transient pg error) before succeeding on the next call.
// Used to prove a failed chunk activation is retried on a later recompute
// instead of being permanently marked active with no creatures loaded.
function fakePoolFlaky() {
  let thrown = false;
  return withConnect({
    query: async (sql, params) => {
      if (/FROM worlds WHERE id/i.test(sql)) return { rows: [{ id: 'w1', seed: '1', chunk_size: 8 }] };
      if (/token_version.*FROM users WHERE/i.test(sql)) return { rows: [{ token_version: 1 }] }; // matches token()'s tv:1 → passes the on-connect version check
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
  });
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
// CreatureSim.addCreatures. Dropping defense/resistances from it loads them
// as undefined, every creature spawns with an inert `mit`; dropping
// level/damage loads THOSE as undefined, and addCreatures' own fallbacks
// silently reset every persisted creature to level 1 / CREATURE_DAMAGE. In
// both cases every maths test still passes -- addCreatures is only ever fed
// what the SELECT actually returns, never told what it should have asked
// for. The fake pool ignores the SQL text, so assert on it directly.
//
// The four column names below must never appear inside the SELECT's own SQL
// comments (server.js keeps that query's rationale as JS comments above the
// template literal for exactly this reason) -- a name that shows up only in
// a comment would satisfy this regex while the real column is gone.
test('the chunk creature load SELECTs the columns CreatureSim maps into `mit`/level/damage', async () => {
  const sqls = [];
  const base = fakePool();
  const pool = withConnect({ query: async (sql, params) => { sqls.push(sql); return base.query(sql, params); } });
  const { url, handle, server } = await bootWith(pool);
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  await nextMsg(ws, 'joined');
  await nextMsg(ws, 'creatures');

  const sel = sqls.find((s) => /SELECT/i.test(s) && /FROM world_creatures/i.test(s));
  assert.ok(sel, 'chunk activation must SELECT from world_creatures');
  for (const col of ['defense', 'resistances', 'level', 'damage']) {
    assert.ok(new RegExp(`\\b${col}\\b`).test(sel),
      `the world_creatures load must SELECT ${col} — without it every creature's mit/level/damage is wrong`);
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

// F-018 (SOMET-198): the world_chunks INSERT is activateChunk's once-only
// spawn flag (`ins.rowCount > 0` gates the creature-spawn loop). Before the
// fix that INSERT committed on its own via a plain pool.query, independent
// of the creature INSERTs it gates — so a failure partway through spawning
// still left the flag permanently set, and every retry then saw the chunk
// "already materialized" and silently skipped spawning forever. Reproduces
// with a REAL transactional fake pool (BEGIN/COMMIT/ROLLBACK tracked, not
// just answered) so it actually distinguishes "rolled back together" from
// "committed regardless": seed 16 / chunk_size 8 deterministically spawns
// two wolves in chunk (0,0) (confirmed via spawnChunkCreatures directly).
// The player's default (no persisted position) spawn also activates the 8
// chunks neighboring (0,0), which can have their own incidental spawns at
// this seed — so `throwOnFirstInsertInBbox` only fires for an INSERT whose
// (x,y) falls inside chunk (0,0)'s own bbox, and the bbox SELECT is filtered
// by params like the real query, keeping the assertion scoped to chunk
// (0,0) regardless of what its neighbors do or when they activate.
function fakePoolTxn({ seed, chunkSize, bbox }) {
  const committedChunks = new Set();     // "cx,cy" keys actually materialized
  const committedCreatures = [];         // rows visible to the bbox SELECT
  let inBboxInsertCalls = 0;
  let thrown = false;
  let nextRowId = 1;

  // `pendingRef` is `null` for a plain (autocommit) pool.query call — mirrors
  // the OLD, unfixed activateChunk, which issued the world_chunks and
  // world_creatures INSERTs via plain pool.query with no transaction at all,
  // so each committed the instant it ran. Each pool.connect() call below
  // hands out a { current: null } box of its OWN, so two chunk activations
  // running concurrently (recomputeActive fires one per neighborhood chunk)
  // never see or clobber each other's in-flight transaction — the same
  // isolation a real pg client gets from the pool.
  function makeQuery(pendingRef) {
    return async function query(sql, params) {
      if (/FROM worlds WHERE id/i.test(sql)) return { rows: [{ id: 'w1', seed: String(seed), chunk_size: chunkSize }] };
      if (/token_version.*FROM users WHERE/i.test(sql)) return { rows: [{ token_version: 1 }] };
      if (/FROM tile_types/i.test(sql)) return { rows: [{ name: 'grass', walkable: true, speed: 1 }] };
      if (/FROM entity_types WHERE is_creature/i.test(sql)) return { rows: [{ name: 'Wolf', color: '#c0392b', hp: 10 }] };
      if (/FROM world_players WHERE/i.test(sql)) return { rows: [] };
      if (/INSERT INTO world_players/i.test(sql)) return { rows: [] };
      if (/FROM item_types/i.test(sql)) return { rows: [] };
      if (/FROM player_items/i.test(sql)) return { rows: [] };
      if (/FROM player_equipment/i.test(sql)) return { rows: [] };

      if (pendingRef) {
        if (/^\s*BEGIN\s*$/i.test(sql)) { pendingRef.current = { chunks: new Set(), creatures: [] }; return {}; }
        if (/^\s*COMMIT\s*$/i.test(sql)) {
          for (const k of pendingRef.current.chunks) committedChunks.add(k);
          committedCreatures.push(...pendingRef.current.creatures);
          pendingRef.current = null;
          return {};
        }
        if (/^\s*ROLLBACK\s*$/i.test(sql)) { pendingRef.current = null; return {}; }
      }

      const store = (pendingRef && pendingRef.current) || { chunks: committedChunks, creatures: committedCreatures };

      if (/INSERT INTO world_chunks/i.test(sql)) {
        const key = `${params[1]},${params[2]}`;
        if (committedChunks.has(key)) return { rows: [], rowCount: 0 };
        store.chunks.add(key);
        return { rows: [{ id: 'chunk1' }], rowCount: 1 };
      }
      if (/INSERT INTO world_creatures/i.test(sql)) {
        const [, , x, y] = params;
        const inBbox = x >= bbox.x0 && x < bbox.x1 && y >= bbox.y0 && y < bbox.y1;
        if (inBbox) {
          inBboxInsertCalls++;
          if (!thrown && inBboxInsertCalls === 1) { thrown = true; throw new Error('simulated creature insert failure'); }
        }
        const row = {
          id: `c${nextRowId++}`, type: params[1], x, y, hp: params[4], facing: params[5],
          home_x: null, home_y: null, color: '#c0392b', defense: 0, resistances: {}, faction: null,
        };
        store.creatures.push(row);
        return { rows: [] };
      }
      if (/FROM world_creatures/i.test(sql)) {
        const [, xMin, xMax, yMin, yMax] = params;
        return { rows: committedCreatures.filter((c) => c.x >= xMin && c.x < xMax && c.y >= yMin && c.y < yMax) };
      }
      if (/FROM world_items/i.test(sql)) return { rows: [] };
      if (/UPDATE world_creatures/i.test(sql)) return { rows: [] };
      return { rows: [] };
    };
  }

  return {
    query: makeQuery(null),
    connect: async () => ({ query: makeQuery({ current: null }), release: () => {} }),
  };
}

test('F-018: a chunk whose spawn fails mid-way is retried as a whole (world_chunks row and creature INSERTs commit or roll back together)', async () => {
  // chunk_size 8, tile 100px -> chunk (0,0) spans [0,800) x [0,800).
  const pool = fakePoolTxn({ seed: 16, chunkSize: 8, bbox: { x0: 0, x1: 800, y0: 0, y1: 800 } });
  const { url, handle, server } = await bootWith(pool);
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  await nextMsg(ws, 'joined');

  // Poll for up to ~1.5s of 5Hz-ish recompute cycles, same budget as the
  // transient-failure test above. Scoped strictly to chunk (0,0)'s own bbox
  // so neighboring chunks' incidental spawns can't pad or hide the count.
  let wolfCount = 0;
  const start = Date.now();
  while (wolfCount < 2 && Date.now() - start < 1500) {
    const m = await nextMsg(ws, 'creatures');
    wolfCount = m.creatures.filter((c) => c.type === 'Wolf' && c.x >= 0 && c.x < 800 && c.y >= 0 && c.y < 800).length;
  }
  assert.equal(wolfCount, 2, 'both of chunk (0,0)\'s wolves must eventually appear — a mid-spawn failure must not permanently mark the chunk materialized with fewer creatures than it should have');

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
