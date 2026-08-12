// SOMET-228: PUT /api/entity-types/:id used to 409 a rename that would
// orphan worlds.allowed_creature_types / world_creatures.type / biomes
// flora_types|creature_types (SOMET-185). It now cascades: it rewrites every
// referencing name to the new one in the SAME transaction as the
// entity_types row update, so the rename always succeeds and nothing is left
// inconsistent.
//
// entityTypes.test.js and biomesApi.test.js already cover the route's SQL
// shape with canned-response mocks. This file is the atomicity proof: it
// builds a pool with real committed/pending state (not a mock that just
// returns fixed rows), so a GET after a simulated mid-cascade failure is
// genuine evidence a rollback actually undid EVERY write -- including the
// worlds cascade, which runs and "succeeds" before the later, failing biomes
// UPDATE -- not an assumption about what ROLLBACK "should" do. Mirrors
// tests/villageCreateTransaction.test.js's technique.
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { app, __setPool } = require('../src/index.js');
const { adminToken, isUserLookup, ADMIN_USER_ROW } = require('./helpers/auth.js');

const AUTH = ['Authorization', `Bearer ${adminToken()}`];

// Applies the SAME per-element rewrite the route's SQL performs (rename only
// the matching element, leave everything else -- including a duplicate of a
// name that isn't oldName -- untouched). Used by the fake client to keep its
// in-memory jsonb arrays honest, so this test's "before/after" comparison
// means something.
function renameElement(arr, oldName, newName) {
  return arr.map((v) => (v === oldName ? newName : v));
}

function mkCascadePool({ failOnBiomesUpdate = false } = {}) {
  let committed = {
    entityType: { id: 5, name: 'AuditFixtureBeast' },
    world: { id: 'w1', allowed_creature_types: ['AuditFixtureBeast', 'Goblin'] },
    biome: { id: 'b1', flora_types: ['AuditFixtureBeast'], creature_types: ['Slime'] },
    hasPlacedCreature: true,
  };
  let pending = null;

  const client = {
    query: async (sql, params) => {
      const s = sql.trim();
      if (/^BEGIN$/i.test(s)) {
        pending = JSON.parse(JSON.stringify(committed));
        return { rows: [] };
      }
      if (/^COMMIT$/i.test(s)) {
        committed = pending;
        pending = null;
        return { rows: [] };
      }
      if (/^ROLLBACK$/i.test(s)) {
        pending = null;
        return { rows: [] };
      }
      if (/SELECT name FROM entity_types WHERE id/i.test(s)) {
        return { rows: [{ name: pending.entityType.name }] };
      }
      if (/SELECT id, name FROM worlds WHERE allowed_creature_types/i.test(s)) {
        const [oldName] = JSON.parse(params[0]);
        return pending.world.allowed_creature_types.includes(oldName)
          ? { rows: [{ id: pending.world.id, name: pending.world.id }] }
          : { rows: [] };
      }
      if (/SELECT 1 FROM world_creatures WHERE type/i.test(s)) {
        return pending.hasPlacedCreature ? { rows: [{ '?column?': 1 }] } : { rows: [] };
      }
      if (/SELECT id, name FROM biomes WHERE flora_types/i.test(s)) {
        const [oldName] = JSON.parse(params[0]);
        const hit = pending.biome.flora_types.includes(oldName) || pending.biome.creature_types.includes(oldName);
        return hit ? { rows: [{ id: pending.biome.id, name: pending.biome.id }] } : { rows: [] };
      }
      if (/UPDATE worlds\b[\s\S]*allowed_creature_types/i.test(s)) {
        const [oldName, newName] = params;
        pending.world.allowed_creature_types = renameElement(pending.world.allowed_creature_types, oldName, newName);
        return { rowCount: 1, rows: [] };
      }
      if (/UPDATE world_creatures SET type/i.test(s)) {
        return { rowCount: 1, rows: [] };
      }
      if (/UPDATE biomes\b/i.test(s)) {
        if (failOnBiomesUpdate) throw new Error('simulated biomes cascade failure');
        const [oldName, newName] = params;
        pending.biome.flora_types = renameElement(pending.biome.flora_types, oldName, newName);
        pending.biome.creature_types = renameElement(pending.biome.creature_types, oldName, newName);
        return { rowCount: 1, rows: [] };
      }
      if (/UPDATE entity_types SET/i.test(s)) {
        pending.entityType.name = params[0];
        return { rows: [{ id: pending.entityType.id, name: pending.entityType.name }] };
      }
      throw new Error('unexpected client query: ' + s);
    },
    release: () => {},
  };

  return {
    query: async (sql, params) => {
      if (isUserLookup(sql)) return ADMIN_USER_ROW;
      if (/SELECT \* FROM entity_types ORDER BY id/i.test(sql)) return { rows: [committed.entityType] };
      if (/SELECT \* FROM worlds WHERE id/i.test(sql)) {
        return params[0] === committed.world.id ? { rows: [committed.world] } : { rows: [] };
      }
      throw new Error('unexpected pool query: ' + sql);
    },
    connect: async () => client,
  };
}

test('a successful rename commits the entity_types row AND every cascaded reference (control)', async () => {
  const pool = mkCascadePool({ failOnBiomesUpdate: false });
  __setPool(pool);

  const putRes = await request(app).put('/api/entity-types/5').set(...AUTH)
    .send({ name: 'Timber Wolf', color: '#0f0' });
  assert.equal(putRes.status, 200, JSON.stringify(putRes.body));
  assert.equal(putRes.body.name, 'Timber Wolf');
  assert.deepEqual(putRes.body.renamedReferences, { worlds: 1, biomes: 1, hadPlacedCreatures: true });

  const typesRes = await request(app).get('/api/entity-types');
  assert.equal(typesRes.status, 200);
  assert.equal(typesRes.body[0].name, 'Timber Wolf');

  const worldRes = await request(app).get('/api/worlds/w1').set(...AUTH);
  assert.equal(worldRes.status, 200);
  assert.deepEqual(worldRes.body.allowed_creature_types, ['Timber Wolf', 'Goblin']);
});

test('a mid-cascade failure rolls back: the entity_types name AND every cascaded reference stay unchanged', async () => {
  const pool = mkCascadePool({ failOnBiomesUpdate: true });
  __setPool(pool);

  const putRes = await request(app).put('/api/entity-types/5').set(...AUTH)
    .send({ name: 'Timber Wolf', color: '#0f0' });
  assert.equal(putRes.status, 500);

  const typesRes = await request(app).get('/api/entity-types');
  assert.equal(typesRes.status, 200);
  assert.equal(
    typesRes.body[0].name,
    'AuditFixtureBeast',
    'entity_types name must NOT change when the cascade fails partway through',
  );

  // The worlds cascade runs and "succeeds" BEFORE the failing biomes UPDATE
  // (both are inside the same transaction, in that order) -- this is the
  // real atomicity proof: an earlier statement succeeding inside the
  // transaction must not survive a later statement's failure.
  const worldRes = await request(app).get('/api/worlds/w1').set(...AUTH);
  assert.equal(worldRes.status, 200);
  assert.deepEqual(
    worldRes.body.allowed_creature_types,
    ['AuditFixtureBeast', 'Goblin'],
    'worlds cascade must be rolled back even though its own UPDATE ran and returned success before the later biomes UPDATE failed',
  );
});
