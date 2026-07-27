const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { app, __setPool } = require('../src/index.js');

function poolWith(tileRows, entityRows) {
  return {
    query: async (sql) => {
      if (/FROM tile_types/i.test(sql)) return { rows: tileRows };
      if (/FROM entity_types/i.test(sql)) return { rows: entityRows };
      return { rows: [] };
    },
  };
}

test('/api/map/tiles exposes wall_height and place_order (with a wall value and a defaulted one)', async () => {
  __setPool(poolWith(
    [
      { id: 1, name: 'map_wall', color: '#888', walkable: false, speed: 1, wall_height: 48, place_order: 0 },
      { id: 2, name: 'grass', color: '#3a5', walkable: true, speed: 1 }, // no wall fields -> default 0
    ],
    [],
  ));
  const res = await request(app).get('/api/map/tiles');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.map_wall.wall_height, 48);
  assert.strictEqual(res.body.map_wall.place_order, 0);
  assert.strictEqual(res.body.grass.wall_height, 0);   // defaulted
  assert.strictEqual(res.body.grass.place_order, 0);
});

test('/api/map/config exposes entity place_order defaulting to 0', async () => {
  __setPool(poolWith(
    [],
    [{ id: 1, name: 'Wolf', color: '#777', walkable: true, place_order: 5 },
     { id: 2, name: 'Slime', color: '#5a5' }], // no place_order -> default 0
  ));
  const res = await request(app).get('/api/map/config');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.entityTypes.Wolf.place_order, 5);
  assert.strictEqual(res.body.entityTypes.Slime.place_order, 0);
});
