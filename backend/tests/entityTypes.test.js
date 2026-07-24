const test = require('node:test');
const assert = require('node:assert');
const { adminToken, withAuth } = require('./helpers/auth.js');
const request = require('supertest');

const { app, __setPool } = require('../src/index.js');

// entity-types mutations are behind requireAdmin; carry an admin token and let
// withAuth() answer the guard's user lookup so the captured params reflect the
// route's own INSERT/UPDATE.
const AUTH = ['Authorization', `Bearer ${adminToken()}`];

// PUT /api/entity-types/:id now pre-checks the current name before allowing a
// rename (SOMET-185). None of the tests below exercise a rename, so answer
// the pre-check with the same name the body sends -- that keeps them on the
// no-rename path and preserves their original intent (asserting the UPDATE's
// other columns/params).
function putMock(bodyName, onUpdate) {
  return withAuth(async (s, p) => {
    if (/SELECT name FROM entity_types WHERE id/i.test(s)) return { rows: [{ name: bodyName }] };
    return onUpdate(s, p);
  });
}

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
  __setPool({ query: putMock('Tree', async (s, p) => { sql = s; params = p; return { rows: [{ id: 5 }] }; }) });

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
  __setPool({ query: putMock('Wolf', async (s, p) => { sql = s; params = p; return { rows: [{ id: 5 }] }; }) });

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
  __setPool({ query: putMock('Tree', async (s, p) => { sql = s; params = p; return { rows: [{ id: 5 }] }; }) });

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

// F-005 (SOMET-185): worlds.allowed_creature_types and world_creatures.type
// reference entity_types by NAME with no integrity check. Renaming a
// referenced type silently orphans those references -- confirmed live: a
// world configured with allowed_creature_types ["AuditFixtureBeast"] placed 5
// creatures, then after renaming the entity type via PUT (200, unchecked), a
// re-roll on the same world returned HTTP 200 {"placed":0} with no error.
function mockPool(handlers) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      if (/FROM users/i.test(sql) && /token_version/i.test(sql)) {
        return { rows: [{ token_version: 1, role: 'admin' }] };
      }
      calls.push({ sql, params });
      for (const [re, fn] of handlers) {
        if (re.test(sql)) return fn(params);
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

test('PUT /api/entity-types/:id 409s when the old name is still an allowed creature type on a world', async () => {
  __setPool(mockPool([
    [/SELECT name FROM entity_types WHERE id/i, () => ({ rows: [{ name: 'AuditFixtureBeast' }] })],
    [/SELECT id, name FROM worlds WHERE allowed_creature_types/i, () => ({ rows: [{ id: 'w1', name: 'Test World' }] })],
    [/SELECT 1 FROM world_creatures WHERE type/i, () => ({ rows: [] })],
  ]));
  const res = await request(app)
    .put('/api/entity-types/5')
    .set(...AUTH)
    .send({ name: 'AuditFixtureBeastRenamed', color: '#0f0' });

  assert.equal(res.status, 409);
  assert.equal(res.body.referencing_worlds[0].id, 'w1');
});

test('PUT /api/entity-types/:id 409s when the old name still has placed creatures', async () => {
  __setPool(mockPool([
    [/SELECT name FROM entity_types WHERE id/i, () => ({ rows: [{ name: 'Village Guard' }] })],
    [/SELECT id, name FROM worlds WHERE allowed_creature_types/i, () => ({ rows: [] })],
    [/SELECT 1 FROM world_creatures WHERE type/i, () => ({ rows: [{ '?column?': 1 }] })],
  ]));
  const res = await request(app)
    .put('/api/entity-types/5')
    .set(...AUTH)
    .send({ name: 'Village Guardian', color: '#0f0' });

  assert.equal(res.status, 409);
  assert.equal(res.body.has_placed_creatures, true);
});

test('PUT /api/entity-types/:id allows a rename when nothing references the old name', async () => {
  const pool = mockPool([
    [/SELECT name FROM entity_types WHERE id/i, () => ({ rows: [{ name: 'OldName' }] })],
    [/SELECT id, name FROM worlds WHERE allowed_creature_types/i, () => ({ rows: [] })],
    [/SELECT 1 FROM world_creatures WHERE type/i, () => ({ rows: [] })],
    [/UPDATE entity_types SET/i, () => ({ rows: [{ id: 5, name: 'NewName' }] })],
  ]);
  __setPool(pool);
  const res = await request(app)
    .put('/api/entity-types/5')
    .set(...AUTH)
    .send({ name: 'NewName', color: '#0f0' });

  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'NewName');
});

test('PUT /api/entity-types/:id skips the reference check when the name is unchanged', async () => {
  const pool = mockPool([
    [/SELECT name FROM entity_types WHERE id/i, () => ({ rows: [{ name: 'SameName' }] })],
    [/UPDATE entity_types SET/i, () => ({ rows: [{ id: 5, name: 'SameName' }] })],
  ]);
  __setPool(pool);
  const res = await request(app)
    .put('/api/entity-types/5')
    .set(...AUTH)
    .send({ name: 'SameName', color: '#0f0' });

  assert.equal(res.status, 200);
  const refChecks = pool.calls.filter((c) => /allowed_creature_types|world_creatures/i.test(c.sql));
  assert.equal(refChecks.length, 0, 'no rename attempted, so no reference check should run');
});

test('PUT /api/entity-types/:id 404s when the row does not exist', async () => {
  __setPool(mockPool([
    [/SELECT name FROM entity_types WHERE id/i, () => ({ rows: [] })],
  ]));
  const res = await request(app)
    .put('/api/entity-types/999')
    .set(...AUTH)
    .send({ name: 'Anything', color: '#0f0' });

  assert.equal(res.status, 404);
});
