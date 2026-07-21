const test = require('node:test');
const assert = require('node:assert');
const { doorwaysForWorld } = require('../src/services/mapService');

test('unbounded world has no doorways', () => {
  assert.equal(doorwaysForWorld({ width: null, height: null }).size, 0);
});

test('bounded world defaults to a doorway on every edge (Slice 1)', () => {
  const d = doorwaysForWorld({ width: 20, height: 20 });
  assert.deepEqual([...d].sort(), ['E', 'N', 'S', 'W']);
});
