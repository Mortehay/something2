'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { typeWeight, minibossNamesFor, withMinibosses, weightedPick, isMiniboss, MINIBOSS_WEIGHT } = require('../src/services/minibossPool.js');

// 41 minibosses existed in the catalog and none was ever placed: a world lists "Undead Line", never
// "Undead Miniboss". A family's Line now brings its minibosses, rarely.

test('a Line brings its family\'s miniboss names', () => {
  assert.deepEqual(minibossNamesFor(['Undead Swarm', 'Undead Line', 'Slime']).sort(), ['Undead Elite Miniboss', 'Undead Miniboss']);
  assert.deepEqual(minibossNamesFor(['Wolf', 'Slime']), []);
  assert.deepEqual(withMinibosses(['Fungal Line']).sort(), ['Fungal Elite Miniboss', 'Fungal Line', 'Fungal Miniboss']);
  assert.deepEqual(withMinibosses(['Wolf']), ['Wolf'], 'a world without a Line is unchanged');
});

test('weights: plain creatures 1, a miniboss rare, an elite one rarer', () => {
  assert.equal(typeWeight({ name: 'Undead Line', boss_tier: null }), 1);
  assert.equal(typeWeight({ name: 'Undead Miniboss', boss_tier: 'miniboss' }), MINIBOSS_WEIGHT);
  assert.ok(typeWeight({ name: 'Fallen Elite Miniboss', boss_tier: 'miniboss' }) < MINIBOSS_WEIGHT);
  assert.equal(isMiniboss({ boss_tier: 'miniboss' }), true);
  assert.equal(isMiniboss({ boss_tier: 'world' }), false);
});

test('with no miniboss among the candidates the pick is exactly the old uniform index', () => {
  const types = [{ name: 'A' }, { name: 'B' }, { name: 'C' }];
  for (let i = 0; i < 1000; i += 1) {
    const r = i / 1000;
    assert.equal(weightedPick(types, r), types[Math.floor(r * types.length)]);
  }
});

test('a miniboss turns up about one pick in a hundred among three plain types', () => {
  const types = [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'M Miniboss', boss_tier: 'miniboss' }];
  let minis = 0;
  const N = 100000;
  for (let i = 0; i < N; i += 1) if (isMiniboss(weightedPick(types, (i + 0.5) / N))) minis += 1;
  const share = minis / N;
  assert.ok(share > 0.006 && share < 0.014, `miniboss share ${share}`);
});

test('a world that lists only a miniboss still places it (single candidate)', () => {
  const only = [{ name: 'M Miniboss', boss_tier: 'miniboss' }];
  assert.equal(weightedPick(only, 0.99), only[0]);
});
