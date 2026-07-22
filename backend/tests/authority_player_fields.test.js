const test = require('node:test');
const assert = require('node:assert');
const { World } = require('../src/authority/world');
const { ServerMap } = require('../src/authority/collision');

test('addPlayer initializes the doorway cooldown', () => {
  const map = new ServerMap({ seed: 1, chunkSize: 8, tileTypes: { grass: { walkable: true, speed: 1 } } });
  const world = new World(map, new Map(), null, 8);
  world.addPlayer('u1', { x: 100, y: 100 });
  assert.equal(world.getPlayer('u1')._doorwayCdUntil, 0);
});
