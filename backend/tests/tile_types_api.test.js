const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { adminToken, isUserLookup, ADMIN_USER_ROW } = require('./helpers/auth.js');
const { app, __setPool } = require('../src/index.js');

const AUTH = ['Authorization', `Bearer ${adminToken()}`];

// SQL-text-dispatch pool mock; auth's user lookup answered with an admin row.
function mockPool(handlers) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      if (isUserLookup(sql)) return ADMIN_USER_ROW;
      calls.push({ sql, params });
      for (const [re, fn] of handlers) if (re.test(sql)) return fn(params);
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

test('POST /api/tile-types sends prompt as INSERT param $7 and echoes it', async () => {
  const pool = mockPool([
    [/INSERT INTO tile_types/i, (p) => ({ rows: [{ id: 1, name: 'lava', prompt: p[6] }] })],
  ]);
  __setPool(pool);
  const res = await request(app).post('/api/tile-types').set(...AUTH).send({
    name: 'lava', color: '#f00', walkable: false, speed: 0,
    valid_neighbors: [], prompt: 'molten glowing lava',
  });
  assert.equal(res.status, 201);
  const call = pool.calls.find((c) => /INSERT INTO tile_types/i.test(c.sql));
  assert.equal(call.params[6], 'molten glowing lava', 'prompt must be INSERT $7');
  assert.equal(res.body.prompt, 'molten glowing lava');
});

test('PUT /api/tile-types/:id sends prompt as UPDATE param $7 and id as $8', async () => {
  const pool = mockPool([
    [/UPDATE tile_types/i, (p) => ({ rows: [{ id: Number(p[7]), name: p[0], prompt: p[6] }] })],
  ]);
  __setPool(pool);
  const res = await request(app).put('/api/tile-types/9').set(...AUTH).send({
    name: 'grass', color: '#0f0', walkable: true, speed: 1,
    image: '', valid_neighbors: ['grass'], prompt: 'edited meadow grass',
  });
  assert.equal(res.status, 200);
  const call = pool.calls.find((c) => /UPDATE tile_types/i.test(c.sql));
  assert.equal(call.params[6], 'edited meadow grass', 'prompt must be UPDATE $7');
  assert.equal(String(call.params[7]), '9', 'id must be UPDATE $8');
  assert.equal(res.body.prompt, 'edited meadow grass');
});

test('POST defaults prompt to empty string when omitted', async () => {
  const pool = mockPool([
    [/INSERT INTO tile_types/i, (p) => ({ rows: [{ id: 2, prompt: p[6] }] })],
  ]);
  __setPool(pool);
  const res = await request(app).post('/api/tile-types').set(...AUTH).send({
    name: 'plain', color: '#111',
  });
  assert.equal(res.status, 201);
  const call = pool.calls.find((c) => /INSERT INTO tile_types/i.test(c.sql));
  assert.equal(call.params[6], '', 'missing prompt must default to empty string');
});
