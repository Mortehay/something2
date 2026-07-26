// backend/tests/mapService_overview.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const { overviewOrigin, generateWorldOverview } = require('../src/services/mapService');

const TILES = { grass: { color: '#3a5' }, water: { color: '#25a' }, map_wall: { color: '#333' }, map_doorway: { color: '#fa0' } };

test('overviewOrigin snaps center to a span/4 grid and centers the window', () => {
  const span = 256; // snap grid = span/4 = 64; round(100/64)=2 -> snapped 128
  const o = overviewOrigin(100, 100, span);
  assert.strictEqual(o.snappedCol, 128);
  assert.strictEqual(o.snappedRow, 128);
  assert.strictEqual(o.originCol, 128 - 128); // snapped - span/2
  assert.strictEqual(o.originRow, 0);
});

test('generateWorldOverview downsamples: tiles[r][c] == world tile at origin + r/c*step', () => {
  const world = { seed: 7, chunkSize: 64, tileTypes: TILES };
  const span = 256, step = 4;
  const ov = generateWorldOverview(world, 0, 0, span, step);
  assert.strictEqual(ov.step, step);
  assert.strictEqual(ov.rows, span / step);
  assert.strictEqual(ov.cols, span / step);
  // Re-derive one cell straight from generateRegion and compare.
  const { generateRegion } = require('../src/services/mapService');
  const expected = generateRegion(world, ov.originRow + 5 * step, ov.originCol + 3 * step, 1, 1)[0][0];
  assert.strictEqual(ov.tiles[5][3], expected);
});

test('generateWorldOverview emits doorway + village markers in global tile coords', () => {
  const world = {
    seed: 1, chunkSize: 64, tileTypes: TILES,
    width: 40, height: 20, doorways: ['N', 'E'],
    villages: [{ minRow: 4, minCol: 6, width: 4, height: 4 }],
  };
  const ov = generateWorldOverview(world, 20, 10, 256, 4);
  assert.deepStrictEqual(ov.doorways.find(d => d.edge === 'N'), { edge: 'N', col: 20, row: 0 });
  assert.deepStrictEqual(ov.doorways.find(d => d.edge === 'E'), { edge: 'E', col: 39, row: 10 });
  assert.deepStrictEqual(ov.villages[0], { col: 8, row: 6 });
});

test('generateWorldOverview yields no doorways for an unbounded world', () => {
  const world = { seed: 1, chunkSize: 64, tileTypes: TILES, doorways: ['N'] };
  const ov = generateWorldOverview(world, 0, 0, 256, 4);
  assert.deepStrictEqual(ov.doorways, []);
});
