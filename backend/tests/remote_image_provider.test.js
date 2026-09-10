const test = require('node:test');
const assert = require('node:assert');
const {
  substituteTemplate, decodeImage, stripDataUri, storageKey, isRemoteJobId,
  startGeneration, runGeneration, createJob, getJob, setJob, __resetJobs,
  trimForStorage,
} = require('../src/services/remoteImageProvider');

// A one-pixel PNG, so "did a real image land in storage" is checkable rather
// than assumed.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_BYTES = Buffer.from(PNG_B64, 'base64');

// A PNG header of an arbitrary size -- enough for pngSize to read the grid.
function sheetPngB64(width, height) {
  const buf = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf.toString('base64');
}


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
  // The shape the admin UI already polls for. `sentBody` joined it in
  // SOMET-547 ("history recorded what we asked for, not what was sent") and
  // this assertion was left behind, so the file has been one test red on main
  // ever since; adding the field here rather than loosening the assertion,
  // because an exact key set is the point of the check.
  assert.deepStrictEqual(Object.keys(job).sort(),
    ['error', 'id', 'progress', 'result', 'sentBody', 'status']);
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

test('an animation request now produces a sheet-backed atlas, not a refusal', async (t) => {
  // SOMET-346 reverses SOMET-327's refusal. The other machine draws the whole
  // sheet; this side stores it and computes the manifest. A 512x1280 sheet is
  // 8 direction rows of 4 frames at 128x160.
  t.after(__resetJobs);
  const store = fakeStore();
  const jobId = createJob();
  const sheetProvider = { ...provider, sheet_layout: 'directional' };
  await runGeneration(jobId, sheetProvider,
    { subject: 'Wolf', kind: 'object', prompt: 'wolf', frames: 4 },
    { fetchImpl: async () => okJson({ images: [sheetPngB64(512, 1280)] }), store });

  const job = getJob(jobId);
  assert.strictEqual(job.status, 'done', job.error);
  assert.ok(job.result.atlas_key.endsWith('/atlas.png'), job.result.atlas_key);
  assert.ok(job.result.manifest_key.endsWith('/atlas.json'), job.result.manifest_key);
  assert.strictEqual(job.result.frames, 32, '8 directions x 4 frames');
  // Both objects really landed, and the manifest is the renderer's shape.
  assert.ok(store.written.has(job.result.atlas_key));
  const manifest = JSON.parse(store.written.get(job.result.manifest_key).toString());
  assert.deepStrictEqual(manifest.cell, [128, 160]);
  assert.deepStrictEqual(manifest.frames['S/0'], [0, 0, 128, 160]);
});

test('the frame count is offered to the template as {{frames}}', async (t) => {
  t.after(__resetJobs);
  let seen = null;
  const p = { ...provider, request_template: { prompt: '{{prompt}}', batch_size: '{{frames}}' } };
  const jobId = createJob();
  await runGeneration(jobId, p, { subject: 'Wolf', kind: 'object', prompt: 'w', frames: 4 },
    { fetchImpl: async (u, init) => { seen = JSON.parse(init.body); return okJson({ images: [sheetPngB64(512, 160)] }); },
      store: fakeStore() });
  assert.strictEqual(seen.batch_size, 4, 'the remote must be told how many frames to draw');
  assert.strictEqual(typeof seen.batch_size, 'number');
});

test('a sheet whose grid does not match the image fails without storing anything', async (t) => {
  t.after(__resetJobs);
  const store = fakeStore();
  const jobId = createJob();
  // 510px cannot be cut into 4 equal columns (500 can -- 125 each).
  await runGeneration(jobId, provider, { subject: 'g', kind: 'tile', prompt: 'g', frames: 4 },
    { fetchImpl: async () => okJson({ images: [sheetPngB64(510, 128)] }), store });
  const job = getJob(jobId);
  assert.strictEqual(job.status, 'error');
  assert.match(job.error, /does not divide evenly/);
  assert.strictEqual(store.written.size, 0, 'a bad grid must not leave an atlas behind');
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

// --- What a failed generation actually tells the admin --------------------
// A wedged generator on the LAN answered every request with a 504 carrying
// {"detail":"Generation did not finish within 240s"} while its own /,
// /sdapi/v1/sd-models and /api/jobs-health all returned 200. The status code
// alone could not distinguish that from a bad URL or a stopped service, and
// the sentence that could was being discarded.

// Unlike okJson, this stub carries a real body -- the excerpt cannot be tested
// against a stub that has none, which is exactly why the old non-2xx test
// passed while the message was useless.
function errBody(status, text, contentType = 'application/json') {
  const bytes = Buffer.from(text, 'utf8');
  return {
    ok: false,
    status,
    headers: { get: () => contentType },
    arrayBuffer: async () => bytes.buffer.slice(
      bytes.byteOffset, bytes.byteOffset + bytes.byteLength,
    ),
  };
}

test('a non-2xx carries the provider\'s own explanation, not just the status', async (t) => {
  t.after(__resetJobs);
  const store = fakeStore();
  const jobId = createJob();
  await runGeneration(jobId, provider, { subject: 'rocks', kind: 'tile', prompt: 'r' }, {
    fetchImpl: async () => errBody(504,
      '{"detail":"Generation did not finish within 240s: The operation timed out."}'),
    store,
  });
  const job = getJob(jobId);
  assert.strictEqual(job.status, 'error');
  assert.match(job.error, /504/, 'the status must survive');
  assert.match(job.error, /did not finish within 240s/,
    'the provider said what was wrong; the job must repeat it');
  assert.strictEqual(store.written.size, 0);
});

test('an error body that echoes the token does not leak it into the job', async (t) => {
  t.after(__resetJobs);
  const jobId = createJob();
  // A provider that echoes the request it received is a real shape (several
  // validation-error responses do). auth_token never leaves the process --
  // aiProviders.js enforces that on every read path, and this is a path it
  // never sees.
  await runGeneration(jobId, provider, { subject: 'r', kind: 'tile', prompt: 'r' }, {
    fetchImpl: async () => errBody(400,
      `{"error":"bad request","sent_headers":{"Authorization":"Bearer ${provider.auth_token}"}}`),
    store: fakeStore(),
  });
  const job = getJob(jobId);
  assert.strictEqual(job.status, 'error');
  assert.ok(!job.error.includes(provider.auth_token),
    `the stored token must not appear in a job document: ${job.error}`);
  assert.match(job.error, /redacted/);
});

test('a huge error body is truncated rather than pasted into the dialog', async (t) => {
  t.after(__resetJobs);
  const jobId = createJob();
  await runGeneration(jobId, provider, { subject: 'r', kind: 'tile', prompt: 'r' }, {
    fetchImpl: async () => errBody(500, `<html><body>${'x'.repeat(20000)}</body></html>`, 'text/html'),
    store: fakeStore(),
  });
  const job = getJob(jobId);
  assert.strictEqual(job.status, 'error');
  // Bounded by the module's own cap plus the short "provider answered NNN: "
  // prefix, rather than a magic number that has to be remembered whenever the
  // cap is retuned -- which is exactly what went stale when it moved 200->400.
  const { MAX_ERROR_EXCERPT_CHARS } = require('../src/services/remoteImageProvider');
  assert.ok(job.error.length <= MAX_ERROR_EXCERPT_CHARS + 40,
    `expected a bounded message, got ${job.error.length} chars`);
  assert.ok(job.error.length > 100, 'the excerpt must still carry something useful');
  assert.match(job.error, /\.\.\.$/, 'a truncated excerpt must say so');
});

test('an unreadable error body degrades to the bare status instead of throwing', async (t) => {
  t.after(__resetJobs);
  const jobId = createJob();
  // No body, no arrayBuffer: the shape a 204-ish or hand-written response has.
  await runGeneration(jobId, provider, { subject: 'r', kind: 'tile', prompt: 'r' }, {
    fetchImpl: async () => ({ ok: false, status: 502, headers: { get: () => null } }),
    store: fakeStore(),
  });
  const job = getJob(jobId);
  assert.strictEqual(job.status, 'error');
  assert.strictEqual(job.error, 'provider answered 502',
    'an unreadable body must not replace the provider status with our own error');
});

test('our own deadline reports as a timeout, not as an unreachable provider', async (t) => {
  t.after(__resetJobs);
  process.env.AI_PROVIDER_GENERATE_TIMEOUT_MS = '90000';
  t.after(() => { delete process.env.AI_PROVIDER_GENERATE_TIMEOUT_MS; });
  const jobId = createJob();
  await runGeneration(jobId, provider, { subject: 'r', kind: 'tile', prompt: 'r' }, {
    fetchImpl: async () => {
      // What AbortSignal.timeout actually raises.
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    },
    store: fakeStore(),
  });
  const job = getJob(jobId);
  assert.strictEqual(job.status, 'error');
  assert.doesNotMatch(job.error, /could not reach/,
    'a provider that answers /docs but never finishes is reachable; saying otherwise sends the admin to the wrong problem');
  assert.match(job.error, /did not answer within 90s/);
});

test('a genuinely refused connection still reads as unreachable', async (t) => {
  t.after(__resetJobs);
  const jobId = createJob();
  await runGeneration(jobId, provider, { subject: 'r', kind: 'tile', prompt: 'r' }, {
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    store: fakeStore(),
  });
  const job = getJob(jobId);
  assert.match(getJob(jobId).error, /could not reach/);
  assert.match(job.error, /ECONNREFUSED/);
});

// --- SOMET-563: the trim runs on the way to storage ------------------------
//
// These tests exist because the failure this repo keeps shipping is a green
// suite over a feature nothing calls. pngTrim being correct (SOMET-562) says
// nothing about whether a generated image ever reaches it, so every assertion
// below reads the bytes that LANDED IN THE STORE, never the job document's
// own account of itself.

const fs = require('node:fs');
const path = require('node:path');
const { decodeRGBA, CLEAR } = require('../src/services/pngAlpha.js');

// A real remote-generated image: 256x256 with the subject spanning 14% of the
// width. Synthetic input would not prove much here -- the point is that art
// this provider actually produced comes out tight.
const OFFCENTRE = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'art', 'offcentre-darts.png'),
);
const OFFCENTRE_B64 = OFFCENTRE.toString('base64');

function fillOf(buf) {
  const img = decodeRGBA(buf);
  let left = img.width; let right = -1;
  for (let y = 0; y < img.height; y += 1) {
    for (let x = 0; x < img.width; x += 1) {
      if (img.px[(y * img.width + x) * 4 + 3] >= CLEAR) {
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }
  return { fill: (right - left + 1) / img.width, width: img.width, height: img.height };
}

test('an object image is trimmed before it is stored', async (t) => {
  t.after(__resetJobs);
  const store = fakeStore();
  const jobId = createJob();
  await runGeneration(jobId, provider, { subject: 'darts', kind: 'object', prompt: 'darts' },
    { fetchImpl: async () => okJson({ images: [OFFCENTRE_B64] }), store });

  const job = getJob(jobId);
  assert.strictEqual(job.status, 'done', job.error);
  const written = store.written.get(job.result.image_key);

  // Precondition: the input really was mostly empty, or this proves nothing.
  assert.ok(fillOf(OFFCENTRE).fill < 0.2, 'fixture should start mostly empty');
  // The bytes that landed are NOT the bytes that arrived...
  assert.notDeepStrictEqual(written, OFFCENTRE);
  // ...and the subject now fills its canvas.
  const after = fillOf(written);
  assert.ok(after.fill > 0.9, `stored image still only ${after.fill} full`);
  assert.ok(after.width < 256, `canvas was not cropped: ${after.width}`);
});

test('the job reports how much the trim actually changed', async (t) => {
  // The number that makes a no-op trim visible instead of inferred from a
  // success that did nothing.
  t.after(__resetJobs);
  const store = fakeStore();
  const jobId = createJob();
  await runGeneration(jobId, provider, { subject: 'darts', kind: 'object', prompt: 'darts' },
    { fetchImpl: async () => okJson({ images: [OFFCENTRE_B64] }), store });

  const { result } = getJob(jobId);
  assert.strictEqual(result.trim_skipped, null);
  assert.ok(result.trim_ratio < 0.2, `expected a large crop, got ${result.trim_ratio}`);
  // And the reported ratio matches the image that was actually stored.
  const written = store.written.get(result.image_key);
  const img = decodeRGBA(written);
  const measured = (img.width * img.height) / (256 * 256);
  assert.ok(Math.abs(result.trim_ratio - measured) < 1e-9);
});

test('a tile is stored exactly as the provider sent it', async (t) => {
  // Ground is full-bleed and must never be cropped -- a trimmed tile is a hole
  // in the world. Fed the same off-centre image as the object test above, so
  // the ONLY difference is `kind`.
  t.after(__resetJobs);
  const store = fakeStore();
  const jobId = createJob();
  await runGeneration(jobId, provider, { subject: 'grass', kind: 'tile', prompt: 'grass' },
    { fetchImpl: async () => okJson({ images: [OFFCENTRE_B64] }), store });

  const job = getJob(jobId);
  assert.deepStrictEqual(store.written.get(job.result.image_key), OFFCENTRE);
  assert.strictEqual(job.result.trim_skipped, 'tile');
  assert.strictEqual(job.result.trim_ratio, 1);
});

test('a multi-frame atlas is stored untrimmed', async (t) => {
  // Trimming a sheet as one image would desync it from the manifest computed
  // beside it and crop every frame wrongly. The sheet branch returns before
  // the trim, so this is structural -- and this test is what keeps it that way
  // if the branches are ever reordered.
  t.after(__resetJobs);
  const store = fakeStore();
  const jobId = createJob();
  const sheet = Buffer.from(sheetPngB64(512, 1280), 'base64');
  await runGeneration(jobId, { ...provider, sheet_layout: 'directional' },
    { subject: 'Wolf', kind: 'object', prompt: 'wolf', frames: 4 },
    { fetchImpl: async () => okJson({ images: [sheetPngB64(512, 1280)] }), store });

  const job = getJob(jobId);
  assert.strictEqual(job.status, 'done', job.error);
  assert.deepStrictEqual(store.written.get(job.result.atlas_key), sheet);
});

test('an image we cannot decode is stored unchanged rather than lost', async (t) => {
  // Generation is the expensive half -- a minute or more of remote GPU time.
  // Trading a cosmetic defect for a lost generation would be the worse bug, so
  // anything pngTrim will not touch degrades to the original bytes.
  //
  // THE FIRST VERSION OF THIS TEST USED PNG_B64 AND TESTED NOTHING. That 1x1
  // image is perfectly good 8-bit RGBA (colour type 6, depth 8), so it decodes,
  // trims to a no-op and never goes near the degrade path the test is named
  // after. A truncated PNG -- header, no IDAT -- is what decodeRGBA actually
  // refuses.
  t.after(__resetJobs);
  const store = fakeStore();
  const jobId = createJob();
  const undecodable = Buffer.from(sheetPngB64(64, 64), 'base64');
  await runGeneration(jobId, provider, { subject: 'thing', kind: 'object', prompt: 'thing' },
    { fetchImpl: async () => okJson({ images: [sheetPngB64(64, 64)] }), store });

  const job = getJob(jobId);
  assert.strictEqual(job.status, 'done', job.error);
  assert.strictEqual(job.result.trim_skipped, 'unreadable');
  assert.strictEqual(job.result.trim_ratio, 1);
  assert.deepStrictEqual(store.written.get(job.result.image_key), undecodable);
});

test('an already-tight object image is stored byte-identical', async (t) => {
  // Idempotence at the wiring level: re-running a generation that needs no
  // trim must not churn the bytes, or every repair pass rewrites every image.
  t.after(__resetJobs);
  const store = fakeStore();
  const jobId = createJob();
  await runGeneration(jobId, provider, { subject: 'dot', kind: 'object', prompt: 'dot' },
    { fetchImpl: async () => okJson({ images: [PNG_B64] }), store });

  const job = getJob(jobId);
  assert.strictEqual(job.result.trim_ratio, 1);
  assert.deepStrictEqual(store.written.get(job.result.image_key), PNG_BYTES);
});

test('trimForStorage never throws, whatever it is handed', () => {
  // The degrade path, exercised directly: the wiring's promise is that a
  // broken trim cannot fail a job.
  for (const input of [null, undefined, Buffer.alloc(0), Buffer.from('rubbish'), 42]) {
    const out = trimForStorage(input, 'object');
    assert.strictEqual(out.ratio, 1);
    assert.strictEqual(out.skipped, 'unreadable');
  }
});
