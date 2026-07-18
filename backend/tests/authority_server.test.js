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
      if (/FROM weapon_types/i.test(sql)) {
        return { rows: [
          { id: 1, name: 'dagger', kind: 'melee', damage: 8, cooldown: 0.3, reach: 80, arc_width: 0.6,
            range: null, projectile_speed: null, projectile_radius: null, pierce: null, mana_cost: 0, element: null },
          { id: 3, name: 'bow', kind: 'projectile', damage: 12, cooldown: 0.05, reach: null, arc_width: null,
            range: 2000, projectile_speed: 4000, projectile_radius: 40, pierce: 1, mana_cost: 0, element: null },
        ] };
      }
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

test('rejects an upgrade with a non-HS256 token (alg:none)', async () => {
  const { url, handle, server } = await boot();
  // A token with alg "none" and no signature — accepted by an unpinned verify
  // if the secret check is bypassed; must be rejected when algorithms:['HS256'].
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ user_id: 99 })).toString('base64url');
  const noneToken = `${header}.${body}.`;
  const ws = new WebSocket(`${url}?token=${encodeURIComponent(noneToken)}`);
  const outcome = await new Promise((res) => {
    ws.on('error', () => res('error'));
    ws.on('close', () => res('close'));
    ws.on('open', () => res('open'));
  });
  assert.ok(outcome === 'error' || outcome === 'close', `alg:none must be rejected, got ${outcome}`);
  try { ws.close(); } catch { /* already closed */ }
  handle.close(); server.close();
});

test('rejects an upgrade with a valid signature but wrong algorithm (HS384, same secret)', async () => {
  const { url, handle, server } = await boot();
  // Signed with the correct secret but HS384 — an unpinned verify would ACCEPT
  // this; the algorithms:['HS256'] pin must reject it. This is the test that
  // actually guards the pin against regression.
  const hs384 = jwt.sign({ user_id: 1 }, SECRET, { algorithm: 'HS384' });
  const ws = new WebSocket(`${url}?token=${encodeURIComponent(hs384)}`);
  const outcome = await new Promise((res) => {
    ws.on('error', () => res('error'));
    ws.on('close', () => res('close'));
    ws.on('open', () => res('open'));
  });
  assert.ok(outcome === 'error' || outcome === 'close', `HS384 token must be rejected, got ${outcome}`);
  try { ws.close(); } catch { /* already closed */ }
  handle.close(); server.close();
});

test('accepts a valid HS256 token', async () => {
  const { url, handle, server } = await boot();
  const ws = connect(url, 1); // connect() signs with HS256
  const opened = await new Promise((res) => {
    ws.on('open', () => res(true));
    ws.on('error', () => res(false));
    ws.on('close', () => res(false));
  });
  assert.ok(opened, 'a valid HS256 token should connect');
  ws.close(); handle.close(); server.close();
});

// Boot with a caller-supplied heartbeat interval (ms) for the reaper tests.
function bootHeartbeat(heartbeatMs) {
  return new Promise((resolve) => {
    const server = http.createServer();
    const handle = attachAuthority(server, fakePool(), {
      jwtSecret: SECRET, tickMs: 20, heartbeatMs,
    });
    server.listen(0, () => {
      const port = server.address().port;
      resolve({ url: `ws://127.0.0.1:${port}/authority`, handle, server });
    });
  });
}

test('reaps a dead socket that stops answering protocol pings', async () => {
  const HB = 40;
  const { url, handle, server } = await bootHeartbeat(HB);
  // autoPong:false → this ws client does NOT auto-reply to server pings,
  // so the server sees it as dead after one missed cycle and terminates it.
  const dead = new WebSocket(`${url}?token=${encodeURIComponent(token(1))}`, [], { autoPong: false });
  await new Promise((res) => dead.on('open', res));
  dead.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  await nextMsg(dead, 'joined');

  // Within ~2 heartbeat cycles the server should terminate the socket, which
  // the client observes as a close event.
  const closed = await new Promise((res) => {
    const to = setTimeout(() => res(false), HB * 6);
    dead.on('close', () => { clearTimeout(to); res(true); });
  });
  assert.ok(closed, 'dead (non-ponging) socket should be terminated by the reaper');
  handle.close(); server.close();
});

test('does not reap a live socket that answers protocol pings', async () => {
  const HB = 40;
  const { url, handle, server } = await bootHeartbeat(HB);
  const live = connect(url, 2); // default autoPong:true → auto-replies to pings
  await new Promise((res) => live.on('open', res));
  live.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  await nextMsg(live, 'joined');

  // Over several heartbeat cycles the live socket must NOT be closed.
  const stillOpen = await new Promise((res) => {
    const to = setTimeout(() => res(true), HB * 6);
    live.on('close', () => { clearTimeout(to); res(false); });
  });
  assert.ok(stillOpen, 'live (ponging) socket must survive the reaper');
  live.close(); handle.close(); server.close();
});

test('equip switches the weapon; a later state reflects weaponId', async () => {
  const { url, handle, server } = await boot();
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  const joined = await nextMsg(ws, 'joined');
  assert.ok(Array.isArray(joined.weapons) && joined.weapons.length >= 1, 'joined lists weapons');
  ws.send(JSON.stringify({ type: 'equip', weaponId: 3 }));
  let got = null;
  for (let i = 0; i < 20 && got == null; i++) {
    const s = await nextMsg(ws, 'state');
    const me = s.players.find((p) => p.id === '1');
    if (me && me.weaponId === 3) got = me;
  }
  assert.ok(got, 'weaponId updates to 3 after equip');
  ws.close(); handle.close(); server.close();
});

test('a projectile attack makes a projectile appear in a later state', async () => {
  const { url, handle, server } = await boot();
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  await nextMsg(ws, 'joined');
  ws.send(JSON.stringify({ type: 'equip', weaponId: 3 })); // bow (fast)
  ws.send(JSON.stringify({ type: 'attack', ax: 1, ay: 0 }));
  let sawProjectile = false;
  for (let i = 0; i < 10 && !sawProjectile; i++) {
    const s = await nextMsg(ws, 'state');
    if (Array.isArray(s.projectiles) && s.projectiles.length > 0) sawProjectile = true;
  }
  assert.ok(sawProjectile, 'state includes an active projectile after a projectile attack');
  ws.close(); handle.close(); server.close();
});
