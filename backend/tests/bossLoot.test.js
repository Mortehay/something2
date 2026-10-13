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

test('rollBossRarity with no anchors is always white and consumes no rng', () => {
  let called = false;
  const rng = () => { called = true; return 0.9; };
  assert.equal(rollBossRarity(150, null, { bias: 0.5, minRarity: 'foxy' }, rng), 'white');
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
