const test = require('node:test');
const assert = require('node:assert');
const { LINES, RUNGS, TIER_BANDS } = require('../scripts/bestiary/template');

test('LINES has exactly 32 entries, all unique names', () => {
  assert.strictEqual(LINES.length, 32);
  assert.strictEqual(new Set(LINES.map((l) => l.name)).size, 32);
});

test('every line has a valid tier token', () => {
  const validTiers = new Set(['I', 'II', 'III', 'IV', 'I-II', 'II-III', 'III-IV']);
  for (const l of LINES) {
    assert.ok(validTiers.has(l.tier), `${l.name} has invalid tier "${l.tier}"`);
  }
});

test('every line element is one of the four game elements, or null', () => {
  const valid = new Set(['physical', 'fire', 'ice', 'lightning', null]);
  for (const l of LINES) {
    assert.ok(valid.has(l.element), `${l.name} has invalid element "${l.element}"`);
  }
});

test('RUNGS has exactly 9 entries in umbrella order with sequential index', () => {
  assert.deepEqual(RUNGS.map((r) => r.name),
    ['Swarm', 'Skirmisher', 'Line', 'Ranged', 'Caster', 'Brute', 'Heavy', 'Champion', 'Apex']);
  assert.deepEqual(RUNGS.map((r) => r.index), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
});

test('RUNGS hp/defense match the umbrella table exactly', () => {
  const byName = Object.fromEntries(RUNGS.map((r) => [r.name, r]));
  assert.deepEqual(
    [byName.Swarm.hp, byName.Swarm.defense], [8, 0]);
  assert.deepEqual(
    [byName.Apex.hp, byName.Apex.defense], [130, 13]);
  assert.deepEqual(
    [byName.Champion.hp, byName.Champion.defense], [85, 9]);
});

test('TIER_BANDS covers all four tiers with the umbrella ranges', () => {
  assert.deepEqual(TIER_BANDS, { I: [1, 12], II: [8, 24], III: [20, 36], IV: [32, 50] });
});
