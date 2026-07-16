const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { app, __setPool } = require('../src/index.js');

// A pool mock whose query() dispatches on the SQL text. `handlers` is an array
// of [regex, (params) => ({ rows }|Promise)] pairs, tried in order.
function mockPool(handlers) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      for (const [re, fn] of handlers) {
        if (re.test(sql)) return fn(params);
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

test('POST /api/worlds rejects a missing name', async () => {
  __setPool(mockPool([]));
  const res = await request(app).post('/api/worlds').send({ seed: 5 });
  assert.equal(res.status, 400);
});

test('POST /api/worlds creates and returns the row', async () => {
  __setPool(mockPool([
    [/INSERT INTO worlds/i, (p) => ({
      rows: [{ id: 'w1', name: p[0], seed: String(p[1]), chunk_size: p[2] }],
    })],
  ]));
  const res = await request(app)
    .post('/api/worlds')
    .send({ name: 'Test World', seed: 42, chunk_size: 32 });
  assert.equal(res.status, 201);
  assert.equal(res.body.id, 'w1');
  assert.equal(res.body.name, 'Test World');
  assert.equal(res.body.chunk_size, 32);
});

test('GET /api/worlds lists worlds', async () => {
  __setPool(mockPool([
    [/FROM worlds/i, () => ({ rows: [{ id: 'w1', name: 'A' }, { id: 'w2', name: 'B' }] })],
  ]));
  const res = await request(app).get('/api/worlds');
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 2);
});

test('GET /api/worlds/:id returns 404 when absent', async () => {
  __setPool(mockPool([
    [/FROM worlds WHERE id/i, () => ({ rows: [] })],
  ]));
  const res = await request(app).get('/api/worlds/nope');
  assert.equal(res.status, 404);
});
