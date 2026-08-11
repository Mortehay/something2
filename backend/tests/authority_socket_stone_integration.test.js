const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const { attachAuthority } = require('../src/authority/server.js');

// Harness copied from authority_use_field_chest_integration.test.js's own
// header comment: that file (found via `grep -rln "handlers.drop\|
// handlers.pickup\|type: 'drop'\|type: 'pickup'" tests/*.js`) is the only
// existing coverage of server.js's message-handler dispatch (`messageHandlers`,
// not `handlers` -- confirmed still accurate, server.js:908), so `socket`/
// `unsocket` (this file's subject) reuse its exact fakePool/bootWith/nextMsg
// shape rather than inventing a second parallel harness for the same surface.

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

// Item catalog for these tests: a weapon (host), an armor (host, incompatible
// with a spell stone), and a spell stone (element set).
const WEAPON_TYPE_ID = 1;
const ARMOR_TYPE_ID = 3;
const SPELL_STONE_TYPE_ID = 2;

// `stoneInstances`/`itemsById` are mutated live by the routed queries below,
// the same "fake DB with in-memory state" shape groundItems/chests fixtures
// elsewhere in this test suite use -- socket/unsocket's SELECT-then-UPDATE
// shape needs a stateful fake, not just a fixed canned response, or a
// "socket then immediately unsocket" scenario could not be expressed.
function makePool({ userItems = [], stoneInstances = new Map() } = {}) {
  const calls = [];
  const itemsById = new Map(userItems.map((it) => [it.id, it]));
  const pool = {
    calls,
    matching(re) { return calls.filter((c) => re.test(c.sql)); },
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/FROM worlds WHERE id/i.test(sql)) {
        return {
          rows: [{
            id: 'w1', seed: '1', chunk_size: 64,
            width: 10, height: 10,
            is_entry: null, entry_spawn: null, biomes: [], biome_cell: null,
            level_min: 1, level_max: 5,
          }],
        };
      }
      if (/token_version.*FROM users WHERE/i.test(sql)) return { rows: [{ token_version: 1 }] };
      if (/FROM characters/i.test(sql)) return { rows: [{ id: Number(params[0]) || 1, entity_type_id: 1 }] };
      if (/FROM worlds w WHERE w\.id/i.test(sql)) return { rows: [{ is_entry: true, allows_fast_travel: false, visited: false, visited_any: false, last_world: null }] };
      if (/FROM tile_types/i.test(sql)) return { rows: [{ name: 'grass', walkable: true, speed: 1 }] };
      if (/FROM entity_types e[\s\S]*WHERE e\.is_creature/i.test(sql)) return { rows: [] };
      if (/FROM item_types/i.test(sql)) {
        return {
          rows: [
            { id: WEAPON_TYPE_ID, name: 'dagger', category: 'weapon', stackable: false },
            { id: ARMOR_TYPE_ID, name: 'leather-vest', category: 'armor', slot: 'chest', stackable: false },
            { id: SPELL_STONE_TYPE_ID, name: 'stone_of_fire', category: 'stone', element: 'fire', stackable: false },
          ],
        };
      }
      if (/^\s*INSERT INTO world_chunks/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/FROM world_players WHERE/i.test(sql)) return { rows: [] };
      if (/^\s*INSERT INTO world_players/i.test(sql)) return { rows: [] };
      if (/FROM world_creatures/i.test(sql)) return { rows: [] };
      if (/^\s*DELETE FROM world_items WHERE expires_at/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/SELECT.*FROM world_items/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/FROM world_chests WHERE world_id/i.test(sql)) return { rows: [] };
      if (/^\s*SELECT id, item_type_id, quantity FROM player_items WHERE character_id/i.test(sql)) {
        return { rows: userItems.map((it) => ({ id: it.id, item_type_id: it.item_type_id, quantity: 1 })) };
      }
      if (/FROM player_equipment WHERE character_id/i.test(sql)) return { rows: [] };
      if (/SELECT gold FROM users WHERE id/i.test(sql)) return { rows: [{ gold: 0 }] };

      // --- socket/unsocket-specific routes (items.js: socketStone/unsocketStone) ---
      if (/SELECT pi\.item_type_id, si\.socketed_into_id/i.test(sql)) {
        const [stoneId, characterId] = params;
        const item = itemsById.get(stoneId);
        const inst = stoneInstances.get(stoneId);
        if (!item || !inst || String(characterId) !== '1') return { rows: [], rowCount: 0 };
        return { rows: [{ item_type_id: item.item_type_id, socketed_into_id: inst.socketed_into_id }], rowCount: 1 };
      }
      if (/^SELECT item_type_id FROM player_items WHERE id = \$1 AND character_id = \$2 FOR UPDATE/i.test(sql)) {
        const [hostId, characterId] = params;
        const item = itemsById.get(hostId);
        if (!item || String(characterId) !== '1') return { rows: [], rowCount: 0 };
        return { rows: [{ item_type_id: item.item_type_id }], rowCount: 1 };
      }
      if (/SELECT 1 FROM stone_instances WHERE socketed_into_id = \$1/i.test(sql)) {
        const [hostId] = params;
        const occupied = [...stoneInstances.values()].some((v) => v.socketed_into_id === hostId);
        return occupied ? { rows: [{ x: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (/UPDATE stone_instances SET socketed_into_id = \$1 WHERE player_item_id = \$2/i.test(sql)) {
        const [hostId, stoneId] = params;
        stoneInstances.set(stoneId, { socketed_into_id: hostId });
        return { rows: [], rowCount: 1 };
      }
      if (/SELECT si\.socketed_into_id FROM player_items/i.test(sql)) {
        const [stoneId, characterId] = params;
        const inst = stoneInstances.get(stoneId);
        if (!inst || inst.socketed_into_id == null || String(characterId) !== '1') return { rows: [], rowCount: 0 };
        return { rows: [{ socketed_into_id: inst.socketed_into_id }], rowCount: 1 };
      }
      if (/^UPDATE stone_instances SET socketed_into_id = NULL WHERE player_item_id = \$1/i.test(sql)) {
        const [stoneId] = params;
        const inst = stoneInstances.get(stoneId);
        if (inst) inst.socketed_into_id = null;
        return { rows: [], rowCount: 1 };
      }
      if (/^DELETE FROM player_items WHERE id = \$1$/i.test(sql)) {
        const [stoneId] = params;
        itemsById.delete(stoneId);
        stoneInstances.delete(stoneId);
        return { rows: [], rowCount: 1 };
      }

      return { rows: [] };
    },
  };
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

test('socket with an incompatible stone/host pair sends an error frame', async () => {
  const stoneInstances = new Map([['stone-1', { socketed_into_id: null }]]);
  const userItems = [
    { id: 'stone-1', item_type_id: SPELL_STONE_TYPE_ID },
    { id: 'armor-1', item_type_id: ARMOR_TYPE_ID },
  ];
  const pool = makePool({ userItems, stoneInstances });
  const { url, handle, server } = await bootWith(pool);
  const ws = await joinAndGetPlayer(url);

  ws.send(JSON.stringify({ type: 'socket', stoneId: 'stone-1', hostId: 'armor-1' }));
  const err = await nextMsg(ws, 'error');
  assert.match(err.message, /compatib/i);
  assert.equal(pool.matching(/UPDATE stone_instances SET socketed_into_id = \$1/i).length, 0);

  ws.close(); handle.close(); server.close();
});

test('unsocket without confirm:true sends an error frame and makes no socket/unsocket DB call', async () => {
  const pool = makePool({ userItems: [] });
  const { url, handle, server } = await bootWith(pool);
  const ws = await joinAndGetPlayer(url);

  ws.send(JSON.stringify({ type: 'unsocket', stoneId: 'stone-1' })); // confirm omitted
  const err = await nextMsg(ws, 'error');
  assert.match(err.message, /confirm/i);
  assert.equal(pool.matching(/stone_instances/i).length, 0, 'no DB call before the confirm gate');

  ws.close(); handle.close(); server.close();
});

test('a successful socket sends a socketed frame and the stone/host stay in sync for a later action', async () => {
  const stoneInstances = new Map([['stone-1', { socketed_into_id: null }]]);
  const userItems = [
    { id: 'stone-1', item_type_id: SPELL_STONE_TYPE_ID },
    { id: 'weapon-1', item_type_id: WEAPON_TYPE_ID },
  ];
  const pool = makePool({ userItems, stoneInstances });
  const { url, handle, server } = await bootWith(pool);
  const ws = await joinAndGetPlayer(url);

  ws.send(JSON.stringify({ type: 'socket', stoneId: 'stone-1', hostId: 'weapon-1' }));
  const ok = await nextMsg(ws, 'socketed');
  assert.equal(ok.stoneId, 'stone-1');
  assert.equal(ok.hostId, 'weapon-1');
  assert.equal(stoneInstances.get('stone-1').socketed_into_id, 'weapon-1');

  const entry = handle.worlds.get('w1');
  const p = entry.world.getPlayer('1');
  const hostItem = p.inv.items.find((it) => it.id === 'weapon-1');
  assert.equal(hostItem.socketedStoneTypeId, SPELL_STONE_TYPE_ID, 'in-memory inv must reflect the socketing without a reload');

  ws.close(); handle.close(); server.close();
});

test('unsocket sends unsocketed with the correct destroyed flag under a forced-destroy roll', async () => {
  const stoneInstances = new Map([['stone-1', { socketed_into_id: 'weapon-1' }]]);
  const userItems = [
    { id: 'stone-1', item_type_id: SPELL_STONE_TYPE_ID },
    { id: 'weapon-1', item_type_id: WEAPON_TYPE_ID },
  ];
  const pool = makePool({ userItems, stoneInstances });
  const { url, handle, server } = await bootWith(pool);
  const ws = await joinAndGetPlayer(url);

  const origRandom = Math.random;
  Math.random = () => 0; // forces rollDestroy true (0 < 0.10)
  try {
    ws.send(JSON.stringify({ type: 'unsocket', stoneId: 'stone-1', confirm: true }));
    const msg = await nextMsg(ws, 'unsocketed');
    assert.equal(msg.destroyed, true);
    assert.equal(stoneInstances.has('stone-1'), false, 'the destroyed stone row is gone');
  } finally {
    Math.random = origRandom;
  }

  ws.close(); handle.close(); server.close();
});

test('unsocket sends unsocketed with the correct destroyed flag under a forced-survive roll', async () => {
  const stoneInstances = new Map([['stone-1', { socketed_into_id: 'weapon-1' }]]);
  const userItems = [
    { id: 'stone-1', item_type_id: SPELL_STONE_TYPE_ID },
    { id: 'weapon-1', item_type_id: WEAPON_TYPE_ID },
  ];
  const pool = makePool({ userItems, stoneInstances });
  const { url, handle, server } = await bootWith(pool);
  const ws = await joinAndGetPlayer(url);

  const origRandom = Math.random;
  Math.random = () => 0.99; // forces rollDestroy false
  try {
    ws.send(JSON.stringify({ type: 'unsocket', stoneId: 'stone-1', confirm: true }));
    const msg = await nextMsg(ws, 'unsocketed');
    assert.equal(msg.destroyed, false);
    assert.equal(stoneInstances.get('stone-1').socketed_into_id, null, 'survives, but ejected from the host');
  } finally {
    Math.random = origRandom;
  }

  ws.close(); handle.close(); server.close();
});
