// backend/tests/stampVillage.test.js
const test = require('node:test');
const assert = require('node:assert');
const { stampVillage, pointInVillageBox, villageContaining } = require('../src/services/mapService');

function fill(rows, cols, v = 'grass') {
  const g = [];
  for (let r = 0; r < rows; r++) g.push(new Array(cols).fill(v));
  return g;
}
const V = (over = {}) => ({
  minRow: 2, minCol: 2, width: 5, height: 4, gateEdge: 'S',
  wallTile: 'wooden_wall', gateTile: 'village_gate', ...over,
});

test('stampVillage walls the box perimeter and leaves the interior untouched', () => {
  const g = fill(12, 12);
  stampVillage(g, 0, 0, 12, 12, V());        // box rows 2..5, cols 2..6
  assert.equal(g[2][2], 'wooden_wall');       // top-left corner
  assert.equal(g[2][6], 'wooden_wall');       // top-right corner
  assert.equal(g[5][2], 'wooden_wall');       // bottom-left corner
  assert.equal(g[3][3], 'grass');             // interior untouched
  assert.equal(g[3][5], 'grass');             // interior untouched
  assert.equal(g[0][0], 'grass');             // outside untouched
});

test('the gate edge carves a single passable gate tile centered on that edge', () => {
  const g = fill(12, 12);
  stampVillage(g, 0, 0, 12, 12, V({ gateEdge: 'S' }));   // width 5 -> gate col = 2 + floor(5/2) = 4
  assert.equal(g[5][4], 'village_gate');
  assert.equal(g[5][3], 'wooden_wall');
  assert.equal(g[5][5], 'wooden_wall');
});

test('gate on the W edge is centered vertically', () => {
  const g = fill(12, 12);
  stampVillage(g, 0, 0, 12, 12, V({ gateEdge: 'W' }));    // height 4 -> gate row = 2 + floor(4/2) = 4
  assert.equal(g[4][2], 'village_gate');
  assert.equal(g[3][2], 'wooden_wall');
});

test('stampVillage respects the chunk window offset (rMin/cMin)', () => {
  const g = fill(6, 6);                        // chunk covering global rows 2..7, cols 2..7
  stampVillage(g, 2, 2, 6, 6, V());            // box global rows 2..5, cols 2..6
  assert.equal(g[0][0], 'wooden_wall');        // global (2,2) = box corner
  assert.equal(g[1][1], 'grass');              // global (3,3) = interior
});

test('pointInVillageBox and villageContaining', () => {
  const v = V();                               // rows 2..5, cols 2..6
  assert.equal(pointInVillageBox(3, 3, v), true);
  assert.equal(pointInVillageBox(2, 2, v), true);   // on the ring counts as inside the box
  assert.equal(pointInVillageBox(6, 3, v), false);
  const villages = [V({ id: 'a' }), V({ id: 'b', minRow: 20, minCol: 20 })];
  assert.equal(villageContaining(3, 3, villages).id, 'a');
  assert.equal(villageContaining(21, 21, villages).id, 'b');
  assert.equal(villageContaining(50, 50, villages), null);
});
