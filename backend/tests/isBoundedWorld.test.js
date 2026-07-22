const test = require('node:test');
const assert = require('node:assert');
const { isBoundedWorld } = require('../src/services/mapService');

test('true only when both width and height are set', () => {
  assert.equal(isBoundedWorld({ width: 24, height: 24 }), true);
  assert.equal(isBoundedWorld({ width: 24, height: null }), false);
  assert.equal(isBoundedWorld({ width: null, height: 24 }), false);
  assert.equal(isBoundedWorld({}), false);
  assert.equal(isBoundedWorld(null), false);
  assert.equal(isBoundedWorld(undefined), false);
});

test('zero is treated as unbounded (falsy)', () => {
  assert.equal(isBoundedWorld({ width: 0, height: 0 }), false);
});
