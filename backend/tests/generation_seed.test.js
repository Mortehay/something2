const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { adminToken, isUserLookup, ADMIN_USER_ROW } = require('./helpers/auth.js');
const { app, __setPool, __setSpriteGen } = require('../src/index.js');
const { seedFor } = require('../src/services/bulkImageRegeneration');

const AUTH = ['Authorization', `Bearer ${adminToken()}`];

// Generation is DETERMINISTIC: the same prompt, model and seed return a
// byte-identical image (verified against the LAN provider -- two calls, one
// sha256, one cutout measurement). The interactive job routes used to send a
// flat seed 0, which made that determinism bite twice:
//
//   * every subject started from identical noise, the failure mode
//     bulkImageRegeneration.seedFor exists to fix (four tiles at seed 0
//     measured +0.83 mean pairwise structural correlation); and
//   * pressing "Generate image" again reproduced the previous picture exactly,
//     so a provider-side refusal -- "cutout produced no transparency (0.0%):
//     ... This would be an opaque square" -- was PERMANENT for that subject.
//     No retry could differ; only editing the prompt escaped it.

// Captures the seed that reaches sprite-gen for a subject that already has
// `priorRuns` generations recorded.
async function seedSentFor(path, body, priorRuns) {
  let sent = null;
  __setSpriteGen({
    postGenerate: async (b) => { sent = b; return { job_id: 'j1', recipe: { backend: 'stub', frames: 1 } }; },
    getCapability: async () => ({ tier: 'cpu' }),
  });
  __setPool({
    query: async (sql, params) => {
      if (isUserLookup(sql)) return ADMIN_USER_ROW;
      if (/SELECT COUNT\(\*\)::int AS n FROM sprite_sets/i.test(sql)) return { rows: [{ n: priorRuns }] };
      if (/INSERT INTO sprite_sets/i.test(sql)) return { rows: [{ id: 1, job_id: params[4] }] };
      if (/SELECT ai_provider_mode/i.test(sql)) return { rows: [] };
      if (/FROM ai_providers/i.test(sql)) return { rows: [] };
      if (/FROM biomes/i.test(sql)) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    },
  });
  const res = await request(app).post(path).set(...AUTH).send(body);
  assert.equal(res.status, 201, `expected the job to start, got ${res.status} ${res.text}`);
  return sent.seed;
}

test('a first generation uses the same per-subject seed a bulk run would', async () => {
  const seed = await seedSentFor('/api/entity-jobs', { entity_type: 'Slime', base_prompt: 'a slime' }, 0);
  assert.equal(seed, seedFor({ table: 'entity_types', name: 'Slime' }, 0),
    'the interactive path and the bulk path must not disagree about a subject\'s seed');
  assert.notStrictEqual(seed, 0, 'seed 0 is the shared-noise bug this replaces');
});

test('two subjects do not start from the same noise', async () => {
  const slime = await seedSentFor('/api/entity-jobs', { entity_type: 'Slime', base_prompt: 'x' }, 0);
  const wolf = await seedSentFor('/api/entity-jobs', { entity_type: 'Wolf', base_prompt: 'x' }, 0);
  assert.notStrictEqual(slime, wolf);
});

test('retrying a subject resamples, so a cutout refusal is not permanent', async () => {
  // The whole point: press Generate again and the provider is asked for a
  // DIFFERENT picture. Equal seeds here would mean an identical PNG and an
  // identical refusal, forever.
  const first = await seedSentFor('/api/entity-jobs', { entity_type: 'Slime', base_prompt: 'x' }, 0);
  const second = await seedSentFor('/api/entity-jobs', { entity_type: 'Slime', base_prompt: 'x' }, 1);
  const third = await seedSentFor('/api/entity-jobs', { entity_type: 'Slime', base_prompt: 'x' }, 2);
  assert.notStrictEqual(first, second);
  assert.notStrictEqual(second, third);
  assert.notStrictEqual(first, third);
});

test('tiles and entities of the same name get different seeds', async () => {
  // seedFor keys on table:name, so the tile 'rocks' and an entity 'rocks' are
  // different subjects. Deriving the table from `kind` is what preserves that.
  const asEntity = await seedSentFor('/api/entity-jobs', { entity_type: 'rocks', base_prompt: 'x' }, 0);
  const asTile = await seedSentFor('/api/tile-jobs', { tile_type: 'rocks', base_prompt: 'x' }, 0);
  assert.notStrictEqual(asEntity, asTile);
});

test('an explicitly requested seed still wins, so a run stays reproducible', async () => {
  const seed = await seedSentFor('/api/entity-jobs', { entity_type: 'Slime', base_prompt: 'x', seed: 4242 }, 9);
  assert.equal(seed, 4242);
});

test('an explicit seed of 0 is honoured rather than treated as absent', async () => {
  // `seed = 0` as a default is what this replaced, so 0 must not now be read
  // as "the caller said nothing" -- that is the classic falsy-default bug.
  const seed = await seedSentFor('/api/entity-jobs', { entity_type: 'Slime', base_prompt: 'x', seed: 0 }, 3);
  assert.equal(seed, 0);
});
