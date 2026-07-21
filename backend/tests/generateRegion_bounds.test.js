// backend/tests/generateRegion_bounds.test.js
const test = require('node:test');
const assert = require('node:assert');
const { generateRegion, worldConfig } = require('../src/services/mapService');

const BIOMES = { grass: {}, forest: {}, water: {}, meadow: {} };

test('worldConfig.bounds is null when unbounded, set when width+height given', () => {
  assert.equal(worldConfig({ seed: 1, tileTypes: BIOMES }).bounds, null);
  const b = worldConfig({ seed: 1, tileTypes: BIOMES, width: 10, height: 10 }).bounds;
  assert.equal(b.width, 10);
  assert.equal(b.wallTile, 'map_wall');
  assert.ok(b.doorways instanceof Set);
});

test('bounded generateRegion walls the boundary; unbounded is unchanged', () => {
  const unbounded = { seed: 5, chunkSize: 12, tileTypes: BIOMES };
  const plain = generateRegion(unbounded, 0, 0, 12, 12);
  assert.ok(!plain.flat().includes('map_wall'), 'unbounded region has no walls');

  const bounded = { seed: 5, chunkSize: 12, tileTypes: BIOMES, width: 12, height: 12 };
  const walled = generateRegion(bounded, 0, 0, 12, 12);
  assert.equal(walled[0][6], 'map_wall');   // north ring
  assert.equal(walled[6][0], 'map_wall');   // west ring
  assert.equal(walled[6][6], plain[6][6]);  // interior identical to unbounded
});

test('a doorway edge produces a passable gap in the ring', () => {
  const bounded = { seed: 5, chunkSize: 12, tileTypes: BIOMES,
    width: 12, height: 12, doorways: ['N'] };
  const g = generateRegion(bounded, 0, 0, 12, 12);
  assert.equal(g[0][6], 'map_doorway'); // mid of width 12 = col 6
  assert.equal(g[0][2], 'map_wall');
});
