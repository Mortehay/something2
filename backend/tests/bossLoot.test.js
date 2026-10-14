// backend/tests/bossLoot.test.js
// SOMET-611 (S10, spec §3.7/§7). Pure rules: tier-default resolution, the
// biased-and-floored rarity roll, and the properties the spec's own testing
// section names explicitly -- monotonic in rng, never below the floor, an
// End boss never worse than an Elite at equal rng/level, a higher-level
// boss never worse than a lower-level one of the same tier. Expected values
// are hand-computed from the spec's own table (design doc §3.7), never read
// back from TIER_LOOT_DEFAULTS -- a typo in that constant must fail here.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TIER_LOOT_DEFAULTS, resolveLootProfile, biasedRng, floorRarity, rollBossRarity,
  MAX_LOOT_ROLLS, bossGoldRange, DEFAULT_BOSS_GOLD_RANGE, spawnBossLootItems,
  awardDungeonBossLoot, shortenBossChestExpiry,
} = require('../src/authority/bossLoot.js');
const { RARITIES } = require('../src/authority/rarity.js');

// Same anchor table rarity.test.js pins against the spec's own §6.3 table --
// reused here rather than invented, so a boss-loot test and the ordinary
// kill-loot test agree on what "level 150" even means.
const ANCHORS = [
  { item_level: 1, white: 90, blue: 9, yellow: 1, foxy: 0 },
  { item_level: 50, white: 70, blue: 21, yellow: 8, foxy: 1 },
  { item_level: 150, white: 45, blue: 30, yellow: 20, foxy: 5 },
];

test('TIER_LOOT_DEFAULTS matches the spec table (design doc §3.7) exactly', () => {
  assert.deepEqual(TIER_LOOT_DEFAULTS.dungeon_elite, {
    rolls: 2, minRarity: 'blue', bias: 0.2, chest: false,
  });
  assert.deepEqual(TIER_LOOT_DEFAULTS.dungeon_end, {
    rolls: 4, minRarity: 'yellow', bias: 0.4, chest: true,
  });
  assert.deepEqual(TIER_LOOT_DEFAULTS.world, {
    rolls: 3, minRarity: 'yellow', bias: 0.5, chest: true,
  });
});

test('resolveLootProfile falls back to the tier default when every override column is null', () => {
  assert.deepEqual(
    resolveLootProfile({ boss_tier: 'dungeon_elite', loot_rolls: null, loot_min_rarity: null, loot_rarity_bias: null, loot_chest: null }),
    { tier: 'dungeon_elite', rolls: 2, minRarity: 'blue', bias: 0.2, chest: false },
  );
  assert.deepEqual(
    resolveLootProfile({ boss_tier: 'world' }), // columns absent entirely, same as null
    { tier: 'world', rolls: 3, minRarity: 'yellow', bias: 0.5, chest: true },
  );
});

test('resolveLootProfile honors an explicit override, including a falsy one (0 rolls, chest: false)', () => {
  const profile = resolveLootProfile({
    boss_tier: 'dungeon_end', loot_rolls: 0, loot_min_rarity: 'foxy', loot_rarity_bias: 0.1, loot_chest: false,
  });
  // An explicit 0/false must NOT be mistaken for "unset" and fall through to
  // the dungeon_end default (4 rolls, chest: true) -- the whole point of `??`
  // over `||` in resolveLootProfile.
  assert.deepEqual(profile, { tier: 'dungeon_end', rolls: 0, minRarity: 'foxy', bias: 0.1, chest: false });
});

test('resolveLootProfile clamps a bias column to [0, 0.9] even if a bad value reached the DB', () => {
  assert.equal(resolveLootProfile({ boss_tier: 'world', loot_rarity_bias: 5 }).bias, 0.9);
  assert.equal(resolveLootProfile({ boss_tier: 'world', loot_rarity_bias: -3 }).bias, 0);
});

test('resolveLootProfile returns null for a non-boss row or an unknown tier', () => {
  assert.equal(resolveLootProfile({ boss_tier: null }), null);
  assert.equal(resolveLootProfile({ boss_tier: 'miniboss' }), null); // a real tier, but not one this table covers
  assert.equal(resolveLootProfile({}), null);
});

test('biasedRng maps [0,1) into [bias,1) and is strictly increasing', () => {
  const rng = biasedRng(() => 0, 0.3);
  assert.equal(rng(), 0.3);
  const rngTop = biasedRng(() => 0.999999, 0.3);
  assert.ok(rngTop() < 1 && rngTop() > 0.99);
  // Strictly increasing in the underlying raw roll.
  const raws = [0, 0.1, 0.25, 0.5, 0.75, 0.999];
  const biased = raws.map((r) => biasedRng(() => r, 0.4)());
  for (let i = 1; i < biased.length; i += 1) assert.ok(biased[i] > biased[i - 1]);
});

test('floorRarity raises a roll below the floor and leaves one at or above it alone', () => {
  assert.equal(floorRarity('white', 'blue'), 'blue');
  assert.equal(floorRarity('white', 'foxy'), 'foxy');
  assert.equal(floorRarity('yellow', 'blue'), 'yellow');
  assert.equal(floorRarity('foxy', 'blue'), 'foxy');
  assert.equal(floorRarity('white', null), 'white'); // no floor configured
  assert.equal(floorRarity('white', 'not-a-real-grade'), 'white'); // unknown floor ignored, not thrown
});

// SOMET-611 rework: no anchors (no weight table, or a failed tuning refresh)
// still rolls nothing -- but the floor is the boss profile's promise and
// must hold regardless. It used to return a bare 'white' BEFORE flooring.
test('rollBossRarity with no anchors consumes no rng but still honours the floor', () => {
  let called = false;
  const rng = () => { called = true; return 0.9; };
  assert.equal(rollBossRarity(150, null, { bias: 0.5, minRarity: 'foxy' }, rng), 'foxy');
  assert.equal(rollBossRarity(150, null, { bias: 0.5, minRarity: 'blue' }, rng), 'blue');
  assert.equal(rollBossRarity(150, null, { bias: 0.5, minRarity: null }, rng), 'white');
  assert.equal(called, false, 'no anchors must roll NOTHING, mirroring spawnDrops/openChest');
});

test('rollBossRarity is monotonic in raw rng for a fixed profile', () => {
  const profile = { bias: 0.3, minRarity: null };
  const seen = [];
  for (let i = 0; i <= 100; i += 1) seen.push(rollBossRarity(150, ANCHORS, profile, () => i / 100));
  for (let i = 1; i < seen.length; i += 1) {
    assert.ok(
      RARITIES.indexOf(seen[i]) >= RARITIES.indexOf(seen[i - 1]),
      `raw rng ${i / 100} gave ${seen[i]} after ${seen[i - 1]}`,
    );
  }
});

test('rollBossRarity never rolls below loot_min_rarity, across the whole rng range', () => {
  const profile = { bias: 0.1, minRarity: 'yellow' }; // dungeon_end's own default
  const floorIdx = RARITIES.indexOf('yellow');
  for (let i = 0; i <= 1000; i += 1) {
    const r = rollBossRarity(1, ANCHORS, profile, () => i / 1000); // level 1: worst possible anchor
    assert.ok(RARITIES.indexOf(r) >= floorIdx, `rng ${i / 1000} at item level 1 gave ${r}, below the yellow floor`);
  }
});

test('a higher bias never produces a worse rarity than a lower bias, same raw rng and level', () => {
  // dungeon_end (bias 0.4) vs dungeon_elite (bias 0.2), spec's own two tiers,
  // at the SAME raw rng and the SAME item level -- "End >= Elite at equal
  // rng/level" (spec §7), proven here as the general "higher bias never
  // worse" property rather than pinned to one lucky sample.
  const elite = { bias: TIER_LOOT_DEFAULTS.dungeon_elite.bias, minRarity: null };
  const end = { bias: TIER_LOOT_DEFAULTS.dungeon_end.bias, minRarity: null };
  for (let i = 0; i <= 100; i += 1) {
    const raw = () => i / 100;
    const eliteRarity = rollBossRarity(75, ANCHORS, elite, raw);
    const endRarity = rollBossRarity(75, ANCHORS, end, raw);
    assert.ok(
      RARITIES.indexOf(endRarity) >= RARITIES.indexOf(eliteRarity),
      `rng ${i / 100}: dungeon_end gave ${endRarity}, worse than dungeon_elite's ${eliteRarity}`,
    );
  }
});

test('a higher item level never produces a worse rarity than a lower one, same profile and raw rng', () => {
  // Inherits interpolateWeights' own monotonic-in-level guarantee (pinned
  // directly in rarity.test.js); this test pins it through BOSS LOOT's own
  // call path (the biased wrapper), not just the underlying primitive, since
  // the spec's own testing section (§7, S10) names this as an S10 property.
  const profile = { bias: 0.5, minRarity: null };
  for (let i = 0; i <= 20; i += 1) {
    const raw = () => i / 20;
    let prev = rollBossRarity(1, ANCHORS, profile, raw);
    for (let lvl = 2; lvl <= 150; lvl += 1) {
      const cur = rollBossRarity(lvl, ANCHORS, profile, raw);
      assert.ok(
        RARITIES.indexOf(cur) >= RARITIES.indexOf(prev),
        `raw ${i / 20}, level ${lvl}: ${cur} is worse than level ${lvl - 1}'s ${prev}`,
      );
      prev = cur;
    }
  }
});

// ---- SOMET-611 rework -------------------------------------------------------

test('resolveLootProfile caps an over-large loot_rolls at MAX_LOOT_ROLLS (20)', () => {
  assert.equal(MAX_LOOT_ROLLS, 20);
  assert.equal(resolveLootProfile({ boss_tier: 'world', loot_rolls: 1e6 }).rolls, 20);
  assert.equal(resolveLootProfile({ boss_tier: 'world', loot_rolls: 20 }).rolls, 20);
});

// The spec's "End >= Elite at equal rng/level", with the REAL tier profiles
// (floors included) rather than floor-stripped ones: dungeon_end's floor
// (yellow) and bias (0.4) both dominate dungeon_elite's (blue, 0.2).
test('the real dungeon_end profile never rolls worse than the real dungeon_elite profile', () => {
  const end = resolveLootProfile({ boss_tier: 'dungeon_end' });
  const elite = resolveLootProfile({ boss_tier: 'dungeon_elite' });
  for (const level of [1, 25, 50, 100, 150]) {
    for (let i = 0; i < 1000; i += 1) {
      const r = i / 1000;
      const e = RARITIES.indexOf(rollBossRarity(level, ANCHORS, end, () => r));
      const l = RARITIES.indexOf(rollBossRarity(level, ANCHORS, elite, () => r));
      assert.ok(e >= l, `level ${level}, rng ${r}: end ${RARITIES[e]} < elite ${RARITIES[l]}`);
    }
  }
});

test('bossGoldRange reads the row\'s own gold_min/gold_max (spec §3.1), defaulting only when none is authored', () => {
  assert.deepEqual(bossGoldRange({ gold_min: 20, gold_max: 40 }), { min: 20, max: 40 });
  assert.deepEqual(bossGoldRange({ gold_min: '8', gold_max: '15' }), { min: 8, max: 15 });
  assert.deepEqual(bossGoldRange({ gold_min: 50, gold_max: 10 }), { min: 10, max: 10 }, 'min clamped to max');
  assert.equal(bossGoldRange({ gold_min: null, gold_max: null }), DEFAULT_BOSS_GOLD_RANGE);
  assert.equal(bossGoldRange({ gold_min: 0, gold_max: 0 }), DEFAULT_BOSS_GOLD_RANGE);
  assert.equal(bossGoldRange(null), DEFAULT_BOSS_GOLD_RANGE);
});

function recordingPool(handlers = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      for (const [re, fn] of Object.entries(handlers)) {
        if (new RegExp(re).test(sql)) return fn(sql, params);
      }
      return { rows: [] };
    },
  };
}

test('spawnBossLootItems with includeOwnDrops:false never reads the entity\'s own drop rows', async () => {
  const pool = recordingPool();
  const entry = { worldId: 'w', world: { groundItems: { add() {} } } };
  await spawnBossLootItems(pool, entry, {
    entityTypeId: 7, behaviorId: 3, profile: { rolls: 0, minRarity: null, bias: 0 },
    itemLevel: 10, x: 0, y: 0, includeOwnDrops: false,
  });
  assert.equal(pool.calls.filter((c) => /creature_drops|behavior_drops/.test(c.sql)).length, 0);

  const pool2 = recordingPool();
  await spawnBossLootItems(pool2, entry, {
    entityTypeId: 7, behaviorId: 3, profile: { rolls: 0, minRarity: null, bias: 0 },
    itemLevel: 10, x: 0, y: 0,
  });
  assert.equal(pool2.calls.filter((c) => /creature_drops|behavior_drops/.test(c.sql)).length, 2,
    'the default still reads both (the kill\'s own drops)');
});

// A failed gold insert used to abort the award before the chest was spawned
// and before anything was broadcast.
test('awardDungeonBossLoot still spawns the chest and broadcasts when the gold insert fails', async () => {
  const pool = recordingPool({
    'INSERT INTO world_items \\(world_id, item_type_id, x, y, expires_at, quantity\\)': () => { throw new Error('gold boom'); },
    'INSERT INTO world_chests': () => ({
      rows: [{ id: 'ch1', x: 5, y: 6, kind: 'vault', guard_entity_type_id: 21, guard_level: 50,
        guard_creature_ids: [], state: 'unlocked', expires_at: new Date() }],
    }),
  });
  const entry = { worldId: 'w', goldItemTypeId: 99, chests: [], world: { groundItems: { add() {} } } };
  const broadcasts = [];
  await assert.rejects(awardDungeonBossLoot({
    entry, entityTypeId: 21, level: 50, x: 5, y: 6,
    row: { boss_tier: 'dungeon_end', gold_min: 20, gold_max: 40 },
  }, {
    pool, rng: () => 0.5,
    broadcastItemsFn: () => broadcasts.push('items'),
    broadcastChestsFn: () => broadcasts.push('chests'),
  }), /gold boom/);
  assert.equal(entry.chests.length, 1, 'the chest still spawned');
  assert.deepEqual(broadcasts, ['items', 'chests']);
  const goldCall = pool.calls.find((c) => /quantity\)\s*VALUES/.test(c.sql));
  assert.ok(goldCall, 'gold insert attempted');
  assert.ok(goldCall.params[5] >= 20 && goldCall.params[5] <= 40, `gold uses the row's own range, got ${goldCall.params[5]}`);
});

test('shortenBossChestExpiry leaves a permanent (no-deadline) chest alone without a query', async () => {
  const pool = recordingPool();
  const chest = { id: 'c', expiresAt: null };
  await shortenBossChestExpiry(pool, chest);
  assert.equal(pool.calls.length, 0);
});

// Review gap: the world-boss loop's "own drops once per kill" was only
// guarded by a DB-gated test (skipped without TEST_DATABASE_URL). This runs
// the REAL WorldBossManager.onCreatureDeath against a recording pool: four
// participants must produce exactly ONE creature_drops read, and the extra
// gear pool must be drawn once per participant.
test('world boss kill: own drop rows read once per kill, extra rolls once per participant', async () => {
  const { WorldBossManager } = require('../src/authority/worldBoss.js');
  const pool = recordingPool({
    'FROM item_types': () => ({ rows: [{ id: 1 }, { id: 2 }] }),
    'INSERT INTO world_items': () => ({ rows: [] }),
    'INSERT INTO world_chests': () => ({
      rows: [{ id: 'ch', x: 1, y: 1, kind: 'vault', guard_entity_type_id: 7, guard_level: 100,
        guard_creature_ids: [], state: 'unlocked', expires_at: new Date() }],
    }),
  });
  const wbm = new WorldBossManager({ pool, rng: () => 0.1 });
  const dmg = new Map([['u1', 400], ['u2', 300], ['u3', 200], ['u4', 100]]);
  wbm.state = 'active';
  wbm.bossCreatureId = 'wb_1';
  wbm.currentBoss = {
    row: { id: 7, behavior_id: 3, boss_tier: 'world' }, name: 'Testboss', maxHp: 1000, _playerDamage: dmg,
  };
  const entry = { worldId: 'w', chests: [], world: { groundItems: { add() {} } } };
  const legendaries = [];
  await wbm.onCreatureDeath(entry, { id: 'wb_1', bossTier: 'world', x: 10, y: 10, _playerDamage: dmg }, 'u1', {
    pool, dropLegendaryFn: async (e, uId) => { legendaries.push(uId); },
  });
  assert.equal(pool.calls.filter((c) => /FROM creature_drops/.test(c.sql)).length, 1, 'own creature_drops once per kill');
  assert.equal(pool.calls.filter((c) => /FROM behavior_drops/.test(c.sql)).length, 1, 'own behavior_drops once per kill');
  assert.equal(pool.calls.filter((c) => /FROM item_types/.test(c.sql)).length, 4, 'extra gear rolled for every participant');
  assert.equal(legendaries.length, 3, 'top-3 legendaries unchanged');
  assert.equal(entry.chests.length, 1, 'victory chest spawned');
});

// Review gap: the openchest handler is the only caller that shortens an
// opened boss chest's deadline. A source gate proves the call is WRITTEN in
// the handler, guarded on expiresAt; boss_loot_award_db.test.js proves the
// function's SQL, and the browser pass proved the wired path end to end.
test('the openchest handler shortens a transient chest\'s deadline once opened', () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/authority/server.js'), 'utf8');
  const handler = src.slice(src.indexOf("chainOp(ws, 'openchest'"));
  const body = handler.slice(0, handler.indexOf('chainOp(ws, ', 10));
  assert.match(body, /if \(chest\.expiresAt != null\) \{\s*await shortenBossChestExpiry\(pool, chest\)/);
});
