const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const { attachAuthority } = require('../src/authority/server.js');

const SECRET = 'test-secret';

// Minimal pool: one world row, a couple of walkable tile types, no persisted
// player rows, and a no-op upsert.
function fakePool() {
  return {
    query: async (sql) => {
      if (/FROM worlds WHERE id/i.test(sql)) {
        return { rows: [{ id: 'w1', seed: '1', chunk_size: 8 }] };
      }
      if (/FROM tile_types/i.test(sql)) {
        return { rows: [
          { name: 'grass', walkable: true, speed: 1 },
          { name: 'path', walkable: true, speed: 1 },
        ] };
      }
      if (/FROM world_players WHERE/i.test(sql)) return { rows: [] };
      if (/INSERT INTO world_players/i.test(sql)) return { rows: [] };
      return { rows: [] };
    },
  };
}

function token(userId) {
  return jwt.sign({ user_id: userId }, SECRET, { algorithm: 'HS256' });
}

// Boot an http server with the authority attached; returns {url, handle, server}.
function boot() {
  return bootWith(fakePool());
}

// Same as boot(), but with a caller-supplied pool (e.g. one with an
// artificial delay to force concurrent cold-start loads to interleave).
function bootWith(pool) {
  return new Promise((resolve) => {
    const server = http.createServer();
    const handle = attachAuthority(server, pool, { jwtSecret: SECRET, tickMs: 20 });
    server.listen(0, () => {
      const port = server.address().port;
      resolve({ url: `ws://127.0.0.1:${port}/authority`, handle, server });
    });
  });
}

// Like fakePool(), but the world-lookup query awaits a real delay before
// resolving, so two concurrent first-joins to the same world genuinely
// interleave across the `await pool.query(...)` in loadWorld (instant
// microtask resolution is too fast to ever interleave two loads).
function delayedFakePool(delayMs) {
  return {
    query: async (sql, ...args) => {
      if (/FROM worlds WHERE id/i.test(sql)) {
        await new Promise((r) => setTimeout(r, delayMs));
        return { rows: [{ id: 'w1', seed: '1', chunk_size: 8 }] };
      }
      return fakePool().query(sql, ...args);
    },
  };
}

function connect(url, uid) {
  return new WebSocket(`${url}?token=${encodeURIComponent(token(uid))}`);
}

// Await the next JSON message of a given type.
function nextMsg(ws, type) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), 2000);
    ws.on('message', function onMsg(data) {
      const m = JSON.parse(data);
      if (!type || m.type === type) { clearTimeout(to); ws.off('message', onMsg); resolve(m); }
    });
  });
}

test('rejects an upgrade with no token', async () => {
  const { url, handle, server } = await boot();
  const bare = url; // no ?token
  const ws = new WebSocket(bare);
  const closed = await new Promise((res) => {
    ws.on('error', () => res('error'));
    ws.on('close', () => res('close'));
  });
  assert.ok(closed === 'error' || closed === 'close');
  try { ws.close(); } catch { /* already closed */ }
  handle.close(); server.close();
});

test('join → joined with a spawn; input → state includes the moved player', async () => {
  const { url, handle, server } = await boot();
  const ws = connect(url, 1);
  await new Promise((res) => ws.on('open', res));
  ws.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  const joined = await nextMsg(ws, 'joined');
  assert.equal(joined.type, 'joined');
  assert.equal(joined.user_id, '1');
  assert.ok(typeof joined.spawn.x === 'number' && typeof joined.spawn.y === 'number');

  ws.send(JSON.stringify({ type: 'input', seq: 1, dx: 1, dy: 0 }));
  // Wait for a state where our player has moved east of spawn.
  const startX = joined.spawn.x;
  let moved = null;
  for (let i = 0; i < 20 && !moved; i++) {
    const s = await nextMsg(ws, 'state');
    const me = s.players.find((p) => p.id === '1');
    if (me && me.x > startX) moved = me;
  }
  assert.ok(moved, 'player should move east after input');
  ws.close();
  handle.close(); server.close();
});

test('two clients in one world see each other', async () => {
  const { url, handle, server } = await boot();
  const a = connect(url, 1);
  const b = connect(url, 2);
  await Promise.all([
    new Promise((r) => a.on('open', r)),
    new Promise((r) => b.on('open', r)),
  ]);
  a.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  b.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  await nextMsg(a, 'joined');
  await nextMsg(b, 'joined');
  // a's state should eventually list both player ids.
  let both = false;
  for (let i = 0; i < 20 && !both; i++) {
    const s = await nextMsg(a, 'state');
    const ids = s.players.map((p) => p.id).sort();
    if (ids.includes('1') && ids.includes('2')) both = true;
  }
  assert.ok(both, "a should see both players");
  a.close(); b.close();
  handle.close(); server.close();
});

test('concurrent first-joins to a fresh (unloaded) world both get ticked, not orphaned', async () => {
  // Regression test for the cold-start race in loadWorld(): with an
  // instant-resolving pool two concurrent joins never actually interleave
  // across the await, so we use a pool whose world lookup takes a real
  // 15ms round-trip to force both joins to pass the `worlds.get` miss
  // check before either query resolves.
  const { url, handle, server } = await bootWith(delayedFakePool(15));
  const a = connect(url, 1);
  const b = connect(url, 2);
  await Promise.all([
    new Promise((r) => a.on('open', r)),
    new Promise((r) => b.on('open', r)),
  ]);
  // Fire both joins as close together as possible so they race the same
  // cold-start load.
  a.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  b.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  await Promise.all([nextMsg(a, 'joined'), nextMsg(b, 'joined')]);

  let both = false;
  for (let i = 0; i < 20 && !both; i++) {
    const s = await nextMsg(a, 'state');
    const ids = s.players.map((p) => p.id).sort();
    if (ids.includes('1') && ids.includes('2')) both = true;
  }
  assert.ok(both, 'both concurrently-joined players should end up present, not orphaned');
  a.close(); b.close();
  handle.close(); server.close();
});
