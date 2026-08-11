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
// with a spell stone), a spell stone (element set), and a buff stone
// (stat_bonus_stat set, no element -- SOMET-245 Task 6's subject). +2
// constitution -> maxHp +20 (HP_PER_CON, progressionConstants.js), matching
// authority_server.test.js's own highConProgression literal-math comment.
const WEAPON_TYPE_ID = 1;
const ARMOR_TYPE_ID = 3;
const SPELL_STONE_TYPE_ID = 2;
const BUFF_STONE_TYPE_ID = 4;

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
            {
              id: BUFF_STONE_TYPE_ID, name: 'stone_of_vigor', category: 'stone', element: null,
              stat_bonus_stat: 'constitution', stat_bonus_amount: 2, stackable: false,
            },
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
  // Magic-stones Task 5: loadInventory now hydrates the socketedStoneTypeId
  // cache from stone_instances on every join (see items.js), so the pool
  // legitimately already has one such call by the time joinAndGetPlayer
  // returns -- that is unrelated to unsocket's confirm gate. Snapshot the
  // count AFTER join and assert no NEW stone_instances call, rather than
  // zero ever, so this test keeps testing what it says it tests.
  const beforeUnsocket = pool.matching(/stone_instances/i).length;

  ws.send(JSON.stringify({ type: 'unsocket', stoneId: 'stone-1' })); // confirm omitted
  const err = await nextMsg(ws, 'error');
  assert.match(err.message, /confirm/i);
  assert.equal(pool.matching(/stone_instances/i).length, beforeUnsocket, 'no DB call before the confirm gate');

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
  // SOMET-245 Task 7: the stone's OWN instance id must ALSO be cached live,
  // not just its catalog type -- combat's activeWeaponType reads this to
  // award stone XP against the right stone_instances row on a landed hit.
  assert.equal(hostItem.socketedStoneItemId, 'stone-1', 'the stone\'s own instance id must be cached too, not just its type');

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

// --- SOMET-245 Task 6: buff-stone re-derive on socket/unsocket -----------
//
// A spell stone (the fixture used everywhere above) never changes a player's
// derived stats, so none of the tests above exercise the new re-derive path
// at all -- these two are the only coverage for it. Both read the LIVE
// player object's maxHp off `handle.worlds`, the same access pattern the
// existing "stone/host stay in sync" test above already uses, rather than
// trying to infer it from a wire frame -- applyDerivedStats' effect is on
// World#players, and the `progression` frame's own `progression` field is
// the raw (unbuffed) DB row by design (see server.js's onCreatureDeath/
// openchest frames, which never buff `progression` either -- only `stats`
// carries the buffed bundle, and only refreshPlayerStats' frame has a
// `stats` field at all).
//
// A successful socket/unsocket of a BUFF stone is the only action in this
// whole file that sends TWO frames for one client message ('socketed'/
// 'unsocketed' immediately followed by 'progression'). The shared nextMsg()
// above attaches a fresh, self-removing listener per call -- fine when a
// server action sends exactly one reply (every other test here), but on a
// localhost socket both sends can land in the SAME client-side read, so 'ws'
// parses and emits both 'message' events synchronously within one callback.
// By the time `await nextMsg(ws, 'socketed')`'s continuation resumes and
// attaches a listener for 'progression', that second frame has already come
// and gone with nobody listening -- EventEmitter drops an event with no
// listener, there is no re-delivery, and the second nextMsg() call then
// waits out its full 3s timeout for a frame that already arrived. This was
// verified NOT to be a server-side bug (a debug trace confirmed server.js
// sends both frames every time) before writing this queue -- it is exactly
// the "message arrived before anyone was listening" race. messageQueue
// attaches ONE persistent listener up front that buffers anything nobody
// has asked for yet, so a frame that outruns the test code is still found.
function messageQueue(ws) {
  const queue = [];
  const waiters = [];
  ws.on('message', (data) => {
    const m = JSON.parse(data);
    const wi = waiters.findIndex((w) => !w.type || w.type === m.type);
    if (wi !== -1) {
      const [w] = waiters.splice(wi, 1);
      clearTimeout(w.to);
      w.resolve(m);
    } else {
      queue.push(m);
    }
  });
  return (type) => {
    const qi = queue.findIndex((m) => !type || m.type === type);
    if (qi !== -1) return Promise.resolve(queue.splice(qi, 1)[0]);
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error(`timeout ${type}`)), 3000);
      waiters.push({ type, resolve, to });
    });
  };
}

test('socketing a buff stone sends an immediate progression frame and raises maxHp right away', async () => {
  const stoneInstances = new Map([['stone-buff', { socketed_into_id: null }]]);
  const userItems = [
    { id: 'stone-buff', item_type_id: BUFF_STONE_TYPE_ID },
    { id: 'weapon-1', item_type_id: WEAPON_TYPE_ID },
  ];
  const pool = makePool({ userItems, stoneInstances });
  const { url, handle, server } = await bootWith(pool);
  const ws = await joinAndGetPlayer(url);
  const next = messageQueue(ws);

  const entry = handle.worlds.get('w1');
  const player = entry.world.getPlayer('1');
  const before = player.maxHp;
  // Important #4 fix (SOMET-245 final review): socketedBuffStones now only
  // counts a stone socketed into an EQUIPPED item (see stoneBonuses.js) --
  // this fixture's makePool always answers the player_equipment load with
  // no rows, so equip weapon-1 directly in-memory, the same way
  // stones_integration_db.test.js's DB-backed equivalent does.
  player.inv.equipment.main_hand = 'weapon-1';

  ws.send(JSON.stringify({ type: 'socket', stoneId: 'stone-buff', hostId: 'weapon-1' }));
  const socketed = await next('socketed');
  assert.equal(socketed.hostId, 'weapon-1');
  const frame = await next('progression');

  assert.equal(frame.leveledUp, false, 'no XP was awarded, only a re-derive triggered');
  assert.equal(frame.awarded, 0);
  assert.equal(player.maxHp, before + 20, 'buff stone (+2 constitution) must raise maxHp by 20 (HP_PER_CON) immediately, not at the next kill/level-up');

  ws.close(); handle.close(); server.close();
});

test('unsocketing a buff stone (survives) sends an immediate progression frame and removes the maxHp bonus right away', async () => {
  const stoneInstances = new Map([['stone-buff', { socketed_into_id: null }]]);
  const userItems = [
    { id: 'stone-buff', item_type_id: BUFF_STONE_TYPE_ID },
    { id: 'weapon-1', item_type_id: WEAPON_TYPE_ID },
  ];
  const pool = makePool({ userItems, stoneInstances });
  const { url, handle, server } = await bootWith(pool);
  const ws = await joinAndGetPlayer(url);
  const next = messageQueue(ws);

  const entry = handle.worlds.get('w1');
  const player = entry.world.getPlayer('1');
  const baseline = player.maxHp;
  // See the socket test above: socketedBuffStones now requires the host to
  // be equipped, so equip weapon-1 directly in-memory.
  player.inv.equipment.main_hand = 'weapon-1';

  // Socket first (setup), same as the previous test -- confirms the boosted
  // state before removing it.
  ws.send(JSON.stringify({ type: 'socket', stoneId: 'stone-buff', hostId: 'weapon-1' }));
  await next('socketed');
  await next('progression');
  assert.equal(player.maxHp, baseline + 20, 'setup: buff must be live before testing its removal');

  const origRandom = Math.random;
  Math.random = () => 0.99; // forces rollDestroy false -- the stone survives, just ejected
  try {
    ws.send(JSON.stringify({ type: 'unsocket', stoneId: 'stone-buff', confirm: true }));
    const unsocketed = await next('unsocketed');
    assert.equal(unsocketed.destroyed, false);
    const frame = await next('progression');
    assert.equal(frame.leveledUp, false);
    assert.equal(frame.awarded, 0);
    assert.equal(player.maxHp, baseline, 'maxHp must drop back to the unbuffed baseline once the buff stone is unsocketed');
  } finally {
    Math.random = origRandom;
  }

  ws.close(); handle.close(); server.close();
});
