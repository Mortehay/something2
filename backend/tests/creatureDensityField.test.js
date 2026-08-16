const test = require('node:test');
const assert = require('node:assert');
const {
  buildDensityField, safetyForDistance, noiseWeight,
  WEIGHT_MIN, WEIGHT_MAX, SAFETY_RAMP,
} = require('../src/services/creatureDensityField');

// Hand-typed literals throughout. Deriving an expectation from the constant
// under test makes the test pass at any value.
test('safetyForDistance is a rising step function over the ramp', () => {
  assert.strictEqual(safetyForDistance(0), 0);
  assert.strictEqual(safetyForDistance(1), 0.4);
  assert.strictEqual(safetyForDistance(5), 0.4);
  assert.strictEqual(safetyForDistance(6), 1);
  assert.strictEqual(safetyForDistance(12), 1);
  assert.strictEqual(safetyForDistance(13), 1.4);
  assert.strictEqual(safetyForDistance(20), 1.4);
  assert.strictEqual(safetyForDistance(21), 1.6);
  assert.strictEqual(safetyForDistance(999), 1.6);
});

test('safetyForDistance returns the far value for unreachable tiles', () => {
  // Infinity is what the BFS leaves on a map with no safe tiles at all.
  assert.strictEqual(safetyForDistance(Infinity), 1.6);
});

test('SAFETY_RAMP matches the last distance that is not yet far', () => {
  assert.strictEqual(SAFETY_RAMP, 20);
});

test('noiseWeight stays within its band across many tiles', () => {
  let lo = Infinity, hi = -Infinity;
  for (let r = 0; r < 60; r++) {
    for (let c = 0; c < 60; c++) {
      const w = noiseWeight(12345, r, c);
      lo = Math.min(lo, w); hi = Math.max(hi, w);
    }
  }
  assert.ok(lo >= 0.3, `noise floor ${lo} below 0.3`);
  assert.ok(hi <= 1.8, `noise ceiling ${hi} above 1.8`);
  // The band must actually be used, or the term is a constant in disguise.
  assert.ok(hi - lo > 0.5, `noise range ${hi - lo} too flat to matter`);
});

// --- buildDensityField -------------------------------------------------

// Minimal stand-ins. The field must not require mapService (circular import),
// so its two mapService helpers arrive as arguments.
function fakeCfg(overrides = {}) {
  return {
    seed: 777,
    bounds: { width: 60, height: 60 },
    biomes: [],
    ...overrides,
  };
}
const noSafe = { safeAt: () => false };
const deps = {
  noise: (seed, r, c, cell) => {
    // Deterministic, cheap, and genuinely varying -- a constant here would
    // make the normalization test vacuous.
    const v = Math.sin((seed % 97) + r / cell + c / (cell * 1.7));
    return (v + 1) / 2;
  },
  regionAt: () => null,
};

test('buildDensityField normalizes to mean 1 over interior non-safe tiles', () => {
  const f = buildDensityField(fakeCfg(), noSafe, deps);
  let sum = 0, n = 0;
  for (let r = 1; r <= 58; r++) {
    for (let c = 1; c <= 58; c++) { sum += f.weightAt(r, c); n++; }
  }
  const mean = sum / n;
  // Clamping perturbs the mean, so this is a band, not an equality.
  assert.ok(mean > 0.9 && mean < 1.1, `mean ${mean} not near 1`);
});

test('buildDensityField clamps every tile into [WEIGHT_MIN, WEIGHT_MAX]', () => {
  const f = buildDensityField(fakeCfg({
    biomes: [{ name: 'crypt', creatureDensity: 2.5, creatureTypes: [], terrainNames: [] }],
  }), noSafe, { ...deps, regionAt: (cfg) => cfg.biomes[0] });
  for (let r = 1; r <= 58; r++) {
    for (let c = 1; c <= 58; c++) {
      const w = f.weightAt(r, c);
      assert.ok(w >= WEIGHT_MIN && w <= WEIGHT_MAX, `weight ${w} at ${r},${c} out of band`);
    }
  }
  assert.strictEqual(f.max, WEIGHT_MAX);
});

test('buildDensityField is deterministic for the same seed', () => {
  const a = buildDensityField(fakeCfg(), noSafe, deps);
  const b = buildDensityField(fakeCfg(), noSafe, deps);
  for (let r = 1; r <= 20; r++) {
    assert.strictEqual(a.weightAt(r, r), b.weightAt(r, r));
  }
});

test('buildDensityField differs for a different seed', () => {
  const a = buildDensityField(fakeCfg({ seed: 1 }), noSafe, deps);
  const b = buildDensityField(fakeCfg({ seed: 2 }), noSafe, deps);
  let differences = 0;
  for (let r = 1; r <= 50; r++) if (a.weightAt(r, r) !== b.weightAt(r, r)) differences++;
  assert.ok(differences > 20, `only ${differences}/50 tiles differ between seeds`);
});

test('tiles near a safe region weigh less than tiles far from one', () => {
  // One safe block in the top-left corner.
  const safeCtx = { safeAt: (r, c) => r < 4 && c < 4 };
  const flat = { noise: () => 0.5, regionAt: () => null };
  const f = buildDensityField(fakeCfg(), safeCtx, flat);
  assert.ok(f.weightAt(5, 5) < f.weightAt(40, 40),
    'a tile 1-2 tiles from safety must weigh less than one far away');
});

test('a denser biome outweighs a thinner one on an otherwise flat map', () => {
  const thin = { name: 'meadow', creatureDensity: 0.5 };
  const thick = { name: 'swamp', creatureDensity: 2 };
  const flat = {
    noise: () => 0.5,
    // Left half thin, right half thick.
    regionAt: (cfg, r, c) => (c < 30 ? thin : thick),
  };
  const f = buildDensityField(fakeCfg({ biomes: [thin, thick] }), noSafe, flat);
  assert.ok(f.weightAt(20, 40) > f.weightAt(20, 10),
    'the swamp half must weigh more than the meadow half');
});

test('buildDensityField returns a flat field for an unbounded config', () => {
  const f = buildDensityField(fakeCfg({ bounds: null }), noSafe, deps);
  assert.strictEqual(f.weightAt(3, 3), 1);
  assert.strictEqual(f.weightAt(900, 900), 1);
});
