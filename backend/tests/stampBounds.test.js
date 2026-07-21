const test = require('node:test');
const assert = require('node:assert');
const { stampBounds, DOORWAY_TILES } = require('../src/services/mapService');

// Build a rows x cols grid of a sentinel biome, absolute origin (rMin,cMin).
function fill(rMin, cMin, rows, cols, v = 'grass') {
  const g = [];
  for (let r = 0; r < rows; r++) g.push(new Array(cols).fill(v));
  return g;
}
const BOUNDS = (doorways) => ({
  width: 10, height: 10, wallTile: 'map_wall', doorwayTile: 'map_doorway',
  doorways: new Set(doorways),
});

test('DOORWAY_TILES is 3', () => assert.equal(DOORWAY_TILES, 3));

test('boundary ring becomes wall, interior untouched', () => {
  const g = fill(0, 0, 10, 10);
  stampBounds(g, 0, 0, 10, 10, BOUNDS([]));
  assert.equal(g[0][5], 'map_wall');   // north ring
  assert.equal(g[9][5], 'map_wall');   // south ring
  assert.equal(g[5][0], 'map_wall');   // west ring
  assert.equal(g[5][9], 'map_wall');   // east ring
  assert.equal(g[5][5], 'grass');      // interior unchanged
});

test('cells outside [0,width)x[0,height) become wall', () => {
  // Window starts one tile north/west of the origin.
  const g = fill(-1, -1, 3, 3);
  stampBounds(g, -1, -1, 3, 3, BOUNDS([]));
  assert.equal(g[0][0], 'map_wall');   // (-1,-1) outside
  assert.equal(g[0][1], 'map_wall');   // (-1,0) outside (north of row 0)
  assert.equal(g[1][1], 'map_wall');   // (0,0) corner ring
});

test('a doorway edge carves a centered 3-tile passable gap', () => {
  const g = fill(0, 0, 10, 10);
  stampBounds(g, 0, 0, 10, 10, BOUNDS(['N']));
  // width=10 -> mid col = 5, halfGap=1 -> cols 4,5,6 are doorway on row 0.
  assert.equal(g[0][4], 'map_doorway');
  assert.equal(g[0][5], 'map_doorway');
  assert.equal(g[0][6], 'map_doorway');
  assert.equal(g[0][3], 'map_wall');   // just outside the gap
  assert.equal(g[0][7], 'map_wall');
  assert.equal(g[9][5], 'map_wall');   // south edge has no doorway
});

test('a window fully interior is left unchanged', () => {
  const g = fill(3, 3, 4, 4);
  stampBounds(g, 3, 3, 4, 4, BOUNDS(['N', 'E', 'S', 'W']));
  for (const row of g) for (const v of row) assert.equal(v, 'grass');
});
