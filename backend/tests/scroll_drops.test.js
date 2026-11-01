// Enchant scrolls that drop: from creatures (rarely), chests (sometimes) and bosses (often),
// and the guarantee that none of it can leak into a test that pins an exact drop table.
const test = require('node:test');
const assert = require('node:assert/strict');
const enchant = require('../src/services/enchant.js');
const {
  scrollTypeId, scrollRollCount, appendChestScrolls, spawnScrollsOnGround,
} = require('../src/authority/scrollDrops.js');
const { commitCreatureDeath } = require('../src/authority/loot.js');
const { spawnBossLootItems } = require('../src/authority/bossLoot.js');
const { CREATURE_SIZE } = require('../src/authority/creatures.js');

const SCROLL_ID = 77;
const catalog = () => new Map([
  [1, { id: 1, name: 'sword', category: 'weapon' }],
  [SCROLL_ID, { id: SCROLL_ID, name: 'enchant_scroll', category: 'consumable' }],
]);

// A tiny seeded generator so the distribution tests are deterministic.
function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

// ----------------------------------------------------------- the odds

test('mobs drop a scroll rarely, chests more often, bosses most often', () => {
  const d = enchant.ENCHANT_CONFIG.scrollDrops;
  assert.ok(d.creature.chance < d.chest.chance, 'a chest beats a mob');
  assert.ok(d.chest.chance < d.boss.chance, 'a boss beats a chest');

  const mean = (kind) => {
    const rng = lcg(1234);
    let total = 0;
    const n = 40000;
    for (let i = 0; i < n; i += 1) total += scrollRollCount(kind, rng);
    return total / n;
  };
  const creature = mean('creature');
  const chest = mean('chest');
  const boss = mean('boss');
  assert.ok(Math.abs(creature - d.creature.chance * d.creature.max) < 0.004, `creature ${creature}`);
  assert.ok(Math.abs(chest - d.chest.chance * d.chest.max) < 0.01, `chest ${chest}`);
  assert.ok(Math.abs(boss - d.boss.chance * d.boss.max) < 0.02, `boss ${boss}`);
  assert.ok(creature < chest && chest < boss, 'the observed rates keep that order too');
});

test('a source rolls up to its max, each time independently', () => {
  const seq = (...v) => { let i = 0; return () => v[i++]; };
  assert.equal(scrollRollCount('boss', seq(0.1, 0.1)), 2);
  assert.equal(scrollRollCount('boss', seq(0.9, 0.1)), 1);
  assert.equal(scrollRollCount('boss', seq(0.9, 0.9)), 0);
  assert.equal(scrollRollCount('creature', seq(0.004)), 1);
  assert.equal(scrollRollCount('creature', seq(0.5)), 0);
  assert.equal(scrollRollCount('creature', () => 0.0049), 1);
  const edge = enchant.ENCHANT_CONFIG.scrollDrops.creature.chance;
  assert.equal(scrollRollCount('creature', () => edge), 0, 'the boundary is exclusive');
});

test('nothing drops without an rng, or from an unknown source', () => {
  assert.equal(scrollRollCount('creature', null), 0);
  assert.equal(scrollRollCount('creature', undefined), 0);
  assert.equal(scrollRollCount('dragon', () => 0), 0);
});

test('the drop settings are configurable, merge per source, and are validated', () => {
  const lucky = enchant.buildEnchantConfig({ scrollDrops: { creature: { chance: 0.5 } } });
  assert.equal(lucky.scrollDrops.creature.chance, 0.5);
  assert.equal(lucky.scrollDrops.creature.max, 1, 'max keeps its default');
  assert.equal(lucky.scrollDrops.boss.chance, enchant.buildEnchantConfig({}).scrollDrops.boss.chance, 'the other sources are untouched');
  assert.equal(scrollRollCount('creature', () => 0.4, lucky), 1);

  const none = enchant.buildEnchantConfig({ scrollDrops: { chest: { max: 0 } } });
  assert.equal(scrollRollCount('chest', () => 0, none), 0, 'max 0 turns a source off');

  assert.throws(() => enchant.buildEnchantConfig({ scrollDrops: { boss: { chance: 1.5 } } }), /scrollDrops\.boss\.chance/);
  assert.throws(() => enchant.buildEnchantConfig({ scrollDrops: { boss: { chance: -0.1 } } }), /scrollDrops\.boss\.chance/);
  assert.throws(() => enchant.buildEnchantConfig({ scrollDrops: { chest: { max: 99 } } }), /scrollDrops\.chest\.max/);
  assert.throws(() => enchant.buildEnchantConfig({ scrollDrops: { creature: { max: 1.5 } } }), /scrollDrops\.creature\.max/);
  assert.throws(() => enchant.buildEnchantConfig({ maxScrollPurchase: 0 }), /maxScrollPurchase/);
});

test('the scroll\'s type id is found by name, and a catalog without it yields null', () => {
  assert.equal(scrollTypeId(catalog()), SCROLL_ID);
  assert.equal(scrollTypeId(catalog()), SCROLL_ID, 'cached lookups agree');
  assert.equal(scrollTypeId(new Map([[1, { id: 1, name: 'sword' }]])), null);
  assert.equal(scrollTypeId(null), null);
  assert.equal(scrollTypeId({}), null);
  assert.equal(scrollTypeId(catalog(), enchant.buildEnchantConfig({ scrollItemName: 'sword' })), 1, 'the cache is per config name');
});

// ----------------------------------------------------------- chests

test('a chest appends scrolls after its gear, and tells the caller which id they are', () => {
  const ids = [1, 1];
  const scrollId = appendChestScrolls(ids, catalog(), () => 0);
  assert.equal(scrollId, SCROLL_ID);
  assert.deepEqual(ids, [1, 1, SCROLL_ID], 'gear first, untouched; one scroll after it');
});

test('a chest with no rng or no scroll in the catalog adds nothing and draws no random numbers', () => {
  const ids = [1];
  let draws = 0;
  assert.equal(appendChestScrolls(ids, catalog(), null), null);
  assert.equal(appendChestScrolls(ids, new Map([[1, { id: 1, name: 'sword' }]]), () => { draws += 1; return 0; }), null);
  assert.deepEqual(ids, [1]);
  assert.equal(draws, 0);
});

// ----------------------------------------------------------- the ground

function fakeDb() {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (/INSERT INTO world_items/.test(sql)) {
        return { rows: params[4].map((typeId, i) => ({ id: `g${i}`, item_type_id: typeId, x: params[1], y: params[2], quantity: 1 })), rowCount: params[4].length };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}
function liveEntry() {
  const added = [];
  return { worldId: 'w1', world: { weapons: catalog(), groundItems: { add: (rows) => added.push(...rows) } }, added };
}

test('scrolls land on the ground one row each and join the ground index', async () => {
  const db = fakeDb();
  const entry = liveEntry();
  const rows = await spawnScrollsOnGround(db, entry, 2, 100.4, 200.6);
  assert.equal(rows.length, 2);
  assert.deepEqual(db.calls[0].params, ['w1', 100, 201, 180000, [SCROLL_ID, SCROLL_ID]]);
  assert.equal(entry.added.length, 2);
});

test('zero scrolls, or a catalog with none, touches nothing', async () => {
  const db = fakeDb();
  assert.deepEqual(await spawnScrollsOnGround(db, liveEntry(), 0, 1, 1), []);
  const bare = { worldId: 'w', world: { weapons: new Map(), groundItems: { add() {} } } };
  assert.deepEqual(await spawnScrollsOnGround(db, bare, 3, 1, 1), []);
  assert.equal(db.calls.length, 0);
});

// ----------------------------------------------------------- a creature's death

function killPool(record) {
  const client = {
    async query(sql, params) {
      const q = sql.replace(/\s+/g, ' ').trim();
      record.push({ q, params });
      if (q.startsWith('DELETE FROM world_creatures')) {
        return { rowCount: 1, rows: [{ type: 'Wolf', x: 100, y: 200, level: 3, home_x: null, blocks_portal_id: null }] };
      }
      if (q.startsWith('INSERT INTO world_items')) {
        return { rowCount: 1, rows: params[4].map((t, i) => ({ id: `g${i}`, item_type_id: t, x: params[1], y: params[2], quantity: 1 })) };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  return { connect: async () => client };
}
function killEntry(extra = {}) {
  return {
    worldId: 'w1',
    creatureTypeIds: new Map([['Wolf', 5]]),
    gearRollChance: 0,
    world: { weapons: catalog(), groundItems: { add() {} }, getPlayer: () => null },
    ...extra,
  };
}

test('a live world rolls a scroll at the corpse; a fixture entry never does', async () => {
  const lucky = [];
  await commitCreatureDeath(killPool(lucky), killEntry({ scrollRng: () => 0 }), 'c1', { rng: () => 0.99 });
  const drop = lucky.find((c) => c.q.startsWith('INSERT INTO world_items'));
  assert.ok(drop, 'the scroll was inserted');
  assert.deepEqual(drop.params, ['w1', Math.round(100 + CREATURE_SIZE / 2), Math.round(200 + CREATURE_SIZE / 2), 180000, [SCROLL_ID]]);
  assert.ok(lucky.some((c) => c.q === 'COMMIT'), 'inside the death transaction');
  assert.ok(lucky.findIndex((c) => c === drop) < lucky.findIndex((c) => c.q === 'COMMIT'));

  const fixture = [];
  await commitCreatureDeath(killPool(fixture), killEntry(), 'c1', { rng: () => 0.99 });
  assert.equal(fixture.some((c) => c.q.startsWith('INSERT INTO world_items')), false, 'no scrollRng, no scroll');
});

test('a creature that misses its roll drops no scroll', async () => {
  const rec = [];
  await commitCreatureDeath(killPool(rec), killEntry({ scrollRng: () => 0.99 }), 'c1', { rng: () => 0.99 });
  assert.equal(rec.some((c) => c.q.startsWith('INSERT INTO world_items')), false);
});

test('a creature kill rolls scrolls with ITS OWN generator, so the loot rng is not disturbed', async () => {
  let lootDraws = 0;
  const lootRng = () => { lootDraws += 1; return 0.99; };
  const a = [];
  await commitCreatureDeath(killPool(a), killEntry(), 'c1', { rng: lootRng });
  const without = lootDraws;
  lootDraws = 0;
  await commitCreatureDeath(killPool([]), killEntry({ scrollRng: () => 0 }), 'c1', { rng: lootRng });
  assert.equal(lootDraws, without, 'adding scroll drops did not consume a loot random number');
});

// ----------------------------------------------------------- a boss's death

function bossPool(record) {
  return {
    async query(sql, params) {
      record.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (/INSERT INTO world_items/.test(sql)) {
        return { rows: params[4].map((t, i) => ({ id: `b${i}`, item_type_id: t, quantity: 1 })) };
      }
      return { rows: [] };
    },
  };
}
const BOSS_ARGS = {
  entityTypeId: 9, profile: { rolls: 0, bias: 0 }, itemLevel: 40, x: 500, y: 600, includeOwnDrops: false,
};

test('a boss drops scrolls as plain white items, with no rarity or affix rolled on them', async () => {
  const rec = [];
  const entry = { worldId: 'w1', scrollRng: () => 0, world: { weapons: catalog(), groundItems: { add() {} } } };
  const rows = await spawnBossLootItems(bossPool(rec), entry, { ...BOSS_ARGS, rng: () => 0.5 });
  assert.equal(rows.length, 2, 'both of the boss\'s rolls hit');
  const ins = rec.find((c) => /INSERT INTO world_items/.test(c.sql));
  const [, , , , typeIds, rarities, levels, affixes] = ins.params;
  assert.deepEqual(typeIds, [SCROLL_ID, SCROLL_ID]);
  assert.deepEqual(rarities, ['white', 'white']);
  assert.deepEqual(levels, [1, 1]);
  assert.deepEqual(affixes, ['[]', '[]']);
});

test('a boss with no scrollRng (a fixture) drops exactly what it always did', async () => {
  const rec = [];
  const entry = { worldId: 'w1', world: { weapons: catalog(), groundItems: { add() {} } } };
  const rows = await spawnBossLootItems(bossPool(rec), entry, { ...BOSS_ARGS, rng: () => 0.5 });
  assert.deepEqual(rows, []);
  assert.equal(rec.length, 0, 'not even a query');
});

test('a boss that misses its scroll rolls drops nothing from them', async () => {
  const entry = { worldId: 'w1', scrollRng: () => 0.99, world: { weapons: catalog(), groundItems: { add() {} } } };
  assert.deepEqual(await spawnBossLootItems(bossPool([]), entry, { ...BOSS_ARGS, rng: () => 0.5 }), []);
});

// ----------------------------------------------------------- wiring guards

test('only a live world carries scrollRng, and every loot path reads it from the entry', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const read = (rel) => fs.readFileSync(path.resolve(__dirname, '../src/authority', rel), 'utf8');
  assert.match(read('server.js'), /scrollRng: Math\.random,/, 'the live entry opts in');
  assert.match(read('server.js'), /scrollRng: entry\.scrollRng,/, 'the chest opener gets it from the entry');
  assert.match(read('loot.js'), /scrollRng = \(entry && entry\.scrollRng\) \|\| null/);
  assert.match(read('bossLoot.js'), /scrollRng = \(entry && entry\.scrollRng\) \|\| null/);
});
