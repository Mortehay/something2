const test = require('node:test');
const assert = require('node:assert');
const { adminToken, withAuth } = require('./helpers/auth.js');
const request = require('supertest');

const { app, __setPool } = require('../src/index.js');

// entity-types mutations are behind requireAdmin; carry an admin token and let
// withAuth() answer the guard's user lookup so the captured params reflect the
// route's own INSERT/UPDATE.
const AUTH = ['Authorization', `Bearer ${adminToken()}`];

test('POST /api/entity-types defaults render_mode to rect', async () => {
  let params = null;
  __setPool({ query: withAuth(async (_sql, p) => { params = p; return { rows: [{ id: 1 }] }; }) });

  const res = await request(app).post('/api/entity-types').set(...AUTH).send({ name: 'Bush', color: '#0f0' });

  assert.equal(res.status, 201);
  // render_mode is the second-to-last INSERT parameter (is_creature is last).
  assert.equal(params[params.length - 2], 'rect');
});

test('POST /api/entity-types passes an explicit render_mode', async () => {
  let params = null;
  __setPool({ query: withAuth(async (_sql, p) => { params = p; return { rows: [{ id: 1 }] }; }) });

  const res = await request(app)
    .post('/api/entity-types')
    .set(...AUTH)
    .send({ name: 'Tree', color: '#0f0', render_mode: 'static' });

  assert.equal(res.status, 201);
  assert.equal(params[params.length - 2], 'static');
});

test('PUT /api/entity-types/:id passes render_mode (before is_creature and the id param)', async () => {
  let params = null;
  __setPool({ query: withAuth(async (_sql, p) => { params = p; return { rows: [{ id: 5 }] }; }) });

  const res = await request(app)
    .put('/api/entity-types/5')
    .set(...AUTH)
    .send({ name: 'Tree', color: '#0f0', render_mode: 'animated' });

  assert.equal(res.status, 200);
  assert.equal(params[params.length - 3], 'animated'); // render_mode
  assert.equal(params[params.length - 2], false);       // is_creature default
  assert.equal(params[params.length - 1], '5');         // id
});

test('POST /api/entity-types defaults is_creature to false', async () => {
  let params = null;
  __setPool({ query: withAuth(async (_sql, p) => { params = p; return { rows: [{ id: 1 }] }; }) });

  const res = await request(app).post('/api/entity-types').set(...AUTH).send({ name: 'Bush', color: '#0f0' });

  assert.equal(res.status, 201);
  // is_creature is the last INSERT parameter.
  assert.equal(params[params.length - 1], false);
});

test('POST /api/entity-types passes an explicit is_creature', async () => {
  let params = null;
  __setPool({ query: withAuth(async (_sql, p) => { params = p; return { rows: [{ id: 1 }] }; }) });

  const res = await request(app)
    .post('/api/entity-types')
    .set(...AUTH)
    .send({ name: 'Wolf', color: '#0f0', is_creature: true });

  assert.equal(res.status, 201);
  assert.equal(params[params.length - 1], true);
});

test('PUT /api/entity-types/:id passes is_creature (before the id param)', async () => {
  let params = null;
  __setPool({ query: withAuth(async (_sql, p) => { params = p; return { rows: [{ id: 5 }] }; }) });

  const res = await request(app)
    .put('/api/entity-types/5')
    .set(...AUTH)
    .send({ name: 'Wolf', color: '#0f0', is_creature: true });

  assert.equal(res.status, 200);
  assert.equal(params[params.length - 2], true); // is_creature
  assert.equal(params[params.length - 1], '5');  // id
});
