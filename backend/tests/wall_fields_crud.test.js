// backend/tests/wall_fields_crud.test.js
// IMPORTANT: require the auth helper FIRST — it sets JWT_SECRET before index.js
// loads (mirrors catalogNameLength.test.js / mapsGenerateRoute.test.js).
const { adminToken, withAuth } = require('./helpers/auth.js');
const { app, __setPool } = require('../src/index.js');
const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const AUTH = ['Authorization', `Bearer ${adminToken()}`];

test('POST /api/tile-types persists wall_height and place_order', async () => {
  let captured = null;
  // withAuth answers the adminGuard user lookup; the INSERT falls through here.
  __setPool({ query: withAuth(async (sql, params) => { captured = { sql, params }; return { rows: [{ id: 9 }] }; }) });
  const res = await request(app).post('/api/tile-types').set(...AUTH)
    .send({ name: 'brickwall', color: '#987', walkable: false, speed: 1, wall_height: 60, place_order: 2 });
  assert.strictEqual(res.status, 201);
  assert.match(captured.sql, /wall_height/);
  assert.match(captured.sql, /place_order/);
  assert.ok(captured.params.includes(60));
  assert.ok(captured.params.includes(2));
});

test('PUT /api/tile-types/:id persists wall_height and place_order', async () => {
  let captured = null;
  __setPool({
    query: withAuth(async (sql, params) => {
      // name is unchanged ('brickwall' -> 'brickwall'), so the rename guard's
      // reference checks are skipped and only the UPDATE itself is captured.
      if (/SELECT name FROM tile_types WHERE id/i.test(sql)) return { rows: [{ name: 'brickwall' }] };
      captured = { sql, params };
      return { rows: [{ id: 9 }] };
    }),
  });
  const res = await request(app).put('/api/tile-types/9').set(...AUTH)
    .send({ name: 'brickwall', color: '#987', walkable: false, speed: 1, wall_height: 60, place_order: 2 });
  assert.strictEqual(res.status, 200);
  assert.match(captured.sql, /wall_height/);
  assert.match(captured.sql, /place_order/);
  assert.ok(captured.params.includes(60));
  assert.ok(captured.params.includes(2));
});

test('POST /api/entity-types persists place_order', async () => {
  let captured = null;
  __setPool({ query: withAuth(async (sql, params) => { captured = { sql, params }; return { rows: [{ id: 9 }] }; }) });
  const res = await request(app).post('/api/entity-types').set(...AUTH)
    .send({ name: 'goblin', color: '#0f0', place_order: 3 });
  assert.strictEqual(res.status, 201);
  assert.match(captured.sql, /place_order/);
  assert.ok(captured.params.includes(3));
});

test('PUT /api/entity-types/:id persists place_order', async () => {
  let captured = null;
  __setPool({
    query: withAuth(async (sql, params) => {
      if (/SELECT name FROM entity_types/i.test(sql)) return { rows: [{ name: 'goblin' }] };
      captured = { sql, params };
      return { rows: [{ id: 9 }] };
    }),
  });
  const res = await request(app).put('/api/entity-types/9').set(...AUTH)
    .send({ name: 'goblin', color: '#0f0', place_order: 3 });
  assert.strictEqual(res.status, 200);
  assert.match(captured.sql, /place_order/);
  assert.ok(captured.params.includes(3));
});
