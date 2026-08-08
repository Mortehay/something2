// Real-HTTP, real-DB tests for /api/creature-behaviors and the
// behavior_id/attack_element fields on /api/entity-types. Bootstrap modeled
// on tests/progression_routes.test.js: a real pg Pool swapped into the app
// via __setPool, a disposable admin user created per test and dropped in a
// `finally`, gated on TEST_DATABASE_URL alone so a bare `npm test` on a
// machine with a working dev database never reaches here.
//
// SAFETY: every fixture row this file creates is a `zz`-prefixed
// creature_behaviors/entity_types row, torn down BY NAME, unconditionally,
// in a `finally`. This file never asserts a rejection against a REAL catalog
// row (e.g. 'Line') -- Task 3 destroyed the real Line row doing exactly that
// before the FK/CHECK that would have protected it existed. Entity-type
// fixtures are created with is_creature = false so they stay invisible to
// other test files' catalog-wide creature invariants while they briefly
// exist.

require('./helpers/auth.js'); // sets JWT_SECRET before any token is signed
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { Pool } = require('pg');

const { app, __setPool } = require('../src/index.js');
const { signToken } = require('../src/auth/tokens.js');

const DB_URL = process.env.TEST_DATABASE_URL || 'postgres://user:password@localhost:15432/game_db';

let dbPool = null;

before(async () => {
  if (!process.env.TEST_DATABASE_URL) return; // no DB configured -- every test below self-skips
  const p = new Pool({ connectionString: DB_URL, connectionTimeoutMillis: 2000, max: 4 });
  try {
    await p.query('SELECT 1');
    dbPool = p;
    __setPool(p);
  } catch (err) {
    await p.end().catch(() => {});
  }
});

after(async () => {
  if (dbPool) await dbPool.end().catch(() => {});
});

function skipMsg(what) {
  return `NO DATABASE at ${DB_URL} -- ${what} is UNVERIFIED on this run`;
}

// True only once both TEST_DATABASE_URL is set AND the connection actually
// opened -- same idiom as progression_routes.test.js's dbReady.
function dbReady(t, what) {
  if (!process.env.TEST_DATABASE_URL) {
    const msg = `TEST_DATABASE_URL not set -- skipping to avoid mutating a real database (${what})`;
    if (process.env.CI) assert.fail(msg);
    t.skip(msg);
    return false;
  }
  if (!dbPool) {
    const m = skipMsg(what);
    if (process.env.CI) assert.fail(m);
    t.skip(m);
    return false;
  }
  return true;
}

async function createTestAdmin(pool, tag) {
  const username = `creature-behaviors-api-test-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const r = await pool.query(
    `INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'admin') RETURNING id, token_version`,
    [username],
  );
  return r.rows[0];
}

async function dropUser(pool, userId) {
  if (userId != null) await pool.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
}

function authHeaderFor(user) {
  const token = signToken({
    userId: user.id, username: `admin-${user.id}`, role: 'admin', tokenVersion: user.token_version,
  });
  return { Authorization: `Bearer ${token}` };
}

// SOMET-253 Task 3: the attack lives on the nested `abilities` array now, not
// on the behaviour row -- behaviorAbilitiesError rejects a POST/PUT with no
// abilities at all, so every fixture body below must carry at least one.
const FIXTURE_BODY = {
  name: 'zzApiBehaviorProfile',
  aggro_radius: 300,
  leash_radius: 500,
  chase_style: 'charge',
  // Required as of SOMET-249 fix-wave I4: behaviorFieldError now rejects a
  // missing/non-positive move_speed_mult (0 silently produces a creature
  // that never moves), so this fixture must carry one explicitly rather than
  // relying on the route's insert-time `?? 1` default, which now runs too
  // late to matter.
  move_speed_mult: 1,
  abilities: [{
    name: 'Attack', attack_kind: 'melee', attack_range: 55, attack_cooldown: 1.2,
    projectile_speed: 0, projectile_radius: 0, element: null, damage_mult: 1, knockback: 0,
  }],
};

async function deleteBehaviorByName(pool, name) {
  await pool.query('DELETE FROM creature_behaviors WHERE name = $1', [name]).catch(() => {});
}

async function deleteEntityTypeByName(pool, name) {
  await pool.query('DELETE FROM entity_types WHERE name = $1', [name]).catch(() => {});
}

test('GET /api/creature-behaviors returns the seeded profiles, Line among them', async (t) => {
  if (!dbReady(t, 'reads the live creature_behaviors catalog')) return;

  const res = await request(app).get('/api/creature-behaviors');

  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body));
  // At least the twelve migration-seeded profiles -- "at least" (not
  // "exactly") because other DB test files transiently insert/delete their
  // own zz-prefixed rows and node:test may run files concurrently.
  assert.ok(res.body.length >= 12, `expected at least 12 profiles, got ${res.body.length}`);
  const line = res.body.find((b) => b.name === 'Line');
  assert.ok(line, 'Line must be among the seeded profiles');
  assert.equal(line.chase_style, 'charge');
  // The attack lives on the nested `abilities` array now (SOMET-253 Task 3);
  // the behaviour row itself no longer carries attack_kind/attack_range.
  assert.ok(Array.isArray(line.abilities) && line.abilities.length >= 1);
  assert.equal(line.abilities[0].attack_kind, 'melee');
  assert.equal(Number(line.abilities[0].attack_range), 60);
});

test('POST /api/creature-behaviors rejects an unknown chase_style with 400, not a 500', async (t) => {
  if (!dbReady(t, 'posts an invalid chase_style and confirms it is caught before the CHECK constraint')) return;
  let admin;
  try {
    admin = await createTestAdmin(dbPool, 'post-badstyle');

    const res = await request(app).post('/api/creature-behaviors').set(authHeaderFor(admin)).send({
      ...FIXTURE_BODY,
      name: 'zzApiBadStyle',
      chase_style: 'teleport',
    });

    assert.equal(res.status, 400);
    assert.match(res.body.error, /chase_style/);

    const row = await dbPool.query('SELECT 1 FROM creature_behaviors WHERE name = $1', ['zzApiBadStyle']);
    assert.equal(row.rowCount, 0, 'a rejected POST must not create a row');
  } finally {
    await deleteBehaviorByName(dbPool, 'zzApiBadStyle');
    await dropUser(dbPool, admin && admin.id);
  }
});

test('POST /api/creature-behaviors rejects ranged/cast with a non-positive projectile_speed', async (t) => {
  if (!dbReady(t, 'posts a ranged ability with projectile_speed 0 and confirms the carried validation catches it')) return;
  let admin;
  try {
    admin = await createTestAdmin(dbPool, 'post-badprojectile');

    const res = await request(app).post('/api/creature-behaviors').set(authHeaderFor(admin)).send({
      ...FIXTURE_BODY,
      name: 'zzApiBadProjectile',
      chase_style: 'kite',
      preferred_range: 0,
      abilities: [{
        name: 'Shot', attack_kind: 'ranged', attack_range: 200, attack_cooldown: 1,
        projectile_speed: 0, projectile_radius: 0, element: null, damage_mult: 1, knockback: 0,
      }],
    });

    assert.equal(res.status, 400);
    assert.match(res.body.error, /projectile_speed/);

    const row = await dbPool.query('SELECT 1 FROM creature_behaviors WHERE name = $1', ['zzApiBadProjectile']);
    assert.equal(row.rowCount, 0, 'a rejected POST must not create a row');
  } finally {
    await deleteBehaviorByName(dbPool, 'zzApiBadProjectile');
    await dropUser(dbPool, admin && admin.id);
  }
});

test('POST /api/creature-behaviors rejects a non-melee guard', async (t) => {
  if (!dbReady(t, 'posts a guard/ranged combo and confirms the carried validation catches it')) return;
  let admin;
  try {
    admin = await createTestAdmin(dbPool, 'post-badguard');

    const res = await request(app).post('/api/creature-behaviors').set(authHeaderFor(admin)).send({
      ...FIXTURE_BODY,
      name: 'zzApiBadGuard',
      chase_style: 'guard',
      abilities: [{
        name: 'Shot', attack_kind: 'ranged', attack_range: 200, attack_cooldown: 1,
        projectile_speed: 400, projectile_radius: 0, element: null, damage_mult: 1, knockback: 0,
      }],
    });

    assert.equal(res.status, 400);
    assert.match(res.body.error, /guard/);

    const row = await dbPool.query('SELECT 1 FROM creature_behaviors WHERE name = $1', ['zzApiBadGuard']);
    assert.equal(row.rowCount, 0, 'a rejected POST must not create a row');
  } finally {
    await deleteBehaviorByName(dbPool, 'zzApiBadGuard');
    await dropUser(dbPool, admin && admin.id);
  }
});

test('PUT /api/creature-behaviors/:id updates a profile\'s numbers', async (t) => {
  if (!dbReady(t, 'creates a zz fixture profile and PUTs new numbers onto it')) return;
  let admin;
  try {
    admin = await createTestAdmin(dbPool, 'put-updates');

    const created = await request(app).post('/api/creature-behaviors').set(authHeaderFor(admin)).send({
      ...FIXTURE_BODY,
      name: 'zzApiPutTarget',
    });
    assert.equal(created.status, 201);
    const id = created.body.id;

    const res = await request(app).put(`/api/creature-behaviors/${id}`).set(authHeaderFor(admin)).send({
      ...FIXTURE_BODY,
      name: 'zzApiPutTarget',
      aggro_radius: 333,
      leash_radius: 666,
      chase_style: 'kite',
      preferred_range: 70,
      damage_override: 0, // real value, meaning "hits for nothing" -- must survive
      // SOMET-253 Task 8: aura_radius/gold_min both 0 here on purpose -- real,
      // legitimate values ("not a leader" / "no loot floor"), not stand-ins
      // for "leave unset". This PUT is the regression guard for a bug this
      // task fixed: the INSERT/UPDATE statements never carried these six
      // columns at all, so an admin editing them in the form silently had the
      // write discarded.
      aura_radius: 0, aura_damage_mult: 1.25, aura_defense_mult: 1.2, aura_speed_mult: 1.1,
      gold_min: 0, gold_max: 9,
      abilities: [{
        name: 'Attack', attack_kind: 'melee', attack_range: 77, attack_cooldown: 2.5,
        projectile_speed: 0, projectile_radius: 0, element: null, damage_mult: 1, knockback: 0,
      }],
    });

    assert.equal(res.status, 200);
    assert.equal(Number(res.body.aggro_radius), 333);
    assert.equal(Number(res.body.leash_radius), 666);
    assert.equal(res.body.chase_style, 'kite');
    assert.equal(Number(res.body.damage_override), 0, 'damage_override 0 must survive, not fall back to null');
    assert.equal(Number(res.body.abilities[0].attack_range), 77);
    assert.equal(Number(res.body.abilities[0].attack_cooldown), 2.5);
    assert.equal(Number(res.body.aura_radius), 0, 'aura_radius 0 must survive, not fall back to a stale/default value');
    assert.equal(Number(res.body.aura_damage_mult), 1.25);
    assert.equal(Number(res.body.aura_defense_mult), 1.2);
    assert.equal(Number(res.body.aura_speed_mult), 1.1);
    assert.equal(Number(res.body.gold_min), 0);
    assert.equal(Number(res.body.gold_max), 9);

    const row = await dbPool.query('SELECT * FROM creature_behaviors WHERE id = $1', [id]);
    assert.equal(Number(row.rows[0].aggro_radius), 333, 'the row in the database must reflect the update');
    assert.equal(Number(row.rows[0].damage_override), 0);
    assert.equal(Number(row.rows[0].aura_damage_mult), 1.25, 'the aura columns must actually be written, not silently dropped');
    assert.equal(Number(row.rows[0].gold_max), 9, 'the gold columns must actually be written, not silently dropped');
    const abilityRow = await dbPool.query('SELECT attack_range FROM creature_abilities WHERE behavior_id = $1', [id]);
    assert.equal(Number(abilityRow.rows[0].attack_range), 77, 'the replaced ability must reflect the update');
  } finally {
    await deleteBehaviorByName(dbPool, 'zzApiPutTarget');
    await dropUser(dbPool, admin && admin.id);
  }
});

test('DELETE of a profile referenced by an entity type returns 409, names the referencing type, and leaves the row in place', async (t) => {
  if (!dbReady(t, 'builds its own zz profile + zz entity-type fixture pair and attempts to delete the referenced profile')) return;
  let admin;
  try {
    admin = await createTestAdmin(dbPool, 'delete-referenced');

    const created = await request(app).post('/api/creature-behaviors').set(authHeaderFor(admin)).send({
      ...FIXTURE_BODY,
      name: 'zzApiInUseProfile',
    });
    assert.equal(created.status, 201);
    const id = created.body.id;

    // is_creature = false: the FK does not care, and false keeps this
    // fixture invisible to other test files' creature-only catalog
    // invariants while it briefly exists.
    await dbPool.query(
      `INSERT INTO entity_types (name, color, is_creature, behavior_id)
       VALUES ('zzApiInUseCreature', '#fff', false, $1)`,
      [id],
    );

    const res = await request(app).delete(`/api/creature-behaviors/${id}`).set(authHeaderFor(admin));

    assert.equal(res.status, 409);
    assert.ok(Array.isArray(res.body.referencing_entity_types));
    assert.ok(
      res.body.referencing_entity_types.some((e) => e.name === 'zzApiInUseCreature'),
      'the 409 body must name the referencing entity type',
    );

    const row = await dbPool.query('SELECT id FROM creature_behaviors WHERE id = $1', [id]);
    assert.equal(row.rowCount, 1, 'the row must still be present after a refused delete');
  } finally {
    // Entity type first (it holds the FK), then the profile. Both by name,
    // unconditionally.
    await deleteEntityTypeByName(dbPool, 'zzApiInUseCreature');
    await deleteBehaviorByName(dbPool, 'zzApiInUseProfile');
    await dropUser(dbPool, admin && admin.id);
  }
});

test('DELETE of an unreferenced profile returns 204 and removes the row', async (t) => {
  if (!dbReady(t, 'creates a zz fixture profile with no references and deletes it')) return;
  let admin;
  try {
    admin = await createTestAdmin(dbPool, 'delete-unreferenced');

    const created = await request(app).post('/api/creature-behaviors').set(authHeaderFor(admin)).send({
      ...FIXTURE_BODY,
      name: 'zzApiFreeProfile',
    });
    assert.equal(created.status, 201);
    const id = created.body.id;

    const res = await request(app).delete(`/api/creature-behaviors/${id}`).set(authHeaderFor(admin));

    assert.equal(res.status, 204);
    assert.equal(res.body && Object.keys(res.body).length, 0);

    const row = await dbPool.query('SELECT 1 FROM creature_behaviors WHERE id = $1', [id]);
    assert.equal(row.rowCount, 0, 'the row must be gone');
  } finally {
    await deleteBehaviorByName(dbPool, 'zzApiFreeProfile');
    await dropUser(dbPool, admin && admin.id);
  }
});

// SOMET-254: a duplicate name used to reach Postgres's unique constraint
// (creature_behaviors_name_key) and come back as a raw 23505 500 instead of
// the 409 biomes/worlds already give for the exact same class of conflict
// via isUniqueViolation.
test('POST /api/creature-behaviors rejects a duplicate name with 409, not a 500', async (t) => {
  if (!dbReady(t, 'posts the same zz name twice and confirms the second is a clean 409')) return;
  let admin;
  try {
    admin = await createTestAdmin(dbPool, 'post-dupename');

    const first = await request(app).post('/api/creature-behaviors').set(authHeaderFor(admin)).send({
      ...FIXTURE_BODY,
      name: 'zzApiDupeName',
    });
    assert.equal(first.status, 201);

    const second = await request(app).post('/api/creature-behaviors').set(authHeaderFor(admin)).send({
      ...FIXTURE_BODY,
      name: 'zzApiDupeName',
    });

    assert.equal(second.status, 409);
    assert.match(second.body.error, /already exists/);

    const rows = await dbPool.query('SELECT id FROM creature_behaviors WHERE name = $1', ['zzApiDupeName']);
    assert.equal(rows.rowCount, 1, 'the duplicate must not have been inserted');
  } finally {
    await deleteBehaviorByName(dbPool, 'zzApiDupeName');
    await dropUser(dbPool, admin && admin.id);
  }
});

// SOMET-254: a non-numeric :id used to reach `WHERE id = $1` against an
// integer column and come back as a raw cast-error 500 on both PUT and
// DELETE.
test('PUT /api/creature-behaviors/:id with a non-numeric id returns 400, not a 500', async (t) => {
  if (!dbReady(t, 'PUTs to a non-numeric id and confirms it is a clean 400')) return;
  let admin;
  try {
    admin = await createTestAdmin(dbPool, 'put-badid');

    const res = await request(app).put('/api/creature-behaviors/not-a-number').set(authHeaderFor(admin)).send({
      ...FIXTURE_BODY,
      name: 'zzApiPutBadId',
    });

    assert.equal(res.status, 400);
    assert.match(res.body.error, /id/);
  } finally {
    await dropUser(dbPool, admin && admin.id);
  }
});

test('DELETE /api/creature-behaviors/:id with a non-numeric id returns 400, not a 500', async (t) => {
  if (!dbReady(t, 'DELETEs a non-numeric id and confirms it is a clean 400')) return;
  let admin;
  try {
    admin = await createTestAdmin(dbPool, 'delete-badid');

    const res = await request(app).delete('/api/creature-behaviors/not-a-number').set(authHeaderFor(admin));

    assert.equal(res.status, 400);
    assert.match(res.body.error, /id/);
  } finally {
    await dropUser(dbPool, admin && admin.id);
  }
});

// --- entity-types behavior_id / attack_element ------------------------------

test('POST /api/entity-types accepts behavior_id and attack_element', async (t) => {
  if (!dbReady(t, 'creates a zz profile then a zz entity type pointing at it with a non-physical element')) return;
  let admin;
  let behaviorId;
  try {
    admin = await createTestAdmin(dbPool, 'entitytype-post');

    const behavior = await request(app).post('/api/creature-behaviors').set(authHeaderFor(admin)).send({
      ...FIXTURE_BODY,
      name: 'zzApiEntityTypeBehavior',
    });
    assert.equal(behavior.status, 201);
    behaviorId = behavior.body.id;

    const res = await request(app).post('/api/entity-types').set(authHeaderFor(admin)).send({
      name: 'zzApiEntityTypeWithBehavior',
      color: '#abc',
      is_creature: false,
      behavior_id: behaviorId,
      attack_element: 'fire',
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.behavior_id, behaviorId);
    assert.equal(res.body.attack_element, 'fire');

    const row = await dbPool.query('SELECT behavior_id, attack_element FROM entity_types WHERE name = $1', ['zzApiEntityTypeWithBehavior']);
    assert.equal(row.rows[0].behavior_id, behaviorId);
    assert.equal(row.rows[0].attack_element, 'fire');
  } finally {
    await deleteEntityTypeByName(dbPool, 'zzApiEntityTypeWithBehavior');
    await deleteBehaviorByName(dbPool, 'zzApiEntityTypeBehavior');
    await dropUser(dbPool, admin && admin.id);
  }
});

test('PUT /api/entity-types/:id updates behavior_id and attack_element', async (t) => {
  if (!dbReady(t, 'creates a zz entity type then PUTs a new behavior_id and attack_element onto it')) return;
  let admin;
  let behaviorId;
  try {
    admin = await createTestAdmin(dbPool, 'entitytype-put');

    const behavior = await request(app).post('/api/creature-behaviors').set(authHeaderFor(admin)).send({
      ...FIXTURE_BODY,
      name: 'zzApiEntityTypeBehavior2',
    });
    assert.equal(behavior.status, 201);
    behaviorId = behavior.body.id;

    const created = await request(app).post('/api/entity-types').set(authHeaderFor(admin)).send({
      name: 'zzApiEntityTypeForPut',
      color: '#abc',
      is_creature: false,
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.attack_element, 'physical', 'attack_element must default to physical when omitted');
    const entityId = created.body.id;

    const res = await request(app).put(`/api/entity-types/${entityId}`).set(authHeaderFor(admin)).send({
      name: 'zzApiEntityTypeForPut',
      color: '#abc',
      walkable: false,
      spawn_tiles: [],
      chance: 0.1,
      is_creature: false,
      behavior_id: behaviorId,
      attack_element: 'ice',
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.behavior_id, behaviorId);
    assert.equal(res.body.attack_element, 'ice');

    const row = await dbPool.query('SELECT behavior_id, attack_element FROM entity_types WHERE id = $1', [entityId]);
    assert.equal(row.rows[0].behavior_id, behaviorId);
    assert.equal(row.rows[0].attack_element, 'ice');
  } finally {
    await deleteEntityTypeByName(dbPool, 'zzApiEntityTypeForPut');
    await deleteBehaviorByName(dbPool, 'zzApiEntityTypeBehavior2');
    await dropUser(dbPool, admin && admin.id);
  }
});

// SOMET-254: a PUT that omits behavior_id/attack_element must leave the
// existing values alone (COALESCE against the row, same as `prompt` on this
// same route) rather than falling back to `?? null`/`'physical'` -- the
// pre-fix code silently demoted a creature to no profile and reset its
// element on any partial write, even though the only real caller (the admin
// form) always sends the whole object.
test('PUT /api/entity-types/:id omitting behavior_id/attack_element leaves them unchanged', async (t) => {
  if (!dbReady(t, 'creates a zz entity type with a profile+element, then PUTs a body missing both fields')) return;
  let admin;
  try {
    admin = await createTestAdmin(dbPool, 'entitytype-put-partial');

    const behavior = await request(app).post('/api/creature-behaviors').set(authHeaderFor(admin)).send({
      ...FIXTURE_BODY,
      name: 'zzApiEntityTypePartialBehavior',
    });
    assert.equal(behavior.status, 201);
    const behaviorId = behavior.body.id;

    const created = await request(app).post('/api/entity-types').set(authHeaderFor(admin)).send({
      name: 'zzApiEntityTypeForPartialPut',
      color: '#abc',
      is_creature: false,
      behavior_id: behaviorId,
      attack_element: 'ice',
    });
    assert.equal(created.status, 201);
    const entityId = created.body.id;

    // No behavior_id, no attack_element in this body -- the partial write.
    const res = await request(app).put(`/api/entity-types/${entityId}`).set(authHeaderFor(admin)).send({
      name: 'zzApiEntityTypeForPartialPut',
      color: '#def',
      walkable: false,
      spawn_tiles: [],
      chance: 0.1,
      is_creature: false,
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.behavior_id, behaviorId, 'behavior_id must survive an omitted field, not reset to null');
    assert.equal(res.body.attack_element, 'ice', "attack_element must survive an omitted field, not reset to 'physical'");

    const row = await dbPool.query('SELECT behavior_id, attack_element FROM entity_types WHERE id = $1', [entityId]);
    assert.equal(row.rows[0].behavior_id, behaviorId);
    assert.equal(row.rows[0].attack_element, 'ice');
  } finally {
    await deleteEntityTypeByName(dbPool, 'zzApiEntityTypeForPartialPut');
    await deleteBehaviorByName(dbPool, 'zzApiEntityTypePartialBehavior');
    await dropUser(dbPool, admin && admin.id);
  }
});

// SOMET-254: attack_element and behavior_id were written through with no
// validation at all on these two routes -- an unknown element used to reach
// the entity_types_attack_element_check CHECK constraint and come back as a
// raw 500; a non-numeric behavior_id used to reach the integer FK column the
// same way.
test('POST /api/entity-types rejects an unknown attack_element with 400, not a 500', async (t) => {
  if (!dbReady(t, 'posts an entity type with an out-of-set attack_element')) return;
  let admin;
  try {
    admin = await createTestAdmin(dbPool, 'entitytype-post-badelement');

    const res = await request(app).post('/api/entity-types').set(authHeaderFor(admin)).send({
      name: 'zzApiEntityTypeBadElement',
      color: '#abc',
      is_creature: false,
      attack_element: 'poison',
    });

    assert.equal(res.status, 400);
    assert.match(res.body.error, /attack_element/);

    const row = await dbPool.query('SELECT 1 FROM entity_types WHERE name = $1', ['zzApiEntityTypeBadElement']);
    assert.equal(row.rowCount, 0, 'a rejected POST must not create a row');
  } finally {
    await deleteEntityTypeByName(dbPool, 'zzApiEntityTypeBadElement');
    await dropUser(dbPool, admin && admin.id);
  }
});

test('POST /api/entity-types rejects a non-numeric behavior_id with 400, not a 500', async (t) => {
  if (!dbReady(t, 'posts an entity type with a string behavior_id')) return;
  let admin;
  try {
    admin = await createTestAdmin(dbPool, 'entitytype-post-badbehaviorid');

    const res = await request(app).post('/api/entity-types').set(authHeaderFor(admin)).send({
      name: 'zzApiEntityTypeBadBehaviorId',
      color: '#abc',
      is_creature: false,
      behavior_id: 'not-a-number',
    });

    assert.equal(res.status, 400);
    assert.match(res.body.error, /behavior_id/);

    const row = await dbPool.query('SELECT 1 FROM entity_types WHERE name = $1', ['zzApiEntityTypeBadBehaviorId']);
    assert.equal(row.rowCount, 0, 'a rejected POST must not create a row');
  } finally {
    await deleteEntityTypeByName(dbPool, 'zzApiEntityTypeBadBehaviorId');
    await dropUser(dbPool, admin && admin.id);
  }
});

test('PUT /api/entity-types/:id rejects an unknown attack_element with 400, not a 500', async (t) => {
  if (!dbReady(t, 'creates a zz entity type then PUTs an out-of-set attack_element onto it')) return;
  let admin;
  try {
    admin = await createTestAdmin(dbPool, 'entitytype-put-badelement');

    const created = await request(app).post('/api/entity-types').set(authHeaderFor(admin)).send({
      name: 'zzApiEntityTypePutBadElement',
      color: '#abc',
      is_creature: false,
    });
    assert.equal(created.status, 201);
    const entityId = created.body.id;

    const res = await request(app).put(`/api/entity-types/${entityId}`).set(authHeaderFor(admin)).send({
      name: 'zzApiEntityTypePutBadElement',
      color: '#abc',
      walkable: false,
      spawn_tiles: [],
      chance: 0.1,
      is_creature: false,
      attack_element: 'poison',
    });

    assert.equal(res.status, 400);
    assert.match(res.body.error, /attack_element/);

    const row = await dbPool.query('SELECT attack_element FROM entity_types WHERE id = $1', [entityId]);
    assert.equal(row.rows[0].attack_element, 'physical', 'a rejected PUT must not change the stored value');
  } finally {
    await deleteEntityTypeByName(dbPool, 'zzApiEntityTypePutBadElement');
    await dropUser(dbPool, admin && admin.id);
  }
});
