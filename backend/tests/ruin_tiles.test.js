// SOMET-773: the six ruin tiles. Appended (tile order is id order, and
// detectPathTile picks the FIRST name matching PATH_NAME_RE), never named like
// a path, walls blocking with a wall_height, floors walkable.
const test = require('node:test');
const assert = require('node:assert');
const { DEFAULT_TILE_TYPES } = require('../seeds/data/tileTypes.js');

const PATH_NAME_RE = /path|dirt|road|trail|earth|sand/i;
const byName = new Map(DEFAULT_TILE_TYPES.map((t, i) => [t.name, { ...t, i }]));
const WALLS = { ruined_wall: 32, burnt_wall: 32, mossy_wall: 32, weathered_wall: 24 };
const FLOORS = ['rubble_floor', 'charred_floor'];

test('ruin walls block and carry a wall height', () => {
  for (const [n, h] of Object.entries(WALLS)) {
    const t = byName.get(n);
    assert.ok(t, `${n} missing`);
    assert.equal(t.walkable, false, n);
    assert.equal(t.wall_height, h, n);
  }
});

test('ruin floors are walkable ground', () => {
  for (const n of FLOORS) {
    const t = byName.get(n);
    assert.ok(t, `${n} missing`);
    assert.equal(t.walkable, true, n);
    assert.ok(!t.wall_height, n);
  }
});

test('no ruin tile can be mistaken for the path tile, and all are appended last', () => {
  const last = byName.get('road_ash').i;
  for (const n of [...Object.keys(WALLS), ...FLOORS]) {
    assert.doesNotMatch(n, PATH_NAME_RE, n);
    assert.ok(byName.get(n).i > last, `${n} must come after road_ash`);
    assert.ok(byName.get(n).prompt.length > 20, `${n} prompt`);
  }
});
