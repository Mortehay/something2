const test = require('node:test');
const assert = require('node:assert');
const { adminToken, withAuth } = require('./helpers/auth.js');
const request = require('supertest');

const { app, __setPool } = require('../src/index.js');

// entity-types mutations are behind requireAdmin; carry an admin token and let
// withAuth() answer the guard's user lookup so the captured params reflect the
// route's own INSERT/UPDATE.
const AUTH = ['Authorization', `Bearer ${adminToken()}`];

// Read a captured parameter BY COLUMN NAME rather than by position. Asserting
// on params[length - 2] silently retargets a different column the moment one is
// added, which is exactly how adding `prompt` broke this file — the assertions
// still ran, they just checked the wrong value.
function paramFor(sql, params, column) {
  const insert = /INSERT INTO\s+\w+\s*\(([\s\S]*?)\)\s*VALUES/i.exec(sql);
  if (insert) {
    const cols = insert[1].split(',').map((c) => c.trim());
    const i = cols.indexOf(column);
    assert.ok(i >= 0, `INSERT has no column '${column}' (got: ${cols.join(', ')})`);
    return params[i];
  }
  // UPDATE: find `<column> = $N`, tolerating a COALESCE wrapper.
  const re = new RegExp(`\\b${column}\\s*=\\s*(?:COALESCE\\()?\\$(\\d+)`, 'i');
  const m = re.exec(sql);
  assert.ok(m, `UPDATE does not assign '${column}' from a parameter`);
  return params[Number(m[1]) - 1];
}

test('POST /api/entity-types defaults render_mode to rect', async () => {
  let params = null, sql = null;
  __setPool({ query: withAuth(async (s, p) => { sql = s; params = p; return { rows: [{ id: 1 }] }; }) });

  const res = await request(app).post('/api/entity-types').set(...AUTH).send({ name: 'Bush', color: '#0f0' });

  assert.equal(res.status, 201);
  assert.equal(paramFor(sql, params, 'render_mode'), 'rect');
});

test('POST /api/entity-types passes an explicit render_mode', async () => {
  let params = null, sql = null;
  __setPool({ query: withAuth(async (s, p) => { sql = s; params = p; return { rows: [{ id: 1 }] }; }) });

  const res = await request(app)
    .post('/api/entity-types')
    .set(...AUTH)
    .send({ name: 'Tree', color: '#0f0', render_mode: 'static' });

  assert.equal(res.status, 201);
  assert.equal(paramFor(sql, params, 'render_mode'), 'static');
});

test('PUT /api/entity-types/:id passes render_mode (and is_creature, and the id param)', async () => {
  let params = null, sql = null;
  __setPool({ query: withAuth(async (s, p) => { sql = s; params = p; return { rows: [{ id: 5 }] }; }) });

  const res = await request(app)
    .put('/api/entity-types/5')
    .set(...AUTH)
    .send({ name: 'Tree', color: '#0f0', render_mode: 'animated' });

  assert.equal(res.status, 200);
  assert.equal(paramFor(sql, params, 'render_mode'), 'animated');
  assert.equal(paramFor(sql, params, 'is_creature'), false); // default
  assert.equal(params[params.length - 1], '5');              // id is always last
});

test('POST /api/entity-types defaults is_creature to false', async () => {
  let params = null, sql = null;
  __setPool({ query: withAuth(async (s, p) => { sql = s; params = p; return { rows: [{ id: 1 }] }; }) });

  const res = await request(app).post('/api/entity-types').set(...AUTH).send({ name: 'Bush', color: '#0f0' });

  assert.equal(res.status, 201);
  assert.equal(paramFor(sql, params, 'is_creature'), false);
});

test('POST /api/entity-types passes an explicit is_creature', async () => {
  let params = null, sql = null;
  __setPool({ query: withAuth(async (s, p) => { sql = s; params = p; return { rows: [{ id: 1 }] }; }) });

  const res = await request(app)
    .post('/api/entity-types')
    .set(...AUTH)
    .send({ name: 'Wolf', color: '#0f0', is_creature: true });

  assert.equal(res.status, 201);
  assert.equal(paramFor(sql, params, 'is_creature'), true);
});

test('PUT /api/entity-types/:id passes is_creature (before the id param)', async () => {
  let params = null, sql = null;
  __setPool({ query: withAuth(async (s, p) => { sql = s; params = p; return { rows: [{ id: 5 }] }; }) });

  const res = await request(app)
    .put('/api/entity-types/5')
    .set(...AUTH)
    .send({ name: 'Wolf', color: '#0f0', is_creature: true });

  assert.equal(res.status, 200);
  assert.equal(paramFor(sql, params, 'is_creature'), true);
  assert.equal(params[params.length - 1], '5'); // id
});

test('POST /api/entity-types defaults prompt to the empty string', async () => {
  let params = null, sql = null;
  __setPool({ query: withAuth(async (s, p) => { sql = s; params = p; return { rows: [{ id: 1 }] }; }) });

  const res = await request(app).post('/api/entity-types').set(...AUTH).send({ name: 'Bush', color: '#0f0' });

  assert.equal(res.status, 201);
  assert.equal(paramFor(sql, params, 'prompt'), '');
});

test('POST /api/entity-types passes an explicit prompt', async () => {
  let params = null, sql = null;
  __setPool({ query: withAuth(async (s, p) => { sql = s; params = p; return { rows: [{ id: 1 }] }; }) });

  const res = await request(app)
    .post('/api/entity-types')
    .set(...AUTH)
    .send({ name: 'Tree', color: '#0f0', prompt: 'a tall oak tree' });

  assert.equal(res.status, 201);
  assert.equal(paramFor(sql, params, 'prompt'), 'a tall oak tree');
});

test('PUT /api/entity-types/:id leaves prompt untouched when the body omits it', async () => {
  let params = null, sql = null;
  __setPool({ query: withAuth(async (s, p) => { sql = s; params = p; return { rows: [{ id: 5 }] }; }) });

  // The UPDATE uses COALESCE($n, prompt), so a null parameter must mean "keep
  // the stored prompt" — otherwise saving the form from an older client would
  // wipe a prompt the admin had already written.
  const res = await request(app)
    .put('/api/entity-types/5')
    .set(...AUTH)
    .send({ name: 'Tree', color: '#0f0' });

  assert.equal(res.status, 200);
  assert.equal(paramFor(sql, params, 'prompt'), null);
});
