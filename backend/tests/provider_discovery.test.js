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

test('testConnection reports ok with a latency', async () => {
  let t = 1000;
  const fetchImpl = stubFetch(async () => { t += 42; return jsonResponse({}, 200); });
  const out = await testConnection({ base_url: 'http://box:7860' },
    { fetchImpl, now: () => t });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.status, 200);
  assert.strictEqual(out.latency_ms, 42);
  assert.strictEqual(out.error, null);
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
