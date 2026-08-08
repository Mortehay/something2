// backend/tests/bestiary_drop_mapping.test.js
//
// Tests for backend/scripts/bestiary/dropMapping.js: pure line-element/tier -> drop-item
// mapping, drawing from the existing item_types weapon catalog. Item names/damages here were
// verified against the live dev database on 2026-08-08 (see dropMapping.js header) -- they
// matched the plan's snapshot exactly, no drift to work around.
const test = require('node:test');
const assert = require('node:assert');
const { pickDropItem } = require('../scripts/bestiary/dropMapping');

test('a tier-I line with no element picks a low-damage neutral melee item', () => {
  const d = pickDropItem(null, 'I');
  assert.ok(['knife', 'stick', 'dagger'].includes(d.item), `unexpected item: ${d.item}`);
});

test('a fire-element line picks the flame staff when the tier supports it', () => {
  const d = pickDropItem('fire', 'III');
  assert.strictEqual(d.item, 'flame staff');
});

test('an ice-element line picks the frost staff', () => {
  const d = pickDropItem('ice', 'II-III');
  assert.strictEqual(d.item, 'frost staff');
});

test('a lightning-element line picks the storm staff', () => {
  const d = pickDropItem('lightning', 'III');
  assert.strictEqual(d.item, 'storm staff');
});

test('a tier-IV line picks a high-damage item regardless of element', () => {
  const d = pickDropItem('physical', 'IV');
  assert.ok(['two-handed sword', 'scythe', 'pike', 'archmage staff'].includes(d.item));
});

test('every returned drop rule has a valid chance and quantity range', () => {
  const d = pickDropItem('physical', 'II');
  assert.ok(d.chance > 0 && d.chance <= 1);
  assert.ok(d.min_qty >= 1 && d.max_qty >= d.min_qty);
});
