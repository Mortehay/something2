const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { app, __setPool } = require('../src/index.js');

test('POST /api/entity-types defaults render_mode to rect', async () => {
  let params = null;
  __setPool({ query: async (_sql, p) => { params = p; return { rows: [{ id: 1 }] }; } });

  const res = await request(app).post('/api/entity-types').send({ name: 'Bush', color: '#0f0' });

  assert.equal(res.status, 201);
  // render_mode is the last INSERT parameter.
  assert.equal(params[params.length - 1], 'rect');
});

test('POST /api/entity-types passes an explicit render_mode', async () => {
  let params = null;
  __setPool({ query: async (_sql, p) => { params = p; return { rows: [{ id: 1 }] }; } });

  const res = await request(app)
    .post('/api/entity-types')
    .send({ name: 'Tree', color: '#0f0', render_mode: 'static' });

  assert.equal(res.status, 201);
  assert.equal(params[params.length - 1], 'static');
});

test('PUT /api/entity-types/:id passes render_mode (before the id param)', async () => {
  let params = null;
  __setPool({ query: async (_sql, p) => { params = p; return { rows: [{ id: 5 }] }; } });

  const res = await request(app)
    .put('/api/entity-types/5')
    .send({ name: 'Tree', color: '#0f0', render_mode: 'animated' });

  assert.equal(res.status, 200);
  assert.equal(params[params.length - 2], 'animated'); // render_mode
  assert.equal(params[params.length - 1], '5');         // id
});
