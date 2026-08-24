const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const { attachAuthority } = require('../src/authority/server.js');
const { DEFAULTS } = require('../src/services/gameSettings.js');

// SOMET-482 -- ground loot expires on game_settings.ground_item_ttl_seconds
// (default 180) and leaves a purely cosmetic puff behind.
//
// Everything here runs through the REAL path: a real socket, a real join, the
// real chunk activation that loads world_items into the sim, the real
// _itemSweep, and the real dropItem SQL. That is deliberate. The pure
// removeExpired change is covered in groundItems.test.js; a unit test of the
// pure function alone would stay green with the whole feature unwired, which
// is exactly the failure mode this epic keeps shipping.
//
// Fake-pool shape and helpers mirror authority_groundItems_integration.test.js.

const SECRET = 'test-secret';

function token(u) { return jwt.sign({ user_id: u, tv: 1 }, SECRET, { algorithm: 'HS256' }); }
function connect(url, uid) { return new WebSocket(`${url}?token=${encodeURIComponent(token(uid))}`); }

function bootWith(pool, opts = {}) {
  return new Promise((resolve) => {
    const server = http.createServer();
    const handle = attachAuthority(server, pool, {
      jwtSecret: SECRET, tickMs: 20, creatureBroadcastEvery: 2, creatureFlushMs: 100,
      // A sweep interval far past any test's lifetime: every pass in this file
      // is driven explicitly through the _itemSweep seam, so a background
      // timer firing mid-assertion could only add nondeterminism.
      itemSweepMs: 3600000,
      ...opts,
    });
    server.listen(0, () => resolve({ url: `ws://127.0.0.1:${server.address().port}/authority`, handle, server }));
  });
}

function nextMsg(ws, type) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`timeout ${type}`)), 4000);
    ws.on('message', function onMsg(data) {
      const m = JSON.parse(data);
      if (!type || m.type === type) { clearTimeout(to); ws.off('message', onMsg); resolve(m); }
    });
  });
}

// The atomic claim CTE (loot.js claimItem / dropItem) literally contains
// "FROM world_items" in its DELETE half, so it MUST be routed before any
// generic world_items pattern. Same ambiguity trap the sibling file documents.
const CLAIM_RE = /^\s*WITH d AS/i;
const ITEMS_SELECT_RE = /SELECT[\s\S]*FROM world_items/i;

// `settings` is a live object the test may mutate between sweeps -- that is
// how "an admin changed the number, without a restart" is expressed here.
function makePool(chunkSize, { itemsFor, settings, inventory } = {}) {
  const calls = [];
  const live = settings || {};
  const pool = {
    calls,
    settings: live,
    matching(re) { return calls.filter((c) => re.test(c.sql)); },
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/FROM worlds WHERE id/i.test(sql)) return { rows: [{ id: 'w1', seed: '1', chunk_size: chunkSize }] };
      if (/token_version.*FROM users WHERE/i.test(sql)) return { rows: [{ token_version: 1 }] };
      if (/FROM tile_types/i.test(sql)) return { rows: [{ name: 'grass', walkable: true, speed: 1 }] };
      if (/FROM entity_types e[\s\S]*WHERE e\.is_creature/i.test(sql)) return { rows: [] };
      if (/INSERT INTO world_chunks/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/FROM characters/i.test(sql)) return { rows: [{ id: Number(params[0]), entity_type_id: 1 }] };
      if (/FROM worlds w WHERE w\.id/i.test(sql)) {
        return { rows: [{ is_entry: true, allows_fast_travel: false, visited: false, visited_any: false, last_world: null }] };
      }
      if (/FROM world_players WHERE/i.test(sql)) return { rows: [] };
      if (/FROM world_creatures/i.test(sql)) return { rows: [] };
      if (/INSERT INTO world_players/i.test(sql)) return { rows: [] };
      // The admin-tunable settings store, read by refreshLootTuning once per
      // sweep. Answers only the keys asked for, exactly as the real one does.
      if (/FROM game_settings/i.test(sql)) {
        const wanted = params && params[0] ? params[0] : [];
        return { rows: wanted.filter((k) => k in live).map((k) => ({ key: k, value: live[k] })) };
      }
      if (/FROM affix_types/i.test(sql)) return { rows: [] };
      if (/^\s*DELETE FROM world_items WHERE expires_at/i.test(sql)) return { rows: [], rowCount: 0 };
      if (CLAIM_RE.test(sql)) {
        // dropItem's CTE: player_items row out, world_items row in. The
        // returned row is what lands in the sim, so its expires_at has to be
        // derived from the ttlMs the server actually passed (params[5]) --
        // echoing a fixed date here would make the TTL untestable end to end.
        if (/INSERT INTO world_items/i.test(sql)) {
          const ttlMs = Number(params[5]);
          return {
            rows: [{
              id: 'dropped-1', item_type_id: 7, x: params[3], y: params[4], quantity: 1,
              expires_at: new Date(Date.now() + ttlMs).toISOString(),
              rarity: 'white', item_level: 1, affixes: [], soulbound: false,
            }],
            rowCount: 1,
          };
        }
        // claimItem's CTE: world_items row out, player_items row in.
        return { rows: [{ id: 'inst-1', item_type_id: 7, quantity: 1 }], rowCount: 1 };
      }
      if (ITEMS_SELECT_RE.test(sql)) {
        const row = itemsFor && itemsFor(params);
        return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (inventory && /FROM player_items/i.test(sql)) return { rows: inventory, rowCount: inventory.length };
      return { rows: [] };
    },
  };
  pool.connect = async () => ({ query: pool.query, release: () => {} });
  return pool;
}

// Wait until the join's chunk activation has pulled the item into the sim.
// activateChunk is async and off the join's critical path, so polling the sim
// is the only honest way to know it landed.
async function waitForItems(handle, worldId, n, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const entry = handle.worlds.get(worldId);
    if (entry && entry.world.groundItems.count() >= n) return entry;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`ground items never reached ${n}`);
}

const EXPIRED = '2000-01-01T00:00:00Z';
const FAR_FUTURE = '2999-01-01T00:00:00Z';

test('the ground item TTL defaults to 180s and is re-read from game_settings without a restart', async () => {
  // No `settings` rows at all: getSettings falls back to DEFAULTS, which is
  // the state a fresh database is in.
  const pool = makePool(8, { itemsFor: () => null, settings: {} });
  const { url, handle, server } = await bootWith(pool);
  const ws = connect(url, 1);
  try {
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'join', character_id: 1, world_id: 'w1' }));
    await nextMsg(ws, 'joined');

    // The default the whole ticket is specified against, asserted against the
    // shared DEFAULTS table rather than a literal so the two cannot drift.
    assert.strictEqual(DEFAULTS.ground_item_ttl_seconds, 180);
    await handle._refreshLootTuning();
    assert.strictEqual(handle._groundItemTtlMs(), 180000, 'default TTL is 180s, not the old 600s');

    // An admin edits the number. No restart, no reconnect -- one sweep.
    pool.settings.ground_item_ttl_seconds = 4;
    await handle._refreshLootTuning();
    assert.strictEqual(handle._groundItemTtlMs(), 4000);

    // Junk keeps the last good value rather than emptying (or freezing) the floor.
    pool.settings.ground_item_ttl_seconds = 0;
    await handle._refreshLootTuning();
    assert.strictEqual(handle._groundItemTtlMs(), 4000, 'a non-positive setting is ignored, not applied');
    pool.settings.ground_item_ttl_seconds = 'nonsense';
    await handle._refreshLootTuning();
    assert.strictEqual(handle._groundItemTtlMs(), 4000, 'an unparseable setting is ignored, not applied');
  } finally {
    ws.close(); handle.close(); server.close();
  }
});

test('a retuned TTL reaches the SQL of a subsequently dropped item', async () => {
  // The end-to-end half of the criterion above: a live number that never
  // reaches the INSERT is a setting nothing reads.
  const pool = makePool(8, { itemsFor: () => null, settings: { ground_item_ttl_seconds: 7 } });
  const { url, handle, server } = await bootWith(pool);
  const ws = connect(url, 1);
  try {
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'join', character_id: 1, world_id: 'w1' }));
    await nextMsg(ws, 'joined');

    await handle._refreshLootTuning();
    const entry = handle.worlds.get('w1');
    const p = entry.world.getPlayer('1');
    // Put something droppable in the live inventory the drop handler reads.
    p.inv.items.push({ id: 'pi-1', typeId: 7, quantity: 1 });

    ws.send(JSON.stringify({ type: 'drop', itemId: 'pi-1' }));
    await nextMsg(ws, 'dropped');

    const insert = pool.matching(/INSERT INTO world_items/i).pop();
    assert.ok(insert, 'the drop issued the world_items INSERT');
    assert.strictEqual(Number(insert.params[5]), 7000,
      'the drop carried the retuned TTL, not the boot-time or hardcoded one');
  } finally {
    ws.close(); handle.close(); server.close();
  }
});

test('an expired ground item emits an item_despawn vfx frame at its position and NO damage', async () => {
  const pool = makePool(8, {
    settings: { ground_item_ttl_seconds: 180 },
    // Loaded by the real activateChunk with an expiry already in the past.
    itemsFor: (params) => (params[1] === 0 && params[3] === 0
      ? { id: 'g1', item_type_id: 7, x: 321, y: 654, expires_at: EXPIRED }
      : null),
  });
  const { url, handle, server } = await bootWith(pool);
  const ws = connect(url, 1);
  const frames = [];
  try {
    ws.on('message', (data) => frames.push(JSON.parse(data)));
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'join', character_id: 1, world_id: 'w1' }));
    await nextMsg(ws, 'joined');

    const entry = await waitForItems(handle, 'w1', 1);
    const p = entry.world.getPlayer('1');
    // Stand ON the item, so "no damage" is a claim about the worst case rather
    // than about distance.
    p.x = 321; p.y = 654;
    const hpBefore = p.hp;
    const maxHpBefore = p.maxHp;

    frames.length = 0;
    await handle._itemSweep();
    // Let the socket drain, plus a few real ticks: if the despawn were wired
    // into any damage channel, this is the window it would show up in.
    await new Promise((r) => setTimeout(r, 150));

    const vfx = frames.filter((f) => f.type === 'vfx');
    assert.strictEqual(vfx.length, 1, `expected exactly one vfx frame, got ${JSON.stringify(frames)}`);
    assert.deepStrictEqual(vfx[0], { type: 'vfx', name: 'item_despawn', x: 321, y: 654 },
      'the puff is sited where the item stood -- which is only knowable because removeExpired returns the position');
    assert.strictEqual(entry.world.groundItems.count(), 0, 'the item left the sim');

    // ABSENCE, not just presence: the puff is presentation only. Asserted over
    // EVERY frame of the window, not just the vfx one, because a despawn that
    // leaked into combat would surface on the state frame, not on its own.
    for (const f of frames) {
      assert.strictEqual(f.impacts, undefined, `a despawn must not ride the impacts channel: ${JSON.stringify(f)}`);
      assert.strictEqual(f.attacks, undefined, `a despawn is not an attack: ${JSON.stringify(f)}`);
      assert.strictEqual(f.detonations, undefined, `a despawn is not a detonation: ${JSON.stringify(f)}`);
      assert.strictEqual(f.kills, undefined, `a despawn kills nothing: ${JSON.stringify(f)}`);
      assert.strictEqual(f.blocks, undefined, `a despawn is not a blocked attack: ${JSON.stringify(f)}`);
    }
    assert.strictEqual(p.hp, hpBefore, 'a despawn must not damage anybody');
    assert.strictEqual(p.maxHp, maxHpBefore);
    // No knockback and no collision: standing on a despawning item must not
    // move the player one pixel.
    assert.strictEqual(p.x, 321, 'a despawn must not knock the player back');
    assert.strictEqual(p.y, 654);
  } finally {
    ws.close(); handle.close(); server.close();
  }
});

test('an item claimed before it expires emits no despawn frame', async () => {
  const pool = makePool(8, {
    settings: { ground_item_ttl_seconds: 180 },
    itemsFor: (params) => (params[1] === 0 && params[3] === 0
      ? { id: 'g1', item_type_id: 7, x: 400, y: 400, expires_at: FAR_FUTURE }
      : null),
  });
  const { url, handle, server } = await bootWith(pool);
  const ws = connect(url, 1);
  const frames = [];
  try {
    ws.on('message', (data) => frames.push(JSON.parse(data)));
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'join', character_id: 1, world_id: 'w1' }));
    await nextMsg(ws, 'joined');

    const entry = await waitForItems(handle, 'w1', 1);
    entry.world.getPlayer('1').x = 400;
    entry.world.getPlayer('1').y = 400;

    ws.send(JSON.stringify({ type: 'pickup' }));
    const picked = await nextMsg(ws, 'picked');
    assert.ok(picked.item, 'the item was claimed before expiry');
    assert.strictEqual(entry.world.groundItems.count(), 0);

    frames.length = 0;
    await handle._itemSweep();
    await new Promise((r) => setTimeout(r, 100));
    assert.deepStrictEqual(frames.filter((f) => f.type === 'vfx'), [],
      'a picked-up item never expired, so it must not puff');
  } finally {
    ws.close(); handle.close(); server.close();
  }
});

test('the 3-second drop grace still stops the dropper re-claiming inside one tick', async () => {
  // Regression guard for the window dropItem opens: the expiry work above
  // moved the sweep around it, and a drop that is instantly re-looted is the
  // exact bug DROP_GRACE_MS exists to prevent.
  const pool = makePool(8, { itemsFor: () => null, settings: { ground_item_ttl_seconds: 180 } });
  const { url, handle, server } = await bootWith(pool);
  const ws = connect(url, 1);
  try {
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'join', character_id: 1, world_id: 'w1' }));
    await nextMsg(ws, 'joined');

    const entry = handle.worlds.get('w1');
    const p = entry.world.getPlayer('1');
    p.inv.items.push({ id: 'pi-1', typeId: 7, quantity: 1 });

    const { dropGraceActive, DROP_GRACE_MS } = require('../src/authority/loot.js');
    assert.strictEqual(DROP_GRACE_MS, 3000, 'the grace window is still three seconds');

    ws.send(JSON.stringify({ type: 'drop', itemId: 'pi-1' }));
    await nextMsg(ws, 'dropped');

    const now = Date.now();
    assert.strictEqual(dropGraceActive(p, 'dropped-1', now), true,
      'the just-dropped item is inside the dropper\'s own grace window');
    // The item is genuinely on the floor for everyone else and for this player
    // once the window closes -- grace suppresses the auto-loot scan, it does
    // not un-drop the item.
    assert.ok(entry.world.groundItems.get('dropped-1'), 'the drop is really in the sim');
    assert.strictEqual(dropGraceActive(p, 'dropped-1', now + DROP_GRACE_MS + 1), false,
      'the window closes after three seconds');
  } finally {
    ws.close(); handle.close(); server.close();
  }
});
