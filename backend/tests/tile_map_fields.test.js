const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { app, __setPool } = require('../src/index.js');

// GET /api/map/tiles is a public passthrough of getTileTypesMap — no auth.
function mockPool(rows) {
  return { query: async () => ({ rows }) };
}

test('GET /api/map/tiles exposes sprite and render_mode per tile', async () => {
  __setPool(mockPool([
    { id: 1, name: 'grass', color: '#0f0', walkable: true, speed: 1,
      image: 'sprites/tiles/grass/static.png', valid_neighbors: ['grass'],
      sprite: null, render_mode: 'image' },
    { id: 2, name: 'water', color: '#00f', walkable: false, speed: 0,
      image: '', valid_neighbors: ['water'],
      sprite: { atlas_key: 'sprites/tiles/water/atlas.png', manifest_key: 'sprites/tiles/water/atlas.json', frames: 4 },
      render_mode: 'animated' },
  ]));
  const res = await request(app).get('/api/map/tiles');
  assert.equal(res.status, 200);
  assert.equal(res.body.grass.render_mode, 'image');
  assert.equal(res.body.grass.image, 'sprites/tiles/grass/static.png');
  assert.equal(res.body.grass.sprite, null);
  assert.equal(res.body.water.render_mode, 'animated');
  assert.deepEqual(res.body.water.sprite, { atlas_key: 'sprites/tiles/water/atlas.png', manifest_key: 'sprites/tiles/water/atlas.json', frames: 4 });
});

// Generated asset keys are stable (approving overwrites static.png in place)
// and /api/assets sends max-age=300, so the client versions its asset URLs by
// updated_at. Withhold it and an approved regeneration keeps rendering the old
// art for five minutes — observed in the browser before this was exposed.
test('GET /api/map/tiles exposes updated_at so the client can bust asset caches', async () => {
  __setPool(mockPool([
    { id: 1, name: 'grass', color: '#0f0', walkable: true, speed: 1,
      image: 'sprites/tiles/grass/static.png', valid_neighbors: [], sprite: null,
      render_mode: 'image', updated_at: '2026-07-24T07:56:33.714Z' },
  ]));
  const res = await request(app).get('/api/map/tiles');
  assert.equal(res.status, 200);
  assert.equal(res.body.grass.updated_at, '2026-07-24T07:56:33.714Z');
});

test('GET /api/map/config exposes updated_at on entity types too', async () => {
  __setPool(mockPool([
    { id: 3, name: 'Wolf', color: '#888', spawn_tiles: [], valid_neighbors: [],
      image: 'sprites/objects/Wolf/static.png', sprite: null, render_mode: 'static',
      updated_at: '2026-07-24T08:10:00.000Z' },
  ]));
  const res = await request(app).get('/api/map/config');
  assert.equal(res.status, 200);
  assert.equal(res.body.entityTypes.Wolf.updated_at, '2026-07-24T08:10:00.000Z');
});
