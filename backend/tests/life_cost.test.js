const test = require('node:test');
const assert = require('node:assert');
const { LIFE_COST_RATIO, lifeCostFor, canPayLife } = require('../src/services/lifeCost.js');

// Every expectation below is a hand-computed literal. Writing
// `Math.ceil(cost * LIFE_COST_RATIO)` here would assert that the module equals
// itself -- the dominant vacuous-test shape in this repo.
test('LIFE_COST_RATIO is the specced 0.6', () => {
  assert.equal(LIFE_COST_RATIO, 0.6);
});

test('lifeCostFor rounds up, so a cheap spell is never free', () => {
  assert.equal(lifeCostFor(1), 1);
  assert.equal(lifeCostFor(5), 3);
  assert.equal(lifeCostFor(8), 5);    // the apprentice staff
  assert.equal(lifeCostFor(10), 6);
  assert.equal(lifeCostFor(15), 9);   // magic-bolt
  assert.equal(lifeCostFor(16), 10);  // the frost staff
  assert.equal(lifeCostFor(18), 11);  // the flame staff
  assert.equal(lifeCostFor(20), 12);  // AC5's stated literal: 20 -> 12
  assert.equal(lifeCostFor(22), 14);  // the storm staff
  assert.equal(lifeCostFor(32), 20);  // the archmage staff
});

test('a zero or absent mana cost costs no life', () => {
  assert.equal(lifeCostFor(0), 0);
  assert.equal(lifeCostFor(undefined), 0);
  assert.equal(lifeCostFor(null), 0);
  assert.equal(lifeCostFor(-4), 0);
});

test('the tree multiplier scales the cost and still rounds up', () => {
  // The Cultist START node's grant (SOMET-471): 20 * 0.6 * 0.9 = 10.8 -> 11.
  assert.equal(lifeCostFor(20, 0.9), 11);
  assert.equal(lifeCostFor(32, 0.9), 18);   // 17.28 -> 18
  assert.equal(lifeCostFor(8, 0.9), 5);     // 4.32 -> 5, same as at 1.0
  // Blood Pact (0.75), and Blood Pact stacked on the start node (0.675).
  assert.equal(lifeCostFor(8, 0.75), 4);
  assert.equal(lifeCostFor(24, 0.75), 11);
  assert.equal(lifeCostFor(20, 0.675), 9);  // 8.1 -> 9
  // A missing, zero or nonsense multiplier means "no discount", never "free".
  assert.equal(lifeCostFor(8, 0), 5);
  assert.equal(lifeCostFor(8, NaN), 5);
  assert.equal(lifeCostFor(8, null), 5);
  assert.equal(lifeCostFor(8, -2), 5);
});

test('a cast that would leave the caster below 1 hp cannot be paid', () => {
  assert.equal(canPayLife(6, 5), true);   // lands on exactly 1
  assert.equal(canPayLife(5, 5), false);  // would land on 0
  assert.equal(canPayLife(4, 5), false);  // would land below 0
  assert.equal(canPayLife(100, 24), true);
  assert.equal(canPayLife(1, 0), true);   // a free cast at 1 hp is fine
  // AC5's stated literal: a Cultist at 11 hp cannot pay a 12 hp cast, and at
  // 13 hp they can (13 - 12 = 1, the floor exactly).
  assert.equal(canPayLife(11, 12), false);
  assert.equal(canPayLife(12, 12), false);
  assert.equal(canPayLife(13, 12), true);
});

test('a non-finite pool or cost refuses rather than casting', () => {
  assert.equal(canPayLife(NaN, 5), false);
  assert.equal(canPayLife(10, NaN), false);
  assert.equal(canPayLife(Infinity, 5), false);
});
