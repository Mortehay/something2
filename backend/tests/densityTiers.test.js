const test = require('node:test');
const assert = require('node:assert');
const { resolveDensity, DENSITY_NAMES, DEFAULT_DENSITY } = require('../src/services/densityTiers');

// Expected counts are written as LITERALS, never recomputed from the tier
// table. Importing DENSITY_TIERS and recomputing perThousand * area / 1000
// would assert that arithmetic works, not that the table holds the intended
// numbers -- the test would keep passing through any edit to the table.

test('normal on a 64x64 map scatters 12 with one small pack', () => {
  assert.deepEqual(resolveDensity('normal', 64, 64),
    { scatterCount: 12, packCount: 1, packSizeMin: 3, packSizeMax: 4 });
});

test('horde on a 64x64 map is roughly 75 creatures all told', () => {
  assert.deepEqual(resolveDensity('horde', 64, 64),
    { scatterCount: 49, packCount: 4, packSizeMin: 5, packSizeMax: 8 });
});

test('swarm on a 64x64 map is roughly 160 creatures all told', () => {
  assert.deepEqual(resolveDensity('swarm', 64, 64),
    { scatterCount: 98, packCount: 6, packSizeMin: 8, packSizeMax: 12 });
});

test('dead places nothing at all', () => {
  assert.deepEqual(resolveDensity('dead', 64, 64),
    { scatterCount: 0, packCount: 0, packSizeMin: 0, packSizeMax: 0 });
});

test('sparse and dense sit either side of normal', () => {
  assert.equal(resolveDensity('sparse', 64, 64).scatterCount, 6);
  assert.equal(resolveDensity('dense', 64, 64).scatterCount, 25);
});

// The whole point of scaling per 1000 tiles: a bigger map is not sparser at
// the same setting. 96x96 is 9216 tiles against 64x64's 4096.
test('scatter scales with map area, so a 96x96 world is not sparser', () => {
  assert.equal(resolveDensity('normal', 96, 96).scatterCount, 28);
  assert.equal(resolveDensity('horde', 96, 96).scatterCount, 111);
});

test('a nullish tier resolves to the default rather than throwing', () => {
  assert.deepEqual(resolveDensity(null, 64, 64), resolveDensity(DEFAULT_DENSITY, 64, 64));
  assert.deepEqual(resolveDensity(undefined, 64, 64), resolveDensity(DEFAULT_DENSITY, 64, 64));
});

// Loud, not silent: a typo'd tier is a bug in the caller, and falling back to
// 'normal' would hide it behind a plausible-looking population.
test('an unknown tier throws rather than falling back', () => {
  assert.throws(() => resolveDensity('enormous', 64, 64), /unknown density tier "enormous"/);
});

test('DENSITY_NAMES lists exactly the six tiers, ascending', () => {
  assert.deepEqual(DENSITY_NAMES, ['dead', 'sparse', 'normal', 'dense', 'horde', 'swarm']);
});

test('an unbounded world resolves to no creatures', () => {
  assert.equal(resolveDensity('horde', null, null).scatterCount, 0);
});
