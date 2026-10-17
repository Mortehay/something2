const test = require('node:test');
const assert = require('node:assert');
const { parsePointer, selectAll, selectOne } = require('../src/services/pointerPath');
const {
  authHeaders, resolveUrl, extractModels, fetchModels, testConnection,
} = require('../src/services/providerDiscovery');

// --- Pointer grammar -----------------------------------------------------

test('selectAll walks keys, wildcards and indices', () => {
  const doc = { models: [{ name: 'a' }, { name: 'b' }], images: ['png0', 'png1'] };
  assert.deepStrictEqual(selectAll(doc, 'models[*].name'), ['a', 'b']);
  assert.deepStrictEqual(selectAll(doc, 'images[0]'), ['png0']);
  assert.deepStrictEqual(selectAll(doc, 'images[1]'), ['png1']);
  assert.deepStrictEqual(selectAll([{ x: 1 }, { x: 2 }], '$[*].x'), [1, 2]);
  // A leading $ is optional.
  assert.deepStrictEqual(selectAll(doc, '$.models[*].name'), ['a', 'b']);
});

test('an empty pointer selects the root, spreading a root array', () => {
  // This is what makes a service that answers with a bare ["sd15","sdxl"]
  // work without a special case in the caller.
  assert.deepStrictEqual(selectAll(['sd15', 'sdxl'], ''), ['sd15', 'sdxl']);
  assert.deepStrictEqual(selectAll({ a: 1 }, ''), [{ a: 1 }]);
});

test('a pointer that matches nothing is distinct from one that will not parse', () => {
  // The distinction the error messages depend on: [] means "walked fine,
  // found nothing"; null means "this string is not a path".
  assert.deepStrictEqual(selectAll({ a: 1 }, 'b.c'), []);
  assert.strictEqual(selectAll({ a: 1 }, 'a..b'), null);
  assert.strictEqual(parsePointer('['), null);
  assert.strictEqual(parsePointer('a[x]'), null);
  assert.strictEqual(parsePointer('a.'), null);
});

test('an out-of-range index yields no match rather than undefined', () => {
  assert.deepStrictEqual(selectAll({ images: ['only'] }, 'images[3]'), []);
  assert.strictEqual(selectOne({ images: ['only'] }, 'images[3]'), undefined);
});

test('selectOne returns the first match, and null only for a bad path', () => {
  assert.strictEqual(selectOne({ images: ['a', 'b'] }, 'images[*]'), 'a');
  assert.strictEqual(selectOne({ images: ['a'] }, 'nope'), undefined);
  assert.strictEqual(selectOne({ images: ['a'] }, ']['), null);
});

// --- The genericity claim ------------------------------------------------
// The epic's central design bet is that three unrelated services work through
// ONE code path differing only by two stored strings. If that is not true,
// the models_path/models_pointer columns are pointless complexity.

test('one code path extracts models from A1111, Ollama and OpenAI shapes', () => {
  const a1111 = [{ title: 'sd_xl.safetensors [abc]', model_name: 'sd_xl' },
    { title: 'sd15.safetensors [def]', model_name: 'sd15' }];
  assert.deepStrictEqual(extractModels(a1111, '$[*].model_name'), { models: ['sd_xl', 'sd15'] });

  const ollama = { models: [{ name: 'llava:7b', size: 1 }, { name: 'sdxl:latest', size: 2 }] };
  assert.deepStrictEqual(extractModels(ollama, 'models[*].name'),
    { models: ['llava:7b', 'sdxl:latest'] });

  const openai = { data: [{ id: 'dall-e-3' }, { id: 'gpt-image-1' }] };
  assert.deepStrictEqual(extractModels(openai, 'data[*].id'),
    { models: ['dall-e-3', 'gpt-image-1'] });
});

test('extractModels dedupes and drops blanks, preserving order', () => {
  const doc = { m: ['b', 'a', 'b', '', '   ', 'c'] };
  assert.deepStrictEqual(extractModels(doc, 'm[*]'), { models: ['b', 'a', 'c'] });
});

test('pointing at objects instead of names is reported, not returned empty', () => {
  // The commonest admin typo. An empty list would send them looking at the
  // service; this sends them at the pointer field.
  const out = extractModels([{ model_name: 'x' }], '$[*]');
  assert.ok(out.error, 'selecting objects must be an error');
  assert.match(out.error, /selected objects/);
});

test('a malformed pointer is reported as a bad path', () => {
  const out = extractModels({ a: 1 }, 'a..b');
  assert.match(out.error || '', /not a valid path/);
});

test('a pointer that legitimately matches nothing returns an empty list', () => {
  assert.deepStrictEqual(extractModels({ models: [] }, 'models[*].name'), { models: [] });
});

// --- URL and auth --------------------------------------------------------

test('resolveUrl joins base and path regardless of slashes', () => {
  assert.strictEqual(resolveUrl('http://h:7860', '/sdapi/v1/sd-models'),
    'http://h:7860/sdapi/v1/sd-models');
  assert.strictEqual(resolveUrl('http://h:7860/', 'sdapi/v1/sd-models'),
    'http://h:7860/sdapi/v1/sd-models');
  assert.strictEqual(resolveUrl('http://h:7860', ''), 'http://h:7860/');
});

test('an explicitly named auth header is sent verbatim, and only with a value', () => {
  assert.deepStrictEqual(authHeaders({ auth_header_name: 'X-Key', auth_token: 'v' }), { 'X-Key': 'v' });
  // A name with no token would otherwise go out as "X-Key: undefined".
  assert.deepStrictEqual(authHeaders({ auth_header_name: 'X-Key', auth_token: null }), {});
  assert.deepStrictEqual(authHeaders({}), {});
  // An explicit name means the admin is telling us the exact wire format, so
  // the value is never rewritten -- a raw key under Authorization stays raw.
  assert.deepStrictEqual(authHeaders({ auth_header_name: 'Authorization', auth_token: 'raw-key' }),
    { Authorization: 'raw-key' });
});

test('a token with no header name is sent as Authorization: Bearer, not dropped', () => {
  // SOMET-325 follow-up. The header-name box is optional in the admin form, so
  // pasting a key and nothing else is the obvious thing to do -- and used to
  // send NO header at all, which reads at the far end as "you forgot to
  // authenticate" and at this end as a stale model list that never refreshes.
  assert.deepStrictEqual(authHeaders({ auth_header_name: null, auth_token: 'k' }),
    { Authorization: 'Bearer k' });
  assert.deepStrictEqual(authHeaders({ auth_header_name: '   ', auth_token: 'k' }),
    { Authorization: 'Bearer k' });
  // A value that already names its scheme is passed through unchanged, so
  // "Bearer k" does not become "Bearer Bearer k" and Basic still works.
  assert.deepStrictEqual(authHeaders({ auth_token: 'Bearer k' }), { Authorization: 'Bearer k' });
  assert.deepStrictEqual(authHeaders({ auth_token: 'Basic dXNlcjpwdw==' }),
    { Authorization: 'Basic dXNlcjpwdw==' });
});

// --- fetchModels end to end (stubbed transport) --------------------------

function stubFetch(impl) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init }); return impl(url, init); };
  fn.calls = calls;
  return fn;
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('fetchModels returns names and passes the auth header through', async () => {
  const fetchImpl = stubFetch(async () => jsonResponse([{ model_name: 'sd15' }]));
  const provider = {
    base_url: 'http://box:7860',
    models_path: '/sdapi/v1/sd-models',
    models_pointer: '$[*].model_name',
    auth_header_name: 'Authorization',
    auth_token: 'Bearer secret',
  };
  const out = await fetchModels(provider, { fetchImpl });
  assert.deepStrictEqual(out.models, ['sd15']);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(fetchImpl.calls[0].url, 'http://box:7860/sdapi/v1/sd-models');
  assert.strictEqual(fetchImpl.calls[0].init.headers.Authorization, 'Bearer secret');
});

test('an unreachable host is a described failure, not a throw', async () => {
  const fetchImpl = stubFetch(async () => { throw new Error('ECONNREFUSED'); });
  const out = await fetchModels({ base_url: 'http://off:7860', models_path: '/x' }, { fetchImpl });
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /could not reach/);
  assert.match(out.error, /ECONNREFUSED/);
});

test('a non-2xx answer reports the status', async () => {
  const fetchImpl = stubFetch(async () => jsonResponse({}, 503));
  const out = await fetchModels({ base_url: 'http://box:7860', models_path: '/x' }, { fetchImpl });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.status, 503);
  assert.match(out.error, /503/);
});

test('a non-JSON answer is reported rather than crashing the parse', async () => {
  const fetchImpl = stubFetch(async () => ({
    ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); },
  }));
  const out = await fetchModels({ base_url: 'http://box:7860', models_path: '/x' }, { fetchImpl });
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /did not answer with usable JSON/);
});

test('no failure path echoes the auth token', async () => {
  // Every error string an admin can trigger, checked against the secret.
  const secret = 'sk-do-not-leak';
  const provider = {
    base_url: 'http://box:7860', models_path: '/x', models_pointer: 'a..b',
    auth_header_name: 'Authorization', auth_token: secret,
  };
  const cases = [
    stubFetch(async () => { throw new Error('ECONNREFUSED'); }),
    stubFetch(async () => jsonResponse({}, 500)),
    stubFetch(async () => jsonResponse({ a: 1 }, 200)),
  ];
  for (const fetchImpl of cases) {
    const out = await fetchModels(provider, { fetchImpl });
    assert.ok(!JSON.stringify(out).includes(secret), 'no response may contain the token');
  }
});

// --- testConnection ------------------------------------------------------

// SOMET-542. A models GET answering 200 proves the web server is up, not that
// the box can draw: a faulted CUDA context kept /sdapi/v1/sd-models green while
// every txt2img call 500'd, and the Test button certified it. ok now means "a
// real generation produced an image", with the models GET kept as a pre-check.

// A real 1x1 RGBA PNG, so the probe's signature check sees genuine bytes.
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const imageProvider = () => ({
  base_url: 'http://box:7860/sdapi/v1/txt2img',
  models_path: '/sdapi/v1/sd-models',
  models_pointer: '$[*].model_name',
  model: 'sd15',
  request_template: {
    prompt: '{{prompt}}', steps: 20, width: '{{width}}', height: '{{height}}', seed: '{{seed}}',
  },
  response_image_pointer: 'images[0]',
});

// Real Response objects for the generation leg: the probe reads through the
// same capped readers a job does, and a hand-rolled stub would let those
// readers take a test-only branch.
function generationStub({ models = () => jsonResponse([{ model_name: 'sd15' }]), generate }) {
  return stubFetch(async (url, init) => ((init && init.method === 'POST') ? generate(url, init) : models(url, init)));
}
const jsonBody = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

test('testConnection is NOT ok when models answers 200 but generation fails', async () => {
  // The exact 2026-09-04 failure. Before the fix this returned ok:true.
  const fetchImpl = generationStub({
    generate: () => jsonBody({ error: 'RuntimeError', errors: 'CUDA error: unspecified launch failure' }, 500),
  });
  const out = await testConnection(imageProvider(), { fetchImpl });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.status, 500);
  assert.match(out.error, /500/);
  assert.match(out.error, /CUDA error/);
  assert.strictEqual(fetchImpl.calls.length, 2);
});

test('testConnection is ok only after a generation returns a decodable image', async () => {
  let t = 1000;
  const fetchImpl = generationStub({
    generate: async () => { t += 42; return jsonBody({ images: [PNG_1X1] }); },
  });
  const out = await testConnection(imageProvider(), { fetchImpl, now: () => t });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.status, 200);
  assert.strictEqual(out.latency_ms, 42);
  assert.strictEqual(out.error, null);
  assert.strictEqual(out.probe, 'generation');

  const [pre, gen] = fetchImpl.calls;
  assert.strictEqual(pre.url, 'http://box:7860/sdapi/v1/sd-models');
  assert.strictEqual(gen.url, 'http://box:7860/sdapi/v1/txt2img');
  const sent = JSON.parse(gen.init.body);
  // The provider's OWN template, cut down to the cheapest real generation.
  assert.strictEqual(sent.steps, 1);
  assert.strictEqual(sent.width, 64);
  assert.strictEqual(sent.height, 64);
  assert.strictEqual(typeof sent.prompt, 'string');
  assert.ok(sent.prompt.length > 0);
});

test('testConnection does not add a steps key the template never had', async () => {
  const provider = { ...imageProvider(), request_template: { prompt: '{{prompt}}', size: '{{width}}x{{height}}' } };
  const fetchImpl = generationStub({ generate: () => jsonBody({ images: [PNG_1X1] }) });
  const out = await testConnection(provider, { fetchImpl });
  assert.strictEqual(out.ok, true);
  const sent = JSON.parse(fetchImpl.calls[1].init.body);
  assert.deepStrictEqual(Object.keys(sent).sort(), ['prompt', 'size']);
  assert.strictEqual(sent.size, '64x64');
});

test('testConnection shrinks a template whose size is LITERAL, not a placeholder', async () => {
  // The shape of the real "desktop gpu (objects)" row: width/height are
  // numbers, not {{width}}/{{height}}, so substitution alone left the probe at
  // a full 1024x1024 SDXL draw -- the VRAM allocation that faults this box.
  const provider = {
    ...imageProvider(),
    request_template: {
      seed: '{{seed}}', steps: 24, width: 1024, cutout: true, height: 1024, prompt: '{{prompt}}',
      cfg_scale: 7, negative_prompt: 'border', override_settings: { sd_model_checkpoint: '{{model}}' },
    },
  };
  const fetchImpl = generationStub({ generate: () => jsonBody({ images: [PNG_1X1] }) });
  const out = await testConnection(provider, { fetchImpl });
  assert.strictEqual(out.ok, true);
  const sent = JSON.parse(fetchImpl.calls[1].init.body);
  assert.strictEqual(sent.width, 64);
  assert.strictEqual(sent.height, 64);
  assert.strictEqual(sent.steps, 1);
  // Everything else is the provider's own request, cutout included.
  assert.strictEqual(sent.cutout, true);
  assert.strictEqual(sent.cfg_scale, 7);
  assert.deepStrictEqual(sent.override_settings, { sd_model_checkpoint: 'sd15' });
});

test('testConnection rejects a 200 that carries no image', async () => {
  const fetchImpl = generationStub({ generate: () => jsonBody({ images: [] }) });
  const out = await testConnection(imageProvider(), { fetchImpl });
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /no image found/);
});

test('testConnection rejects a 200 whose "image" is not an image', async () => {
  // Buffer.from(…, 'base64') accepts nearly anything; decoding to bytes is
  // not the same as producing a picture.
  const fetchImpl = generationStub({
    generate: () => jsonBody({ images: [Buffer.from('internal server error').toString('base64')] }),
  });
  const out = await testConnection(imageProvider(), { fetchImpl });
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /not a recognisable image/);
});

test('testConnection accepts a raw image/* body', async () => {
  const fetchImpl = generationStub({
    generate: () => new Response(Buffer.from(PNG_1X1, 'base64'), {
      status: 200, headers: { 'content-type': 'image/png' },
    }),
  });
  const out = await testConnection(imageProvider(), { fetchImpl });
  assert.strictEqual(out.ok, true);
});

test('testConnection skips the generation when the models pre-check already failed', async () => {
  const fetchImpl = generationStub({
    models: () => jsonResponse({}, 503),
    generate: () => { throw new Error('generation must not be attempted'); },
  });
  const out = await testConnection(imageProvider(), { fetchImpl });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.status, 503);
  assert.strictEqual(fetchImpl.calls.length, 1);
});

test('testConnection names the probe deadline when generation never answers', async () => {
  const fetchImpl = generationStub({
    generate: () => { const e = new Error('aborted'); e.name = 'TimeoutError'; throw e; },
  });
  const out = await testConnection(imageProvider(), { fetchImpl });
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /did not produce an image within \d+s/);
});

test('testConnection without a request_template cannot certify generation', async () => {
  const { request_template, ...provider } = imageProvider(); // eslint-disable-line no-unused-vars
  const fetchImpl = generationStub({ generate: () => jsonBody({ images: [PNG_1X1] }) });
  const out = await testConnection(provider, { fetchImpl });
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /request_template/);
  assert.strictEqual(fetchImpl.calls.length, 1);
});

test('testConnection on a dead host resolves ok:false with a reason', async () => {
  const fetchImpl = stubFetch(async () => { throw new Error('getaddrinfo ENOTFOUND box'); });
  const out = await testConnection({ base_url: 'http://box:7860' }, { fetchImpl });
  assert.strictEqual(out.ok, false);
  assert.match(out.error, /ENOTFOUND/);
});

test('testConnection treats a non-2xx as not ok', async () => {
  const fetchImpl = stubFetch(async () => jsonResponse({}, 404));
  const out = await testConnection({ base_url: 'http://box:7860' }, { fetchImpl });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.status, 404);
});
