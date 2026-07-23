const test = require('node:test');
const assert = require('node:assert');
const { villageMerchantPost } = require('../src/services/mapService');

const V = (over = {}) => ({ minRow: 5, minCol: 5, width: 8, height: 6, gateEdge: 'S', ...over });

test('S gate: merchant stands on the gate centre column, one tile deeper than the guard posts', () => {
  // box rows 5..10, cols 5..12; gate row 10 col 9; guard posts row 9; merchant row 8
  assert.deepEqual(villageMerchantPost(V()), { x: 9 * 100 + 50, y: 8 * 100 + 50 });
});

test('N gate mirrors: one tile deeper from the N wall', () => {
  // gate row 5 col 9; guard posts row 6; merchant row 7
  assert.deepEqual(villageMerchantPost(V({ gateEdge: 'N' })), { x: 9 * 100 + 50, y: 7 * 100 + 50 });
});

test('W gate: merchant on the gate centre row, one col deeper', () => {
  // gate col 5 row 8; guard posts col 6; merchant col 7
  assert.deepEqual(villageMerchantPost(V({ gateEdge: 'W' })), { x: 7 * 100 + 50, y: 8 * 100 + 50 });
});

test('E gate: one col deeper from the E wall', () => {
  // gate col 12 row 8; guard posts col 11; merchant col 10
  assert.deepEqual(villageMerchantPost(V({ gateEdge: 'E' })), { x: 10 * 100 + 50, y: 8 * 100 + 50 });
});

test('a minimum 3x3 village clamps the merchant to its single interior tile', () => {
  const p = villageMerchantPost(V({ width: 3, height: 3, gateEdge: 'S' }));
  assert.deepEqual(p, { x: 6 * 100 + 50, y: 6 * 100 + 50 });
});

// --- Merchant/guard tile overlap: a documented geometric limit, not a bug.
//
// A village hosts two gate guards plus one merchant, so three DISTINCT interior
// tiles are needed to avoid overlap. The interior is (width-2) x (height-2)
// tiles, so any village with an interior smaller than 3 tiles physically cannot
// separate them. Slice A's validator allows width 3-8 and height 3-6, which
// makes exactly three sizes too small: 3x3 (1 interior tile), 3x4 and 4x3 (2).
// The overlap is cosmetic — the merchant is a drawn marker, not a colliding
// entity, and trading is proximity-based — but it is locked here so a future
// change to the merchant placement cannot silently widen it.
const { villageGatePosts } = require('../src/services/mapService');

const SIZES_TOO_SMALL = new Set(['3x3', '3x4', '4x3']);
const key = (p) => `${p.x},${p.y}`;

test('the merchant never shares a tile with a guard post in any village big enough to separate them', () => {
  const overlapping = [];
  for (let width = 3; width <= 8; width++) {
    for (let height = 3; height <= 6; height++) {
      for (const gateEdge of ['N', 'E', 'S', 'W']) {
        const v = { minRow: 5, minCol: 5, width, height, gateEdge };
        const merchant = villageMerchantPost(v);
        const collides = villageGatePosts(v).some((g) => key(g) === key(merchant));
        const interior = (width - 2) * (height - 2);
        if (collides) {
          overlapping.push(`${width}x${height} ${gateEdge}`);
          assert.ok(interior < 3,
            `${width}x${height} has ${interior} interior tiles — enough to separate merchant and guards, so overlap is a bug`);
        }
      }
    }
  }
  // Only the three known-too-small sizes may overlap at all. (Not every gate
  // edge collides even at those sizes, so the exact count is not asserted —
  // the contract is "overlap implies too small", checked per-case above.)
  const sizes = new Set(overlapping.map((s) => s.split(' ')[0]));
  assert.deepEqual([...sizes].sort(), [...SIZES_TOO_SMALL].sort());
  assert.ok(overlapping.length > 0, 'the known small-village overlap should still be reproduced here');
});

test('the merchant always stands strictly inside the wall ring, for every legal size', () => {
  for (let width = 3; width <= 8; width++) {
    for (let height = 3; height <= 6; height++) {
      for (const gateEdge of ['N', 'E', 'S', 'W']) {
        const v = { minRow: 5, minCol: 5, width, height, gateEdge };
        const { x, y } = villageMerchantPost(v);
        const col = (x - 50) / 100, row = (y - 50) / 100;
        assert.ok(row > v.minRow && row < v.minRow + height - 1,
          `${width}x${height} ${gateEdge}: merchant row ${row} is on the wall ring`);
        assert.ok(col > v.minCol && col < v.minCol + width - 1,
          `${width}x${height} ${gateEdge}: merchant col ${col} is on the wall ring`);
      }
    }
  }
});
