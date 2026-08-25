const test = require('node:test');
const assert = require('node:assert');
const {
  charmBudget, canSummon, PLAYER_CHARM_MS, PLAYER_CHARM_IMMUNITY_MS,
} = require('../src/services/charm.js');

// Hand-written literals throughout. `Math.floor(cha / 2) + bonus` recomputed in
// the assertion would prove only that the expression parses.
test('charmBudget is half of effective charisma, floored, plus the tree bonus', () => {
  assert.equal(charmBudget(10, 0), 5);
  assert.equal(charmBudget(11, 0), 5);   // floored, not rounded
  assert.equal(charmBudget(40, 0), 20);  // spec 8.2's worked example
  assert.equal(charmBudget(40, 3), 23);
  assert.equal(charmBudget(1, 0), 0);    // below 2 CHA you hold nothing
  assert.equal(charmBudget(0, 0), 0);
});

test('a nonsense charisma or bonus degrades to zero rather than to NaN', () => {
  assert.equal(charmBudget(NaN, 0), 0);
  assert.equal(charmBudget(-5, 0), 0);
  assert.equal(charmBudget(10, NaN), 5);
  assert.equal(charmBudget(10, undefined), 5);
});

test('the SUM of active summon levels is what the budget bounds', () => {
  // Spec 8.2: a level-40 druid (budget 20) holds one level-20 creature...
  assert.deepEqual(canSummon([], 20, 20), { ok: true, reason: null });
  assert.deepEqual(canSummon([20], 1, 20), { ok: false, reason: 'over_budget' });
  // ...or four level-5 ones, and not a fifth.
  assert.deepEqual(canSummon([5, 5, 5], 5, 20), { ok: true, reason: null });
  assert.deepEqual(canSummon([5, 5, 5, 5], 1, 20), { ok: false, reason: 'over_budget' });
});

test('a swarm of level-1 creatures is bounded too', () => {
  // The whole point of summing rather than counting: 20 level-1 creatures fill
  // a budget of 20 exactly, and the 21st is refused.
  const twenty = new Array(20).fill(1);
  assert.deepEqual(canSummon(twenty, 1, 20), { ok: false, reason: 'over_budget' });
  assert.deepEqual(canSummon(twenty.slice(0, 19), 1, 20), { ok: true, reason: null });
});

// A COUNT-based budget would pass every assertion above except this one: three
// held creatures is fewer than "twenty" by any count rule, and the sum is what
// refuses the fourth. Kept separate so a regression to counting is unambiguous.
test('a few HIGH-level creatures exhaust the budget as surely as many low ones', () => {
  assert.deepEqual(canSummon([9, 9], 9, 20), { ok: false, reason: 'over_budget' });
  assert.deepEqual(canSummon([9, 9], 2, 20), { ok: true, reason: null });
});

test('a level below 1 is refused before the budget is consulted', () => {
  assert.deepEqual(canSummon([], 0, 20), { ok: false, reason: 'bad_level' });
  assert.deepEqual(canSummon([], -3, 20), { ok: false, reason: 'bad_level' });
  assert.deepEqual(canSummon([], NaN, 20), { ok: false, reason: 'bad_level' });
});

test('the player charm is short and its immunity window is longer than it', () => {
  assert.equal(PLAYER_CHARM_MS, 4000);
  assert.equal(PLAYER_CHARM_IMMUNITY_MS, 8000);
  assert.ok(PLAYER_CHARM_IMMUNITY_MS > PLAYER_CHARM_MS,
    'an immunity window no longer than the effect would let a second charm land the instant the first expired -- a chain-lock with extra steps');
});
