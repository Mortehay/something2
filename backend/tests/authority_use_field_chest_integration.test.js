const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const { attachAuthority } = require('../src/authority/server.js');
const { worldOverviewCache, clearOverviewCache } = require('../src/services/overviewCache.js');

// Harness follows authority_groundItems_integration.test.js exactly (same
// fakePool shape, same bootWith/nextMsg helpers, same connect() proxy) --
// that file (found via `grep -rln "handlers.drop\|handlers.pickup\|type:
// 'drop'\|type: 'pickup'" tests/*.js`) is the only existing coverage of
// server.js's message-handler dispatch (`messageHandlers`, not `handlers` --
// the brief's guessed name), so `use` (this file's subject) reuses its
// pattern rather than inventing a second parallel harness for the same
// surface.

const SECRET = 'test-secret';

function token(u) { return jwt.sign({ user_id: u, tv: 1 }, SECRET, { algorithm: 'HS256' }); }
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

// `use` needs: a 'consumable' loot_map row and a 'weapon' row (to prove a
// non-consumable is rejected) in the item catalog; a resolvable 'Wolf'
// entity_type (spawnFieldChest's own guard-type resolve, ahead of
// placement -- see chests.js); and whichever `userItems` this test's player
// should already own (mirrors what loadInventory's SELECT would return).
//
// `bounded` toggles whether the world carries width/height: unbounded is
// placeMapCreatures' own documented "nowhere legal" precondition (used by
// the "no legal tile" case below), matching chests_service.test.js's own
// unboundedWorld() fixture.
function makePool({ bounded = true, userItems = [] } = {}) {
  const calls = [];
  const pool = {
    calls,
    matching(re) { return calls.filter((c) => re.test(c.sql)); },
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/FROM worlds WHERE id/i.test(sql)) {
        return {
          rows: [{
            id: 'w1', seed: '1', chunk_size: 64,
            width: bounded ? 10 : null, height: bounded ? 10 : null,
            is_entry: null, entry_spawn: null, biomes: [], biome_cell: null,
            level_min: 1, level_max: 5,
          }],
        };
      }
      if (/token_version.*FROM users WHERE/i.test(sql)) return { rows: [{ token_version: 1 }] };
      // Two answers this fixture predates, both from the player-characters
      // line of work that landed in parallel with chests (SOMET-260/271).
      // Unanswered, the join is REFUSED and the test hangs on
      // nextMsg('joined') rather than failing.
      if (/FROM characters/i.test(sql)) return { rows: [{ id: Number(params[0]) || 1, entity_type_id: 1 }] };
      if (/FROM worlds w WHERE w\.id/i.test(sql)) return { rows: [{ is_entry: true, allows_fast_travel: false, visited: false, visited_any: false, last_world: null }] };
      if (/FROM tile_types/i.test(sql)) return { rows: [{ name: 'grass', walkable: true, speed: 1 }] };
      // Creature-type catalog loader (SOMET-249 LEFT JOINs creature_behaviors,
      // so the SELECT reads "FROM entity_types e ... WHERE e.is_creature").
      // No creature types needed for this world's content.
      if (/FROM entity_types e[\s\S]*WHERE e\.is_creature/i.test(sql)) return { rows: [] };
      // spawnFieldChest's own guard-type resolve, distinct from the join
      // above: a bare `FROM entity_types WHERE name = ANY(...)`.
      if (/FROM entity_types WHERE name = ANY/i.test(sql)) {
        return { rows: [{ id: 42, name: 'Wolf', hp: 30, defense: 2, resistances: {} }], rowCount: 1 };
      }
      if (/FROM item_types/i.test(sql)) {
        return {
          rows: [
            { id: 1, name: 'dagger', category: 'weapon', stackable: false },
            { id: 2, name: 'loot_map', category: 'consumable', stackable: true },
          ],
        };
      }
      if (/^\s*INSERT INTO world_chunks/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/FROM world_players WHERE/i.test(sql)) return { rows: [] }; // default center spawn
      if (/^\s*INSERT INTO world_players/i.test(sql)) return { rows: [] };
      if (/^\s*INSERT INTO world_creatures/i.test(sql)) return { rows: [{ id: 'guard-x' }], rowCount: 1 };
      // injectGuardIntoSim's per-id load (server.js), checked BEFORE the
      // generic bbox-load fallback below for the same reason as everywhere
      // else this pattern appears -- both match that fallback's broader
      // regex. Returns one full joined-shape row per requested id so
      // entry.world.creatures actually gains the freshly-spawned guard.
      if (/WHERE wc\.id = ANY/i.test(sql)) {
        const ids = params[0] || [];
        return {
          rows: ids.map((id) => ({
            id, type: 'Wolf', x: 550, y: 550, hp: 30, facing: 'S',
            home_x: 550, home_y: 550, level: 5, damage: 5, blocks_portal_id: null,
            defense: 2, color: null, resistances: {}, faction: 'hostile', attack_element: 'physical',
            behavior_name: null,
          })),
          rowCount: ids.length,
        };
      }
      if (/FROM world_creatures/i.test(sql)) return { rows: [] }; // bbox load (no "FROM" in the INSERT above)
      if (/^\s*DELETE FROM world_items WHERE expires_at/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/SELECT.*FROM world_items/i.test(sql)) return { rows: [], rowCount: 0 }; // ground-item bbox load
      if (/^\s*INSERT INTO world_chests/i.test(sql)) {
        return {
          rows: [{
            id: 'chest-1', world_id: params[0], x: params[1], y: params[2], kind: 'field',
            guard_entity_type_id: params[3], guard_level: params[4],
            guard_creature_ids: JSON.parse(params[5]), state: 'locked',
            opened_at: null, respawn_at: null, created_at: '2026-01-01T00:00:00Z',
          }],
          rowCount: 1,
        };
      }
      if (/FROM world_chests WHERE world_id/i.test(sql)) return { rows: [] }; // fetchChests at load: none yet
      if (/^\s*SELECT id, item_type_id, quantity FROM player_items WHERE character_id/i.test(sql)) {
        return { rows: userItems };
      }
      if (/FROM player_equipment WHERE character_id/i.test(sql)) return { rows: [] };
      if (/SELECT gold FROM users WHERE id/i.test(sql)) return { rows: [{ gold: 0 }] };
      if (/^\s*DELETE FROM player_items WHERE id = \$1 AND character_id = \$2/i.test(sql)) {
        // $2 is the CHARACTER id now, and it arrives as the number this
        // fixture's `FROM characters` answer hands back -- not the string the
        // WS layer mints for a user id. Compared loosely on purpose: the point
        // of this branch is "does the owner match", not what type the id is.
        const [itemId, ownerId] = params;
        const owned = userItems.find((it) => it.id === itemId);
        const owns = owned && String(ownerId) === '1';
        return owns
          ? { rows: [{ quantity: owned.quantity }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      return { rows: [] };
    },
  };
  // spawnFieldChest's transaction (BEGIN/DELETE/COMMIT) opens a client via
  // pool.connect(), same proxy-to-query fake as groundItems' activateChunk
  // test pool: this fake doesn't assert on BEGIN/COMMIT/ROLLBACK, so routing
  // them straight back into the same `query` fn (falling through to the
  // final `{ rows: [] }`) is a faithful stand-in.
  pool.connect = async () => ({ query: pool.query, release: () => {} });
  return pool;
}

async function joinAndGetPlayer(url) {
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', character_id: 1, world_id: 'w1' }));
  await nextMsg(ws, 'joined');
  return ws;
}

test('use with a non-owned itemId sends an error frame and mutates nothing', async () => {
  const pool = makePool({ userItems: [] });
  const { url, handle, server } = await bootWith(pool);
  const ws = await joinAndGetPlayer(url);

  ws.send(JSON.stringify({ type: 'use', itemId: 'not-mine' }));
  const err = await nextMsg(ws, 'error');
  assert.match(err.message, /do not own/);
  assert.equal(pool.matching(/INSERT INTO world_chests/i).length, 0);
  assert.equal(pool.matching(/DELETE FROM player_items/i).length, 0);

  ws.close(); handle.close(); server.close();
});

test('use with a non-consumable item (a weapon) sends an error frame', async () => {
  const pool = makePool({ userItems: [{ id: 'dagger-1', item_type_id: 1, quantity: 1 }] });
  const { url, handle, server } = await bootWith(pool);
  const ws = await joinAndGetPlayer(url);

  ws.send(JSON.stringify({ type: 'use', itemId: 'dagger-1' }));
  const err = await nextMsg(ws, 'error');
  assert.match(err.message, /no use action/);
  assert.equal(pool.matching(/INSERT INTO world_chests/i).length, 0);

  ws.close(); handle.close(); server.close();
});

test('use with a loot_map when no legal tile exists sends an error frame and does not delete the player_items row', async () => {
  const pool = makePool({ bounded: false, userItems: [{ id: 'map-1', item_type_id: 2, quantity: 1 }] });
  const { url, handle, server } = await bootWith(pool);
  const ws = await joinAndGetPlayer(url);

  ws.send(JSON.stringify({ type: 'use', itemId: 'map-1' }));
  const err = await nextMsg(ws, 'error');
  assert.match(err.message, /no legal spot/);
  assert.equal(pool.matching(/DELETE FROM player_items/i).length, 0, 'the item must survive a failed spawn');
  assert.equal(handle.worlds.get('w1').chests.length, 0);

  ws.close(); handle.close(); server.close();
});

// Mirrors sellItem's own guard in trade.js against the SAME table (F-022 /
// SOMET-202): loot_map is seeded stackable:true, and nothing here prices or
// consumes per-unit, so a stacked row must be refused rather than silently
// destroying the whole stack while only spawning one chest. Unreachable
// today (nothing grants loot_map with quantity > 1 yet) -- this only proves
// the guard exists and actually rolls the effects back.
test('use with a stacked loot_map (quantity > 1) refuses and does not spawn a chest or consume the item', async () => {
  const pool = makePool({ bounded: true, userItems: [{ id: 'map-1', item_type_id: 2, quantity: 5 }] });
  const { url, handle, server } = await bootWith(pool);
  const ws = await joinAndGetPlayer(url);

  ws.send(JSON.stringify({ type: 'use', itemId: 'map-1' }));
  const err = await nextMsg(ws, 'error');
  assert.match(err.message, /stack/i);

  // The handler must not have reached its post-COMMIT effects: neither the
  // in-memory chest cache nor the player's in-memory inventory changed, even
  // though placement (and the DELETE) already ran before the guard caught it.
  const entry = handle.worlds.get('w1');
  assert.equal(entry.chests.length, 0, 'no chest pushed onto entry.chests -- the transaction must have rolled back');
  const p = entry.world.getPlayer('1');
  assert.ok(p.inv.items.some((it) => it.id === 'map-1'), 'the stacked item must still be in the in-memory inventory');

  ws.close(); handle.close(); server.close();
});

test('use with the loot_map item successfully sends a used frame, deletes the player_items row, creates one world_chests row, and pushes it onto entry.chests', async () => {
  const pool = makePool({ bounded: true, userItems: [{ id: 'map-1', item_type_id: 2, quantity: 1 }] });
  const { url, handle, server } = await bootWith(pool);
  const ws = await joinAndGetPlayer(url);

  ws.send(JSON.stringify({ type: 'use', itemId: 'map-1' }));
  const used = await nextMsg(ws, 'used');
  assert.equal(used.itemId, 'map-1');
  assert.equal(used.spawnedChestId, 'chest-1');

  const del = pool.matching(/DELETE FROM player_items/i);
  assert.equal(del.length, 1);
  assert.deepEqual(del[0].params, ['map-1', '1']);

  assert.equal(pool.matching(/INSERT INTO world_chests/i).length, 1);

  const entry = handle.worlds.get('w1');
  assert.equal(entry.chests.length, 1, 'the spawned chest must be pushed onto the live entry.chests cache');
  assert.equal(entry.chests[0].kind, 'field');
  assert.equal(entry.chests[0].state, 'locked');
  // Same camelCase shape fetchChests produces (guardEntityTypeId, not
  // guard_entity_type_id) -- entry.chests must never mix shapes.
  assert.ok('guardEntityTypeId' in entry.chests[0]);

  ws.close(); handle.close(); server.close();
});

// Final-review fix (SOMET-244 Critical #1), `use`-handler half. Every world
// in the live DB fits inside a single player's 3x3 chunk neighborhood, so a
// chunk holding a player never unloads -- activateChunk (the ONLY other
// path that feeds entry.world.creatures) never re-fires to pick up the
// guard spawnFieldChest just INSERTed into world_creatures. Without the
// fix, this guard would stay DB-only: invisible, unkillable, and
// openchest's guard-alive check would refuse forever ("guard is still
// alive") since the DB row it counts never dies.
test('use with the loot_map item injects the spawned guard into entry.world.creatures, not just the DB', async () => {
  const pool = makePool({ bounded: true, userItems: [{ id: 'map-1', item_type_id: 2, quantity: 1 }] });
  const { url, handle, server } = await bootWith(pool);
  const ws = await joinAndGetPlayer(url);

  const entry = handle.worlds.get('w1');
  assert.equal(entry.world.creatures.creatures.has('guard-x'), false, 'not present before the spawn');

  ws.send(JSON.stringify({ type: 'use', itemId: 'map-1' }));
  await nextMsg(ws, 'used');

  assert.equal(
    entry.world.creatures.creatures.has('guard-x'), true,
    'the newly-spawned guard must be injected into the live sim, or it can never be killed to unlock the chest',
  );

  ws.close(); handle.close(); server.close();
});

// Final-review fix (SOMET-244 Important #4). Task 6b's own clearOverviewCache
// fix (commit 0eb4891) covered the open and respawn paths but missed this
// third mutation site: a field chest spawned via `use` also changes what
// /overview shows (a brand-new chest marker), and with no TTL on that cache,
// an already-cached window would otherwise stay stale until an unrelated
// explicit clear or the 64-entry FIFO eviction reached it.
test('use with the loot_map item invalidates the /overview cache for this world', async () => {
  const pool = makePool({ bounded: true, userItems: [{ id: 'map-1', item_type_id: 2, quantity: 1 }] });
  const { url, handle, server } = await bootWith(pool);
  const ws = await joinAndGetPlayer(url);

  // Seed a cached /overview entry the same way the real route keys it
  // (worldId:snappedCol:snappedRow) -- the exact prefix clearOverviewCache
  // matches on.
  worldOverviewCache.set('w1:0:0', { chests: [] });
  assert.ok(worldOverviewCache.has('w1:0:0'), 'sanity: the cache entry exists before the spawn');

  ws.send(JSON.stringify({ type: 'use', itemId: 'map-1' }));
  await nextMsg(ws, 'used');

  assert.equal(
    worldOverviewCache.has('w1:0:0'), false,
    'a field-chest spawn via `use` must clear this world\'s cached /overview entries',
  );

  ws.close(); handle.close(); server.close();
  clearOverviewCache('w1'); // leave no cross-test residue in the shared singleton Map
});
