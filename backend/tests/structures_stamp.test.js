// SOMET-773: stored ruin stamps reach the tile grid the same way everywhere.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { generateRegion, generateChunk } = require('../src/services/mapService');

const tileTypes = { grass: { walkable: true }, earth: { walkable: true }, map_wall: { walkable: false }, map_doorway: { walkable: true }, mossy_wall: { walkable: false }, rubble_floor: { walkable: true } };
const base = { seed: 7, chunkSize: 8, width: 24, height: 24, tileTypes, noGeneratedRoads: true };
const RUIN = { type: 'overgrown_hut', minRow: 6, minCol: 6, width: 4, height: 3, wallTile: 'mossy_wall', floorTile: 'rubble_floor', gaps: [[6, 7], [8, 9]], source: 'auto' };

test('a stamp draws its ring as wall, its gaps and interior as floor', () => {
  const g = generateRegion({ ...base, structures: [RUIN] }, 0, 0, 24, 24);
  assert.equal(g[6][6], 'mossy_wall');   // corner
  assert.equal(g[6][7], 'rubble_floor'); // gap on the north edge
  assert.equal(g[8][9], 'rubble_floor'); // gap on the south-east corner
  assert.equal(g[8][6], 'mossy_wall');
  assert.equal(g[7][7], 'rubble_floor'); // interior
  assert.equal(g[7][8], 'rubble_floor');
});

test('cells outside the stamp are untouched, and no structures means no change', () => {
  const bare = generateRegion(base, 0, 0, 24, 24);
  const withRuin = generateRegion({ ...base, structures: [RUIN] }, 0, 0, 24, 24);
  for (let r = 0; r < 24; r++) for (let c = 0; c < 24; c++) {
    const inside = r >= 6 && r <= 8 && c >= 6 && c <= 9;
    if (!inside) assert.equal(withRuin[r][c], bare[r][c], `${r},${c}`);
  }
  assert.deepEqual(generateRegion({ ...base, structures: [] }, 0, 0, 24, 24), bare);
});

test('a stamp straddling a chunk seam is identical chunk by chunk and as one region', () => {
  const w = { ...base, structures: [{ ...RUIN, minRow: 6, minCol: 6 }] }; // cols 6..9 cross the 8-col seam
  const region = generateRegion(w, 0, 0, 16, 16);
  const left = generateChunk(w, 0, 0), right = generateChunk(w, 1, 0);
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) assert.equal(left[r][c], region[r][c]);
    for (let c = 0; c < 8; c++) assert.equal(right[r][c], region[r][c + 8]);
  }
});

test('a malformed stored stamp is loud, not silently skipped', () => {
  assert.throws(() => generateRegion({ ...base, structures: [{ ...RUIN, width: 'four' }] }, 0, 0, 8, 8), /structure/i);
});

test('the authority loads the structures column (parity with every SELECT * site)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/authority/server.js'), 'utf8');
  const sel = src.split('\n').find((l) => /SELECT id, name, seed, chunk_size/.test(l));
  assert.ok(sel, 'authority world SELECT not found');
  assert.match(sel, /\bstructures\b/);
});
