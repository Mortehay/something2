const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const request = require('supertest');
const { app, __setPool } = require('../src/index.js');
const { attachAuthority } = require('../src/authority/server.js');

// Review follow-up on Task 6b (commit 7e10da4): the /overview cache
// (worldOverviewCache, now backend/src/services/overviewCache.js) had zero
// invalidation coverage for a chest's `state` field -- the very field this
// task added to the payload. Villages/doorways get their overview cache
// cleared on every mutation that changes what they show (village create/
// delete, doorway link create/delete, all via invalidateWorld in index.js);
// chests never did, because their two state-mutation paths
// (chestLoot.js's openChest, chests.js's respawnDueFieldChests) live on the
// authority side, not in index.js.
//
// This file proves the fix end-to-end across BOTH subsystems in one process
// -- exactly the scenario that was silently broken: populate the /overview
// cache via the real Express `app` (supertest), open the chest via the real
// authority WS `openchest` handler (attachAuthority), then re-request the
// SAME cached window and confirm it reflects the new state rather than the
// stale cached one. Harness follows progression_routes.test.js's "Part 3"
// pattern (real `app` + real `attachAuthority` sharing one fake pool) and
// authority_openchest_integration.test.js's fakePool shape for the
// openchest flow itself.

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

const SPAWN = { x: 500, y: 500 };
const WORLD_ID = 'w-chest-cache';

// `chestState` is a mutable closure so fetchChests (world load, AND the
// /overview route's own fresh per-request read) and openChest's FOR-UPDATE
// read/CAS all see the SAME evolving world_chests row -- a real
// locked/unlocked/opened lifecycle, not three independently-scripted answers
// that could drift out of sync with each other.
function makePool() {
  let chestState = 'unlocked';
  const pool = {
    query: async (sql) => {
      if (/FROM worlds WHERE id/i.test(sql)) {
        return {
          rows: [{
            id: WORLD_ID, seed: '1', chunk_size: 64, width: 10, height: 10,
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
      if (/FROM characters/i.test(sql)) return { rows: [{ id: 1, entity_type_id: 1 }] };
      if (/FROM worlds w WHERE w\.id/i.test(sql)) return { rows: [{ is_entry: true, allows_fast_travel: false, visited: false, visited_any: false, last_world: null }] };
      if (/FROM tile_types/i.test(sql)) return { rows: [{ name: 'grass', color: '#3a5', walkable: true, speed: 1 }] };
      if (/FROM map_links/i.test(sql)) return { rows: [] };
      if (/FROM villages/i.test(sql)) return { rows: [] };
      if (/FROM entity_types e[\s\S]*WHERE e\.is_creature/i.test(sql)) return { rows: [] };
      if (/FROM item_types/i.test(sql)) return { rows: [{ id: 1, name: 'dagger', category: 'weapon', stackable: false }] };
      if (/^\s*INSERT INTO world_chunks/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/SELECT x, y FROM world_players WHERE world_id/i.test(sql)) return { rows: [{ x: SPAWN.x, y: SPAWN.y }] };
      if (/FROM player_binds WHERE/i.test(sql)) return { rows: [] };
      if (/^\s*INSERT INTO world_players/i.test(sql)) return { rows: [] };
      if (/SELECT count\(\*\) .* FROM world_creatures/i.test(sql)) return { rows: [{ count: '0' }] };
      if (/FROM world_creatures/i.test(sql)) return { rows: [] };
      if (/^\s*DELETE FROM world_items WHERE expires_at/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/SELECT.*FROM world_items/i.test(sql)) return { rows: [], rowCount: 0 };
      // fetchChests: world load (authority) AND the /overview route's own
      // fresh read -- both hit this same branch, both must see chestState.
      if (/FROM world_chests WHERE world_id/i.test(sql)) {
        return {
          rows: [{
            id: 'chest-1', x: SPAWN.x, y: SPAWN.y, kind: 'vault',
            guard_entity_type_id: 1, guard_level: 5, guard_creature_ids: [],
            state: chestState, opened_at: null, respawn_at: null,
          }],
        };
      }
      // openChest's own locked/unlocked read (chestLoot.js).
      if (/FROM world_chests WHERE id = \$1 FOR UPDATE/i.test(sql)) {
        return {
          rows: [{ id: 'chest-1', state: chestState, kind: 'vault', guard_creature_ids: [], guard_level: 5 }],
          rowCount: 1,
        };
      }
      if (/UPDATE world_chests SET state = 'unlocked' WHERE id = \$1/i.test(sql)) {
        chestState = 'unlocked';
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE world_chests SET state = 'opened'/i.test(sql)) {
        if (chestState !== 'unlocked') return { rows: [], rowCount: 0 };
        chestState = 'opened';
        return { rows: [{ id: 'chest-1', opened_at: '2026-08-10T00:00:00.000Z' }], rowCount: 1 };
      }
      if (/FROM chest_loot/i.test(sql)) return { rows: [{ item_type_id: 7, chance: '1', min_qty: 1, max_qty: 1 }], rowCount: 1 };
      if (/INSERT INTO player_items/i.test(sql)) return { rows: [{ id: 'pi1', item_type_id: 7, quantity: 1 }], rowCount: 1 };
      if (/FROM player_progression/i.test(sql)) return { rows: [{ level: 1, experience: 0 }], rowCount: 1 };
      if (/UPDATE player_progression/i.test(sql)) {
        return {
          rows: [{
            user_id: '1', experience: 50, level: 1, stat_points: 0,
            strength: 5, dexterity: 5, constitution: 5, intelligence: 5, wisdom: 5, charisma: 5,
          }],
          rowCount: 1,
        };
      }
      if (/^\s*SELECT id, item_type_id, quantity FROM player_items WHERE user_id/i.test(sql)) return { rows: [] };
      if (/FROM player_equipment WHERE user_id/i.test(sql)) return { rows: [] };
      if (/SELECT gold FROM users WHERE id/i.test(sql)) return { rows: [{ gold: 0 }] };
      return { rows: [] };
    },
  };
  pool.connect = async () => ({ query: pool.query, release: () => {} });
  return pool;
}

test('opening a chest invalidates the /overview cache: a previously-cached window reflects the new state on the next request', async () => {
  const pool = makePool();
  __setPool(pool);

  // 1) Populate the overview cache with the chest still 'unlocked'.
  const first = await request(app).get(`/api/worlds/${WORLD_ID}/overview?cx=0&cy=0`);
  assert.strictEqual(first.status, 200);
  assert.strictEqual(first.body.chests.length, 1);
  assert.strictEqual(first.body.chests[0].state, 'unlocked');

  // 2) Open the chest via the REAL authority WS handler (openchest ->
  // chestLoot.js's openChest -> the two UPDATEs the reviewer flagged).
  const { url, handle, server } = await bootWith(pool);
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', character_id: 1, world_id: WORLD_ID }));
  await nextMsg(ws, 'joined');
  ws.send(JSON.stringify({ type: 'openchest' }));
  const opened = await nextMsg(ws, 'chestOpened');
  assert.strictEqual(opened.chestId, 'chest-1');
  ws.close(); handle.close(); server.close();

  // 3) Re-request the SAME window (same cache key: worldId:snappedCol:
  // snappedRow). Before the fix this silently served the stale cached
  // 'unlocked' entry -- clearOverviewCache was never called from the chest
  // mutation path, so the cache never learned the chest had opened.
  const second = await request(app).get(`/api/worlds/${WORLD_ID}/overview?cx=0&cy=0`);
  assert.strictEqual(second.status, 200);
  assert.strictEqual(
    second.body.chests[0].state,
    'opened',
    'the /overview cache must be invalidated when a chest\'s state changes, not just when villages/doorways change',
  );
});
