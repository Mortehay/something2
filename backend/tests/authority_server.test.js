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
      if (/FROM item_types/i.test(sql)) {
        return { rows: [
          { id: 1, name: 'dagger', category: 'weapon', slot: 'main_hand', two_handed: false, kind: 'melee',
            damage: 8, cooldown: 0.3, reach: 80, arc_width: 6.3, range: null, projectile_speed: null,
            projectile_radius: null, pierce: null, mana_cost: 0, element: null, defense: null, resistances: null },
          { id: 3, name: 'bow', category: 'weapon', slot: 'main_hand', two_handed: false, kind: 'projectile',
            damage: 12, cooldown: 0.05, reach: null, arc_width: null, range: 2000, projectile_speed: 4000,
            projectile_radius: 40, pierce: 1, mana_cost: 0, element: null, defense: null, resistances: null },
          { id: 5, name: 'leather-vest', category: 'armor', slot: 'chest', two_handed: false, kind: null,
            damage: 0, cooldown: 0, reach: null, arc_width: null, range: null, projectile_speed: null,
            projectile_radius: null, pierce: null, mana_cost: 0, element: null, defense: 2, resistances: {} },
        ] };
      }
      if (/FROM player_items/i.test(sql)) return { rows: [{ id: 'i1', item_type_id: 1 }, { id: 'i3', item_type_id: 3 }, { id: 'i5', item_type_id: 5 }] };
      if (/FROM player_equipment/i.test(sql)) return { rows: [] };
      if (/INSERT INTO player_equipment/i.test(sql)) return { rows: [], rowCount: 1 };
      if (/DELETE FROM player_equipment/i.test(sql)) return { rows: [], rowCount: 1 };
      if (/INSERT INTO player_items/i.test(sql)) return { rows: [], rowCount: 1 };
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
//
// opts.itemsDelayMs additionally delays the player_items (inventory) query,
// which is used to force a real await window across the join handler's
// `await loadInventory(...)` so a kicked socket's close can genuinely race
// the new session's registration (again, instant microtask resolution can
// never interleave the two).
function delayedFakePool(delayMs, opts = {}) {
  const itemsDelayMs = opts.itemsDelayMs || 0;
  return {
    query: async (sql, ...args) => {
      if (/FROM worlds WHERE id/i.test(sql)) {
        await new Promise((r) => setTimeout(r, delayMs));
        return { rows: [{ id: 'w1', seed: '1', chunk_size: 8 }] };
      }
      if (itemsDelayMs && /FROM player_items/i.test(sql)) {
        await new Promise((r) => setTimeout(r, itemsDelayMs));
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

test('equip switches the weapon; a later state reflects equipment.main_hand', async () => {
  const { url, handle, server } = await boot();
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  const joined = await nextMsg(ws, 'joined');
  assert.ok(Array.isArray(joined.itemTypes) && joined.itemTypes.length >= 1, 'joined lists the item catalog');
  ws.send(JSON.stringify({ type: 'equip', itemId: 'i3', slot: 'main_hand' })); // bow
  let got = null;
  for (let i = 0; i < 20 && got == null; i++) {
    const s = await nextMsg(ws, 'state');
    const me = s.players.find((p) => p.id === '1');
    if (me && me.equipment && me.equipment.main_hand === 'i3') got = me;
  }
  assert.ok(got, 'equipment.main_hand updates to i3 after equip');
  ws.close(); handle.close(); server.close();
});

test('a projectile attack makes a projectile appear in a later state', async () => {
  const { url, handle, server } = await boot();
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  await nextMsg(ws, 'joined');
  ws.send(JSON.stringify({ type: 'equip', itemId: 'i3', slot: 'main_hand' })); // bow (fast)
  // equip is now async (DB write-through); wait for it to land before
  // attacking so the attack doesn't race ahead of the equip and hit with
  // the still-equipped melee default.
  let equipped = false;
  for (let i = 0; i < 20 && !equipped; i++) {
    const s = await nextMsg(ws, 'state');
    const me = s.players.find((p) => p.id === '1');
    if (me && me.equipment && me.equipment.main_hand === 'i3') equipped = true;
  }
  assert.ok(equipped, 'bow equipped before attacking');
  ws.send(JSON.stringify({ type: 'attack', ax: 1, ay: 0 }));
  let sawProjectile = false;
  for (let i = 0; i < 10 && !sawProjectile; i++) {
    const s = await nextMsg(ws, 'state');
    if (Array.isArray(s.projectiles) && s.projectiles.length > 0) sawProjectile = true;
  }
  assert.ok(sawProjectile, 'state includes an active projectile after a projectile attack');
  ws.close(); handle.close(); server.close();
});

test('joined carries the item catalog, the owned items and the equipment map', async () => {
  const { url, handle, server } = await boot();
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  const joined = await nextMsg(ws, 'joined');
  assert.ok(Array.isArray(joined.itemTypes) && joined.itemTypes.length >= 2);
  assert.ok(Array.isArray(joined.items) && joined.items.length >= 1);
  assert.equal(typeof joined.equipment, 'object');
  assert.equal(joined.weapons, undefined, 'the 3b-1 weapons payload is retired');
  ws.close(); handle.close(); server.close();
});

test('equip is reflected in a later state; unequip clears it', async () => {
  const { url, handle, server } = await boot();
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  await nextMsg(ws, 'joined');

  ws.send(JSON.stringify({ type: 'equip', itemId: 'i5', slot: 'chest' }));
  let got = null;
  for (let i = 0; i < 25 && !got; i++) {
    const s = await nextMsg(ws, 'state');
    const me = s.players.find((p) => p.id === '1');
    if (me && me.equipment && me.equipment.chest === 'i5') got = me;
  }
  assert.ok(got, 'chest equipment appears in state');

  ws.send(JSON.stringify({ type: 'unequip', slot: 'chest' }));
  let cleared = false;
  for (let i = 0; i < 25 && !cleared; i++) {
    const s = await nextMsg(ws, 'state');
    const me = s.players.find((p) => p.id === '1');
    if (me && me.equipment && me.equipment.chest === undefined) cleared = true;
  }
  assert.ok(cleared, 'chest equipment cleared in state');
  ws.close(); handle.close(); server.close();
});

test('a second session for the same account kicks the first (newest wins)', async () => {
  const { url, handle, server } = await boot();
  const a = connect(url, 1);
  await new Promise((r) => a.on('open', r));
  a.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  await nextMsg(a, 'joined');

  // Second connection, same user id.
  const b = connect(url, 1);
  await new Promise((r) => b.on('open', r));
  const aClosed = new Promise((res) => a.on('close', () => res(true)));
  b.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  await nextMsg(b, 'joined');

  const closed = await Promise.race([aClosed, new Promise((r) => setTimeout(() => r(false), 1500))]);
  assert.ok(closed, 'the first session should be terminated by the second');

  // The new session stays alive and keeps receiving state.
  const s = await nextMsg(b, 'state');
  assert.ok(Array.isArray(s.players));
  b.close(); handle.close(); server.close();
});

// Like fakePool(), but simulates the real DB behavior that the double-equip
// race actually trips: player_equipment_item_unique. INSERT INTO
// player_equipment is delayed (so two equip frames sent back-to-back
// genuinely interleave across the await, same rationale as delayedFakePool
// above) and rejects with a unique-violation-shaped error if the same
// item_id is inserted twice (the ON CONFLICT target is (user_id, slot), so
// it does NOT cover this constraint — a second slot for the same item_id
// is a real conflict, not a merge).
function equipRacePool(delayMs = 20) {
  const base = fakePool();
  const usedItemIds = new Set();
  return {
    query: async (sql, params) => {
      if (/INSERT INTO player_equipment/i.test(sql)) {
        await new Promise((r) => setTimeout(r, delayMs));
        const itemId = params[2];
        if (usedItemIds.has(itemId)) {
          const err = new Error('duplicate key value violates unique constraint "player_equipment_item_unique"');
          err.code = '23505';
          throw err;
        }
        usedItemIds.add(itemId);
        return { rows: [], rowCount: 1 };
      }
      return base.query(sql, params);
    },
  };
}

test('concurrent double-equip of the same item into two hand slots does not crash the process', async () => {
  // Regression test for the equip/unequip unhandled-rejection crash: send
  // two equip frames back-to-back for the SAME one-handed weapon instance
  // into main_hand and off_hand. Both handlers' canEquip() reads run before
  // either write lands, so both pass; the second write then conflicts on
  // player_equipment_item_unique. Pre-fix, that rejection had no .catch and
  // propagated out of the `async (data) => {...}` message handler as an
  // unhandled rejection — which crashes the whole Node process by default
  // (confirmed with a standalone `node` repro outside the test harness; see
  // the review-fixes report). node's test runner installs its own
  // process-level rejection handlers, which swallow that crash without
  // reproducing it faithfully here, so this assertion targets the
  // fix-specific, deterministic signal instead: the loser must come back as
  // a normal 'error' reply (from the new try/catch), not silence. Pre-fix,
  // nothing ever catches it, so no 'error' is ever sent and this times out.
  const { url, handle, server } = await bootWith(equipRacePool());
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  await nextMsg(ws, 'joined');

  ws.send(JSON.stringify({ type: 'equip', itemId: 'i1', slot: 'main_hand' }));
  ws.send(JSON.stringify({ type: 'equip', itemId: 'i1', slot: 'off_hand' }));

  const err = await nextMsg(ws, 'error');
  assert.match(err.message, /equip failed/i, "the loser's DB conflict is reported, not swallowed as an unhandled rejection");

  // And the connection must still be fully alive afterwards.
  const s = await nextMsg(ws, 'state');
  assert.ok(Array.isArray(s.players), 'a later state still arrives after the racing equips');
  assert.equal(ws.readyState, ws.OPEN, 'the socket stays open despite the equip conflict');

  ws.close(); handle.close(); server.close();
});

test('a second join on the same socket is rejected (no free re-heal / no ghost)', async () => {
  // Regression test: prev === ws used to skip the kick check entirely, so a
  // client could join twice on one socket. Re-joining the SAME world calls
  // addPlayer again, which resets hp/mana to max and teleports to spawn — a
  // free full heal now that combat is real. A second join must be refused.
  const { url, handle, server } = await boot();
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  await nextMsg(ws, 'joined');

  ws.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  const err = await nextMsg(ws, 'error');
  assert.match(err.message, /already joined/i, 'the second join on the same socket is refused');

  // The connection is otherwise unaffected: it keeps receiving state.
  const s = await nextMsg(ws, 'state');
  assert.ok(Array.isArray(s.players));

  ws.close(); handle.close(); server.close();
});

// ---------------------------------------------------------------------------
// Ammo: the attack handler's ordering invariant (canAttack → consume → attack)
// ---------------------------------------------------------------------------

const AMMO_TYPE_ID = 7;

// A weapon type row with every optional column nulled out, so a test that
// supplies a partial weapon (e.g. a melee one with no ammo) genuinely gets
// ammo_type_id: null rather than inheriting the ammo bow's.
const BLANK_WEAPON = {
  id: 9, name: 'harness-weapon', category: 'weapon', slot: 'main_hand', two_handed: false,
  kind: null, damage: 0, cooldown: 0, reach: null, arc_width: null, range: null,
  projectile_speed: null, projectile_radius: null, pierce: null, mana_cost: 0,
  stamina_cost: 0, element: null, defense: null, resistances: null,
  stackable: false, ammo_type_id: null, aoe_radius: null,
};

// The default harness weapon: a bow that eats ammo and costs stamina, with a
// long cooldown so `_attackCd > 0` after a successful shot is not a race with
// the 20ms tick loop's cooldown decay.
const AMMO_BOW = {
  kind: 'projectile', damage: 12, cooldown: 5, range: 2000, projectile_speed: 4000,
  projectile_radius: 40, pierce: 1, stamina_cost: 5, ammo_type_id: AMMO_TYPE_ID,
};

// Boot a world with one joined player holding `opts.weapon` in main_hand, and
// route the real consumeAmmo() UPDATE through `opts.onConsume`.
//
// Nothing here reimplements the handler: frames go over a real websocket into
// the real attachAuthority message handler, and the consume decision is made
// at the pool boundary, so src/authority/ammo.js runs for real too. The only
// thing the test injects is whether the DB had a unit to spend.
async function mkAttackHarness(opts = {}) {
  const weapon = { ...BLANK_WEAPON, ...(opts.weapon || AMMO_BOW) };
  const onConsume = opts.onConsume || (() => true);
  // What ammoCount()'s SELECT SUM should currently report; a function so a
  // test can make it move (e.g. decrement in lockstep with onConsume) to
  // simulate the summed-across-stacks total draining shot by shot.
  const ammoCountFn = opts.ammoCountFn || (() => 5);
  const base = fakePool();
  const pool = {
    query: async (sql, params) => {
      // Must be matched BEFORE the generic /FROM player_items/ branch: the
      // consume statement mentions player_items in its subquery too.
      if (/UPDATE player_items SET quantity/i.test(sql)) {
        return onConsume(params)
          ? { rowCount: 1, rows: [{ id: 'ammo1', quantity: 5 }] }
          : { rowCount: 0, rows: [] };
      }
      // Also must precede the generic /FROM player_items/ branch below:
      // ammoCount()'s SUM query mentions player_items too.
      if (/SELECT COALESCE\(SUM\(quantity\)/i.test(sql)) {
        return { rows: [{ n: ammoCountFn(params) }] };
      }
      if (/FROM item_types/i.test(sql)) return { rows: [weapon] };
      if (/FROM player_items/i.test(sql)) {
        return { rows: [{ id: 'i9', item_type_id: 9, quantity: 1 },
                        { id: 'ammo1', item_type_id: AMMO_TYPE_ID, quantity: 5 }] };
      }
      if (/FROM player_equipment/i.test(sql)) return { rows: [{ slot: 'main_hand', item_id: 'i9' }] };
      return base.query(sql, params);
    },
  };

  const { url, handle, server } = await bootWith(pool);
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  const sent = [];
  ws.on('message', (data) => {
    const m = JSON.parse(data);
    if (m.type !== 'state' && m.type !== 'creatures') sent.push(m);
  });
  ws.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  await nextMsg(ws, 'joined');

  const world = handle.worlds.get('w1').world;
  const player = world.getPlayer('1');
  assert.ok(player, 'harness player joined');
  assert.equal(world.canAttack('1').weapon.id, 9, 'the harness weapon is the active one');

  return {
    ws, handle, server, world, player, sent,
    // Send attack frames and wait until the server has finished processing
    // them. The barrier is an unequip of a bogus slot: it is a pure no-op that
    // still chains onto ws._opChain, so its reply cannot arrive until every
    // attack queued before it has fully run (and the synchronous melee path is
    // long done by the time the barrier frame is even parsed).
    async sendAttack(ax = 1, ay = 0, times = 1) {
      for (let i = 0; i < times; i++) ws.send(JSON.stringify({ type: 'attack', ax, ay }));
      ws.send(JSON.stringify({ type: 'unequip', slot: '__barrier__' }));
      const err = await nextMsg(ws, 'error');
      assert.match(err.message, /unknown slot/i, 'barrier resolved');
    },
    close() { ws.close(); handle.close(); server.close(); },
  };
}

test('an attack refused for cooldown does not consume ammo', async () => {
  const spent = [];
  const h = await mkAttackHarness({ onConsume: () => { spent.push(1); return true; } });
  h.player._attackCd = 1; // cooldown running
  await h.sendAttack(1, 0);
  assert.equal(spent.length, 0,
    'ammo was spent on an attack that was refused for cooldown — the consume must come AFTER canAttack');
  h.close();
});

test('an attack refused for stamina does not consume ammo', async () => {
  const spent = [];
  const h = await mkAttackHarness({ onConsume: () => { spent.push(1); return true; } });
  h.player.stamina = 0;
  await h.sendAttack(1, 0);
  assert.equal(spent.length, 0, 'ammo was spent on an attack refused for stamina');
  h.close();
});

test('firing with no ammo sends noammo and leaves the cooldown untouched', async () => {
  const h = await mkAttackHarness({ onConsume: () => false });
  await h.sendAttack(1, 0);
  assert.equal(h.player._attackCd, 0,
    'an ammo denial must not consume the cooldown, matching the mana/stamina rule');
  const noammo = h.sent.find((m) => m.type === 'noammo');
  assert.ok(noammo, 'the client is told it is out of ammo');
  // The refusal must name the ammo type. It is the client's only authoritative
  // signal that this type is at zero — without it the HUD keeps rendering its
  // last believed count while every shot is being refused, and the client
  // would have to guess the type from equipment state that may already have
  // moved on.
  assert.equal(noammo.item_type_id, AMMO_TYPE_ID,
    'noammo must carry the ammo type it refused, so the client can zero exactly that count');
  h.close();
});

test('a weapon with no ammo_type_id never touches player_items', async () => {
  let consumed = false;
  const h = await mkAttackHarness({
    weapon: { kind: 'melee', reach: 80, arc_width: 1, damage: 5, cooldown: 0.3 },
    onConsume: () => { consumed = true; return true; },
  });
  await h.sendAttack(1, 0);
  assert.equal(consumed, false, 'the ammo-free hot path must not hit the DB');
  h.close();
});

test('a successful ammo attack spends exactly one unit and fires', async () => {
  let count = 0;
  const h = await mkAttackHarness({ onConsume: () => { count += 1; return true; } });
  await h.sendAttack(1, 0);
  assert.equal(count, 1);
  assert.ok(h.player._attackCd > 0, 'a successful attack starts the cooldown');
  h.close();
});

test('two attack frames in one batch spend only one unit', async () => {
  // Both frames are parsed (and would both be gated) before either chained
  // callback runs, so a gate captured at parse time is already stale by the
  // time the second consume happens: the second shot would burn a unit and
  // then be refused by attack() for the cooldown the first one started. The
  // handler must re-gate inside the chain, immediately before consuming.
  let count = 0;
  const h = await mkAttackHarness({ onConsume: () => { count += 1; return true; } });
  await h.sendAttack(1, 0, 2);
  assert.equal(count, 1, 'the cooldown-refused second shot must not consume a unit');
  h.close();
});

// ---------------------------------------------------------------------------
// The 'ammo' push frame: the HUD's whole reason for existing. consumeAmmo
// succeeding is not enough — the shooter must actually be told the new
// count, or the number on screen freezes after the first shot.
// ---------------------------------------------------------------------------

test('a successful ammo attack sends an ammo frame with the correct summed count', async () => {
  // 43 stands in for two real, never-merged stacks (12 + 31) — ammoCount()
  // sums across all of them, so the pushed number must reflect that sum
  // minus the one unit this shot just spent, not a single row's quantity.
  let remaining = 43;
  const h = await mkAttackHarness({
    onConsume: () => { remaining -= 1; return true; },
    ammoCountFn: () => remaining,
  });
  await h.sendAttack(1, 0);
  const frame = h.sent.find((m) => m.type === 'ammo');
  assert.ok(frame, 'a successful shot must push an ammo frame to the shooter');
  assert.equal(frame.item_type_id, AMMO_TYPE_ID);
  assert.equal(frame.count, 42, 'the pushed count must be the post-consume summed total');
  h.close();
});

test('firing twice reports a decreasing count', async () => {
  let remaining = 10;
  const h = await mkAttackHarness({
    onConsume: () => { remaining -= 1; return true; },
    ammoCountFn: () => remaining,
  });
  await h.sendAttack(1, 0);
  h.player._attackCd = 0; // clear the cooldown so the second shot is not refused
  await h.sendAttack(1, 0);
  const frames = h.sent.filter((m) => m.type === 'ammo');
  assert.equal(frames.length, 2, 'each successful shot pushes its own ammo frame');
  assert.equal(frames[0].count, 9);
  assert.equal(frames[1].count, 8);
  assert.ok(frames[1].count < frames[0].count, 'the count must decrease, not stay frozen');
  h.close();
});

test('firing with no ammo does not push an ammo frame', async () => {
  const h = await mkAttackHarness({ onConsume: () => false });
  await h.sendAttack(1, 0);
  assert.ok(!h.sent.some((m) => m.type === 'ammo'), 'a refused shot spends nothing, so there is no new count to push');
  h.close();
});

// ---------------------------------------------------------------------------
// AoE: detonations must actually reach a connected client
// ---------------------------------------------------------------------------

// An ammo-free AoE bow with a very short range, so the projectile runs out of
// flight (which counts as an impact) and detonates within a tick or two.
const AOE_BOW = {
  kind: 'projectile', damage: 12, cooldown: 5, range: 60, projectile_speed: 900,
  projectile_radius: 8, pierce: null, aoe_radius: 96, element: 'arcane',
  ammo_type_id: null,
};

test('a detonation reaches the client on the state frame, and only once', async () => {
  // Regression guard for the open item left by the AoE tick work: the tick
  // stashed entry.pendingDetonations and NOTHING ever read it. Because the
  // stash is replaced (not appended to) every tick, an unconsumed detonation
  // is silently overwritten ~20ms later and no blast ever renders. This test
  // fails outright if the broadcast does not carry it.
  const h = await mkAttackHarness({ weapon: AOE_BOW });

  const frames = [];
  h.ws.on('message', (data) => {
    const m = JSON.parse(data);
    if (m.type === 'state') frames.push(m);
  });

  await h.sendAttack(1, 0);

  // Poll real state frames until one carries a detonation.
  let det = null;
  for (let i = 0; i < 30 && det == null; i++) {
    const s = await nextMsg(h.ws, 'state');
    if (Array.isArray(s.detonations) && s.detonations.length > 0) det = s.detonations[0];
  }

  assert.ok(det, 'a state frame must carry the detonation the tick produced');
  assert.equal(det.radius, 96, 'the blast radius the client renders comes from the weapon');
  assert.equal(det.element, 'arcane');
  assert.ok(Number.isFinite(det.x) && Number.isFinite(det.y), 'world-space centre');

  // The stash must be cleared after sending: a detonation repeated on every
  // subsequent frame would leave a blast ring stuck on screen forever.
  const before = frames.length;
  for (let i = 0; i < 5; i++) await nextMsg(h.ws, 'state');
  const later = frames.slice(before).filter((f) => Array.isArray(f.detonations) && f.detonations.length);
  assert.equal(later.length, 0, 'detonations must not repeat on later frames');

  h.close();
});

test('a state frame with no detonations omits the field entirely', async () => {
  // Keeps the common-case frame small; the client treats a missing field as
  // "no blasts this tick".
  const { url, handle, server } = await boot();
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  await nextMsg(ws, 'joined');
  const s = await nextMsg(ws, 'state');
  assert.equal(s.detonations, undefined);
  ws.close(); handle.close(); server.close();
});

test('a kicked socket closing mid-join does not tear down the new session', async () => {
  // Delay the inventory (player_items) query so the new session's join
  // handler genuinely sits mid-await while the kicked (old) socket's real
  // 'close' event fires — the exact ordering the Critical exploited: the
  // old socket's close must not find itself still "owning" entry.sockets
  // and tear down the whole world entry out from under the new session.
  const { url, handle, server } = await bootWith(delayedFakePool(0, { itemsDelayMs: 60 }));
  const a = connect(url, 1);
  await new Promise((r) => a.on('open', r));
  a.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  await nextMsg(a, 'joined');

  const b = connect(url, 1); // same user id as a → a gets kicked
  await new Promise((r) => b.on('open', r));
  const aClosed = new Promise((res) => a.on('close', () => res(true)));
  b.send(JSON.stringify({ type: 'join', world_id: 'w1' }));

  const closed = await Promise.race([aClosed, new Promise((r) => setTimeout(() => r(false), 5000))]);
  assert.ok(closed, 'the kicked (old) session should be terminated');

  // The new session must still complete its join and keep receiving state —
  // if the kicked socket's close tore down the world entry mid-await, b
  // would either never see 'joined'/'state' or would be silently soft-locked.
  await nextMsg(b, 'joined');
  const s = await nextMsg(b, 'state');
  assert.ok(Array.isArray(s.players), 'the new session should still receive state after the kicked close');
  b.close(); handle.close(); server.close();
});
