const test = require('node:test');
const assert = require('node:assert');
const {
  resolveDensity, DENSITY_NAMES, DEFAULT_DENSITY, MAX_WORLD_CREATURES,
} = require('../src/services/densityTiers');

// Expected counts are written as LITERALS, never recomputed from the tier
// table. Importing DENSITY_TIERS and recomputing perThousand * area / 1000
// would assert that arithmetic works, not that the table holds the intended
// numbers -- the test would keep passing through any edit to the table.

test('normal on a 64x64 map scatters 25 with one small pack', () => {
  assert.deepEqual(resolveDensity('normal', 64, 64),
    { scatterCount: 25, packCount: 1, packSizeMin: 3, packSizeMax: 4, clamped: false });
});

test('horde on a 64x64 map is roughly 130 creatures all told', () => {
  assert.deepEqual(resolveDensity('horde', 64, 64),
    { scatterCount: 98, packCount: 4, packSizeMin: 5, packSizeMax: 8, clamped: false });
});

test('swarm on a 64x64 map is roughly 270 creatures all told', () => {
  assert.deepEqual(resolveDensity('swarm', 64, 64),
    { scatterCount: 197, packCount: 6, packSizeMin: 8, packSizeMax: 12, clamped: false });
});

test('dead places nothing at all', () => {
  assert.deepEqual(resolveDensity('dead', 64, 64),
    { scatterCount: 0, packCount: 0, packSizeMin: 0, packSizeMax: 0, clamped: false });
});

test('sparse and dense sit either side of normal', () => {
  assert.equal(resolveDensity('sparse', 64, 64).scatterCount, 12);
  assert.equal(resolveDensity('dense', 64, 64).scatterCount, 49);
});

// The whole point of scaling per 1000 tiles: a bigger map is not sparser at
// the same setting. 96x96 is 9216 tiles against 64x64's 4096.
test('scatter scales with map area, so a 96x96 world is not sparser', () => {
  assert.equal(resolveDensity('normal', 96, 96).scatterCount, 55);
  assert.equal(resolveDensity('horde', 96, 96).scatterCount, 221);
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

// SOMET-246 final review, finding 4. Area scaling has no natural ceiling, and
// POST/PUT /api/worlds accept width and height up to 4096. Unclamped, the
// numbers below are 100,663 / 201,327 / 805,306 scattered creatures -- seconds
// of event-loop-blocking rejection sampling in the same process as the live
// authority, plus that many INSERTs inside one open write transaction.
//
// The expected values are literals: 4000 minus each tier's worst-case pack
// budget (packCount * packSizeMax). Recomputing them from MAX_WORLD_CREATURES
// and DENSITY_TIERS would assert the clamp's own arithmetic back at itself.
test('a map large enough to blow past the cap is clamped, packs included', () => {
  // normal: 1 pack of at most 4 -> 4000 - 4.
  assert.equal(resolveDensity('normal', 4096, 4096).scatterCount, 3996);
  // dense: 2 packs of at most 6 -> 4000 - 12.
  assert.equal(resolveDensity('dense', 4096, 4096).scatterCount, 3988);
  // swarm: 6 packs of at most 12 -> 4000 - 72.
  assert.equal(resolveDensity('swarm', 4096, 4096).scatterCount, 3928);
});

test('the clamped total never exceeds 4000 creatures for any tier', () => {
  assert.equal(MAX_WORLD_CREATURES, 4000);
  for (const tier of DENSITY_NAMES) {
    const d = resolveDensity(tier, 4096, 4096);
    const worstCaseTotal = d.scatterCount + d.packCount * d.packSizeMax;
    assert.ok(worstCaseTotal <= 4000,
      `${tier} on a 4096x4096 map resolves to ${worstCaseTotal} creatures`);
  }
});

// The deepest world on the size ramp is 224x224 at swarm -- 2408 creatures,
// comfortably inside the ceiling. The clamp must stay invisible to every world
// the game actually ships, which is exactly why a regression in it would go
// unnoticed without this.
test('the cap leaves every world on the size ramp untouched', () => {
  assert.equal(resolveDensity('swarm', 224, 224).scatterCount, 2408);
  assert.equal(resolveDensity('swarm', 286, 286).scatterCount, 3926);   // just under the clamp
  assert.equal(resolveDensity('swarm', 287, 287).scatterCount, 3928);   // one tile wider: clamped
});

// The flag is the whole point of SOMET-302's ceiling work: before it, a
// truncated world was indistinguishable from a world authored thin.
test('clamped is true only when the ceiling actually cut the target', () => {
  assert.equal(resolveDensity('swarm', 286, 286).clamped, false);
  assert.equal(resolveDensity('swarm', 287, 287).clamped, true);
  assert.equal(resolveDensity('normal', 64, 64).clamped, false);
  assert.equal(resolveDensity('dead', 4096, 4096).clamped, false);
});
