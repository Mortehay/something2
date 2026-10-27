const test = require('node:test');
const assert = require('node:assert');
const { discover } = require('../src/services/providerCatalog.js');

// fetchImpl keyed by pathname; unknown paths 404. Records fetched URLs.
function fake(routes) {
  const seen = [];
  const impl = async (u) => {
    const url = new URL(String(u));
    seen.push(url.pathname);
    const r = routes[url.pathname];
    if (r === undefined) return jsonRes({ error: 'nope' }, 404);
    return jsonRes(r.body, r.status || 200);
  };
  impl.seen = seen;
  return impl;
}
function jsonRes(body, status = 200) {
  const text = JSON.stringify(body);
  return new Response(text, { status, headers: { 'content-type': 'application/json' } });
}

const box = (modality, extra = {}) => ({
  base_url: 'http://box.test', modality, adapter: 'box', ...extra,
});
const ids = (cache, kind) => cache.entries.filter((e) => e.kind === kind).map((e) => e.id);

test('box audio: only audio:* gateway choices, source per_kind', async () => {
  const f = fake({
    '/api/models/status': { status: 404, body: {} },
    '/api/model-gateway': { body: { choices: ['brain:qwen3.6-35b-a3b', 'audio:ace-step', 'audio:stable-audio'] } },
  });
  const r = await discover(box('audio'), { fetchImpl: f });
  assert.equal(r.ok, true);
  assert.deepEqual(ids(r.cache, 'audio'), ['audio:ace-step', 'audio:stable-audio']);
  assert.equal(r.cache.source, 'per_kind');
  assert.equal(f.seen.includes('/api/models/status'), false, 'models/status is not called');
});

test('box gateway choices may be objects', async () => {
  const f = fake({ '/api/model-gateway': { body: { choices: [{ id: 'audio:x' }, { value: 'brain:y' }, { name: 'audio:z' }] } } });
  const r = await discover(box('audio'), { fetchImpl: f });
  assert.deepEqual(ids(r.cache, 'audio'), ['audio:x', 'audio:z']);
});

test('box image_edit: null is the base model', async () => {
  const f = fake({ '/api/edit-capabilities': { body: [null, 'pixelate'] } });
  const r = await discover(box('image_edit'), { fetchImpl: f });
  assert.equal(r.ok, true);
  assert.deepEqual(ids(r.cache, 'image_edit'), ['', 'pixelate']);
  assert.equal(r.cache.entries.find((e) => e.id === '').label, 'Base model');
});

test('box: text 500 but core-models 200 still ok with sprite entries', async () => {
  const f = fake({
    '/api/text/models': { status: 500, body: { error: 'boom' } },
    '/api/core-models': { body: { models: [{ value: 'qwen-image', available: true }] } },
  });
  const r = await discover(box('text'), { fetchImpl: f });
  assert.equal(r.ok, true);
  assert.deepEqual(ids(r.cache, 'sprite'), ['qwen-image']);
  assert.deepEqual(ids(r.cache, 'text'), []);
});

test('box: ok:false only when every source fails', async () => {
  const r = await discover(box('text'), { fetchImpl: fake({}) });
  assert.equal(r.ok, false);
  assert.ok(r.error);
});

test('NULL-adapter audio row is treated as box', async () => {
  const f = fake({ '/api/model-gateway': { body: { choices: ['audio:a'] } } });
  const r = await discover({ base_url: 'http://box.test', modality: 'audio', adapter: null }, { fetchImpl: f });
  assert.equal(r.ok, true);
  assert.deepEqual(ids(r.cache, 'audio'), ['audio:a']);
});

test('ollama: /api/tags names become text entries', async () => {
  const f = fake({ '/api/tags': { body: { models: [{ name: 'llama3:8b' }] } } });
  const r = await discover({ base_url: 'http://o.test', modality: 'text', adapter: 'ollama' }, { fetchImpl: f });
  assert.equal(r.ok, true);
  assert.equal(r.cache.source, 'ollama');
  assert.deepEqual(r.cache.entries, [{ kind: 'text', id: 'llama3:8b', label: 'llama3:8b', available: true }]);
  assert.deepEqual(r.cache.unsupported, []);
});

test('openai_compatible: /v1/models ids take the provider modality', async () => {
  const f = fake({ '/v1/models': { body: { data: [{ id: 'gpt-x' }] } } });
  const r = await discover({ base_url: 'http://a.test', modality: 'text', adapter: 'openai_compatible' }, { fetchImpl: f });
  assert.equal(r.cache.source, 'openai');
  assert.deepEqual(r.cache.entries.map((e) => [e.kind, e.id]), [['text', 'gpt-x']]);
});

test('NULL-adapter image goes through models_path', async () => {
  const f = fake({ '/sdapi/v1/sd-models': { body: [{ model_name: 'sd15' }] } });
  const r = await discover({
    base_url: 'http://a.test', modality: 'image', adapter: null, models_path: '/sdapi/v1/sd-models', models_pointer: '$[*].model_name',
  }, { fetchImpl: f });
  assert.equal(r.ok, true);
  assert.equal(r.cache.source, 'models_path');
  assert.deepEqual(f.seen, ['/sdapi/v1/sd-models']);
  assert.deepEqual(ids(r.cache, 'image'), ['sd15']);
});

test('ollama failure surfaces as ok:false with status', async () => {
  const r = await discover({ base_url: 'http://o.test', modality: 'text', adapter: 'ollama' }, { fetchImpl: fake({}) });
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
});

// Skipped: the box's /api/models/status payload shape was never captured
// (Task 0), so kind-labelled discovery and the `unsupported` bucket for a
// `video` entry cannot be exercised yet.
test('unsupported kinds land in unsupported', { skip: 'Task 0 not captured: fromModelsStatus is a stub' }, () => {});
