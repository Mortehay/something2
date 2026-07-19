const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const { attachAuthority } = require('../src/authority/server.js');

const SECRET = 'test-secret';

// Task 6's chunk lifecycle (activateChunk loading world_items, flushAndPrune
// calling groundItems.pruneInactive, the expiry sweep) has no coverage
// anywhere else. There is no "items" broadcast message, so every test here
// uses 'pickup' as the observable probe: an item can only be claimed if it
// actually made it into entry.world.groundItems, so a successful/failed
// 'picked' reply is proof of the sim's internal state.
//
// Follows the pattern in authority_creatures_integration.test.js (same
// fakePool shape, same nextMsg helper, same retry-polling style for
// async chunk activation).

function token(u) { return jwt.sign({ user_id: u }, SECRET, { algorithm: 'HS256' }); }
function connect(url, uid) { return new WebSocket(`${url}?token=${encodeURIComponent(token(uid))}`); }
function bootWith(pool, opts = {}) {
  return new Promise((resolve) => {
    const server = http.createServer();
    const handle = attachAuthority(server, pool, {
      jwtSecret: SECRET, tickMs: 20, creatureBroadcastEvery: 2, creatureFlushMs: 100, ...opts,
    });
    server.listen(0, () => resolve({ url: `ws://127.0.0.1:${server.address().port}/authority`, handle, server }));
  });
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

// The atomic claim statement (loot.js claimItem): a single CTE that DELETEs
// world_items and INSERTs player_items together. Its DELETE half literally
// contains the text "FROM world_items", so it must be routed BEFORE any
// generic world_items match — exactly the ambiguity finding 3 calls out for
// loot.js's own test pool, and the same trap applies to a server-level fake
// pool here.
const CLAIM_RE = /^\s*WITH d AS/i;
// The bbox SELECT that activateChunk issues to load a chunk's ground items.
const ITEMS_SELECT_RE = /SELECT.*FROM world_items/i;

// Base pool routes shared by every test in this file: world w1 (chunk_size
// configurable), one walkable tile type, no creature types (irrelevant to
// ground items — kept empty so creature spawn/load is a no-op), no persisted
// player row (defaults to world-center spawn).
//
// `itemsFor(params)` answers the bbox SELECT (return a row, or null/undefined
// for none). `claim()` answers the atomic claim statement (defaults to a
// successful grant, since most tests here care about loading/pruning, not
// the claim result itself).
function makePool(chunkSize, { itemsFor, claim } = {}) {
  const calls = [];
  return {
    calls,
    matching(re) { return calls.filter((c) => re.test(c.sql)); },
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/FROM worlds WHERE id/i.test(sql)) return { rows: [{ id: 'w1', seed: '1', chunk_size: chunkSize }] };
      if (/FROM tile_types/i.test(sql)) return { rows: [{ name: 'grass', walkable: true, speed: 1 }] };
      if (/FROM entity_types WHERE is_creature/i.test(sql)) return { rows: [] };
      if (/INSERT INTO world_chunks/i.test(sql)) return { rows: [], rowCount: 0 }; // already materialized
      if (/FROM world_players WHERE/i.test(sql)) return { rows: [] }; // default center spawn
      if (/FROM world_creatures/i.test(sql)) return { rows: [] };
      if (/INSERT INTO world_players/i.test(sql)) return { rows: [] };
      // The background expiry sweep issues this with no params array.
      if (/^\s*DELETE FROM world_items WHERE expires_at/i.test(sql)) return { rows: [], rowCount: 0 };
      if (CLAIM_RE.test(sql)) {
        if (claim) return claim(params);
        return { rows: [{ id: 'inst-1', item_type_id: 7 }], rowCount: 1 };
      }
      if (ITEMS_SELECT_RE.test(sql)) {
        const row = itemsFor && itemsFor(params);
        return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      return { rows: [] };
    },
  };
}

// Poll 'pickup' until a 'picked' reply arrives or the timeout elapses.
// Returns the 'picked' message or null.
async function pollPickup(ws, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    ws.send(JSON.stringify({ type: 'pickup' }));
    const got = await new Promise((resolve) => {
      const to = setTimeout(() => { ws.off('message', onMsg); resolve(null); }, 100);
      function onMsg(data) {
        const m = JSON.parse(data);
        if (m.type === 'picked') { clearTimeout(to); ws.off('message', onMsg); resolve(m); }
      }
      ws.on('message', onMsg);
    });
    if (got) return got;
  }
  return null;
}

test('items in a chunk\'s bbox load into the sim on activation and are pickup-able', async () => {
  const pool = makePool(8, {
    // chunk (0,0) bbox: x,y in [0,800). Item sits near spawn (400,400).
    itemsFor: (params) => (params[1] === 0 && params[3] === 0
      ? { id: 'g1', item_type_id: 7, x: 420, y: 420, expires_at: '2999-01-01T00:00:00Z' }
      : null),
  });

  const { url, handle, server } = await bootWith(pool);
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  await nextMsg(ws, 'joined');

  const picked = await pollPickup(ws, 1500);
  assert.ok(picked, 'the item that loaded with its chunk is pickup-able');
  assert.deepStrictEqual(picked.item, { id: 'inst-1', typeId: 7, quantity: 1 });

  ws.close(); handle.close(); server.close();
});

test('the ground-item bbox is half-open and matches the creature query\'s convention', async () => {
  const pool = makePool(8, { itemsFor: () => null });

  const { url, handle, server } = await bootWith(pool);
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  await nextMsg(ws, 'joined');

  // Give activateChunk a couple of broadcast cycles to run for chunk (0,0).
  for (let i = 0; i < 3; i++) await nextMsg(ws, 'creatures');

  const isChunk00 = (c) => c.params && c.params[1] === 0 && c.params[2] === 800 && c.params[3] === 0 && c.params[4] === 800;
  const creatureCall = pool.calls.find((c) => /FROM world_creatures/i.test(c.sql) && isChunk00(c));
  const itemCall = pool.calls.find((c) => ITEMS_SELECT_RE.test(c.sql) && isChunk00(c));

  assert.ok(creatureCall, 'creature bbox query for chunk (0,0) was issued');
  assert.ok(itemCall, 'item bbox query for chunk (0,0) was issued');
  assert.deepStrictEqual(itemCall.params, creatureCall.params, 'item bbox spans must match the creature bbox spans exactly');
  assert.match(itemCall.sql, /x >= \$2 AND x < \$3 AND y >= \$4 AND y < \$5/,
    'half-open bbox: inclusive lower bound, exclusive upper bound — same convention as the creature query');

  ws.close(); handle.close(); server.close();
});

test('a transiently failed ground-item load leaves the chunk out of loadedChunks and is retried', async () => {
  let thrown = false;
  const pool = makePool(8, {
    itemsFor: (params) => {
      if (params[1] === 0 && params[3] === 0) {
        if (!thrown) { thrown = true; throw new Error('transient pg error'); }
        return { id: 'g1', item_type_id: 7, x: 420, y: 420, expires_at: '2999-01-01T00:00:00Z' };
      }
      return null;
    },
  });

  const { url, handle, server } = await bootWith(pool);
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  await nextMsg(ws, 'joined');

  // recomputeActive retries every broadcast cycle since a failed
  // activateChunk never adds the chunk key to loadedChunks. Success can only
  // happen here via a retry, since itemsFor deliberately throws on the very
  // first invocation for chunk (0,0) — so this succeeding at all is itself
  // proof the failed attempt didn't leave the chunk permanently unloaded.
  const picked = await pollPickup(ws, 1500);
  assert.ok(picked, 'the item becomes pickup-able once activation is retried successfully');
  assert.strictEqual(thrown, true, 'the first activation attempt for the item\'s chunk did fail (sanity: the retry was actually exercised)');

  ws.close(); handle.close(); server.close();
});

test('pruneInactive (wired through flushAndPrune) evicts out-of-range ground items, not just loadedChunks bookkeeping', async () => {
  // chunk_size 1 (span 100px) keeps required travel distance small so the
  // player can walk clear of chunk (0,0)'s neighborhood quickly.
  let itemQueryCountForChunk00 = 0;
  const pool = makePool(1, {
    itemsFor: (params) => {
      if (!(params[1] === 0 && params[3] === 0)) return null;
      itemQueryCountForChunk00++;
      // Present on the first load, gone on any later reload — simulating
      // the DB state simply not changing; the only way a later reload can
      // fail to find it again is if the earlier sim entry was genuinely
      // evicted, since add() would otherwise have kept the original.
      if (itemQueryCountForChunk00 === 1) {
        return { id: 'g1', item_type_id: 7, x: 90, y: 90, expires_at: '2999-01-01T00:00:00Z' };
      }
      return null;
    },
  });

  const { url, handle, server } = await bootWith(pool);
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  const joined = await nextMsg(ws, 'joined');
  const spawnX = joined.spawn.x; // world-center spawn, chunk (0,0)

  // Let chunk (0,0) activate (item loads into the sim; not claimed here so
  // the eviction being tested isn't confounded with a claim-driven removal).
  for (let i = 0; i < 3; i++) await nextMsg(ws, 'creatures');

  // Walk far enough east that chunk (0,0) leaves the 3x3 active neighborhood
  // (chunk span 100px; 3 chunks away is comfortably outside radius 1).
  ws.send(JSON.stringify({ type: 'input', seq: 1, dx: 1, dy: 0 }));
  let farEnough = null;
  for (let i = 0; i < 200 && !farEnough; i++) {
    const s = await nextMsg(ws, 'state');
    const me = s.players.find((p) => p.id === '1');
    if (me && me.x >= spawnX + 300) farEnough = me;
  }
  assert.ok(farEnough, 'player walked clear of the item\'s chunk neighborhood');

  // Give the creatureFlushTimer (100ms) time to run flushAndPrune at least
  // once while chunk (0,0) is out of entry.activeChunks.
  await new Promise((r) => setTimeout(r, 300));

  // Walk back to spawn; chunk (0,0) reactivates and reloads from the DB
  // (which — per the mock above — now reports the item gone).
  ws.send(JSON.stringify({ type: 'input', seq: 2, dx: -1, dy: 0 }));
  let backHome = null;
  for (let i = 0; i < 200 && !backHome; i++) {
    const s = await nextMsg(ws, 'state');
    const me = s.players.find((p) => p.id === '1');
    if (me && me.x <= spawnX + 20) backHome = me;
  }
  assert.ok(backHome, 'player walked back into the item\'s chunk neighborhood');
  ws.send(JSON.stringify({ type: 'input', seq: 3, dx: 0, dy: 0 }));

  // Confirm the item never comes back: if pruneInactive had not actually
  // run, the original in-memory entry would still be sitting in
  // groundItems.items regardless of what the reload query returns, and this
  // would wrongly succeed.
  const picked = await pollPickup(ws, 800);
  assert.strictEqual(picked, null, 'the stale item must not still be pickup-able: pruneInactive must have evicted it');

  ws.close(); handle.close(); server.close();
});
