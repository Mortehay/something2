const test = require('node:test');
const assert = require('node:assert');
const { isCompatible, rollDestroy, stoneKind, STONE_DESTROY_CHANCE } = require('../src/services/stones.js');

test('stoneKind reads spell vs buff off the item_types row shape', () => {
  assert.equal(stoneKind({ element: 'fire', stat_bonus_stat: null }), 'spell');
  assert.equal(stoneKind({ element: null, stat_bonus_stat: 'strength' }), 'buff');
});

test('spell stones are weapon-only; buff stones fit weapon or armor', () => {
  assert.equal(isCompatible('spell', 'weapon'), true);
  assert.equal(isCompatible('spell', 'armor'), false);
  assert.equal(isCompatible('buff', 'weapon'), true);
  assert.equal(isCompatible('buff', 'armor'), true);
});

test('rollDestroy is deterministic under an injected rng, at the exact 10% boundary', () => {
  assert.equal(STONE_DESTROY_CHANCE, 0.10);
  assert.equal(rollDestroy(() => 0.05), true, 'below the threshold destroys');
  assert.equal(rollDestroy(() => 0.10), false, 'exactly at the threshold survives (chance is a strict <)');
  assert.equal(rollDestroy(() => 0.99), false);
});
