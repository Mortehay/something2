const test = require('node:test');
const assert = require('node:assert');
const { placeMapCreatures } = require('../src/services/mapService');

const TILE = 100;
const allowed = [{ name: 'goblin', hp: 10, defense: 0, resistances: {} }];

function bounded(extra = {}) {
  return {
    seed: 7, chunkSize: 32,
    tileTypes: { grass: { walkable: true }, wooden_wall: { walkable: false }, village_gate: { walkable: true } },
    width: 30, height: 30,
    ...extra,
  };
}

test('placeMapCreatures never places a creature inside a village box', () => {
  const world = bounded({
    villages: [{ id: 'v', minRow: 5, minCol: 5, width: 8, height: 6, gateEdge: 'S', spawnX: 0, spawnY: 0 }],
  });
  const placed = placeMapCreatures(world, 40, allowed, 123, 200);
  for (const c of placed) {
    const gCol = Math.floor(c.x / TILE), gRow = Math.floor(c.y / TILE);
    const inBox = gRow >= 5 && gRow <= 10 && gCol >= 5 && gCol <= 12;
    assert.equal(inBox, false, `creature at (${gRow},${gCol}) is inside the village box`);
  }
  assert.ok(placed.length > 0, 'should still place creatures outside the village');
});

test('with no villages, placement is unchanged (regression)', () => {
  const placed = placeMapCreatures(bounded(), 10, allowed, 123, 200);
  assert.ok(placed.length > 0);
});
