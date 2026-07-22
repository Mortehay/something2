const test = require('node:test');
const assert = require('node:assert');
const { adminToken, isUserLookup, ADMIN_USER_ROW } = require('./helpers/auth.js');
const request = require('supertest');
const { app, __setPool } = require('../src/index.js');

const AUTH = ['Authorization', `Bearer ${adminToken()}`];
function mockPool(handlers) {
  const calls = [];
  return { calls, query: async (sql, params) => {
    if (isUserLookup(sql)) return ADMIN_USER_ROW;
    calls.push({ sql, params });
    for (const [re, fn] of handlers) if (re.test(sql)) return fn(params);
    throw new Error(`unexpected query: ${sql}`);
  } };
}

test('GET /api/worlds/:id/links lists edges', async () => {
  __setPool(mockPool([[/FROM map_links/i, () => ({ rows: [{ edge: 'E', to_world_id: 'B', to_width: 16, to_height: 16 }] })]]));
  const res = await request(app).get('/api/worlds/A/links');
  assert.equal(res.status, 200);
  assert.equal(res.body[0].edge, 'E');
  assert.equal(res.body[0].to_world_id, 'B');
});

test('POST links rejects a bad edge', async () => {
  __setPool(mockPool([]));
  const res = await request(app).post('/api/worlds/A/links').set(...AUTH).send({ edge: 'X', to_world_id: 'B' });
  assert.equal(res.status, 400);
});

test('POST links rejects linking a world to itself', async () => {
  __setPool(mockPool([]));
  const res = await request(app).post('/api/worlds/A/links').set(...AUTH).send({ edge: 'E', to_world_id: 'A' });
  assert.equal(res.status, 400);
});

test('POST links rejects when a target is not bounded', async () => {
  __setPool(mockPool([
    [/SELECT .* FROM worlds WHERE id = \$1/i, (p) => ({ rows: [{ id: p[0], width: p[0] === 'A' ? 24 : null, height: p[0] === 'A' ? 24 : null }] })],
  ]));
  const res = await request(app).post('/api/worlds/A/links').set(...AUTH).send({ edge: 'E', to_world_id: 'B' });
  assert.equal(res.status, 400);
});

test('POST links writes both directions and returns ok', async () => {
  const pool = mockPool([
    [/SELECT .* FROM worlds WHERE id = \$1/i, (p) => ({ rows: [{ id: p[0], width: 24, height: 24 }] })],
    [/INSERT INTO map_links/i, () => ({ rows: [] })],
  ]);
  __setPool(pool);
  const res = await request(app).post('/api/worlds/A/links').set(...AUTH).send({ edge: 'E', to_world_id: 'B' });
  assert.equal(res.status, 200);
  assert.equal(pool.calls.filter(c => /INSERT INTO map_links/i.test(c.sql)).length, 2);
});

test('DELETE links removes the link (204)', async () => {
  const pool = mockPool([
    [/SELECT to_world_id FROM map_links/i, () => ({ rows: [{ to_world_id: 'B' }] })],
    [/DELETE FROM map_links/i, () => ({ rows: [] })],
  ]);
  __setPool(pool);
  const res = await request(app).delete('/api/worlds/A/links/E').set(...AUTH);
  assert.equal(res.status, 204);
});
