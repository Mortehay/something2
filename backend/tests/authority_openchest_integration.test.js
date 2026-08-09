const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const { attachAuthority } = require('../src/authority/server.js');

// Harness follows authority_use_field_chest_integration.test.js exactly (same
// fakePool shape, same bootWith/nextMsg/connect helpers) -- that file is
// Task 4's own coverage of server.js's message-handler dispatch
// (`messageHandlers`), so `openchest` (this file's subject) reuses the same
// pattern rather than inventing a third parallel harness for the same
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

// The player is given a PERSISTED spawn point (world_players row) so its
// position is deterministic instead of depending on chooseSpawn's bounded-
// center math -- the chest is placed at/near this same point (or far away,
// for the "nothing in range" case) so proximity is exact rather than
// incidental.
const SPAWN = { x: 500, y: 500 };

// `chestSeed` seeds fetchChests' load-time row (world_chests WHERE world_id),
// which becomes the live-world's entry.chests[0] via mapChestRow. `state`/
// `guardAlive` are mutable closures so the SAME chest id can be read (SELECT
// ... FOR UPDATE), transitioned (UPDATE ... unlocked / CAS ... opened), and
// re-read across multiple `openchest` frames in one test, exactly like a
// real world_chests row would be.
function makePool({ chestSeed, guardAlive = false } = {}) {
  const calls = [];
  let chestState = chestSeed.state;
  const pool = {
    calls,
    matching(re) { return calls.filter((c) => re.test(c.sql)); },
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/FROM worlds WHERE id/i.test(sql)) {
        return {
          rows: [{
            id: 'w1', seed: '1', chunk_size: 64, width: 10, height: 10,
            is_entry: null, entry_spawn: null, biomes: [], biome_cell: null,
            level_min: 1, level_max: 5,
          }],
        };
      }
      if (/token_version.*FROM users WHERE/i.test(sql)) return { rows: [{ token_version: 1 }] };
      if (/FROM tile_types/i.test(sql)) return { rows: [{ name: 'grass', walkable: true, speed: 1 }] };
      if (/FROM entity_types e[\s\S]*WHERE e\.is_creature/i.test(sql)) return { rows: [] };
      if (/FROM item_types/i.test(sql)) {
        return {
          rows: [
            { id: 1, name: 'dagger', category: 'weapon', stackable: false },
            { id: 2, name: 'loot_map', category: 'consumable', stackable: true },
          ],
        };
      }
      if (/^\s*INSERT INTO world_chunks/i.test(sql)) return { rows: [], rowCount: 0 };
      // Persisted spawn: loadSpawn's own read, distinct from fetchChests'
      // "WHERE world_id" read below.
      if (/SELECT x, y FROM world_players WHERE world_id/i.test(sql)) {
        return { rows: [{ x: SPAWN.x, y: SPAWN.y }] };
      }
      if (/SELECT x, y FROM player_binds/i.test(sql)) return { rows: [] };
      if (/^\s*INSERT INTO world_players/i.test(sql)) return { rows: [] };
      // The guard-alive count query (openChest's own read) -- checked BEFORE
      // the generic "FROM world_creatures" bbox-load fallback below, since
      // both patterns match that fallback's broader regex.
      if (/SELECT count\(\*\) .* FROM world_creatures/i.test(sql)) {
        return { rows: [{ count: guardAlive ? '1' : '0' }], rowCount: 1 };
      }
      if (/FROM world_creatures/i.test(sql)) return { rows: [] }; // bbox load at world load
      if (/^\s*DELETE FROM world_items WHERE expires_at/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/SELECT.*FROM world_items/i.test(sql)) return { rows: [], rowCount: 0 }; // ground-item bbox load
      // fetchChests at world load: the one seeded chest.
      if (/FROM world_chests WHERE world_id/i.test(sql)) {
        return {
          rows: [{
            id: chestSeed.id, x: chestSeed.x, y: chestSeed.y, kind: chestSeed.kind,
            guard_entity_type_id: 1, guard_level: chestSeed.guardLevel,
            guard_creature_ids: chestSeed.guardCreatureIds, state: chestSeed.state,
            opened_at: null, respawn_at: null,
          }],
        };
      }
      // openChest's own locked read.
      if (/FROM world_chests WHERE id = \$1 FOR UPDATE/i.test(sql)) {
        if (params[0] !== chestSeed.id) return { rows: [], rowCount: 0 };
        return {
          rows: [{
            id: chestSeed.id, state: chestState, kind: chestSeed.kind,
            guard_creature_ids: chestSeed.guardCreatureIds, guard_level: chestSeed.guardLevel,
          }],
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
        return { rows: [{ id: chestSeed.id, opened_at: '2026-08-10T00:00:00.000Z' }], rowCount: 1 };
      }
      // Field-chest-only respawn timer (chestLoot.js's openChest, branching
      // on `kind`).
      if (/UPDATE world_chests SET respawn_at/i.test(sql)) {
        return { rows: [{ respawn_at: '2026-08-10T02:00:00.000Z' }], rowCount: 1 };
      }
      if (/FROM chest_loot/i.test(sql)) {
        return { rows: [{ item_type_id: 7, chance: '1', min_qty: 1, max_qty: 1 }], rowCount: 1 };
      }
      if (/INSERT INTO player_items/i.test(sql)) {
        return { rows: [{ id: 'pi1', item_type_id: 7, quantity: 1 }], rowCount: 1 };
      }
      if (/FROM player_progression/i.test(sql)) {
        return { rows: [{ level: 1, experience: 0 }], rowCount: 1 };
      }
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

async function joinAndGetPlayer(url) {
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', world_id: 'w1' }));
  await nextMsg(ws, 'joined');
  return ws;
}

test('openchest with no chest in range sends an error frame', async () => {
  const pool = makePool({
    chestSeed: {
      id: 'chest-1', x: 5000, y: 5000, kind: 'vault', state: 'locked', guardLevel: 5, guardCreatureIds: [],
    },
  });
  const { url, handle, server } = await bootWith(pool);
  const ws = await joinAndGetPlayer(url);

  ws.send(JSON.stringify({ type: 'openchest' }));
  const err = await nextMsg(ws, 'error');
  assert.match(err.message, /no chest nearby/);
  assert.equal(handle.worlds.get('w1').chests[0].state, 'locked');

  ws.close(); handle.close(); server.close();
});

test('openchest against a chest with a live guard sends an error frame mentioning the guard', async () => {
  const pool = makePool({
    chestSeed: {
      id: 'chest-1', x: SPAWN.x, y: SPAWN.y, kind: 'vault', state: 'locked', guardLevel: 5, guardCreatureIds: ['guard-1'],
    },
    guardAlive: true,
  });
  const { url, handle, server } = await bootWith(pool);
  const ws = await joinAndGetPlayer(url);

  ws.send(JSON.stringify({ type: 'openchest' }));
  const err = await nextMsg(ws, 'error');
  assert.match(err.message, /guard/i);
  assert.equal(handle.worlds.get('w1').chests[0].state, 'locked', 'a refused open must not flip the in-memory cache');

  ws.close(); handle.close(); server.close();
});

test('openchest against an unlocked chest in range sends chestOpened with items+XP, then a second attempt on the now-opened vault chest is refused', async () => {
  const pool = makePool({
    chestSeed: {
      id: 'chest-1', x: SPAWN.x, y: SPAWN.y, kind: 'vault', state: 'unlocked', guardLevel: 5, guardCreatureIds: [],
    },
  });
  const { url, handle, server } = await bootWith(pool);
  const ws = await joinAndGetPlayer(url);

  ws.send(JSON.stringify({ type: 'openchest' }));
  const opened = await nextMsg(ws, 'chestOpened');
  assert.equal(opened.chestId, 'chest-1');
  assert.deepEqual(opened.items, [7]);
  assert.ok(opened.awarded > 0, 'a guard-level-5 chest opened by a level-1 player must award positive XP');

  const entry = handle.worlds.get('w1');
  assert.equal(entry.chests.length, 1);
  assert.equal(entry.chests[0].state, 'opened', 'the in-memory cache must reflect the DB write openChest committed');
  assert.ok(entry.chests[0].openedAt, 'openedAt must be carried into the in-memory cache too, not just the DB row');
  assert.equal(entry.chests[0].respawnAt, null, 'a vault chest never gets a respawn timer');

  // A second attempt: nearestChest excludes an opened vault chest, so this
  // never even reaches openChest / the DB again.
  const insertCallsBefore = pool.matching(/INSERT INTO player_items/i).length;
  ws.send(JSON.stringify({ type: 'openchest' }));
  const err = await nextMsg(ws, 'error');
  assert.match(err.message, /no chest nearby/);
  assert.equal(pool.matching(/INSERT INTO player_items/i).length, insertCallsBefore, 'no second loot grant');

  ws.close(); handle.close(); server.close();
});

test('openchest against a field chest carries respawnAt into the in-memory cache, not just the DB row', async () => {
  const pool = makePool({
    chestSeed: {
      id: 'chest-1', x: SPAWN.x, y: SPAWN.y, kind: 'field', state: 'unlocked', guardLevel: 5, guardCreatureIds: [],
    },
  });
  const { url, handle, server } = await bootWith(pool);
  const ws = await joinAndGetPlayer(url);

  ws.send(JSON.stringify({ type: 'openchest' }));
  const opened = await nextMsg(ws, 'chestOpened');
  assert.equal(opened.chestId, 'chest-1');

  const entry = handle.worlds.get('w1');
  assert.equal(entry.chests[0].state, 'opened');
  assert.ok(entry.chests[0].openedAt, 'openedAt must be carried into the in-memory cache');
  assert.ok(
    entry.chests[0].respawnAt,
    'a field chest open must carry respawnAt into the in-memory cache, or a chest the respawn sweep later relocks would look permanently opened to an already-connected player',
  );
  assert.ok(pool.matching(/UPDATE world_chests SET respawn_at/i).length > 0, 'field chest open must schedule a respawn in the DB');

  ws.close(); handle.close(); server.close();
});
