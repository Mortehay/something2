// backend/tests/stat_composition.test.js
//
// Every expected value below is HAND-WRITTEN. This module is the exact shape
// the spec §11 warning names: a test that builds its expectation by summing
// the same inputs the code sums proves only that addition is associative.
const test = require('node:test');
const assert = require('node:assert');
const { composeStats, STAT_KEYS } = require('../src/services/statComposition.js');

const BASE = {
  strength: 5, dexterity: 5, constitution: 5,
  intelligence: 5, wisdom: 5, charisma: 5,
};

test('the six stat keys, in the order the rest of the codebase uses', () => {
  assert.deepStrictEqual(STAT_KEYS,
    ['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma']);
});

test('with no passives and no gear the base passes straight through', () => {
  const r = composeStats({ base: BASE, passives: [], gear: [] });
  assert.strictEqual(r.strength, 5);
  assert.strictEqual(r.charisma, 5);
  assert.deepStrictEqual(r.sources.strength, { base: 5, tree: 0, gear: 0 });
  assert.deepStrictEqual(r.modifiers, []);
  // Every rule at its identity. EXHAUSTIVE: a rule added to RULE_COMBINE with
  // the wrong identity would reach its consumer as undefined, and undefined
  // times a `product` rule is NaN.
  assert.deepStrictEqual(r.rules, {
    lifeCostMultiplier: 1, treeCharmBonus: 0, cooldownFloor: null, regenLifeShare: 0,
    attackSpeedMult: 1, castSpeedMult: 1,
  });
});

test('base + tree + gear, itemised — STR 19 = 5 base + 10 tree + 4 gear', () => {
  const r = composeStats({
    base: BASE,
    passives: [
      { type: 'stat', stat: 'strength', value: 2, label: 'Sinew' },
      { type: 'stat', stat: 'strength', value: 8, label: 'Great Sinew' },
      { type: 'stat', stat: 'wisdom', value: 3, label: 'Focus' },
      { type: 'resource', pool: 'hp', value: 40, label: 'Thick Skin' },
    ],
    gear: [
      { label: "Bear's Girdle", effect: { type: 'stat', stat: 'strength' }, value: 4 },
      { label: 'Owl Charm', effect: { type: 'resist', element: 'fire' }, value: 7 },
    ],
  });

  assert.strictEqual(r.strength, 19);
  assert.strictEqual(r.wisdom, 8);
  assert.strictEqual(r.dexterity, 5);
  assert.deepStrictEqual(r.sources.strength, { base: 5, tree: 10, gear: 4 });
  assert.deepStrictEqual(r.sources.wisdom, { base: 5, tree: 3, gear: 0 });
  assert.deepStrictEqual(r.sources.dexterity, { base: 5, tree: 0, gear: 0 });
});

test('every grant becomes exactly one modifier, tagged with where it came from', () => {
  const r = composeStats({
    base: BASE,
    passives: [
      { type: 'stat', stat: 'strength', value: 8, label: 'Great Sinew' },
      { type: 'damage', element: 'fire', value: 12, label: 'Kindling' },
    ],
    gear: [{ label: 'Owl Charm', effect: { type: 'resist', element: 'fire' }, value: 7 }],
  });

  assert.strictEqual(r.modifiers.length, 3);
  assert.deepStrictEqual(r.modifiers[0],
    { label: 'Great Sinew', value: 8, source: 'tree', kind: 'stat', detail: 'strength' });
  assert.deepStrictEqual(r.modifiers[1],
    { label: 'Kindling', value: 12, source: 'tree', kind: 'damage', detail: 'fire' });
  assert.deepStrictEqual(r.modifiers[2],
    { label: 'Owl Charm', value: 7, source: 'gear', kind: 'resist', detail: 'fire' });
});

test('rules combine by their declared mode: product, sum and min', () => {
  const r = composeStats({
    base: BASE,
    passives: [
      { type: 'rule', rule: 'lifeCostMultiplier', value: 0.75, label: 'Blood Pact' },
      { type: 'rule', rule: 'lifeCostMultiplier', value: 0.8, label: 'Sanguine Rite' },
      { type: 'rule', rule: 'treeCharmBonus', value: 5, label: 'Beast Bond' },
      { type: 'rule', rule: 'treeCharmBonus', value: 3, label: 'Pack Leader' },
      { type: 'rule', rule: 'cooldownFloor', value: 0.36, label: 'Nimble' },
      { type: 'rule', rule: 'cooldownFloor', value: 0.32, label: 'Fleet' },
    ],
    gear: [],
  });

  // 0.75 * 0.8 in binary floating point is 0.6000000000000001; the module
  // rounds rule products to 4dp for the same reason playerStats.js's round4
  // exists, so the literal below is 0.6 and not a tolerance argument.
  assert.strictEqual(r.rules.lifeCostMultiplier, 0.6);
  assert.strictEqual(r.rules.treeCharmBonus, 8);
  assert.strictEqual(r.rules.cooldownFloor, 0.32);
  assert.strictEqual(r.rules.regenLifeShare, 0);
  assert.strictEqual(r.modifiers.length, 6);
  assert.deepStrictEqual(r.modifiers[0],
    { label: 'Blood Pact', value: 0.75, source: 'tree', kind: 'rule', detail: 'lifeCostMultiplier' });
});

test('composed totals are integers, so derivePlayerStats never sees a fraction', () => {
  const r = composeStats({
    base: BASE,
    passives: [{ type: 'stat', stat: 'dexterity', value: 2.5, label: 'Odd' }],
    gear: [{ label: 'Odd Ring', effect: { type: 'stat', stat: 'dexterity' }, value: 1.5 }],
  });
  // 5 + 2.5 + 1.5 = 9 exactly; the flooring is on the SUM, not per grant, so a
  // pair of halves is not silently thrown away.
  assert.strictEqual(r.dexterity, 9);
  assert.strictEqual(Number.isInteger(r.dexterity), true);
});

test('a stat can never compose below its base — a negative grant floors there', () => {
  // derivePlayerStats' own stat() falls back to BASE_STAT for anything below
  // it (playerStats.js:33-37), so a value that composes lower would be
  // silently ignored downstream. Floor it here instead, where it is visible.
  const r = composeStats({
    base: BASE,
    passives: [{ type: 'stat', stat: 'charisma', value: -20, label: 'Curse' }],
    gear: [],
  });
  assert.strictEqual(r.charisma, 5);
  assert.deepStrictEqual(r.sources.charisma, { base: 5, tree: -20, gear: 0 });
});

test('a missing or malformed base falls back to 5 rather than producing NaN', () => {
  const r = composeStats({ base: { strength: 'x' }, passives: [], gear: [] });
  assert.strictEqual(r.strength, 5);
  assert.strictEqual(r.intelligence, 5);
});

test('an unknown grant type is ignored by the totals but still listed as a modifier', () => {
  const r = composeStats({
    base: BASE,
    passives: [{ type: 'wat', value: 3, label: 'Mystery' }],
    gear: [],
  });
  assert.strictEqual(r.strength, 5);
  assert.strictEqual(r.modifiers.length, 1);
  assert.strictEqual(r.modifiers[0].kind, 'wat');
});

// Not in the plan. Added because composeStats is called with a RAW
// player_progression row as `base` (composeProgression passes the row
// straight through) and that row carries character_id, experience, level and
// passive_points alongside the six stats. If the composer ever started
// iterating the base object rather than STAT_KEYS, `level` would silently
// become a seventh stat and `sources` would grow keys nothing renders.
test('a base object with extra columns contributes only its six stat keys', () => {
  const r = composeStats({
    base: {
      character_id: 7, experience: 99999, level: 42, passive_points: 3,
      strength: 5, dexterity: 5, constitution: 5,
      intelligence: 5, wisdom: 5, charisma: 5,
    },
    passives: [],
    gear: [],
  });
  assert.deepStrictEqual(Object.keys(r.sources), STAT_KEYS);
  assert.strictEqual(r.level, undefined);
  assert.strictEqual(r.strength, 5);
});

// Not in the plan. A `min` rule whose only grant is a single keystone must
// take that keystone's value, not stay at the null identity -- the plan's
// own test only exercises the two-grant path, where a bug that ignored the
// first grant entirely would still produce the right answer.
test('a single min-mode rule grant replaces the null identity', () => {
  const r = composeStats({
    base: BASE,
    passives: [{ type: 'rule', rule: 'cooldownFloor', value: 0.4, label: 'Only' }],
    gear: [],
  });
  assert.strictEqual(r.rules.cooldownFloor, 0.4);
});

// Not in the plan. A grant naming a stat that does not exist must not create
// a seventh `sources` entry -- the object is rendered key-by-key by the
// Character tab and a stray key would draw a row for a stat with no formula.
test('a grant for an unknown stat key is listed but creates no sources entry', () => {
  const r = composeStats({
    base: BASE,
    passives: [{ type: 'stat', stat: 'luck', value: 10, label: 'Fortune' }],
    gear: [],
  });
  assert.deepStrictEqual(Object.keys(r.sources), STAT_KEYS);
  assert.strictEqual(r.modifiers.length, 1);
  assert.strictEqual(r.modifiers[0].detail, 'luck');
});
