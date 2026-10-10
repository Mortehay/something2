const test = require('node:test');
const assert = require('node:assert/strict');

const { createDispatcher } = require('../src/services/spriteDispatcher.js');

test('dispatcher drains a local sprite job and persists its generated keys', async () => {
  const completed = [];
  let claimed = false;
  const queue = {
    claim: async () => {
      if (claimed) return null;
      claimed = true;
      return {
        id: 'row-1', creature: 'Wolf', generation_kind: 'creature',
        base_prompt: 'a wolf', seed: 7, frames: 4, provider_id: null,
      };
    },
    attach: async () => {},
    complete: async (_db, id, result) => completed.push({ id, result }),
    fail: async (_db, _id, error) => { throw error; },
  };
  const spriteGen = {
    postGenerate: async () => ({ job_id: 'job-1', recipe: { backend: 'stub', frames: 4 } }),
    getJob: async () => ({
      status: 'done',
      result: { atlas_key: 'sprites/Wolf/job-1/atlas.png', manifest_key: 'sprites/Wolf/job-1/atlas.json' },
    }),
  };
  const dispatcher = createDispatcher({
    db: {}, queue, spriteGen, pollMs: 0, timeoutMs: 100,
  });

  await dispatcher.start();

  assert.deepEqual(completed, [{
    id: 'row-1',
    result: { atlas_key: 'sprites/Wolf/job-1/atlas.png', manifest_key: 'sprites/Wolf/job-1/atlas.json' },
  }]);
  assert.equal(dispatcher.status().running, false);
});


test('dispatcher sends every job to local sprite-gen, never a registered provider', async () => {
  const posted = [];
  let claimed = false;
  const queue = {
    claim: async () => {
      if (claimed) return null;
      claimed = true;
      // provider_id survives on rows written before the batch went local-only.
      return {
        id: 'row-2', creature: 'pine_tree', generation_kind: 'object',
        base_prompt: 'a pine tree', seed: 3, frames: 1, provider_id: 12,
      };
    },
    attach: async () => {},
    complete: async () => {},
    fail: async (_db, _id, error) => { throw error; },
  };
  const spriteGen = {
    postGenerate: async (body) => { posted.push(body); return { job_id: 'job-2', recipe: {} }; },
    getJob: async () => ({ status: 'done', result: { image_key: 'sprites/objects/pine_tree/job-2/static.png' } }),
  };
  const dispatcher = createDispatcher({ db: {}, queue, spriteGen, pollMs: 0, timeoutMs: 100 });

  await dispatcher.start();

  assert.deepEqual(posted, [{
    creature: 'pine_tree', base_prompt: 'a pine tree', kind: 'object', seed: 3, frames: 1,
  }]);
  assert.equal(dispatcher.status().completed, 1);
});
