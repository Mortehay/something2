const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { adminToken, withAuth } = require('./helpers/auth.js');
const { app, __setPool } = require('../src/index.js');

const AUTH = ['Authorization', `Bearer ${adminToken()}`];

test('GET /api/world-point-kinds lists kinds with their default name', async () => {
  __setPool({
    query: withAuth(async (sql) => {
      assert.match(sql, /FROM world_point_kinds/i);
      assert.match(sql, /LEFT JOIN entity_types/i);
      return { rows: [
        { kind: 'portal', default_entity_type_id: 7, default_name: 'portal' },
        { kind: 'waypoint', default_entity_type_id: null, default_name: null },
      ] };
    }),
  });
  const res = await request(app).get('/api/world-point-kinds');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, [
    { kind: 'portal', default_entity_type_id: 7, default_name: 'portal' },
    { kind: 'waypoint', default_entity_type_id: null, default_name: null },
  ]);
});

test('PUT /api/world-point-kinds/:kind rejects a type of another kind', async () => {
  __setPool({
    query: withAuth(async (sql) => {
      if (/SELECT point_kind FROM entity_types WHERE id/i.test(sql)) return { rows: [{ point_kind: 'bank' }] };
      throw new Error(`unexpected query: ${sql}`);
    }),
  });
  const res = await request(app).put('/api/world-point-kinds/portal').set(...AUTH)
    .send({ default_entity_type_id: 9 });
  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /point_kind "bank".*kind "portal"/);
});

test('PUT /api/world-point-kinds/:kind writes the default and returns the row', async () => {
  const updates = [];
  __setPool({
    query: withAuth(async (sql, params) => {
      if (/SELECT point_kind FROM entity_types WHERE id/i.test(sql)) return { rows: [{ point_kind: 'portal' }] };
      if (/UPDATE world_point_kinds/i.test(sql)) {
        updates.push(params);
        return { rows: [{ kind: 'portal', default_entity_type_id: 9, default_name: 'stone_gate' }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    }),
  });
  const res = await request(app).put('/api/world-point-kinds/portal').set(...AUTH)
    .send({ default_entity_type_id: 9 });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(updates, [[9, 'portal']]);
  assert.strictEqual(res.body.default_name, 'stone_gate');
});

test('PUT /api/world-point-kinds/:kind 404s an unknown kind', async () => {
  __setPool({
    query: withAuth(async (sql) => {
      if (/SELECT point_kind FROM entity_types WHERE id/i.test(sql)) return { rows: [{ point_kind: 'portal' }] };
      if (/UPDATE world_point_kinds/i.test(sql)) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    }),
  });
  const res = await request(app).put('/api/world-point-kinds/portal').set(...AUTH)
    .send({ default_entity_type_id: 9 });
  assert.strictEqual(res.status, 404);
});

test('PUT /api/world-point-kinds/:kind with null clears the default without a type lookup', async () => {
  const updates = [];
  __setPool({
    query: withAuth(async (sql, params) => {
      if (/UPDATE world_point_kinds/i.test(sql)) {
        updates.push(params);
        return { rows: [{ kind: 'portal', default_entity_type_id: null, default_name: null }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    }),
  });
  const res = await request(app).put('/api/world-point-kinds/portal').set(...AUTH)
    .send({ default_entity_type_id: null });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(updates, [[null, 'portal']]);
});
