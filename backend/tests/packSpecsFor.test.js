const test = require('node:test');
const assert = require('node:assert');
const { packSpecsFor } = require('../src/services/worldPopulation');

// SOMET-246 final review, finding 6. packSpecsFor used to take `s % span` off
// an inline mod-2^32 LCG. Bit k of such an LCG has period at most 2^(k+1), so
// the low bits it sampled barely moved:
//   - `horde` (4 packs, sizes 5-8, span 4) emitted a permutation of exactly
//     {5,6,7,8} -- total 26 -- for every seed that will ever exist, because
//     four successive values of the low 2 bits cycle through all 4 residues.
//   - `normal` (1 pack, sizes 3-4, span 2) picked 3 for every even seed and 4
//     for every odd one: pure parity.
// The tiers below are passed as literal shapes rather than through
// resolveDensity, so these tests stay about the size draw and cannot be
// silently reshaped by an edit to the density table.

const HORDE = { packCount: 4, packSizeMin: 5, packSizeMax: 8 };
const NORMAL = { packCount: 1, packSizeMin: 3, packSizeMax: 4 };

test('every pack size stays inside the tier band', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const specs = packSpecsFor(HORDE, seed);
    assert.equal(specs.length, 4);
    for (const p of specs) {
      assert.ok(p.size >= 5 && p.size <= 8, `size ${p.size} escaped the band [5,8]`);
    }
  }
});

test('horde pack totals vary across seeds instead of always summing to 26', () => {
  const totals = new Set();
  for (let seed = 1; seed <= 500; seed++) {
    totals.add(packSpecsFor(HORDE, seed).reduce((a, p) => a + p.size, 0));
  }
  // The low-bit bug pinned this set to exactly {26}. The theoretical range is
  // 20..32; require a broad spread rather than an exact set, which would be a
  // brittle restatement of the generator's output.
  assert.ok(totals.size >= 10, `only ${totals.size} distinct horde totals over 500 seeds`);
  assert.ok(!(totals.size === 1 && totals.has(26)), 'horde still collapses to a fixed total of 26');
});

test('a single-pack tier does not decide its size by seed parity', () => {
  let evenSmall = 0, oddSmall = 0;
  const N = 500;
  for (let seed = 1; seed <= 2 * N; seed++) {
    const size = packSpecsFor(NORMAL, seed)[0].size;
    if (seed % 2 === 0) { if (size === 3) evenSmall += 1; }
    else if (size === 3) oddSmall += 1;
  }
  // The old low-bit draw scored 100% on one parity class and 0% on the other.
  // Both classes must now land near half; the band is generous so this is a
  // parity check, not a randomness-quality assertion.
  for (const [label, n] of [['even', evenSmall], ['odd', oddSmall]]) {
    assert.ok(n > N * 0.3 && n < N * 0.7,
      `${label} seeds chose the small pack ${n}/${N} times — size still tracks seed parity`);
  }
});

test('pack sizes are deterministic for a fixed seed', () => {
  assert.deepEqual(packSpecsFor(HORDE, 4242), packSpecsFor(HORDE, 4242));
  assert.notDeepEqual(packSpecsFor(HORDE, 4242), packSpecsFor(HORDE, 4243));
});

test('a tier with no packs yields no specs', () => {
  assert.deepEqual(packSpecsFor({ packCount: 0, packSizeMin: 0, packSizeMax: 0 }, 7), []);
});
