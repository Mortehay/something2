const test = require('node:test');
const assert = require('node:assert');
const { boundedCacheSet } = require('../src/index.js');

test('boundedCacheSet keeps all entries when count === max', () => {
  const map = new Map();
  for (let i = 0; i < 5; i += 1) boundedCacheSet(map, `k${i}`, i, 5);
  assert.strictEqual(map.size, 5);
  for (let i = 0; i < 5; i += 1) assert.strictEqual(map.get(`k${i}`), i);
});

test('boundedCacheSet evicts the oldest entries once over max (FIFO)', () => {
  const map = new Map();
  const max = 5;
  for (let i = 0; i < max + 3; i += 1) boundedCacheSet(map, `k${i}`, i, max);
  assert.strictEqual(map.size, max);
  // the 3 oldest keys (k0, k1, k2) should be gone
  assert.strictEqual(map.has('k0'), false);
  assert.strictEqual(map.has('k1'), false);
  assert.strictEqual(map.has('k2'), false);
  // the newest `max` keys remain
  for (let i = 3; i < max + 3; i += 1) {
    assert.strictEqual(map.has(`k${i}`), true);
    assert.strictEqual(map.get(`k${i}`), i);
  }
});

test('boundedCacheSet re-setting an existing key updates in place without eviction', () => {
  const map = new Map();
  const max = 3;
  boundedCacheSet(map, 'a', 1, max);
  boundedCacheSet(map, 'b', 2, max);
  boundedCacheSet(map, 'c', 3, max);
  assert.strictEqual(map.size, 3);
  // re-set an existing key: value updates, size stays at the live-set size
  boundedCacheSet(map, 'a', 100, max);
  assert.strictEqual(map.size, 3);
  assert.strictEqual(map.get('a'), 100);
  assert.strictEqual(map.has('b'), true);
  assert.strictEqual(map.has('c'), true);
});
