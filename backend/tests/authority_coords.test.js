const test = require('node:test');
const assert = require('node:assert');
const { chunkOf, CHUNK_KEY, parseKey, neighborhoodKeys } = require('../src/authority/coords.js');

test('chunkOf maps world px to chunk coords with floor for negatives', () => {
  // chunkSize 8 → chunk spans 800 world px. (50,50)→tile(0,0)→chunk(0,0).
  assert.deepEqual(chunkOf(50, 50, 8), { cx: 0, cy: 0 });
  // (-50,-50)→tile(-1,-1)→chunk(-1,-1).
  assert.deepEqual(chunkOf(-50, -50, 8), { cx: -1, cy: -1 });
  // (850, 10)→tile(8,0)→chunk(1,0).
  assert.deepEqual(chunkOf(850, 10, 8), { cx: 1, cy: 0 });
});

test('CHUNK_KEY / parseKey round-trip incl. negatives', () => {
  assert.equal(CHUNK_KEY(-2, 3), '-2,3');
  assert.deepEqual(parseKey('-2,3'), { cx: -2, cy: 3 });
});

test('neighborhoodKeys returns the 3x3 ring around a chunk', () => {
  const keys = neighborhoodKeys(0, 0, 1).sort();
  assert.equal(keys.length, 9);
  assert.ok(keys.includes('0,0'));
  assert.ok(keys.includes('-1,-1'));
  assert.ok(keys.includes('1,1'));
});
