const test = require('node:test');
const assert = require('node:assert');
const { rollDrops } = require('../src/authority/loot');

// Deterministic rng returning a scripted sequence.
function seq(...vals) { let i = 0; return () => (i < vals.length ? vals[i++] : 0); }

test('no drop rows yields nothing', () => {
  assert.deepStrictEqual(rollDrops([], seq(0)), []);
  assert.deepStrictEqual(rollDrops(undefined, seq(0)), []);
});

test('chance 1 always drops', () => {
  const rows = [{ item_type_id: 5, chance: '1', min_qty: 1, max_qty: 1 }];
  assert.deepStrictEqual(rollDrops(rows, seq(0.999, 0)), [5]);
});

test('chance 0.5 respects the rng on both sides', () => {
  const rows = [{ item_type_id: 5, chance: '0.5', min_qty: 1, max_qty: 1 }];
  assert.deepStrictEqual(rollDrops(rows, seq(0.4, 0)), [5], 'roll under chance drops');
  assert.deepStrictEqual(rollDrops(rows, seq(0.5, 0)), [], 'roll at chance does not drop');
  assert.deepStrictEqual(rollDrops(rows, seq(0.9, 0)), [], 'roll over chance does not drop');
});

test('quantity spans min..max inclusive', () => {
  const rows = [{ item_type_id: 7, chance: '1', min_qty: 2, max_qty: 4 }];
  assert.deepStrictEqual(rollDrops(rows, seq(0, 0)), [7, 7], 'rng 0 -> min');
  assert.deepStrictEqual(rollDrops(rows, seq(0, 0.999)), [7, 7, 7, 7], 'rng ~1 -> max');
});

test('each row rolls independently', () => {
  const rows = [
    { item_type_id: 1, chance: '1', min_qty: 1, max_qty: 1 },
    { item_type_id: 2, chance: '0.1', min_qty: 1, max_qty: 1 },
    { item_type_id: 3, chance: '1', min_qty: 1, max_qty: 1 },
  ];
  // row1: drop(0) qty(0) | row2: 0.9 -> skip | row3: drop(0) qty(0)
  assert.deepStrictEqual(rollDrops(rows, seq(0, 0, 0.9, 0, 0)), [1, 3]);
});

test('malformed quantities degrade to a single drop rather than throwing', () => {
  const rows = [{ item_type_id: 9, chance: '1', min_qty: null, max_qty: null }];
  assert.deepStrictEqual(rollDrops(rows, seq(0, 0)), [9]);
});

test('chance 0 drops nothing', () => {
  const rows = [{ item_type_id: 1, chance: '0', min_qty: 1, max_qty: 1 }];
  assert.deepStrictEqual(rollDrops(rows, seq(0, 0)), []);
});

test('a negative chance drops nothing', () => {
  const rows = [{ item_type_id: 1, chance: '-0.5', min_qty: 1, max_qty: 1 }];
  assert.deepStrictEqual(rollDrops(rows, seq(0, 0)), []);
});

test('a NaN chance drops nothing', () => {
  const rows = [{ item_type_id: 1, chance: 'not-a-number', min_qty: 1, max_qty: 1 }];
  assert.deepStrictEqual(rollDrops(rows, seq(0, 0)), []);
});

test('a huge max_qty is clamped rather than hanging the process', () => {
  // Migration 1714440018000 only enforces min_qty <= max_qty — nothing caps
  // max_qty itself, so a bad catalog row (or a future admin typo) could set
  // max_qty to 1e9. rollDrops must clamp internally rather than trust the row.
  const rows = [{ item_type_id: 3, chance: '1', min_qty: 1, max_qty: 1000000000 }];
  const out = rollDrops(rows, seq(0, 0.999999)); // roll(drop)=0 -> drops; roll(qty)~1 -> picks the max
  assert.ok(out.length <= 100, `expected at most 100 entries, got ${out.length}`);
  assert.ok(out.length > 0, 'still drops something');
  assert.ok(out.every((id) => id === 3));
});
