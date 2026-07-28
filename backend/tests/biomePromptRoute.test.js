const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
// helpers/auth.js MUST be required before ../src/index.js — it sets JWT_SECRET
// before the guards read it.
const { adminToken, isUserLookup, ADMIN_USER_ROW } = require('./helpers/auth.js');
const { app, __setPool, __setSpriteGen } = require('../src/index.js');

const AUTH = ['Authorization', `Bearer ${adminToken()}`];

const BIOME_ROW = {
  id: 3, name: 'Arid Dunes',
  terrain_tiles: ['sand'], flora_types: [], creature_types: [],
  palette: ['ochre', 'gold'], art_style: 'sun-bleached', exclusions: 'no grass',
  color: '#c9a227',
};

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

const INSERT_JOB = [/INSERT INTO sprite_sets/i, (p) => ({ rows: [{ id: 1, job_id: p[4] }] })];

// Capture the payload the route forwards to sprite-gen.
function captureGenerate() {
  const seen = [];
  __setSpriteGen({
    postGenerate: async (body) => { seen.push(body); return { job_id: 'job-1', recipe: { backend: 'stub', frames: 1 } }; },
    getCapability: async () => ({ tier: 'cpu' }),
  });
  return seen;
}

test('a biome name composes its art context into base_prompt', async () => {
  const seen = captureGenerate();
  __setPool(mockPool([[/FROM biomes/i, () => ({ rows: [BIOME_ROW] })], INSERT_JOB]));

  const res = await request(app).post('/api/tile-jobs').set(...AUTH)
    .send({ tile_type: 'sand', base_prompt: 'desert sand', biome: 'Arid Dunes' });

  assert.equal(res.status, 201);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].base_prompt, 'desert sand, ochre, gold palette, sun-bleached. Avoid: no grass');
  // The rest of the payload is untouched by biome composition.
  assert.equal(seen[0].kind, 'tile');
  assert.equal(seen[0].creature, 'sand');
});

test('no biome forwards the base prompt unchanged and never queries biomes', async () => {
  const seen = captureGenerate();
  const pool = mockPool([INSERT_JOB]);
  __setPool(pool);

  const res = await request(app).post('/api/tile-jobs').set(...AUTH)
    .send({ tile_type: 'sand', base_prompt: 'desert sand' });

  assert.equal(res.status, 201);
  assert.equal(seen[0].base_prompt, 'desert sand');
  assert.ok(!pool.calls.some((c) => /FROM biomes/i.test(c.sql)));
});

test('an unknown biome name degrades to the plain base prompt rather than failing', async () => {
  const seen = captureGenerate();
  __setPool(mockPool([[/FROM biomes/i, () => ({ rows: [] })], INSERT_JOB]));

  const res = await request(app).post('/api/tile-jobs').set(...AUTH)
    .send({ tile_type: 'sand', base_prompt: 'desert sand', biome: 'Atlantis' });

  assert.equal(res.status, 201);
  assert.equal(seen[0].base_prompt, 'desert sand');
});

test('entity jobs get biome context too (all three kinds share the funnel)', async () => {
  const seen = captureGenerate();
  __setPool(mockPool([[/FROM biomes/i, () => ({ rows: [BIOME_ROW] })], INSERT_JOB]));

  const res = await request(app).post('/api/entity-jobs').set(...AUTH)
    .send({ entity_type: 'dead_tree', base_prompt: 'a bleached dead tree', biome: 'Arid Dunes' });

  assert.equal(res.status, 201);
  assert.equal(seen[0].base_prompt, 'a bleached dead tree, ochre, gold palette, sun-bleached. Avoid: no grass');
  assert.equal(seen[0].kind, 'object');
});
