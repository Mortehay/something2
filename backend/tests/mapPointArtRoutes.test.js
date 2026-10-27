// SOMET-587. Route-level tests for the World Map tab's per-instance art
// picker: PUT /api/map-links/:id/art, PUT /api/waypoints/:id/art,
// PUT /api/world-chests/:id/art, PUT /api/villages/:id/art, plus the two new
// read routes (GET /api/worlds/:id/waypoint, GET /api/worlds/:id/chest).
//
// `__setSpecDir` (mirrors `__setPool`) points every route's spec locator at a
// throwaway fixture directory for the whole file -- these tests must NEVER
// touch the real, checked-in backend/seeds/maps/*.map.json. A test that wants
// "no spec file contains this world" uses an EMPTY temp dir rather than the
// real one.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const { app, __setPool, __setSpecDir } = require('../src/index.js');
const { adminToken, isUserLookup, ADMIN_USER_ROW } = require('./helpers/auth.js');

const AUTH = ['Authorization', `Bearer ${adminToken()}`];

// Same minimal valid fixture shape as mapSpec_pointArt.test.js / specFileLocator.test.js.
function baseSpec() {
  return {
    name: 't', topology: 'grid',
    worlds: [
      {
        key: 'a', name: 'A', grid: [0, 0], seed: 1, width: 40, height: 40, chunk_size: 8,
        biomes: ['meadow'], is_entry: true, entry_spawn: { x: 1250, y: 1150 },
        waypoints: [{ x: 2050, y: 2050, name: 'Stone A' }],
        village: {
          key: 'v1', min_row: 10, min_col: 10, width: 6, height: 4, gate_edge: 'S',
          spawn_x: 1250, spawn_y: 1150,
        },
        chest: { x: 3050, y: 3050, level: 2, guard_creature_type: 'Wolf' },
      },
      { key: 'b', name: 'B', seed: 2, width: 40, height: 40, chunk_size: 8, biomes: ['meadow'] },
    ],
    links: [{ kind: 'portal', from: 'a', to: 'b', from_x: 550, from_y: 1550, to_x: 550, to_y: 550 }],
  };
}

let tmpDir;
test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapPointArtRoutes-test-'));
  __setSpecDir(tmpDir);
});
test.afterEach(() => {
  __setSpecDir(undefined); // next test's beforeEach sets a fresh one; belt-and-suspenders
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeFixture(spec = baseSpec(), name = 'one.map.json') {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, `${JSON.stringify(spec, null, 2)}\n`);
  return file;
}

// The four mapSpecCatalogsWithArt() queries, answered the same way for every
// test in this file -- `stone_gate`/`waypoint_stone`/`merchant_post`/
// `chest_vault` are the only names these tests ever resolve, and none of
// them need a real biome/creature/boss catalog to validate (the fixture spec
// carries no boss, and its one creature-type reference, "Wolf" on the vault
// chest, is unchecked when creatureTypeNames is omitted -- see mapSpec.js's
// `if (creatureTypeNames)` guard).
function catalogHandlers() {
  return [
    [/SELECT name, creature_types FROM biomes/i, () => ({ rows: [{ name: 'meadow', creature_types: [] }] })],
    // "Wolf" is the fixture chest's guard_creature_type (checkBoss/checkArt
    // are not involved, but mapSpec.js's chest block checks
    // `creatureTypeNames.has(c.guard_creature_type)` whenever this Set is
    // non-null) -- without it every happy-path test here would abort on an
    // UNRELATED error, which is not what any of them are testing.
    [/SELECT name FROM entity_types WHERE is_creature = true/i, () => ({ rows: [{ name: 'Wolf' }] })],
    [/SELECT name, boss_tier FROM entity_types WHERE is_creature = true AND boss_tier IS NOT NULL/i, () => ({ rows: [] })],
    [/SELECT id, name, point_kind FROM entity_types WHERE point_kind IS NOT NULL/i, () => ({ rows: [
      { name: 'stone_gate', point_kind: 'portal' },
      { name: 'waypoint_stone', point_kind: 'waypoint' },
      { name: 'merchant_post', point_kind: 'merchant' },
      { name: 'chest_vault', point_kind: 'chest_vault' },
    ] })],
  ];
}

function mockPool(handlers) {
  const calls = [];
  const dispatch = async (sql, params) => {
    if (isUserLookup(sql)) return ADMIN_USER_ROW;
    calls.push({ sql, params });
    for (const [re, fn] of handlers) if (re.test(sql)) return fn(params);
    throw new Error(`unexpected query: ${sql}`);
  };
  return { calls, query: dispatch, connect: async () => ({ query: dispatch, release: () => {} }) };
}

test('PUT /api/map-links/:id/art: happy path on the DEPARTURE row writes the spec `art` field and ONLY that one DB row', async () => {
  const file = writeFixture();
  const pool = mockPool([
    [/SELECT ml\.id, ml\.from_world_id/i, () => ({ rows: [{
      id: 'link1', from_world_id: 'wa', to_world_id: 'wb', edge: 'PORTAL',
      from_x: 550, from_y: 1550, to_x: 550, to_y: 550, from_world_name: 'A',
    }] })],
    [/SELECT id, point_kind FROM entity_types WHERE name = \$1/i, () => ({ rows: [{ id: 42, point_kind: 'portal' }] })],
    ...catalogHandlers(),
    [/UPDATE map_links SET entity_type_id/i, () => ({ rows: [], rowCount: 1 })],
  ]);
  __setPool(pool);

  const res = await request(app).put('/api/map-links/link1/art').set(...AUTH).send({ art_name: 'stone_gate' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.art, 'stone_gate');
  assert.equal(res.body.entity_type_id, 42);
  assert.equal(res.body.side, 'departure');

  // SOMET-586/587: the two doorway rows no longer necessarily share one
  // entity type, so only the single row `:id` addresses is written -- never
  // its mirror (`wb`'s row). That is what the arrival-side test below is for.
  const updates = pool.calls.filter((c) => /UPDATE map_links SET entity_type_id/i.test(c.sql));
  assert.equal(updates.length, 1, 'only the addressed row is updated, not its mirror');
  assert.deepStrictEqual(updates[0].params, ['link1', 42]);

  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(written.links[0].art, 'stone_gate');
  assert.equal('to_art' in written.links[0], false, 'the arrival field is untouched');
});

test('PUT /api/map-links/:id/art: clearing (art_name: null) on the DEPARTURE side deletes the spec `art` field and nulls that one DB row', async () => {
  const spec = baseSpec();
  spec.links[0].art = 'stone_gate';
  const file = writeFixture(spec);
  const pool = mockPool([
    [/SELECT ml\.id, ml\.from_world_id/i, () => ({ rows: [{
      id: 'link1', from_world_id: 'wa', to_world_id: 'wb', edge: 'PORTAL',
      from_x: 550, from_y: 1550, to_x: 550, to_y: 550, from_world_name: 'A',
    }] })],
    ...catalogHandlers(),
    [/UPDATE map_links SET entity_type_id/i, () => ({ rows: [], rowCount: 1 })],
  ]);
  __setPool(pool);

  const res = await request(app).put('/api/map-links/link1/art').set(...AUTH).send({ art_name: null });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.art, null);
  const updates = pool.calls.filter((c) => /UPDATE map_links SET entity_type_id/i.test(c.sql));
  assert.deepStrictEqual(updates.map((u) => u.params), [['link1', null]]);

  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal('art' in written.links[0], false);
});

test('PUT /api/map-links/:id/art: setting the ARRIVAL side to a name distinct from departure adds an explicit to_art key', async () => {
  const spec = baseSpec();
  spec.links[0].art = 'stone_gate';
  const file = writeFixture(spec);
  const pool = mockPool([
    [/SELECT ml\.id, ml\.from_world_id/i, () => ({ rows: [{
      id: 'link1-mirror', from_world_id: 'wb', to_world_id: 'wa', edge: 'PORTAL',
      from_x: 550, from_y: 550, to_x: 550, to_y: 1550, from_world_name: 'B',
    }] })],
    [/SELECT id, point_kind FROM entity_types WHERE name = \$1/i, () => ({ rows: [{ id: 43, point_kind: 'portal' }] })],
    [/SELECT name, creature_types FROM biomes/i, () => ({ rows: [{ name: 'meadow', creature_types: [] }] })],
    [/SELECT name FROM entity_types WHERE is_creature = true/i, () => ({ rows: [{ name: 'Wolf' }] })],
    [/SELECT name, boss_tier FROM entity_types WHERE is_creature = true AND boss_tier IS NOT NULL/i, () => ({ rows: [] })],
    [/SELECT id, name, point_kind FROM entity_types WHERE point_kind IS NOT NULL/i, () => ({ rows: [
      { name: 'stone_gate', point_kind: 'portal' },
      { name: 'dungeon_door', point_kind: 'portal' },
    ] })],
    [/UPDATE map_links SET entity_type_id/i, () => ({ rows: [], rowCount: 1 })],
  ]);
  __setPool(pool);

  const res = await request(app).put('/api/map-links/link1-mirror/art').set(...AUTH).send({ art_name: 'dungeon_door' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.side, 'arrival');

  const updates = pool.calls.filter((c) => /UPDATE map_links SET entity_type_id/i.test(c.sql));
  assert.equal(updates.length, 1, 'only the mirror row is updated, not the departure row');
  assert.deepStrictEqual(updates[0].params, ['link1-mirror', 43]);

  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(written.links[0].art, 'stone_gate', 'departure is untouched');
  assert.equal(written.links[0].to_art, 'dungeon_door');
});

test('PUT /api/map-links/:id/art: setting the ARRIVAL side back to the SAME name as departure deletes to_art rather than writing a redundant duplicate', async () => {
  const spec = baseSpec();
  spec.links[0].art = 'stone_gate';
  spec.links[0].to_art = 'dungeon_door';
  const file = writeFixture(spec);
  const pool = mockPool([
    [/SELECT ml\.id, ml\.from_world_id/i, () => ({ rows: [{
      id: 'link1-mirror', from_world_id: 'wb', to_world_id: 'wa', edge: 'PORTAL',
      from_x: 550, from_y: 550, to_x: 550, to_y: 1550, from_world_name: 'B',
    }] })],
    [/SELECT id, point_kind FROM entity_types WHERE name = \$1/i, () => ({ rows: [{ id: 42, point_kind: 'portal' }] })],
    [/SELECT name, creature_types FROM biomes/i, () => ({ rows: [{ name: 'meadow', creature_types: [] }] })],
    [/SELECT name FROM entity_types WHERE is_creature = true/i, () => ({ rows: [{ name: 'Wolf' }] })],
    [/SELECT name, boss_tier FROM entity_types WHERE is_creature = true AND boss_tier IS NOT NULL/i, () => ({ rows: [] })],
    [/SELECT id, name, point_kind FROM entity_types WHERE point_kind IS NOT NULL/i, () => ({ rows: [
      { name: 'stone_gate', point_kind: 'portal' },
      { name: 'dungeon_door', point_kind: 'portal' },
    ] })],
    [/UPDATE map_links SET entity_type_id/i, () => ({ rows: [], rowCount: 1 })],
  ]);
  __setPool(pool);

  const res = await request(app).put('/api/map-links/link1-mirror/art').set(...AUTH).send({ art_name: 'stone_gate' });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(written.links[0].art, 'stone_gate');
  assert.equal('to_art' in written.links[0], false, 'to_art is deleted, not set to a redundant duplicate of art');
});

test('PUT /api/map-links/:id/art: 404 when the link does not exist', async () => {
  const pool = mockPool([
    [/SELECT ml\.id, ml\.from_world_id/i, () => ({ rows: [] })],
  ]);
  __setPool(pool);
  const res = await request(app).put('/api/map-links/nope/art').set(...AUTH).send({ art_name: 'stone_gate' });
  assert.equal(res.status, 404);
});

test('PUT /api/map-links/:id/art: 400 on a compass edge (no art to carry)', async () => {
  const pool = mockPool([
    [/SELECT ml\.id, ml\.from_world_id/i, () => ({ rows: [{
      id: 'link1', from_world_id: 'wa', to_world_id: 'wb', edge: 'N',
      from_x: null, from_y: null, to_x: null, to_y: null, from_world_name: 'A',
    }] })],
  ]);
  __setPool(pool);
  const res = await request(app).put('/api/map-links/link1/art').set(...AUTH).send({ art_name: 'stone_gate' });
  assert.equal(res.status, 400);
});

test('PUT /api/map-links/:id/art: 400 when the name is the wrong point_kind', async () => {
  const pool = mockPool([
    [/SELECT ml\.id, ml\.from_world_id/i, () => ({ rows: [{
      id: 'link1', from_world_id: 'wa', to_world_id: 'wb', edge: 'PORTAL',
      from_x: 550, from_y: 1550, to_x: 550, to_y: 550, from_world_name: 'A',
    }] })],
    [/SELECT id, point_kind FROM entity_types WHERE name = \$1/i, () => ({ rows: [{ id: 99, point_kind: 'waypoint' }] })],
  ]);
  __setPool(pool);
  const res = await request(app).put('/api/map-links/link1/art').set(...AUTH).send({ art_name: 'waypoint_stone' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /not an entity type of point kind "portal"/);
});

test('PUT /api/map-links/:id/art: 400 when art_name is missing from the body entirely', async () => {
  const pool = mockPool([
    [/SELECT ml\.id, ml\.from_world_id/i, () => ({ rows: [{
      id: 'link1', from_world_id: 'wa', to_world_id: 'wb', edge: 'PORTAL',
      from_x: 550, from_y: 1550, to_x: 550, to_y: 550, from_world_name: 'A',
    }] })],
  ]);
  __setPool(pool);
  const res = await request(app).put('/api/map-links/link1/art').set(...AUTH).send({});
  assert.equal(res.status, 400);
  assert.match(res.body.error, /art_name is required/);
});

test('PUT /api/map-links/:id/art: 422 and NO db write when no spec file contains this world', async () => {
  // Empty tmpDir -- no fixture written at all.
  const pool = mockPool([
    [/SELECT ml\.id, ml\.from_world_id/i, () => ({ rows: [{
      id: 'link1', from_world_id: 'wa', to_world_id: 'wb', edge: 'PORTAL',
      from_x: 550, from_y: 1550, to_x: 550, to_y: 550, from_world_name: 'A',
    }] })],
    [/SELECT id, point_kind FROM entity_types WHERE name = \$1/i, () => ({ rows: [{ id: 42, point_kind: 'portal' }] })],
  ]);
  __setPool(pool);
  const res = await request(app).put('/api/map-links/link1/art').set(...AUTH).send({ art_name: 'stone_gate' });
  assert.equal(res.status, 422);
  assert.ok(!pool.calls.some((c) => /UPDATE map_links SET entity_type_id/i.test(c.sql)),
    'a 422 refusal must never touch the database -- that would be the rejected "DB-only write" path');
});

test('PUT /api/map-links/:id/art: aborts with 400 and touches neither the file nor the DB when the write would make the spec invalid', async () => {
  // A deliberately inconsistent pair of catalog answers: the per-name
  // resolver (SELECT ... WHERE name = $1, the route's OWN lookup) accepts
  // "ghost_gate" as a portal type, but the FULL catalog query
  // mapSpecCatalogsWithArt uses for validateMapSpec's checkArt does not list
  // it at all -- so writeSpecFieldChange's own validation step is what
  // rejects this, not the resolver. This is the shape of a real race (the
  // catalog changing between the two reads) exercised deterministically.
  const file = writeFixture();
  const before = fs.readFileSync(file, 'utf8');
  const pool = mockPool([
    [/SELECT ml\.id, ml\.from_world_id/i, () => ({ rows: [{
      id: 'link1', from_world_id: 'wa', to_world_id: 'wb', edge: 'PORTAL',
      from_x: 550, from_y: 1550, to_x: 550, to_y: 550, from_world_name: 'A',
    }] })],
    [/SELECT id, point_kind FROM entity_types WHERE name = \$1/i, () => ({ rows: [{ id: 42, point_kind: 'portal' }] })],
    [/SELECT name, creature_types FROM biomes/i, () => ({ rows: [{ name: 'meadow', creature_types: [] }] })],
    [/SELECT name FROM entity_types WHERE is_creature = true/i, () => ({ rows: [] })],
    [/SELECT name, boss_tier FROM entity_types WHERE is_creature = true AND boss_tier IS NOT NULL/i, () => ({ rows: [] })],
    [/SELECT id, name, point_kind FROM entity_types WHERE point_kind IS NOT NULL/i, () => ({ rows: [] })], // "ghost_gate" absent
    [/UPDATE map_links SET entity_type_id/i, () => ({ rows: [], rowCount: 1 })],
  ]);
  __setPool(pool);
  const res = await request(app).put('/api/map-links/link1/art').set(...AUTH).send({ art_name: 'ghost_gate' });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.match(res.body.error, /not an entity type of point kind "portal"/);
  assert.ok(!pool.calls.some((c) => /UPDATE map_links SET entity_type_id/i.test(c.sql)),
    'an aborted write must never reach the database');
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'an aborted write must leave the spec file untouched');
});

test('PUT /api/waypoints/:id/art: happy path', async () => {
  const file = writeFixture();
  const pool = mockPool([
    [/SELECT wp\.id, wp\.world_id/i, () => ({ rows: [{ id: 'wp1', world_id: 'wa', world_name: 'A' }] })],
    [/SELECT id, point_kind FROM entity_types WHERE name = \$1/i, () => ({ rows: [{ id: 7, point_kind: 'waypoint' }] })],
    ...catalogHandlers(),
    [/UPDATE waypoints SET entity_type_id/i, () => ({ rows: [], rowCount: 1 })],
  ]);
  __setPool(pool);
  const res = await request(app).put('/api/waypoints/wp1/art').set(...AUTH).send({ art_name: 'waypoint_stone' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.entity_type_id, 7);
  const updates = pool.calls.filter((c) => /UPDATE waypoints SET entity_type_id/i.test(c.sql));
  assert.deepStrictEqual(updates[0].params, ['wp1', 7]);
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(written.worlds[0].waypoints[0].art, 'waypoint_stone');
});

test('PUT /api/waypoints/:id/art: 404 when not found', async () => {
  const pool = mockPool([[/SELECT wp\.id, wp\.world_id/i, () => ({ rows: [] })]]);
  __setPool(pool);
  const res = await request(app).put('/api/waypoints/nope/art').set(...AUTH).send({ art_name: 'waypoint_stone' });
  assert.equal(res.status, 404);
});

test('PUT /api/waypoints/:id/art: 422 with no spec file at all', async () => {
  const pool = mockPool([
    [/SELECT wp\.id, wp\.world_id/i, () => ({ rows: [{ id: 'wp1', world_id: 'wa', world_name: 'A' }] })],
    [/SELECT id, point_kind FROM entity_types WHERE name = \$1/i, () => ({ rows: [{ id: 7, point_kind: 'waypoint' }] })],
  ]);
  __setPool(pool);
  const res = await request(app).put('/api/waypoints/wp1/art').set(...AUTH).send({ art_name: 'waypoint_stone' });
  assert.equal(res.status, 422);
  assert.ok(!pool.calls.some((c) => /UPDATE waypoints SET entity_type_id/i.test(c.sql)));
});

test('PUT /api/world-chests/:id/art: happy path', async () => {
  const file = writeFixture();
  const pool = mockPool([
    [/SELECT c\.id, c\.world_id, c\.kind/i, () => ({ rows: [{ id: 'ch1', world_id: 'wa', kind: 'vault', world_name: 'A' }] })],
    [/SELECT id, point_kind FROM entity_types WHERE name = \$1/i, () => ({ rows: [{ id: 9, point_kind: 'chest_vault' }] })],
    ...catalogHandlers(),
    [/UPDATE world_chests SET entity_type_id/i, () => ({ rows: [], rowCount: 1 })],
  ]);
  __setPool(pool);
  const res = await request(app).put('/api/world-chests/ch1/art').set(...AUTH).send({ art_name: 'chest_vault' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const updates = pool.calls.filter((c) => /UPDATE world_chests SET entity_type_id/i.test(c.sql));
  assert.deepStrictEqual(updates[0].params, ['ch1', 9]);
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(written.worlds[0].chest.art, 'chest_vault');
});

test('PUT /api/world-chests/:id/art: 400 for a field chest (not spec-authored)', async () => {
  const pool = mockPool([
    [/SELECT c\.id, c\.world_id, c\.kind/i, () => ({ rows: [{ id: 'ch2', world_id: 'wa', kind: 'field', world_name: 'A' }] })],
  ]);
  __setPool(pool);
  const res = await request(app).put('/api/world-chests/ch2/art').set(...AUTH).send({ art_name: 'chest_vault' });
  assert.equal(res.status, 400);
});

test('PUT /api/villages/:id/art: happy path on the singular village shape', async () => {
  const file = writeFixture();
  const pool = mockPool([
    [/SELECT v\.id, v\.world_id, v\.spec_key/i, () => ({ rows: [{ id: 'v1', world_id: 'wa', spec_key: 'v1', world_name: 'A' }] })],
    [/SELECT id, point_kind FROM entity_types WHERE name = \$1/i, () => ({ rows: [{ id: 11, point_kind: 'merchant' }] })],
    ...catalogHandlers(),
    [/UPDATE villages SET merchant_entity_type_id/i, () => ({ rows: [], rowCount: 1 })],
  ]);
  __setPool(pool);
  const res = await request(app).put('/api/villages/v1/art').set(...AUTH)
    .send({ slot: 'merchant', art_name: 'merchant_post' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const updates = pool.calls.filter((c) => /UPDATE villages SET merchant_entity_type_id/i.test(c.sql));
  assert.deepStrictEqual(updates[0].params, ['v1', 11]);
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(written.worlds[0].village.art.merchant, 'merchant_post');
});

test('PUT /api/villages/:id/art: 400 for an unknown slot', async () => {
  const pool = mockPool([]);
  __setPool(pool);
  const res = await request(app).put('/api/villages/v1/art').set(...AUTH)
    .send({ slot: 'tavern', art_name: 'merchant_post' });
  assert.equal(res.status, 400);
});

test('PUT /api/villages/:id/art: 422 when the village has no spec_key (a hand-created row)', async () => {
  writeFixture();
  const pool = mockPool([
    [/SELECT v\.id, v\.world_id, v\.spec_key/i, () => ({ rows: [{ id: 'v9', world_id: 'wa', spec_key: null, world_name: 'A' }] })],
    [/SELECT id, point_kind FROM entity_types WHERE name = \$1/i, () => ({ rows: [{ id: 11, point_kind: 'merchant' }] })],
  ]);
  __setPool(pool);
  const res = await request(app).put('/api/villages/v9/art').set(...AUTH)
    .send({ slot: 'merchant', art_name: 'merchant_post' });
  assert.equal(res.status, 422);
  assert.ok(!pool.calls.some((c) => /UPDATE villages SET/i.test(c.sql)));
});

test('GET /api/worlds/:id/waypoint returns the single waypoint or null', async () => {
  const pool = mockPool([
    [/FROM waypoints wp\s+LEFT JOIN entity_types/i, (p) => ({ rows: p[0] === 'has-one'
      ? [{ id: 'wp1', world_id: 'has-one', x: 1, y: 2, name: 'Stone A', map_link_id: null, art: null }]
      : [] }),
    ],
  ]);
  __setPool(pool);
  const withOne = await request(app).get('/api/worlds/has-one/waypoint').set(...AUTH);
  assert.equal(withOne.status, 200);
  assert.equal(withOne.body.name, 'Stone A');
  const withNone = await request(app).get('/api/worlds/none/waypoint').set(...AUTH);
  assert.equal(withNone.status, 200);
  assert.equal(withNone.body, null);
});

test('GET /api/worlds/:id/chest returns the vault chest or null, ignoring field chests', async () => {
  const pool = mockPool([
    [/FROM world_chests c\s+LEFT JOIN entity_types/i, (p) => ({ rows: p[0] === 'has-vault'
      ? [{ id: 'ch1', x: 1, y: 2, kind: 'vault', guard_entity_type_id: 5, guard_level: 1, guard_creature_ids: [], state: 'locked', opened_at: null, respawn_at: null, art: null },
          { id: 'ch2', x: 3, y: 4, kind: 'field', guard_entity_type_id: 5, guard_level: 1, guard_creature_ids: [], state: 'locked', opened_at: null, respawn_at: null, art: null }]
      : [] }),
    ],
  ]);
  __setPool(pool);
  const withVault = await request(app).get('/api/worlds/has-vault/chest').set(...AUTH);
  assert.equal(withVault.status, 200);
  assert.equal(withVault.body.kind, 'vault');
  const withNone = await request(app).get('/api/worlds/none/chest').set(...AUTH);
  assert.equal(withNone.status, 200);
  assert.equal(withNone.body, null);
});
