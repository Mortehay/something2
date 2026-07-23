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
