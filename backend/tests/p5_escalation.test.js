// backend/tests/p5_escalation.test.js
const test = require('node:test');
const assert = require('node:assert');
const { deriveLevelBand, deriveDensity, DENSITY_ORDER } = require('../scripts/dungeon/escalation');

test('deriveLevelBand floor and ceiling both rise monotonically with hopFraction', () => {
  const clamp = [1, 50];
  let prevMin = -Infinity, prevMax = -Infinity;
  for (let i = 0; i <= 10; i++) {
    const [min, max] = deriveLevelBand(i / 10, clamp);
    assert.ok(min >= prevMin, `floor dropped at hopFraction ${i / 10}`);
    assert.ok(max >= prevMax, `ceiling dropped at hopFraction ${i / 10}`);
    assert.ok(min >= clamp[0] && max <= clamp[1], 'band must stay inside the tier clamp');
    assert.ok(max >= min + 1, 'band must have positive width');
    prevMin = min; prevMax = max;
  }
});

test('deriveLevelBand never exceeds its tier clamp even at hopFraction 1', () => {
  const clamp = [20, 36];
  const [min, max] = deriveLevelBand(1, clamp);
  assert.ok(min >= 20 && max <= 36);
});

test('deriveLevelBand at hopFraction 0 sits at the clamp floor', () => {
  const [min] = deriveLevelBand(0, [8, 24]);
  assert.equal(min, 8);
});

test('deriveDensity steps through 5 keywords, never returns "dead"', () => {
  const seen = new Set();
  for (let i = 0; i <= 20; i++) seen.add(deriveDensity(i / 20));
  assert.equal(deriveDensity(0), 'sparse');
  assert.equal(deriveDensity(1), 'swarm');
  assert.ok(!seen.has('dead'));
  for (const d of seen) assert.ok(DENSITY_ORDER.includes(d));
});

test('deriveDensity never decreases as hopFraction rises', () => {
  let prevIdx = -1;
  for (let i = 0; i <= 20; i++) {
    const idx = DENSITY_ORDER.indexOf(deriveDensity(i / 20));
    assert.ok(idx >= prevIdx, `density dropped at hopFraction ${i / 20}`);
    prevIdx = idx;
  }
});
