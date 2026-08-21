const test = require('node:test');
const assert = require('node:assert');
const { adminToken, withAuth } = require('./helpers/auth.js');
const request = require('supertest');

const { app, __setPool } = require('../src/index.js');

// entity-types mutations are behind requireAdmin; carry an admin token and let
// withAuth() answer the guard's user lookup so the captured params reflect the
// route's own INSERT/UPDATE.
const AUTH = ['Authorization', `Bearer ${adminToken()}`];

// PUT /api/entity-types/:id runs inside a transaction now (client.query, not
// pool.query) so a rename's cascade rewrite and the entity_types UPDATE
// commit or roll back together (SOMET-228). It still pre-checks the current
// name before allowing a rename (SOMET-185 origin). None of the tests below
// exercise a rename, so answer the pre-check with the same name the body
// sends -- that keeps them on the no-rename path and preserves their
// original intent (asserting the UPDATE's other columns/params). Returns a
// full pool (not just a query fn), since the route now acquires a client.
function putMock(bodyName, onUpdate) {
  const client = {
    query: async (s, p) => {
      const trimmed = s.trim();
      if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(trimmed)) return { rows: [] };
      if (/SELECT name FROM entity_types WHERE id/i.test(s)) return { rows: [{ name: bodyName }] };
      return onUpdate(s, p);
    },
    release: () => {},
  };
  return {
    query: withAuth(async (s) => { throw new Error(`putMock: unexpected pool.query (route should use the client): ${s}`); }),
    connect: async () => client,
  };
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
  //
  // Also the CASE form, `<column> = CASE WHEN $A::boolean THEN $B ELSE ... END`,
  // which is how a column whose ABSENCE from the body must be distinguished
  // from an explicit null is written on these routes -- behavior_id since
  // SOMET-254, both pin columns since SOMET-342. The value under test is $B;
  // $A is the was-it-sent flag, which a caller that cares about it can read
  // out of the SQL itself.
  const caseRe = new RegExp(`\\b${column}\\s*=\\s*CASE WHEN \\$\\d+::boolean THEN \\$(\\d+)`, 'i');
  const caseMatch = caseRe.exec(sql);
  if (caseMatch) return params[Number(caseMatch[1]) - 1];

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
  __setPool(putMock('Tree', async (s, p) => { sql = s; params = p; return { rows: [{ id: 5 }] }; }));

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
  __setPool(putMock('Wolf', async (s, p) => { sql = s; params = p; return { rows: [{ id: 5 }] }; }));

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
  __setPool(putMock('Tree', async (s, p) => { sql = s; params = p; return { rows: [{ id: 5 }] }; }));

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

// SOMET-228 (was F-005/SOMET-185): worlds.allowed_creature_types,
// world_creatures.type and biomes.flora_types/creature_types reference
// entity_types by NAME with no integrity check. SOMET-185 used to 409 a
// rename that would orphan any of these -- safe, but permanently blocked
// fixing a typo'd name once it was referenced anywhere. Now the route
// cascades: it rewrites every referencing name to the new name in the SAME
// transaction as the entity_types row update, so the rename always succeeds.
// The route now acquires a client (pool.connect()) rather than using
// pool.query directly, so this mock exposes BOTH: `query` answers the
// admin-guard's user lookup, and `connect` hands back a client whose `query`
// resolves against the same handler list (with BEGIN/COMMIT/ROLLBACK
// auto-answered) and records every call into the same `calls` array.
function mockPool(handlers) {
  const calls = [];
  const resolve = async (sql, params) => {
    calls.push({ sql, params });
    for (const [re, fn] of handlers) {
      if (re.test(sql)) return fn(params);
    }
    throw new Error(`unexpected query: ${sql}`);
  };
  const client = {
    query: async (sql, params) => {
      const trimmed = sql.trim();
      if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(trimmed)) return { rows: [] };
      return resolve(sql, params);
    },
    release: () => {},
  };
  return {
    calls,
    query: async (sql, params) => {
      if (/FROM users/i.test(sql) && /token_version/i.test(sql)) {
        return { rows: [{ token_version: 1, role: 'admin' }] };
      }
      return resolve(sql, params);
    },
    connect: async () => client,
  };
}

// Asserts a captured call is the worlds/biomes jsonb-array-element rename
// UPDATE this route is supposed to issue: the CASE-driven rewrite verified
// against real Postgres (see SOMET-228 PR description) with the right
// oldName/newName/containment params, not some other shape.
function assertElementRenameCall(call, { oldName, newName }) {
  assert.match(call.sql, /jsonb_agg\(CASE WHEN elem\.value = \$1 THEN \$2 ELSE elem\.value END/i);
  assert.equal(call.params[0], oldName);
  assert.equal(call.params[1], newName);
  assert.deepEqual(JSON.parse(call.params[2]), [oldName]);
}

test('PUT /api/entity-types/:id cascades the rename into worlds.allowed_creature_types instead of refusing it', async () => {
  const pool = mockPool([
    [/SELECT name FROM entity_types WHERE id/i, () => ({ rows: [{ name: 'AuditFixtureBeast' }] })],
    [/SELECT id, name FROM worlds WHERE allowed_creature_types/i, () => ({ rows: [{ id: 'w1', name: 'Test World' }] })],
    [/SELECT 1 FROM world_creatures WHERE type/i, () => ({ rows: [] })],
    [/SELECT id, name FROM biomes WHERE flora_types/i, () => ({ rows: [] })],
    [/UPDATE worlds\b[\s\S]*allowed_creature_types/i, () => ({ rowCount: 1, rows: [] })],
    [/UPDATE entity_types SET/i, () => ({ rows: [{ id: 5, name: 'AuditFixtureBeastRenamed' }] })],
  ]);
  __setPool(pool);
  const res = await request(app)
    .put('/api/entity-types/5')
    .set(...AUTH)
    .send({ name: 'AuditFixtureBeastRenamed', color: '#0f0' });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.name, 'AuditFixtureBeastRenamed');
  assert.equal(res.body.renamedReferences.worlds, 1);
  assert.equal(res.body.renamedReferences.hadPlacedCreatures, false);

  const worldsUpdate = pool.calls.find((c) => /UPDATE worlds\b/i.test(c.sql));
  assert.ok(worldsUpdate, 'expected the route to issue the worlds cascade UPDATE');
  assertElementRenameCall(worldsUpdate, { oldName: 'AuditFixtureBeast', newName: 'AuditFixtureBeastRenamed' });
});

test('PUT /api/entity-types/:id cascades the rename into world_creatures.type instead of refusing it', async () => {
  const pool = mockPool([
    [/SELECT name FROM entity_types WHERE id/i, () => ({ rows: [{ name: 'Village Guard' }] })],
    [/SELECT id, name FROM worlds WHERE allowed_creature_types/i, () => ({ rows: [] })],
    [/SELECT 1 FROM world_creatures WHERE type/i, () => ({ rows: [{ '?column?': 1 }] })],
    [/SELECT id, name FROM biomes WHERE flora_types/i, () => ({ rows: [] })],
    [/UPDATE world_creatures SET type/i, () => ({ rowCount: 3, rows: [] })],
    [/UPDATE entity_types SET/i, () => ({ rows: [{ id: 5, name: 'Village Guardian' }] })],
  ]);
  __setPool(pool);
  const res = await request(app)
    .put('/api/entity-types/5')
    .set(...AUTH)
    .send({ name: 'Village Guardian', color: '#0f0' });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.renamedReferences.hadPlacedCreatures, true);

  const creaturesUpdate = pool.calls.find((c) => /UPDATE world_creatures SET type/i.test(c.sql));
  assert.ok(creaturesUpdate, 'expected the route to issue the world_creatures cascade UPDATE');
  assert.deepEqual(creaturesUpdate.params, ['Village Guard', 'Village Guardian']);
});

test('PUT /api/entity-types/:id cascades the rename into biomes.flora_types/creature_types instead of refusing it', async () => {
  const pool = mockPool([
    [/SELECT name FROM entity_types WHERE id/i, () => ({ rows: [{ name: 'bush' }] })],
    [/SELECT id, name FROM worlds WHERE allowed_creature_types/i, () => ({ rows: [] })],
    [/SELECT 1 FROM world_creatures WHERE type/i, () => ({ rows: [] })],
    [/SELECT id, name FROM biomes WHERE flora_types/i, () => ({ rows: [{ id: 1, name: 'Meadow' }] })],
    [/UPDATE biomes\b/i, () => ({ rowCount: 1, rows: [] })],
    [/UPDATE entity_types SET/i, () => ({ rows: [{ id: 5, name: 'shrub' }] })],
  ]);
  __setPool(pool);
  const res = await request(app)
    .put('/api/entity-types/5')
    .set(...AUTH)
    .send({ name: 'shrub', color: '#0f0' });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.renamedReferences.biomes, 1);

  const biomesUpdate = pool.calls.find((c) => /UPDATE biomes\b/i.test(c.sql));
  assert.ok(biomesUpdate, 'expected the route to issue the biomes cascade UPDATE');
  // Both columns are guarded by their own containment CASE so an unrelated
  // column on the same row (e.g. creature_types with no match) is left as
  // literally the same column value, not re-aggregated into null.
  assert.match(biomesUpdate.sql, /flora_types = CASE WHEN flora_types @> \$3::jsonb THEN/i);
  assert.match(biomesUpdate.sql, /creature_types = CASE WHEN creature_types @> \$3::jsonb THEN/i);
  assert.equal(biomesUpdate.params[0], 'bush');
  assert.equal(biomesUpdate.params[1], 'shrub');
});

test('PUT /api/entity-types/:id cascades a rename referenced in worlds, world_creatures AND biomes at once', async () => {
  const pool = mockPool([
    [/SELECT name FROM entity_types WHERE id/i, () => ({ rows: [{ name: 'AuditFixtureBeast' }] })],
    [/SELECT id, name FROM worlds WHERE allowed_creature_types/i, () => ({ rows: [{ id: 'w1', name: 'Test World' }] })],
    [/SELECT 1 FROM world_creatures WHERE type/i, () => ({ rows: [{ '?column?': 1 }] })],
    [/SELECT id, name FROM biomes WHERE flora_types/i, () => ({ rows: [{ id: 1, name: 'Meadow' }] })],
    [/UPDATE worlds\b[\s\S]*allowed_creature_types/i, () => ({ rowCount: 1, rows: [] })],
    [/UPDATE world_creatures SET type/i, () => ({ rowCount: 5, rows: [] })],
    [/UPDATE biomes\b/i, () => ({ rowCount: 1, rows: [] })],
    [/UPDATE entity_types SET/i, () => ({ rows: [{ id: 5, name: 'AuditFixtureBeastRenamed' }] })],
  ]);
  __setPool(pool);
  const res = await request(app)
    .put('/api/entity-types/5')
    .set(...AUTH)
    .send({ name: 'AuditFixtureBeastRenamed', color: '#0f0' });

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.renamedReferences, { worlds: 1, biomes: 1, hadPlacedCreatures: true });
  assert.ok(pool.calls.some((c) => /UPDATE worlds\b/i.test(c.sql)));
  assert.ok(pool.calls.some((c) => /UPDATE world_creatures SET type/i.test(c.sql)));
  assert.ok(pool.calls.some((c) => /UPDATE biomes\b/i.test(c.sql)));
});

test('PUT /api/entity-types/:id allows a rename when nothing references the old name (no regression)', async () => {
  const pool = mockPool([
    [/SELECT name FROM entity_types WHERE id/i, () => ({ rows: [{ name: 'OldName' }] })],
    [/SELECT id, name FROM worlds WHERE allowed_creature_types/i, () => ({ rows: [] })],
    [/SELECT 1 FROM world_creatures WHERE type/i, () => ({ rows: [] })],
    [/SELECT id, name FROM biomes WHERE flora_types/i, () => ({ rows: [] })],
    [/UPDATE entity_types SET/i, () => ({ rows: [{ id: 5, name: 'NewName' }] })],
  ]);
  __setPool(pool);
  const res = await request(app)
    .put('/api/entity-types/5')
    .set(...AUTH)
    .send({ name: 'NewName', color: '#0f0' });

  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'NewName');
  assert.equal(res.body.renamedReferences, undefined, 'no reference existed, so no cascade summary should be attached');
  assert.ok(!pool.calls.some((c) => /^UPDATE (worlds|biomes|world_creatures)\b/i.test(c.sql)), 'no cascade UPDATE should run when nothing referenced the old name');
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
  const refChecks = pool.calls.filter((c) => /allowed_creature_types|world_creatures|flora_types/i.test(c.sql));
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

test('PUT /api/entity-types/:id rolls back the whole cascade when a mid-transaction UPDATE fails', async () => {
  // The single most important test for SOMET-228: prove the cascade and the
  // entity_types rename are ONE transaction, not just individually-correct
  // statements. worlds and world_creatures resolve fine; the biomes UPDATE
  // (which runs after them, before the entity_types UPDATE) throws. Nothing
  // -- not even the earlier-in-order worlds/world_creatures writes -- may
  // have committed.
  let entityTypesUpdateCalled = false;
  const pool = mockPool([
    [/SELECT name FROM entity_types WHERE id/i, () => ({ rows: [{ name: 'AuditFixtureBeast' }] })],
    [/SELECT id, name FROM worlds WHERE allowed_creature_types/i, () => ({ rows: [{ id: 'w1', name: 'Test World' }] })],
    [/SELECT 1 FROM world_creatures WHERE type/i, () => ({ rows: [{ '?column?': 1 }] })],
    [/SELECT id, name FROM biomes WHERE flora_types/i, () => ({ rows: [{ id: 1, name: 'Meadow' }] })],
    [/UPDATE worlds\b[\s\S]*allowed_creature_types/i, () => ({ rowCount: 1, rows: [] })],
    [/UPDATE world_creatures SET type/i, () => ({ rowCount: 1, rows: [] })],
    [/UPDATE biomes\b/i, () => { throw new Error('simulated DB failure mid-cascade'); }],
    [/UPDATE entity_types SET/i, () => { entityTypesUpdateCalled = true; return { rows: [{ id: 5, name: 'AuditFixtureBeastRenamed' }] }; }],
  ]);
  __setPool(pool);
  const res = await request(app)
    .put('/api/entity-types/5')
    .set(...AUTH)
    .send({ name: 'AuditFixtureBeastRenamed', color: '#0f0' });

  assert.equal(res.status, 500);
  assert.equal(entityTypesUpdateCalled, false, 'the entity_types rename must never run after an earlier cascade step failed');
});

// SOMET-238: DELETE had no reference guard at all, though the PUT rename
// guard right above (F-005/SOMET-185) already refuses exactly this. Same
// three reference sites, same 409 shape, now on DELETE too. No
// /DELETE FROM entity_types/i handler is registered in the refused cases
// below on purpose: if the guard regressed away, that query would hit the
// mock's throw-on-unexpected-query guard instead of silently deleting a
// still-referenced row.
test('DELETE /api/entity-types/:id 409s when still an allowed creature type on a world', async () => {
  __setPool(mockPool([
    [/SELECT name FROM entity_types WHERE id/i, () => ({ rows: [{ name: 'AuditFixtureBeast' }] })],
    [/SELECT id, name FROM worlds WHERE allowed_creature_types/i, () => ({ rows: [{ id: 'w1', name: 'Test World' }] })],
    [/SELECT 1 FROM world_creatures WHERE type/i, () => ({ rows: [] })],
    [/FROM biomes WHERE/i, () => ({ rows: [] })],
  ]));
  const res = await request(app).delete('/api/entity-types/5').set(...AUTH);

  assert.equal(res.status, 409);
  assert.equal(res.body.referencing_worlds[0].id, 'w1');
});

test('DELETE /api/entity-types/:id 409s when it still has placed creatures', async () => {
  __setPool(mockPool([
    [/SELECT name FROM entity_types WHERE id/i, () => ({ rows: [{ name: 'Village Guard' }] })],
    [/SELECT id, name FROM worlds WHERE allowed_creature_types/i, () => ({ rows: [] })],
    [/SELECT 1 FROM world_creatures WHERE type/i, () => ({ rows: [{ '?column?': 1 }] })],
    [/FROM biomes WHERE/i, () => ({ rows: [] })],
  ]));
  const res = await request(app).delete('/api/entity-types/5').set(...AUTH);

  assert.equal(res.status, 409);
  assert.equal(res.body.has_placed_creatures, true);
});

test('DELETE /api/entity-types/:id 409s when still referenced by a biome', async () => {
  __setPool(mockPool([
    [/SELECT name FROM entity_types WHERE id/i, () => ({ rows: [{ name: 'Bush' }] })],
    [/SELECT id, name FROM worlds WHERE allowed_creature_types/i, () => ({ rows: [] })],
    [/SELECT 1 FROM world_creatures WHERE type/i, () => ({ rows: [] })],
    [/FROM biomes WHERE/i, () => ({ rows: [{ id: 'b1', name: 'Meadow' }] })],
  ]));
  const res = await request(app).delete('/api/entity-types/5').set(...AUTH);

  assert.equal(res.status, 409);
  assert.equal(res.body.referencing_biomes[0].id, 'b1');
});

test('DELETE /api/entity-types/:id succeeds when nothing references it (no regression)', async () => {
  const pool = mockPool([
    [/SELECT name FROM entity_types WHERE id/i, () => ({ rows: [{ name: 'Unused' }] })],
    [/SELECT id, name FROM worlds WHERE allowed_creature_types/i, () => ({ rows: [] })],
    [/SELECT 1 FROM world_creatures WHERE type/i, () => ({ rows: [] })],
    [/FROM biomes WHERE/i, () => ({ rows: [] })],
    [/DELETE FROM entity_types WHERE id/i, () => ({ rows: [{ id: 5 }] })],
  ]);
  __setPool(pool);
  const res = await request(app).delete('/api/entity-types/5').set(...AUTH);

  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.id, 5);
});

test('DELETE /api/entity-types/:id 404s when the row does not exist', async () => {
  __setPool(mockPool([
    [/SELECT name FROM entity_types WHERE id/i, () => ({ rows: [] })],
  ]));
  const res = await request(app).delete('/api/entity-types/999').set(...AUTH);

  assert.equal(res.status, 404);
});

// SOMET-342: the per-type generation pin, written through this route for the
// first time. `paramFor` reads a value out by matching the placeholder in the
// SQL, so these assert what the DB would actually receive rather than what the
// handler happened to build.

test('PUT /api/entity-types/:id writes the pin when one is sent', async () => {
  let params = null, sql = null;
  __setPool(putMock('Tree', async (s, p) => { sql = s; params = p; return { rows: [{ id: 5 }] }; }));

  const res = await request(app)
    .put('/api/entity-types/5')
    .set(...AUTH)
    .send({ name: 'Tree', color: '#0f0', ai_provider_mode: 'provider', ai_provider_id: 7 });

  assert.equal(res.status, 200);
  assert.equal(paramFor(sql, params, 'ai_provider_mode'), 'provider');
  assert.equal(paramFor(sql, params, 'ai_provider_id'), 7);
  assert.equal(params[params.length - 1], '5');
});

test('PUT /api/entity-types/:id leaves the pin alone when the body omits it', async () => {
  // The guard that keeps every older client, script and test safe: a save that
  // says nothing about the pin must not reset it. The CASE in the UPDATE is
  // driven by this boolean, so it is the value worth asserting.
  let params = null, sql = null;
  __setPool(putMock('Tree', async (s, p) => { sql = s; params = p; return { rows: [{ id: 5 }] }; }));

  const res = await request(app)
    .put('/api/entity-types/5')
    .set(...AUTH)
    .send({ name: 'Tree', color: '#0f0' });

  assert.equal(res.status, 200);
  const pinSentIdx = Number(/ai_provider_mode = CASE WHEN \$(\d+)/.exec(sql)[1]) - 1;
  assert.equal(params[pinSentIdx], false, 'an omitted pin must not be written');
});

test('PUT /api/entity-types/:id refuses an unknown mode with a 400, not a 500', async () => {
  __setPool(putMock('Tree', async () => {
    throw new Error('the UPDATE must not run for an invalid pin');
  }));

  const res = await request(app)
    .put('/api/entity-types/5')
    .set(...AUTH)
    .send({ name: 'Tree', color: '#0f0', ai_provider_mode: 'sideways' });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /ai_provider_mode must be one of/);
});

test('PUT /api/entity-types/:id refuses a provider pin with no target', async () => {
  __setPool(putMock('Tree', async () => {
    throw new Error('the UPDATE must not run for an invalid pin');
  }));

  const res = await request(app)
    .put('/api/entity-types/5')
    .set(...AUTH)
    .send({ name: 'Tree', color: '#0f0', ai_provider_mode: 'provider' });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /needs an ai_provider_id/);
});
