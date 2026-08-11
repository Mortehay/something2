const test = require('node:test');
const assert = require('node:assert');
const { socketStone, unsocketStone } = require('../src/authority/items.js');

// Same scriptedRoutePool convention as chestLoot.test.js's openChest coverage
// (the closest existing analog: a check-then-act transaction over a checked-
// out client) -- regex-routed responses per SQL shape, falling through to an
// empty result for anything unmatched (BEGIN/COMMIT/ROLLBACK included).
function scriptedRoutePool(routes) {
  const calls = [];
  function route(sql, params) {
    for (const [re, result] of routes) {
      if (re.test(sql)) return typeof result === 'function' ? result(params) : result;
    }
    return { rows: [], rowCount: 0 };
  }
  return {
    calls,
    query: async (sql, params) => { calls.push({ sql, params }); return route(sql, params); },
    connect: async () => ({
      query: async (sql, params) => { calls.push({ sql, params }); return route(sql, params); },
      release: () => {},
    }),
  };
}

const ITEM_TYPES = new Map([
  [10, { id: 10, category: 'stone', element: 'fire', stat_bonus_stat: null }], // spell stone
  [11, { id: 11, category: 'stone', element: null, stat_bonus_stat: 'strength', stat_bonus_amount: 3 }], // buff stone
  [20, { id: 20, category: 'weapon' }],
  [21, { id: 21, category: 'armor' }],
]);

const STONE_SELECT = /SELECT pi\.item_type_id, si\.socketed_into_id/i;
const HOST_SELECT = /SELECT item_type_id FROM player_items WHERE id = \$1 AND character_id = \$2 FOR UPDATE/i;
const OCCUPANT_SELECT = /SELECT 1 FROM stone_instances WHERE socketed_into_id = \$1/i;
const SOCKET_UPDATE = /UPDATE stone_instances SET socketed_into_id = \$1 WHERE player_item_id = \$2/i;
const UNSOCKET_STONE_SELECT = /SELECT si\.socketed_into_id FROM player_items/i;
const UNSOCKET_CLEAR_UPDATE = /UPDATE stone_instances SET socketed_into_id = NULL WHERE player_item_id = \$1/i;
const STONE_DELETE = /DELETE FROM player_items WHERE id = \$1/i;

test('socketStone rejects a spell stone targeting armor', async () => {
  const pool = scriptedRoutePool([
    [STONE_SELECT, { rows: [{ item_type_id: 10, socketed_into_id: null }], rowCount: 1 }],
    [HOST_SELECT, { rows: [{ item_type_id: 21 }], rowCount: 1 }],
    [OCCUPANT_SELECT, { rows: [], rowCount: 0 }],
  ]);
  const inv = { items: [{ id: 'stone-1', typeId: 10 }, { id: 'host-1', typeId: 21 }], equipment: {} };
  const r = await socketStone(pool, 'char-1', inv, 'stone-1', 'host-1', ITEM_TYPES);
  assert.equal(r.ok, false);
  assert.match(r.reason, /compatib/i);
  assert.ok(!pool.calls.some((c) => SOCKET_UPDATE.test(c.sql)), 'no write on an incompatible pair');
});

test('socketStone rejects a host that already has an occupant', async () => {
  const pool = scriptedRoutePool([
    [STONE_SELECT, { rows: [{ item_type_id: 10, socketed_into_id: null }], rowCount: 1 }],
    [HOST_SELECT, { rows: [{ item_type_id: 20 }], rowCount: 1 }],
    [OCCUPANT_SELECT, { rows: [{ '?column?': 1 }], rowCount: 1 }],
  ]);
  const inv = { items: [{ id: 'stone-1', typeId: 10 }, { id: 'host-1', typeId: 20 }], equipment: {} };
  const r = await socketStone(pool, 'char-1', inv, 'stone-1', 'host-1', ITEM_TYPES);
  assert.equal(r.ok, false);
  assert.match(r.reason, /occupied|already/i);
  assert.ok(!pool.calls.some((c) => SOCKET_UPDATE.test(c.sql)));
});

test('socketStone rejects a stone the character does not own (or that does not exist)', async () => {
  const pool = scriptedRoutePool([
    [STONE_SELECT, { rows: [], rowCount: 0 }],
  ]);
  const inv = { items: [], equipment: {} };
  const r = await socketStone(pool, 'char-1', inv, 'not-mine', 'host-1', ITEM_TYPES);
  assert.equal(r.ok, false);
  assert.match(r.reason, /not found/i);
});

test('socketStone rejects a stone that is already socketed elsewhere', async () => {
  const pool = scriptedRoutePool([
    [STONE_SELECT, { rows: [{ item_type_id: 10, socketed_into_id: 'other-host' }], rowCount: 1 }],
  ]);
  const inv = { items: [{ id: 'stone-1', typeId: 10 }], equipment: {} };
  const r = await socketStone(pool, 'char-1', inv, 'stone-1', 'host-1', ITEM_TYPES);
  assert.equal(r.ok, false);
  assert.match(r.reason, /already socketed/i);
});

test('socketStone succeeds: writes stone_instances.socketed_into_id and updates inv in place', async () => {
  const pool = scriptedRoutePool([
    [STONE_SELECT, { rows: [{ item_type_id: 10, socketed_into_id: null }], rowCount: 1 }],
    [HOST_SELECT, { rows: [{ item_type_id: 20 }], rowCount: 1 }],
    [OCCUPANT_SELECT, { rows: [], rowCount: 0 }],
    [SOCKET_UPDATE, { rows: [], rowCount: 1 }],
  ]);
  const inv = { items: [{ id: 'stone-1', typeId: 10 }, { id: 'host-1', typeId: 20 }], equipment: {} };
  const r = await socketStone(pool, 'char-1', inv, 'stone-1', 'host-1', ITEM_TYPES);
  assert.equal(r.ok, true);
  const update = pool.calls.find((c) => SOCKET_UPDATE.test(c.sql));
  assert.ok(update, 'the socketing UPDATE must run');
  assert.deepEqual(update.params, ['host-1', 'stone-1']);
  const hostItem = inv.items.find((it) => it.id === 'host-1');
  assert.equal(hostItem.socketedStoneTypeId, 10, 'the host\'s in-memory record must reflect the socketed stone type');
  assert.ok(pool.calls.some((c) => c.sql === 'COMMIT'));
});

test('unsocketStone without confirm=true is rejected before any roll or DB write', async () => {
  const calls = [];
  const pool = { connect: async () => ({ query: async (sql) => { calls.push(sql); return { rows: [], rowCount: 0 }; }, release: () => {} }) };
  const result = await unsocketStone(pool, 1, { items: [] }, 'stone-1', { confirm: false });
  assert.equal(result.ok, false);
  assert.equal(calls.length, 0, 'no DB call before the confirm gate');
});

test('unsocketStone rejects a stone that is not owned or not currently socketed', async () => {
  const pool = scriptedRoutePool([
    [UNSOCKET_STONE_SELECT, { rows: [], rowCount: 0 }],
  ]);
  const inv = { items: [], equipment: {} };
  const r = await unsocketStone(pool, 'char-1', inv, 'stone-1', { confirm: true, rng: () => 0 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /not found|not socketed/i);
});

test('unsocketStone: destroy roll below threshold deletes the stone and its instance row', async () => {
  const pool = scriptedRoutePool([
    [UNSOCKET_STONE_SELECT, { rows: [{ socketed_into_id: 'host-1' }], rowCount: 1 }],
    [STONE_DELETE, { rows: [], rowCount: 1 }],
  ]);
  const inv = {
    items: [{ id: 'stone-1', typeId: 10 }, { id: 'host-1', typeId: 20, socketedStoneTypeId: 10 }],
    equipment: {},
  };
  const r = await unsocketStone(pool, 'char-1', inv, 'stone-1', { confirm: true, rng: () => 0 });
  assert.equal(r.ok, true);
  assert.equal(r.destroyed, true);
  const del = pool.calls.find((c) => STONE_DELETE.test(c.sql));
  assert.ok(del);
  assert.deepEqual(del.params, ['stone-1']);
  assert.ok(!inv.items.some((it) => it.id === 'stone-1'), 'destroyed stone must be removed from the in-memory inventory');
  const hostItem = inv.items.find((it) => it.id === 'host-1');
  assert.equal(hostItem.socketedStoneTypeId, undefined, 'the host\'s cache entry must be cleared too');
});

test('unsocketStone: destroy roll at/above threshold clears socketed_into_id and preserves xp/level', async () => {
  const pool = scriptedRoutePool([
    [UNSOCKET_STONE_SELECT, { rows: [{ socketed_into_id: 'host-1' }], rowCount: 1 }],
    [UNSOCKET_CLEAR_UPDATE, { rows: [], rowCount: 1 }],
  ]);
  const inv = {
    items: [{ id: 'stone-1', typeId: 10 }, { id: 'host-1', typeId: 20, socketedStoneTypeId: 10 }],
    equipment: {},
  };
  const r = await unsocketStone(pool, 'char-1', inv, 'stone-1', { confirm: true, rng: () => 0.99 });
  assert.equal(r.ok, true);
  assert.equal(r.destroyed, false);
  const upd = pool.calls.find((c) => UNSOCKET_CLEAR_UPDATE.test(c.sql));
  assert.ok(upd, 'must clear socketed_into_id, not delete the stone');
  assert.deepEqual(upd.params, ['stone-1']);
  assert.ok(!pool.calls.some((c) => STONE_DELETE.test(c.sql)), 'a surviving stone must not be deleted');
  assert.ok(inv.items.some((it) => it.id === 'stone-1'), 'a surviving stone stays in the in-memory inventory (xp/level untouched)');
  const hostItem = inv.items.find((it) => it.id === 'host-1');
  assert.equal(hostItem.socketedStoneTypeId, undefined, 'the host\'s cache entry must be cleared even when the stone survives');
});
