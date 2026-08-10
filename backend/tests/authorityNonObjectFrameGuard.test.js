// Regression test for F-012 (SOMET-192): the authority WS message handler
// must ignore any frame that JSON.parse's successfully but is not a plain
// object, instead of crashing the process.
//
// `JSON.parse` succeeds (does not throw) on every JSON value, not just
// objects: `null`, arrays, strings, numbers, and booleans all parse cleanly.
// The old handler went straight from `JSON.parse` to `msg.type === 'join'`
// with no shape check, so `JSON.parse("null")` produced `msg === null` and
// `msg.type` threw a TypeError. The handler was `async`, so that throw became
// a promise rejection the `ws` EventEmitter had no listener for, which Node
// 22 turns into an uncaught exception that exits the process by default —
// confirmed against the running dev server: one `null` text frame from an
// authenticated socket took the whole app down (port stopped listening,
// /api/health failed).
//
// This was reproduced against the LIVE unfixed code (not just reasoned
// about): running this file before the fix crashed the `node --test` worker
// process for this file outright (no normal red assertion — the whole
// subprocess died), matching the live finding. After the fix, every case
// below is ignored and the socket keeps working.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const { attachAuthority } = require('../src/authority/server.js');

const SECRET = 'test-secret-nonobject-frame';

// activateChunk opens a client via pool.connect() to wrap the world_chunks
// INSERT in a transaction (BEGIN/COMMIT/ROLLBACK). This fake doesn't assert
// on BEGIN/COMMIT/ROLLBACK, so a client that proxies straight back to the
// same `query` fn is a faithful stand-in.
function withConnect(pool) {
  pool.connect = async () => ({ query: pool.query, release: () => {} });
  return pool;
}

// Minimal pool: one world, two walkable tile types, no persisted player rows.
// Same shape as authority_server.test.js's fakePool(); duplicated here rather
// than imported since that helper is private to its file.
function fakePool() {
  return withConnect({
    query: async (sql, params) => {
      if (/FROM worlds WHERE id/i.test(sql)) {
        return { rows: [{ id: 'w1', seed: '1', chunk_size: 8 }] };
      }
      if (/FROM tile_types/i.test(sql)) {
        return { rows: [
          { name: 'grass', walkable: true, speed: 1 },
          { name: 'path', walkable: true, speed: 1 },
        ] };
      }
      if (/token_version.*FROM users WHERE/i.test(sql)) return { rows: [{ token_version: 1 }] };
      if (/FROM world_players WHERE/i.test(sql)) return { rows: [] };
      if (/INSERT INTO world_players/i.test(sql)) return { rows: [] };
      if (/FROM item_types/i.test(sql)) return { rows: [] };
      // SOMET-260: join now resolves the character before anything else, and a
      // fake pool that falls through to rows:[] refuses the join -- which makes the
      // test HANG waiting for 'joined' rather than fail. Answer it explicitly.
      if (/FROM characters/i.test(sql)) return { rows: [{ id: Number(params[0]), entity_type_id: 1 }] };
      // Plan B slice 3: the join policy's world+visit lookup, which now runs
      // on every join. Falling through to rows:[] refuses it, and the test
      // then HANGS waiting for 'joined' rather than failing. is_entry with no
      // history is the first-join leg -- what these fixtures actually are.
      if (/FROM worlds w WHERE w\.id/i.test(sql)) return { rows: [{ is_entry: true, allows_fast_travel: false, visited: false, visited_any: false, last_world: null }] };
      if (/FROM player_items/i.test(sql)) return { rows: [] };
      if (/FROM player_equipment/i.test(sql)) return { rows: [] };
      if (/INSERT INTO player_equipment/i.test(sql)) return { rows: [], rowCount: 1 };
      if (/DELETE FROM player_equipment/i.test(sql)) return { rows: [], rowCount: 1 };
      if (/INSERT INTO player_items/i.test(sql)) return { rows: [], rowCount: 1 };
      return { rows: [] };
    },
  });
}

function token(userId, tv = 1) {
  return jwt.sign({ user_id: userId, tv }, SECRET, { algorithm: 'HS256' });
}

// Torn down after the test WHETHER IT PASSED OR THREW — attachAuthority runs
// un-unref'd timers, so a thrown assertion before an explicit close() would
// otherwise hang node:test. See authority_server.test.js for the same pattern.
const openResources = [];
test.afterEach(() => {
  while (openResources.length) {
    const r = openResources.pop();
    try { r.close(); } catch { /* already closed */ }
  }
});

function boot() {
  return new Promise((resolve) => {
    const server = http.createServer();
    const handle = attachAuthority(server, fakePool(), { jwtSecret: SECRET, tickMs: 20 });
    openResources.push({
      close() {
        handle.close();
        if (server.listening) server.close();
      },
    });
    server.listen(0, () => {
      const port = server.address().port;
      resolve({ url: `ws://127.0.0.1:${port}/authority`, handle, server });
    });
  });
}

function connect(url, uid) {
  const ws = new WebSocket(`${url}?token=${encodeURIComponent(token(uid))}`);
  openResources.push({ close() { ws.terminate(); } });
  return ws;
}

function nextMsg(ws, type) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), 2000);
    ws.on('message', function onMsg(data) {
      const m = JSON.parse(data);
      if (!type || m.type === type) { clearTimeout(to); ws.off('message', onMsg); resolve(m); }
    });
  });
}

// Every JSON value that parses without throwing but is not a plain object —
// exactly the shapes the old `try { msg = JSON.parse(data) } catch {}` let
// through unguarded.
const NON_OBJECT_FRAMES = [
  ['null', 'null'],
  ['[]', 'an empty array'],
  ['"str"', 'a bare string'],
  ['123', 'a bare number'],
  ['true', 'a bare boolean'],
];

for (const [frame, label] of NON_OBJECT_FRAMES) {
  test(`ignores a raw "${frame}" frame (${label}) instead of crashing the socket`, async () => {
    const { url } = await boot();
    const ws = connect(url, 1);
    await new Promise((res) => ws.on('open', res));

    // Establish a session so this exercises the real post-join dispatch path,
    // not just the pre-join gate.
    ws.send(JSON.stringify({ type: 'join', character_id: 1, world_id: 'w1' }));
    await nextMsg(ws, 'joined');

    // The bad frame must be silently ignored: no crash, no error reply, no
    // close. If the handler throws here (unfixed code), the process exits
    // before the ping below ever gets a reply.
    ws.send(frame);

    // Prove the connection — and the process — are still alive: a normal
    // message sent right after gets a normal reply.
    ws.send(JSON.stringify({ type: 'ping' }));
    const pong = await nextMsg(ws, 'pong');
    assert.equal(pong.type, 'pong');
    assert.equal(ws.readyState, WebSocket.OPEN, 'socket should still be open after the bad frame');
  });
}

test('a batch of non-object frames back-to-back does not crash the server or drop the socket', async () => {
  const { url } = await boot();
  const ws = connect(url, 2);
  await new Promise((res) => ws.on('open', res));
  ws.send(JSON.stringify({ type: 'join', character_id: 1, world_id: 'w1' }));
  await nextMsg(ws, 'joined');

  for (const [frame] of NON_OBJECT_FRAMES) ws.send(frame);

  ws.send(JSON.stringify({ type: 'ping' }));
  const pong = await nextMsg(ws, 'pong');
  assert.equal(pong.type, 'pong');
  assert.equal(ws.readyState, WebSocket.OPEN);
});
