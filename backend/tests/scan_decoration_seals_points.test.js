// SOMET-772 review: the seal scanner must check the dungeon boss, the point the
// world-dressing catalog actually sealed (p5-descent d1_end). Pure -- no DB.
const test = require('node:test');
const assert = require('node:assert');
const { arrivalPoints } = require('../scripts/scan-decoration-seals.js');

test('arrivalPoints includes the dungeon boss tile', () => {
  const row = { id: 'w', width: 64, height: 64, dungeon_boss: { x: 5450, y: 4950, entity: 'Boss' } };
  const pts = arrivalPoints(row, [], [], []);
  assert.deepEqual(pts.filter((p) => p.what === 'dungeon boss'), [{ row: 49, col: 54, what: 'dungeon boss' }]);
});

test('a world with no boss gets no boss point', () => {
  assert.equal(arrivalPoints({ id: 'w', width: 64, height: 64 }, [], [], []).filter((p) => p.what === 'dungeon boss').length, 0);
});
