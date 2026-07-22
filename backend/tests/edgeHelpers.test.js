const test = require('node:test');
const assert = require('node:assert');
const { oppositeEdge, edgeOfDoorwayTile, arrivalPoint, chooseSpawn } = require('../src/services/mapService');

test('oppositeEdge flips N<->S and E<->W', () => {
  assert.equal(oppositeEdge('N'), 'S');
  assert.equal(oppositeEdge('S'), 'N');
  assert.equal(oppositeEdge('E'), 'W');
  assert.equal(oppositeEdge('W'), 'E');
});

test('edgeOfDoorwayTile identifies the ring edge (24x24)', () => {
  assert.equal(edgeOfDoorwayTile(0, 12, 24, 24), 'N');
  assert.equal(edgeOfDoorwayTile(23, 12, 24, 24), 'S');
  assert.equal(edgeOfDoorwayTile(12, 0, 24, 24), 'W');
  assert.equal(edgeOfDoorwayTile(12, 23, 24, 24), 'E');
  assert.equal(edgeOfDoorwayTile(5, 5, 24, 24), null); // interior
});

test('arrivalPoint lands one tile inside the arrive edge, player-centered', () => {
  // dest 24x24, arriving via W => col 1, row midRow=12 => center (150,1250) => top-left (118,1218)
  assert.deepEqual(arrivalPoint(24, 24, 'W'), { x: 1 * 100 + 18, y: 12 * 100 + 18 });
  // via E => col width-2=22
  assert.deepEqual(arrivalPoint(24, 24, 'E'), { x: 22 * 100 + 18, y: 12 * 100 + 18 });
  // via N => row 1, col midCol=12
  assert.deepEqual(arrivalPoint(24, 24, 'N'), { x: 12 * 100 + 18, y: 1 * 100 + 18 });
  // via S => row height-2=22
  assert.deepEqual(arrivalPoint(24, 24, 'S'), { x: 12 * 100 + 18, y: 22 * 100 + 18 });
});

test('chooseSpawn: pending arrival wins', () => {
  const s = chooseSpawn({ pending: { x: 111, y: 222 }, persisted: { x: 9, y: 9 },
    worldRow: { width: 24, height: 24 }, chunkSize: 64 });
  assert.deepEqual(s, { x: 111, y: 222, viaDoorway: true });
});

test('chooseSpawn: persisted position when no pending', () => {
  const s = chooseSpawn({ pending: null, persisted: { x: 500, y: 600 },
    worldRow: { width: 24, height: 24 }, chunkSize: 64 });
  assert.deepEqual(s, { x: 500, y: 600, viaDoorway: false });
});

test('chooseSpawn: entry_spawn for a first-join entry world', () => {
  const s = chooseSpawn({ pending: null, persisted: null,
    worldRow: { width: 24, height: 24, is_entry: true, entry_spawn: { x: 1200, y: 1200 } }, chunkSize: 64 });
  assert.deepEqual(s, { x: 1200, y: 1200, viaDoorway: false });
});

test('chooseSpawn: bounded world clamps to interior center (not chunk-center)', () => {
  // 24x24 bounded: interior center tile (12,12) => player top-left (12*100+18)
  const s = chooseSpawn({ pending: null, persisted: null, worldRow: { width: 24, height: 24 }, chunkSize: 64 });
  assert.deepEqual(s, { x: 12 * 100 + 18, y: 12 * 100 + 18, viaDoorway: false });
});

test('chooseSpawn: unbounded world uses chunk-center', () => {
  const s = chooseSpawn({ pending: null, persisted: null, worldRow: { width: null, height: null }, chunkSize: 64 });
  assert.deepEqual(s, { x: (64 * 100) / 2, y: (64 * 100) / 2, viaDoorway: false });
});
