// backend/tests/bestiary_derive.test.js
//
// Tests for backend/scripts/bestiary/derive.js: the two pure derivation rules the umbrella
// spec (docs/superpowers/specs/2026-08-06-bestiary-program-design.md, "Resistances" and
// "Depth tiers and bands" sections) states as ranges/shape rather than exact numbers. The
// exact literals here are the documented judgment call within those stated ranges -- see the
// comments in derive.js for the split rationale (task-2-report.md has the full writeup).
const test = require('node:test');
const assert = require('node:assert');
const { deriveResistances, deriveLevelBand } = require('../scripts/bestiary/derive');

test('Swarm and Skirmisher get no resistance or one weak one', () => {
  const r = deriveResistances('Swarm', 'fire');
  assert.deepEqual(r, {});
  const r2 = deriveResistances('Skirmisher', 'fire');
  assert.deepEqual(r2, { fire: 0.2 });
});

test('Line/Ranged/Caster get the primary element at .4-.7, split by role', () => {
  // Line = the line's generic representative -> range midpoint (.55, also the literal this
  // test locks in). Ranged = kiting/positioning rung, least invested in tankiness -> range
  // floor (.4). Caster = the purest expression of the line's element -> range ceiling (.7).
  const line = deriveResistances('Line', 'ice');
  const ranged = deriveResistances('Ranged', 'ice');
  const caster = deriveResistances('Caster', 'ice');
  assert.strictEqual(ranged.ice, 0.4);
  assert.strictEqual(line.ice, 0.55);
  assert.strictEqual(caster.ice, 0.7);
  assert.strictEqual(Object.keys(line).length, 1);
});

test('Brute/Heavy/Champion/Apex get the primary element strong plus partial physical', () => {
  const r = deriveResistances('Apex', 'lightning');
  assert.deepEqual(r, { lightning: 0.8, physical: 0.3 });
});

test('a physical-primary line at a strong rung gets one physical key at the full strong value, not the diluted partial one', () => {
  // Regression test for SOMET-250 Task 4's review finding: { [element]: STRONG_VALUE,
  // physical: STRONG_PHYSICAL_PARTIAL } collapses to a single `physical` key (JS keeps only
  // the second literal) whenever element === 'physical', silently discarding the intended
  // strong value in favour of the weaker partial figure. Nine of the 32 lines are
  // physical-primary (Swamp, Highland, Cave, Construct, Hive, Umbral, Blight, Nightmare,
  // Titan), so this isn't a hypothetical edge case.
  const brute = deriveResistances('Brute', 'physical');
  assert.deepEqual(brute, { physical: 0.6 });
  const apex = deriveResistances('Apex', 'physical');
  assert.deepEqual(apex, { physical: 0.8 });
  assert.strictEqual(Object.keys(apex).length, 1, 'physical-primary strong tier should have exactly one resistance key');
});

test('a null-element line (Beast, Woodland) gets no resistance at any rung', () => {
  assert.deepEqual(deriveResistances('Line', null), {});
  assert.deepEqual(deriveResistances('Apex', null), {});
});

test('Void and Eldritch resist all four elements, partially, at every rung', () => {
  const r = deriveResistances('Line', 'physical', { allFourPartial: true });
  assert.deepEqual(r, { physical: 0.3, fire: 0.3, ice: 0.3, lightning: 0.3 });
  const r2 = deriveResistances('Apex', 'physical', { allFourPartial: true });
  assert.deepEqual(r2, { physical: 0.5, fire: 0.5, ice: 0.5, lightning: 0.5 });
});

test('deriveLevelBand scales within a tier by rung index, Swarm near floor Apex near ceiling', () => {
  const swarmBand = deriveLevelBand('I', 0); // Swarm, tier I (1-12)
  const apexBand = deriveLevelBand('I', 8); // Apex, tier I (1-12)
  assert.ok(swarmBand.min < apexBand.min, 'Apex should sit higher in the band than Swarm');
  assert.ok(swarmBand.min >= 1 && apexBand.max <= 12, 'band must stay inside the tier range');
});

test('deriveLevelBand handles a two-tier span like "I-II" by using the wider combined range', () => {
  const band = deriveLevelBand('I-II', 8); // Apex at a I-II line: tier I (1-12) + tier II (8-24) combined = 1-24
  assert.ok(band.max <= 24);
  assert.ok(band.min >= 1);
});
