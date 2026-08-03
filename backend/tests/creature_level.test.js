const test = require('node:test');
const assert = require('node:assert');
const {
  rollCreatureLevel, scaleCreature,
} = require('../src/services/creatureLevel.js');

// EVERY expected value below is a hand-computed literal, never a
// recomputation of the formula under test. This repo has twice shipped tests
// whose assertions were derived from the same source as the code and
// therefore passed no matter what the code did -- most recently
// biomes_seed.test.js, which checked biome creature references against a
// hand-typed list containing the very name that was dangling.

test('rollCreatureLevel maps the unit interval across the band inclusively', () => {
  // Band [3, 6] is 4 levels wide. u=0 must give the floor, u just under 1
  // must give the ceiling, and nothing may fall outside.
  assert.equal(rollCreatureLevel(0, 3, 6), 3);
  assert.equal(rollCreatureLevel(0.999999, 3, 6), 6);
  assert.equal(rollCreatureLevel(0.25, 3, 6), 4);
  assert.equal(rollCreatureLevel(0.5, 3, 6), 5);
  assert.equal(rollCreatureLevel(0.75, 3, 6), 6);
});

test('a fixed band always returns that level', () => {
  assert.equal(rollCreatureLevel(0, 5, 5), 5);
  assert.equal(rollCreatureLevel(0.5, 5, 5), 5);
  assert.equal(rollCreatureLevel(0.999999, 5, 5), 5);
});

test('rollCreatureLevel clamps a defensive out-of-range unit', () => {
  // hash2/makeRng both return [0,1), but a caller passing 1.0 or a negative
  // must never produce a level outside the band -- that would write a row the
  // worlds_level_band_check would have rejected.
  assert.equal(rollCreatureLevel(1, 2, 4), 4);
  assert.equal(rollCreatureLevel(1.5, 2, 4), 4);
  assert.equal(rollCreatureLevel(-0.2, 2, 4), 2);
});

test('an inverted or missing band degrades to level 1 rather than throwing', () => {
  // Spawn runs inside a transaction that also writes the world_chunks
  // once-only flag (server.js:341). A throw here would roll that back and the
  // chunk would retry forever.
  assert.equal(rollCreatureLevel(0.5, 9, 3), 1);
  assert.equal(rollCreatureLevel(0.5, undefined, undefined), 1);
  assert.equal(rollCreatureLevel(0.5, null, 7), 1);
});

test('level 1 scales nothing at all', () => {
  const base = { hp: 12, damage: 5, defense: 2 };
  assert.deepEqual(scaleCreature(base, 1), { hp: 12, damage: 5, defense: 2 });
});

test('scaleCreature grows hp, damage and defense by hand-computed amounts', () => {
  // Level 5 => 4 levels of growth over the base.
  //   hp      = round(12 * (1 + 0.15*4)) = round(12 * 1.60) = round(19.2) = 19
  //   damage  = round2(5 * (1 + 0.10*4)) = round2(5 * 1.40) = 7
  //   defense = 2 + 0.5*4 = 4
  assert.deepEqual(scaleCreature({ hp: 12, damage: 5, defense: 2 }, 5),
    { hp: 19, damage: 7, defense: 4 });

  // Level 10 => 9 levels of growth.
  //   hp      = round(18 * (1 + 0.15*9)) = round(18 * 2.35) = round(42.3) = 42
  //   damage  = round2(5 * (1 + 0.10*9)) = round2(5 * 1.90) = 9.5
  //   defense = 0 + 0.5*9 = 4.5
  assert.deepEqual(scaleCreature({ hp: 18, damage: 5, defense: 0 }, 10),
    { hp: 42, damage: 9.5, defense: 4.5 });
});

test('hp never scales below 1 even from a degenerate base', () => {
  assert.equal(scaleCreature({ hp: 0, damage: 5, defense: 0 }, 3).hp, 1);
});

test('scaleCreature does not mutate its input', () => {
  const base = { hp: 12, damage: 5, defense: 2 };
  scaleCreature(base, 9);
  assert.deepEqual(base, { hp: 12, damage: 5, defense: 2 });
});

test('scaleCreature never touches resistances', () => {
  // Deliberate: scaling a 0.6 fire resistance by level reaches effective
  // immunity within a few levels. Resistances are a matchup, not a stat.
  const out = scaleCreature({ hp: 10, damage: 5, defense: 0, resistances: { fire: 0.6 } }, 12);
  assert.equal(out.resistances, undefined,
    'scaleCreature returns only the three scaled stats; the caller carries resistances through untouched');
});
