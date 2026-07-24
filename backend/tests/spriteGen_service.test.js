const test = require('node:test');
const assert = require('node:assert');

// F-033 (SOMET-213): sprite-gen's POST /generate is gated behind a shared
// secret the backend must send. This exercises the real spriteGen.js module
// directly (every other backend test replaces it wholesale via
// __setSpriteGen, so its actual fetch/header logic was previously untested).

const MODULE_PATH = require.resolve('../src/services/spriteGen.js');

function freshSpriteGen() {
  delete require.cache[MODULE_PATH];
  return require('../src/services/spriteGen.js');
}

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  Object.assign(process.env, vars);
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const k of Object.keys(saved)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });
}

test('postGenerate refuses to call sprite-gen when SPRITE_GEN_SHARED_SECRET is unset', async () => {
  await withEnv({ SPRITE_GEN_SHARED_SECRET: '', SPRITE_GEN_URL: 'http://sprite-gen.test' }, async () => {
    delete process.env.SPRITE_GEN_SHARED_SECRET;
    const spriteGen = freshSpriteGen();
    const savedFetch = global.fetch;
    global.fetch = async () => { throw new Error('fetch must not be called when unconfigured'); };
    try {
      await assert.rejects(
        () => spriteGen.postGenerate({ creature: 'x', base_prompt: 'y' }),
        /SPRITE_GEN_SHARED_SECRET/
      );
    } finally {
      global.fetch = savedFetch;
    }
  });
});

test('postGenerate sends the shared secret header when configured', async () => {
  await withEnv({ SPRITE_GEN_SHARED_SECRET: 'test-secret-value', SPRITE_GEN_URL: 'http://sprite-gen.test' }, async () => {
    const spriteGen = freshSpriteGen();
    const savedFetch = global.fetch;
    let seenHeaders;
    global.fetch = async (url, init) => {
      seenHeaders = init.headers;
      return { ok: true, json: async () => ({ job_id: 'job-abc' }) };
    };
    try {
      const result = await spriteGen.postGenerate({ creature: 'x', base_prompt: 'y' });
      assert.equal(result.job_id, 'job-abc');
      assert.equal(seenHeaders['X-Sprite-Gen-Secret'], 'test-secret-value');
    } finally {
      global.fetch = savedFetch;
    }
  });
});

test('getJob also refuses to call sprite-gen when the shared secret is unset', async () => {
  await withEnv({ SPRITE_GEN_SHARED_SECRET: '', SPRITE_GEN_URL: 'http://sprite-gen.test' }, async () => {
    delete process.env.SPRITE_GEN_SHARED_SECRET;
    const spriteGen = freshSpriteGen();
    const savedFetch = global.fetch;
    global.fetch = async () => { throw new Error('fetch must not be called when unconfigured'); };
    try {
      await assert.rejects(() => spriteGen.getJob('job-1'), /SPRITE_GEN_SHARED_SECRET/);
    } finally {
      global.fetch = savedFetch;
    }
  });
});
