const test = require('node:test');
const assert = require('node:assert');
const { resolveBehavior, DEFAULT_BEHAVIOR } = require('../src/services/creatureBehaviors.js');

// SOMET-253 Task 4: the aura/gold columns are the resolver's read side only --
// nothing in the tick consumes them yet (that's Task 5). This file proves
// resolveBehavior surfaces auraRadius/auraDamageMult/auraDefenseMult/
// auraSpeedMult/goldMin/goldMax correctly, including the NULL-fallback trap
// the ability cooldown hit in Task 2.

test('a behaviour with no aura resolves to radius 0 and neutral multipliers', () => {
  const b = resolveBehavior({
    behavior_name: 'Line', chase_style: 'charge',
    aggro_radius: 400, leash_radius: 800,
  });
  assert.equal(b.auraRadius, 0);
  assert.equal(b.auraDamageMult, 1);
  assert.equal(b.auraDefenseMult, 1);
  assert.equal(b.auraSpeedMult, 1);
  assert.equal(b.goldMin, 0);
  assert.equal(b.goldMax, 0);
});

test('a NULL aura multiplier falls back to 1, not 0', () => {
  // Number(null) === 0 -- and an auraDamageMult of 0 would make every buffed
  // creature deal NOTHING. Same trap as the cooldown in Task 2.
  const b = resolveBehavior({
    behavior_name: 'zzChampion', chase_style: 'charge',
    aggro_radius: 480, leash_radius: 900,
    aura_radius: 260, aura_damage_mult: null, aura_defense_mult: null, aura_speed_mult: null,
  });
  assert.equal(b.auraRadius, 260);
  assert.equal(b.auraDamageMult, 1);
  assert.equal(b.auraDefenseMult, 1);
  assert.equal(b.auraSpeedMult, 1);
});

test('a complete aura/gold row is carried through verbatim', () => {
  const b = resolveBehavior({
    behavior_name: 'Champion', chase_style: 'charge',
    aggro_radius: 480, leash_radius: 900,
    aura_radius: 260, aura_damage_mult: 1.25, aura_defense_mult: 1.2, aura_speed_mult: 1.1,
    // behavior_gold_min/behavior_gold_max: the alias both loader SELECTs use
    // for creature_behaviors.gold_min/gold_max, because loadCreatureTypes
    // also selects entity_types.gold_min/gold_max under the bare name and a
    // duplicate key would let one silently overwrite the other in the pg row.
    behavior_gold_min: 10, behavior_gold_max: 30,
  });
  assert.equal(b.auraRadius, 260);
  assert.equal(b.auraDamageMult, 1.25);
  assert.equal(b.auraDefenseMult, 1.2);
  assert.equal(b.auraSpeedMult, 1.1);
  assert.equal(b.goldMin, 10);
  assert.equal(b.goldMax, 30);
});

test('DEFAULT_BEHAVIOR carries neutral aura/gold defaults', () => {
  assert.equal(DEFAULT_BEHAVIOR.auraRadius, 0);
  assert.equal(DEFAULT_BEHAVIOR.auraDamageMult, 1);
  assert.equal(DEFAULT_BEHAVIOR.auraDefenseMult, 1);
  assert.equal(DEFAULT_BEHAVIOR.auraSpeedMult, 1);
  assert.equal(DEFAULT_BEHAVIOR.goldMin, 0);
  assert.equal(DEFAULT_BEHAVIOR.goldMax, 0);
});
