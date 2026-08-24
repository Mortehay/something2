const test = require('node:test');
const assert = require('node:assert');
const { World } = require('../src/authority/world.js');
const { spawnDrops, commitCreatureDeath } = require('../src/authority/loot.js');

// Same scripted-pool shape authorityLoot.test.js uses, trimmed to what this
// file needs. `.connect()` hands back a DISTINCT client so a statement issued
// on the checked-out connection can be told apart from one on the bare pool.
function scriptedPool(routes = []) {
  const poolCalls = [];
  const clients = [];
  function route(sql, params) {
    for (const [re, result] of routes) {
      if (re.test(sql)) return typeof result === 'function' ? result(params) : result;
    }
    return { rows: [], rowCount: 0 };
  }
  return {
    calls: poolCalls,
    clients,
    matching(re) {
      return [...poolCalls, ...clients.flatMap((c) => c.calls)].filter((c) => re.test(c.sql));
    },
    query: async (sql, params) => { poolCalls.push({ sql, params }); return route(sql, params); },
    connect: async () => {
      const calls = [];
      const client = {
        calls,
        query: async (sql, params) => { calls.push({ sql, params }); return route(sql, params); },
        release: () => {},
      };
      clients.push(client);
      return client;
    },
  };
}

function armEntry(extra = {}) {
  const map = { chunkSize: 8, isWalkable: () => true, speedAt: () => 1, getChunk: () => [] };
  // A one-entry catalog so the slot filter has something real to read: item
  // type 7 is a main_hand.
  const itemTypes = new Map([[7, { id: 7, name: 'crude-blade', slot: 'main_hand' }]]);
  return {
    worldId: 'w1',
    world: new World(map, itemTypes, null, 8),
    creatureTypeIds: new Map([['Wolf', 42]]),
    claiming: new Set(),
    ...extra,
  };
}

const DROP_ROW = { item_type_id: 7, chance: '1', min_qty: 1, max_qty: 1 };
const DEAD = { type: 'Wolf', x: 100, y: 100, level: 150 };

const MIGHT = {
  id: 1,
  key: 'of_might',
  kind: 'buff',
  effect: { type: 'stat', stat: 'strength' },
  min_value: 4,
  max_value: 4,
  min_item_level: 1,
  max_item_level: null,
  allowed_slots: [],
  min_rarity: 'blue',
  weight: 100,
};

function dropRoutes(extraRows = {}) {
  return [
    [/FROM creature_drops/i, { rows: [DROP_ROW], rowCount: 1 }],
    [/INSERT INTO world_items/i, {
      rows: [{
        id: 'g1', item_type_id: 7, x: 100, y: 100, quantity: 1, ...extraRows,
      }],
      rowCount: 1,
    }],
  ];
}

test('with no rarity anchors on the entry, every drop is a plain white item', async () => {
  const entry = armEntry();
  const pool = scriptedPool(dropRoutes());
  await spawnDrops(pool, entry, DEAD, { rng: () => 0, ttlMs: 1000 });

  const ins = pool.matching(/INSERT INTO world_items/i);
  assert.strictEqual(ins.length, 1);
  // $6 rarity, $7 item level, $8 affixes -- array index 5/6/7.
  assert.deepStrictEqual(ins[0].params[5], ['white']);
  assert.deepStrictEqual(ins[0].params[6], [150]);
  assert.deepStrictEqual(ins[0].params[7], ['[]']);
});

test('a foxy-only weight table makes every drop foxy at the creature level', async () => {
  const entry = armEntry({
    rarityAnchors: [{ item_level: 1, white: 0, blue: 0, yellow: 0, foxy: 1 }],
    affixPool: [MIGHT],
  });
  const pool = scriptedPool(dropRoutes());
  await spawnDrops(pool, entry, DEAD, { rng: () => 0, ttlMs: 1000 });

  const ins = pool.matching(/INSERT INTO world_items/i);
  assert.deepStrictEqual(ins[0].params[5], ['foxy']);
  assert.deepStrictEqual(ins[0].params[6], [150], 'item level is the dead creature level');

  // Hand-computed, NOT read back from the roller. rng is constant 0, so:
  //   rollRarity      -> foxy (the only grade with weight)
  //   rarityAffixCount('foxy') -> 3 + floor(0 * 7) = 3 wanted
  //   sampleAffixes    -> only one eligible entry, so one affix comes back
  //   affixValue       -> min 4 + 0 * (4 - 4) = 4
  //                       scale = 1 + (150 - 1)/100 = 2.49
  //                       foxy multiplier 1.25
  //                       4 * 2.49 * 1.25 = 12.45
  const affixes = JSON.parse(ins[0].params[7][0]);
  assert.deepStrictEqual(affixes, [{ affixTypeId: 1, value: 12.45 }]);
});

test('a level-1 kill can never roll foxy, even with an rng pinned at the top', async () => {
  // Criterion 4, through the real drop path rather than through rollRarity.
  const entry = armEntry({
    rarityAnchors: [
      { item_level: 1, white: 90, blue: 9, yellow: 1, foxy: 0 },
      { item_level: 50, white: 70, blue: 21, yellow: 8, foxy: 1 },
      { item_level: 150, white: 45, blue: 30, yellow: 20, foxy: 5 },
    ],
    affixPool: [MIGHT],
  });
  const pool = scriptedPool(dropRoutes());
  // rng 0.9999... clears every chance gate AND lands at the very top of the
  // cumulative distribution -- the only place a zero-weight foxy could leak in.
  await spawnDrops(pool, entry, { ...DEAD, level: 1 }, { rng: () => 0.999999, ttlMs: 1000 });

  const ins = pool.matching(/INSERT INTO world_items/i);
  // chance is 1 and rollDrops uses `rng() >= chance` to REFUSE, so 0.999999 < 1
  // still drops. The grade must be yellow, the best grade with weight at ilvl 1.
  assert.deepStrictEqual(ins[0].params[5], ['yellow']);
  assert.deepStrictEqual(ins[0].params[6], [1]);
});

test('the item level clamps into the 1..150 window the CHECK constraint allows', async () => {
  const entry = armEntry({
    rarityAnchors: [{ item_level: 1, white: 1, blue: 0, yellow: 0, foxy: 0 }],
  });
  const pool = scriptedPool(dropRoutes());
  // A creature whose level is out of band (a bad catalog row, or a null) must
  // not make the whole INSERT throw and cost the player their drops.
  await spawnDrops(pool, entry, { ...DEAD, level: 9000 }, { rng: () => 0, ttlMs: 1000 });
  await spawnDrops(pool, entry, { ...DEAD, level: null }, { rng: () => 0, ttlMs: 1000 });

  const ins = pool.matching(/INSERT INTO world_items/i);
  assert.deepStrictEqual(ins[0].params[6], [150]);
  assert.deepStrictEqual(ins[1].params[6], [1]);
});

test('the gold pile is never rolled -- currency has no rarity', async () => {
  const entry = armEntry({
    goldItemTypeId: 99,
    creatureGold: new Map([['Wolf', { min: 5, max: 5 }]]),
    rarityAnchors: [{ item_level: 1, white: 0, blue: 0, yellow: 0, foxy: 1 }],
  });
  const pool = scriptedPool([
    [/FROM creature_drops/i, { rows: [], rowCount: 0 }],
    [/INSERT INTO world_items/i, {
      rows: [{ id: 'g2', item_type_id: 99, x: 100, y: 100, quantity: 5 }],
      rowCount: 1,
    }],
  ]);
  await spawnDrops(pool, entry, DEAD, { rng: () => 0, ttlMs: 1000 });

  const ins = pool.matching(/INSERT INTO world_items/i);
  assert.strictEqual(ins.length, 1);
  assert.ok(!/rarity/i.test(ins[0].sql),
    'the coin-pile insert must not carry a rolled rarity column at all');
});

test('the drop table still decides WHICH item drops -- rarity only layers on top', async () => {
  // Criterion 5. A creature_drops row whose chance the rng fails must produce
  // no ground item at all, however generous the weight table is.
  const entry = armEntry({
    rarityAnchors: [{ item_level: 1, white: 0, blue: 0, yellow: 0, foxy: 1 }],
    affixPool: [MIGHT],
  });
  const pool = scriptedPool([
    [/FROM creature_drops/i, {
      rows: [{ item_type_id: 7, chance: '0.5', min_qty: 1, max_qty: 1 }],
      rowCount: 1,
    }],
    [/INSERT INTO world_items/i, { rows: [], rowCount: 0 }],
  ]);
  await spawnDrops(pool, entry, DEAD, { rng: () => 0.9, ttlMs: 1000 });
  assert.strictEqual(pool.matching(/INSERT INTO world_items/i).length, 0);

  // And the same row DOES drop, carrying its rolled grade, when the chance
  // gate passes -- so the refusal above is the drop table's doing, not a
  // rarity-path failure that would look identical.
  const pool2 = scriptedPool(dropRoutes());
  await spawnDrops(pool2, entry, DEAD, { rng: () => 0.1, ttlMs: 1000 });
  const ins = pool2.matching(/INSERT INTO world_items/i);
  assert.strictEqual(ins.length, 1);
  assert.deepStrictEqual(ins[0].params[4], [7], 'the item type came from creature_drops');
  assert.deepStrictEqual(ins[0].params[5], ['foxy']);
});

test('commitCreatureDeath forwards the entry rarity table into the drop it commits', async () => {
  // The wiring the acceptance criteria care about: a KILL, not a bare
  // spawnDrops call, has to reach the INSERT with a rolled grade on it.
  const entry = armEntry({
    rarityAnchors: [{ item_level: 1, white: 0, blue: 0, yellow: 0, foxy: 1 }],
    affixPool: [MIGHT],
  });
  const pool = scriptedPool([
    [/DELETE FROM world_creatures/i, {
      rows: [{
        type: 'Wolf', x: 100, y: 100, level: 60, home_x: 5, blocks_portal_id: null,
      }],
      rowCount: 1,
    }],
    ...dropRoutes(),
  ]);
  const res = await commitCreatureDeath(pool, entry, 'c1', { rng: () => 0, ttlMs: 1000 });
  assert.ok(res, 'the death must commit');

  const ins = pool.matching(/INSERT INTO world_items/i);
  assert.strictEqual(ins.length, 1);
  assert.deepStrictEqual(ins[0].params[5], ['foxy']);
  assert.deepStrictEqual(ins[0].params[6], [60], 'the killed creature level is the item level');
  // 4 * (1 + 59/100) * 1.25 = 4 * 1.59 * 1.25 = 7.95
  assert.deepStrictEqual(JSON.parse(ins[0].params[7][0]), [{ affixTypeId: 1, value: 7.95 }]);
});

test('an explicit rarityAnchors option overrides the entry cache', async () => {
  const entry = armEntry({
    rarityAnchors: [{ item_level: 1, white: 1, blue: 0, yellow: 0, foxy: 0 }],
  });
  const pool = scriptedPool([
    [/DELETE FROM world_creatures/i, {
      rows: [{
        type: 'Wolf', x: 100, y: 100, level: 10, home_x: 5, blocks_portal_id: null,
      }],
      rowCount: 1,
    }],
    ...dropRoutes(),
  ]);
  await commitCreatureDeath(pool, entry, 'c1', {
    rng: () => 0,
    ttlMs: 1000,
    rarityAnchors: [{ item_level: 1, white: 0, blue: 1, yellow: 0, foxy: 0 }],
  });
  const ins = pool.matching(/INSERT INTO world_items/i);
  assert.deepStrictEqual(ins[0].params[5], ['blue']);
});
