const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const { attachAuthority } = require('../src/authority/server.js');

// Task 6b: chests must ride the same live per-tick AOI channel creatures/
// items already use (broadcastCreatures/broadcastItems -> now also
// broadcastChests), not just the one-shot 'joined' `merchants` list villages
// get. Harness follows authority_openchest_integration.test.js /
// authority_groundItems_integration.test.js (same fakePool shape, same
// bootWith/nextMsg/connect helpers) -- this file's fetchChests row shape
// (world_chests columns -> mapChestRow) is exactly theirs, just seeding
// entry.chests without exercising the openchest handler itself.

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

// `chests`: [{ id, x, y, kind, state, guardLevel?, guardCreatureIds? }] --
// becomes the world-load fetchChests row set (world_chests shape), which
// mapChestRow turns into entry.chests, exactly like a real chest row would.
function makePool({ chests = [] } = {}) {
  const pool = {
    query: async (sql) => {
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
      // Two answers this fixture predates, both from the player-characters
      // line of work that landed in parallel with chests (SOMET-260/271).
      // Unanswered, the join is REFUSED and the test hangs on
      // nextMsg('joined') rather than failing.
      if (/FROM characters/i.test(sql)) return { rows: [{ id: 1, entity_type_id: 1 }] };
      if (/FROM worlds w WHERE w\.id/i.test(sql)) return { rows: [{ is_entry: true, allows_fast_travel: false, visited: false, visited_any: false, last_world: null }] };
      if (/FROM tile_types/i.test(sql)) return { rows: [{ name: 'grass', walkable: true, speed: 1 }] };
      if (/FROM entity_types e[\s\S]*WHERE e\.is_creature/i.test(sql)) return { rows: [] };
      if (/FROM item_types/i.test(sql)) return { rows: [{ id: 1, name: 'dagger', category: 'weapon', stackable: false }] };
      if (/^\s*INSERT INTO world_chunks/i.test(sql)) return { rows: [], rowCount: 0 };
      // Persisted spawn so the chest's proximity to the player is exact.
      if (/SELECT x, y FROM world_players WHERE world_id/i.test(sql)) return { rows: [{ x: SPAWN.x, y: SPAWN.y }] };
      if (/FROM player_binds WHERE/i.test(sql)) return { rows: [] };
      if (/^\s*INSERT INTO world_players/i.test(sql)) return { rows: [] };
      if (/FROM world_creatures/i.test(sql)) return { rows: [] };
      if (/^\s*DELETE FROM world_items WHERE expires_at/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/SELECT.*FROM world_items/i.test(sql)) return { rows: [], rowCount: 0 };
      // fetchChests at world load (services/chests.js).
      if (/FROM world_chests WHERE world_id/i.test(sql)) {
        return {
          rows: chests.map((c) => ({
            id: c.id, x: c.x, y: c.y, kind: c.kind,
            guard_entity_type_id: 1, guard_level: c.guardLevel || 1,
            guard_creature_ids: c.guardCreatureIds || [], state: c.state,
            opened_at: null, respawn_at: null,
          })),
        };
      }
      if (/SELECT gold FROM users WHERE id/i.test(sql)) return { rows: [{ gold: 0 }] };
      return { rows: [] };
    },
  };
  pool.connect = async () => ({ query: pool.query, release: () => {} });
  return pool;
}

test('a chest in entry.chests reaches a connected player on the live "chests" broadcast with id/x/y/kind/state', async () => {
  const pool = makePool({
    chests: [{ id: 'chest-1', x: SPAWN.x, y: SPAWN.y, kind: 'vault', state: 'locked', guardLevel: 5 }],
  });
  const { url, handle, server } = await bootWith(pool);
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', character_id: 1, world_id: 'w1' }));
  await nextMsg(ws, 'joined');

  const msg = await nextMsg(ws, 'chests');
  assert.equal(msg.chests.length, 1);
  assert.deepEqual(msg.chests[0], { id: 'chest-1', x: SPAWN.x, y: SPAWN.y, kind: 'vault', state: 'locked' });

  ws.close(); handle.close(); server.close();
});

test('a chest outside the player\'s active-chunk neighborhood is omitted from the live broadcast', async () => {
  const pool = makePool({
    chests: [
      { id: 'chest-near', x: SPAWN.x, y: SPAWN.y, kind: 'vault', state: 'locked', guardLevel: 5 },
      // chunk_size 64 (span 6400px): well outside the 3x3 active neighborhood around chunk (0,0).
      { id: 'chest-far', x: 50000, y: 50000, kind: 'field', state: 'unlocked', guardLevel: 1 },
    ],
  });
  const { url, handle, server } = await bootWith(pool);
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', character_id: 1, world_id: 'w1' }));
  await nextMsg(ws, 'joined');

  const msg = await nextMsg(ws, 'chests');
  assert.equal(msg.chests.length, 1);
  assert.equal(msg.chests[0].id, 'chest-near');

  ws.close(); handle.close(); server.close();
});

// entry.chests reflects a chest's state transition (guard death, openchest,
// respawn sweep) in place -- Task 6's own review-fixed invariant. The
// broadcast reads that same array on every tick, so a mutated state must
// reach the wire on the NEXT broadcast without any extra plumbing.
test('a chest state mutated on entry.chests (in place) is reflected on the next broadcast', async () => {
  const pool = makePool({
    chests: [{ id: 'chest-1', x: SPAWN.x, y: SPAWN.y, kind: 'vault', state: 'locked', guardLevel: 5 }],
  });
  const { url, handle, server } = await bootWith(pool);
  const ws = connect(url, 1);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'join', character_id: 1, world_id: 'w1' }));
  await nextMsg(ws, 'joined');

  const first = await nextMsg(ws, 'chests');
  assert.equal(first.chests[0].state, 'locked');

  const entry = handle.worlds.get('w1');
  entry.chests[0].state = 'unlocked';

  const next = await nextMsg(ws, 'chests');
  assert.equal(next.chests[0].state, 'unlocked');

  ws.close(); handle.close(); server.close();
});
