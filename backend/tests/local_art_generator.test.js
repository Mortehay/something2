const test = require('node:test');
const assert = require('node:assert');
const remote = require('../src/services/remoteImageProvider.js');
const local = require('../src/services/localArtGenerator.js');

// SOMET-535 rework. The queue's LOCAL backend: a job whose art_jobs.backend is
// 'local' is drawn by the sprite-gen service, through the same spriteGen.js
// client the interactive local path uses, and reports through the same
// registry contract remote.runGeneration does -- so artDispatcher.runOne reads
// one shape whichever backend drew the image.

function fakeSpriteGen(script) {
  const calls = { posted: [], polled: [] };
  let n = 0;
  return {
    calls,
    async postGenerate(body) {
      calls.posted.push(body);
      return { job_id: 'abc123', recipe: { backend: 'stub' } };
    },
    async getJob(id) {
      calls.polled.push(id);
      const doc = script[Math.min(n, script.length - 1)];
      n += 1;
      return doc;
    },
  };
}

test('a local generation posts the subject to sprite-gen and records its image_key', async () => {
  const sg = fakeSpriteGen([
    { id: 'abc123', status: 'running', result: null, error: null },
    { id: 'abc123', status: 'done', result: { image_key: 'sprites/objects/x/abc123/static.png' } },
  ]);
  const id = remote.createJob();
  await local.runGeneration(id, local.LOCAL_PROVIDER, {
    subject: 'crude blade', kind: 'object', prompt: 'a crude blade', seed: 42, frames: 1,
    width: 1024, height: 1024, negative: ['floor'],
  }, { spriteGen: sg, pollMs: 1 });

  assert.equal(sg.calls.posted.length, 1);
  const body = sg.calls.posted[0];
  assert.equal(body.base_prompt, 'a crude blade');
  assert.equal(body.kind, 'object');
  assert.equal(body.seed, 42);
  assert.equal(body.frames, 1, 'never a sheet');
  // sprite-gen caps size at 512 and 422s anything larger; it picks its own.
  assert.equal(body.size, undefined, 'the remote 1024 ask must not reach sprite-gen');
  assert.match(body.creature, /^[A-Za-z0-9_-]+$/,
    'the subject becomes a storage path segment, so it must be a safe slug');

  const doc = remote.getJob(id);
  assert.equal(doc.status, 'done');
  assert.equal(doc.result.image_key, 'sprites/objects/x/abc123/static.png');
  assert.equal(doc.sentBody.base_prompt, 'a crude blade', 'what was sent is recorded for history');
  assert.equal(doc.sentBody.prompt, 'a crude blade',
    'history reads the composed prompt from .prompt; without it a local attempt records none');
});

test('a sprite-gen error is reported through the registry, not thrown', async () => {
  const sg = fakeSpriteGen([{ id: 'abc123', status: 'error', error: 'CUDA out of memory' }]);
  const id = remote.createJob();
  await local.runGeneration(id, local.LOCAL_PROVIDER,
    { subject: 's', kind: 'tile', prompt: 'grass', seed: 1, frames: 1 },
    { spriteGen: sg, pollMs: 1 });
  const doc = remote.getJob(id);
  assert.equal(doc.status, 'error');
  assert.match(doc.error, /CUDA out of memory/);
  assert.match(doc.error, /sprite-gen/, 'the error must say which backend failed');
});

test('an unreachable sprite-gen is a failure with its reason', async () => {
  const id = remote.createJob();
  await local.runGeneration(id, local.LOCAL_PROVIDER,
    { subject: 's', kind: 'object', prompt: 'p', seed: 1, frames: 1 },
    { spriteGen: { postGenerate: async () => { throw new Error('fetch failed'); } }, pollMs: 1 });
  const doc = remote.getJob(id);
  assert.equal(doc.status, 'error');
  assert.match(doc.error, /fetch failed/);
});

test('a job that never finishes times out instead of hanging the drain', async () => {
  const sg = fakeSpriteGen([{ id: 'abc123', status: 'running' }]);
  const id = remote.createJob();
  await local.runGeneration(id, local.LOCAL_PROVIDER,
    { subject: 's', kind: 'object', prompt: 'p', seed: 1, frames: 1 },
    { spriteGen: sg, pollMs: 1, timeoutMs: 30 });
  const doc = remote.getJob(id);
  assert.equal(doc.status, 'error');
  assert.match(doc.error, /did not finish/);
});

test('the local provider has no id, so nothing records a remote provider for it', () => {
  assert.equal(local.LOCAL_PROVIDER.id, null);
  assert.equal(local.LOCAL_PROVIDER.local, true);
});
