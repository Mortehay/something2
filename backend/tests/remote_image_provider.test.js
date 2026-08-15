const test = require('node:test');
const assert = require('node:assert');
const {
  substituteTemplate, decodeImage, stripDataUri, storageKey, isRemoteJobId,
  startGeneration, runGeneration, createJob, getJob, setJob, __resetJobs,
} = require('../src/services/remoteImageProvider');

// A one-pixel PNG, so "did a real image land in storage" is checkable rather
// than assumed.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_BYTES = Buffer.from(PNG_B64, 'base64');

// --- Template substitution ----------------------------------------------

test('substitution walks nested objects and arrays', () => {
  const template = {
    prompt: '{{prompt}}',
    nested: { deep: ['{{model}}', { deeper: '{{seed}}' }] },
  };
  const out = substituteTemplate(template, { prompt: 'a wolf', model: 'sd15', seed: 7 });
  assert.deepStrictEqual(out, {
    prompt: 'a wolf',
    nested: { deep: ['sd15', { deeper: 7 }] },
  });
});

test('a whole-leaf numeric placeholder emits a number, not a string', () => {
  // A1111 and most OpenAI-compatible endpoints reject {"width": "512"} with a
  // validation error the admin sees only as an opaque 4xx from a machine they
  // cannot inspect.
  const out = substituteTemplate({ width: '{{width}}', height: '{{height}}' },
    { width: 512, height: 640 });
  assert.strictEqual(out.width, 512);
  assert.strictEqual(out.height, 640);
  assert.strictEqual(typeof out.width, 'number');
});

test('a placeholder inside a longer string interpolates as text', () => {
  const out = substituteTemplate({ p: 'a {{prompt}}, {{width}}px, 4k' },
    { prompt: 'wolf', width: 512 });
  assert.strictEqual(out.p, 'a wolf, 512px, 4k');
});

test('an unknown placeholder is left exactly as written', () => {
  // Blanking it would send an empty prompt and return a plausible picture of
  // nothing -- a failure that looks like success.
  const out = substituteTemplate({ p: '{{promt}}', q: '{{prompt}}' }, { prompt: 'wolf' });
  assert.strictEqual(out.p, '{{promt}}');
  assert.strictEqual(out.q, 'wolf');
});

test('a template with no placeholders passes through unchanged', () => {
  const template = { steps: 20, cfg_scale: 7.5, sampler: 'Euler a', flags: [true, null] };
  const out = substituteTemplate(template, { prompt: 'x' });
  assert.deepStrictEqual(out, template);
  assert.strictEqual(JSON.stringify(out), JSON.stringify(template));
});

// --- Response decoding ---------------------------------------------------

test('an A1111-shaped JSON response decodes to PNG bytes', () => {
  const out = decodeImage({ json: { images: [PNG_B64] } }, 'images[0]');
  assert.ok(out.buffer, out.error);
  assert.deepStrictEqual(out.buffer, PNG_BYTES);
  // Really a PNG: magic number check, not just "some bytes".
  assert.strictEqual(out.buffer.subarray(1, 4).toString(), 'PNG');
});

test('a data: URI prefixed value decodes correctly', () => {
  const out = decodeImage({ json: { img: `data:image/png;base64,${PNG_B64}` } }, 'img');
  assert.deepStrictEqual(out.buffer, PNG_BYTES);
  assert.strictEqual(stripDataUri(`data:image/png;base64,${PNG_B64}`), PNG_B64);
});

test('a raw image body is stored without base64 decoding', () => {
  const out = decodeImage({ contentType: 'image/png', body: PNG_BYTES }, 'ignored[0]');
  assert.deepStrictEqual(out.buffer, PNG_BYTES,
    'a raw body must be used as-is, and the pointer ignored');
});

test('the three no-image failures are told apart', () => {
  // Each sends the admin somewhere different, so each needs its own message.
  assert.match(decodeImage({ json: { a: 1 } }, 'a..b').error, /not a valid path/);
  assert.match(decodeImage({ json: { a: 1 } }, 'images[0]').error, /no image found/);
  assert.match(decodeImage({ json: { images: [{ x: 1 }] } }, 'images[0]').error, /non-string/);
});

test('base64 garbage is rejected rather than stored as bytes', () => {
  const out = decodeImage({ json: { img: '!!!!' } }, 'img');
  assert.ok(out.error, 'undecodable data must not produce a buffer');
  assert.match(out.error, /zero bytes|not valid base64/);
});

// --- Storage key ---------------------------------------------------------

test('storage keys match sprite-gen storage.py layout', () => {
  assert.strictEqual(storageKey({ bucket: 'sprites', kind: 'tile', subject: 'grass', jobId: 'j1' }),
    'sprites/tiles/grass/j1/static.png');
  assert.strictEqual(storageKey({ bucket: 'sprites', kind: 'object', subject: 'Wolf', jobId: 'j1' }),
    'sprites/objects/Wolf/j1/static.png');
  assert.strictEqual(storageKey({ bucket: 'sprites', kind: 'creature', subject: 'Wolf', jobId: 'j1' }),
    'sprites/Wolf/j1/static.png');
});

test('a subject with path characters cannot escape its prefix', () => {
  const key = storageKey({ bucket: 'sprites', kind: 'tile', subject: '../../etc/passwd', jobId: 'j' });
  assert.ok(!key.includes('..'), `subject must be sanitised, got ${key}`);
  assert.strictEqual(key, 'sprites/tiles/______etc_passwd/j/static.png');
});

// --- End to end against a stubbed service and store ----------------------

function fakeStore() {
  const written = new Map();
  return {
    BUCKET: () => 'sprites',
    putObject: async (key, buffer) => { written.set(key, buffer); return key; },
    written,
  };
}

const provider = {
  id: 3,
  name: 'desktop',
  base_url: 'http://box:7860/sdapi/v1/txt2img',
  model: 'sd15',
  request_template: { prompt: '{{prompt}}', width: '{{width}}', height: '{{height}}' },
  response_image_pointer: 'images[0]',
  auth_header_name: 'Authorization',
  auth_token: 'sk-secret',
};

function okJson(body) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => body,
  };
}

test('a successful generation stores a PNG and reports the sprite-gen job shape', async (t) => {
  t.after(__resetJobs);
  const store = fakeStore();
  const fetchImpl = async () => okJson({ images: [PNG_B64] });
  const jobId = createJob();
  await runGeneration(jobId, provider, { subject: 'grass', kind: 'tile', prompt: 'grass' },
    { fetchImpl, store });

  const job = getJob(jobId);
  assert.strictEqual(job.status, 'done', job.error);
  // The shape the admin UI already polls for.
  assert.deepStrictEqual(Object.keys(job).sort(), ['error', 'id', 'progress', 'result', 'status']);
  assert.strictEqual(job.result.image_key, `sprites/tiles/grass/${jobId}/static.png`);
  // And a real image actually landed under that key.
  assert.deepStrictEqual(store.written.get(job.result.image_key), PNG_BYTES);
});

test('the request body is the substituted template, with the auth header', async (t) => {
  t.after(__resetJobs);
  let seen = null;
  const fetchImpl = async (url, init) => { seen = { url, init }; return okJson({ images: [PNG_B64] }); };
  const jobId = createJob();
  await runGeneration(jobId, provider, { subject: 'grass', kind: 'tile', prompt: 'lush grass' },
    { fetchImpl, store: fakeStore() });

  assert.strictEqual(seen.url, 'http://box:7860/sdapi/v1/txt2img');
  assert.strictEqual(seen.init.headers.Authorization, 'sk-secret');
  const body = JSON.parse(seen.init.body);
  assert.strictEqual(body.prompt, 'lush grass');
  // Tile defaults from sprite-gen main.py, and as numbers.
  assert.strictEqual(body.width, 128);
  assert.strictEqual(body.height, 128);
});

test('an animation request fails loudly instead of returning a still', async (t) => {
  t.after(__resetJobs);
  const store = fakeStore();
  const jobId = createJob();
  await runGeneration(jobId, provider, { subject: 'Wolf', kind: 'object', prompt: 'wolf', frames: 4 },
    { fetchImpl: async () => okJson({ images: [PNG_B64] }), store });

  const job = getJob(jobId);
  assert.strictEqual(job.status, 'error');
  assert.match(job.error, /single image|animated/i);
  assert.strictEqual(store.written.size, 0, 'a rejected request must store nothing');
});

test('every failure path leaves no object in storage', async (t) => {
  t.after(__resetJobs);
  const cases = [
    ['unreachable', async () => { throw new Error('ECONNREFUSED'); }],
    ['non-2xx', async () => ({ ok: false, status: 500, headers: { get: () => 'application/json' } })],
    ['no image at pointer', async () => okJson({ nothing: true })],
    ['bad base64', async () => okJson({ images: ['!!!!'] })],
  ];
  for (const [label, fetchImpl] of cases) {
    const store = fakeStore();
    const jobId = createJob();
    await runGeneration(jobId, provider, { subject: 'grass', kind: 'tile', prompt: 'g' },
      { fetchImpl, store });
    const job = getJob(jobId);
    assert.strictEqual(job.status, 'error', `${label} must fail the job`);
    assert.ok(job.error && job.error.length, `${label} must carry a readable error`);
    assert.strictEqual(store.written.size, 0, `${label} must not half-write an object`);
  }
});

test('an oversized response is rejected rather than buffered', async (t) => {
  t.after(__resetJobs);
  process.env.AI_PROVIDER_MAX_IMAGE_BYTES = '10';
  t.after(() => { delete process.env.AI_PROVIDER_MAX_IMAGE_BYTES; });
  const store = fakeStore();
  const jobId = createJob();
  await runGeneration(jobId, provider, { subject: 'grass', kind: 'tile', prompt: 'g' },
    { fetchImpl: async () => okJson({ images: [PNG_B64] }), store });
  const job = getJob(jobId);
  assert.strictEqual(job.status, 'error');
  assert.match(job.error, /size cap/);
  assert.strictEqual(store.written.size, 0);
});

test('a storage failure fails the job rather than reporting success', async (t) => {
  t.after(__resetJobs);
  const store = {
    BUCKET: () => 'sprites',
    putObject: async () => { throw new Error('MinIO down'); },
  };
  const jobId = createJob();
  await runGeneration(jobId, provider, { subject: 'grass', kind: 'tile', prompt: 'g' },
    { fetchImpl: async () => okJson({ images: [PNG_B64] }), store });
  const job = getJob(jobId);
  assert.strictEqual(job.status, 'error');
  assert.match(job.error, /could not store/);
});

test('startGeneration returns a prefixed job id immediately', async (t) => {
  t.after(__resetJobs);
  const out = startGeneration(provider, { subject: 'grass', kind: 'tile', prompt: 'g' },
    { fetchImpl: async () => okJson({ images: [PNG_B64] }), store: fakeStore() });
  assert.ok(isRemoteJobId(out.job_id), `expected an rmt_ prefixed id, got ${out.job_id}`);
  assert.strictEqual(getJob(out.job_id).status !== undefined, true);
  // The prefix is what the shared /api/*-jobs/:jobId routes dispatch on.
  assert.ok(!isRemoteJobId('deadbeefcafe'), 'a sprite-gen id must not look remote');
});

test('a throw inside generation becomes a failed job, not an unhandled rejection', async (t) => {
  t.after(__resetJobs);
  const out = startGeneration(provider, { subject: 'g', kind: 'tile', prompt: 'g' }, {
    fetchImpl: async () => okJson({ images: [PNG_B64] }),
    // A store whose BUCKET() throws blows up outside the inner try/catch.
    store: { BUCKET: () => { throw new Error('boom'); }, putObject: async () => {} },
  });
  await new Promise((r) => setImmediate(r));
  const job = getJob(out.job_id);
  assert.strictEqual(job.status, 'error');
  assert.match(job.error, /boom/);
});

// --- Registry bounds -----------------------------------------------------
// The registry lives inside the long-running API server. Without eviction it
// gains one entry per generation and never gives one back.

const { __jobCount, pruneJobs } = require('../src/services/remoteImageProvider');

test('the job registry does not grow without bound', async (t) => {
  t.after(__resetJobs);
  __resetJobs();
  process.env.AI_PROVIDER_MAX_JOBS = '10';
  t.after(() => { delete process.env.AI_PROVIDER_MAX_JOBS; });

  for (let i = 0; i < 50; i += 1) createJob();
  assert.ok(__jobCount() <= 10, `registry must stay capped, saw ${__jobCount()}`);
});

test('the newest jobs survive eviction, because those are the ones being polled', async (t) => {
  t.after(__resetJobs);
  __resetJobs();
  process.env.AI_PROVIDER_MAX_JOBS = '3';
  t.after(() => { delete process.env.AI_PROVIDER_MAX_JOBS; });

  const ids = [];
  for (let i = 0; i < 6; i += 1) ids.push(createJob());
  // The last three must still be retrievable; the first three must be gone.
  for (const id of ids.slice(-3)) {
    assert.ok(getJob(id), `the newest jobs must survive: ${id}`);
  }
  assert.strictEqual(getJob(ids[0]), null, 'the oldest job should have been evicted');
});

test('jobs older than the TTL are dropped', async (t) => {
  t.after(__resetJobs);
  __resetJobs();
  const old = createJob(1_000_000);
  const fresh = createJob(1_000_000);
  assert.ok(getJob(old));
  // Prune at a clock far past the default 1h TTL.
  pruneJobs(1_000_000 + 7_200_000);
  assert.strictEqual(getJob(old), null, 'a job past the TTL must be evicted');
  assert.strictEqual(getJob(fresh), null, 'same-age job evicted too');
});

test('the job document keeps sprite-gen\'s exact field set after the registry change', async (t) => {
  t.after(__resetJobs);
  __resetJobs();
  const id = createJob();
  // Registry bookkeeping (the timestamp) must NOT leak into what the client
  // polls -- the UI and the three proxy routes expect sprite-gen's shape.
  assert.deepStrictEqual(Object.keys(getJob(id)).sort(),
    ['error', 'id', 'progress', 'result', 'status']);
  setJob(id, { status: 'done' });
  assert.deepStrictEqual(Object.keys(getJob(id)).sort(),
    ['error', 'id', 'progress', 'result', 'status']);
});

// --- Template keys that collide with the prototype -----------------------

test('a __proto__ key in a template is sent, not silently dropped', async () => {
  // JSON.parse makes "__proto__" an ordinary own property; plain assignment
  // would hit the prototype setter, dropping the key from the outgoing body.
  const tpl = JSON.parse('{"__proto__": {"a": 1}, "prompt": "{{prompt}}"}');
  const out = substituteTemplate(tpl, { prompt: 'wolf' });
  assert.strictEqual(out.prompt, 'wolf');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(out)).__proto__, { a: 1 },
    'the key must survive into the serialized body');
  // And nothing global is harmed.
  assert.notStrictEqual({}.a, 1);
});
