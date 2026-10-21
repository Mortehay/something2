// Unit: no DB. The fake db and fake fetch CHECK what they are given -- a
// fake that ignores its input is the vacuous-test shape this repo keeps
// shipping.
const test = require('node:test');
const assert = require('node:assert');
const tp = require('../src/services/textProvider');

const BOX = { id: 9, name: 'box', base_url: 'http://box.test:8001', auth_header_name: null, auth_token: 'k', modality: 'text' };
const fakeDb = (provider) => ({
  query: async (sql, params) => {
    assert.match(sql, /modality = \$1/);
    assert.deepEqual(params, ['text'], 'must look up the TEXT provider, not image/audio');
    return { rows: provider ? [provider] : [] };
  },
});
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const SCHEMA = { type: 'object', properties: { entity: { type: 'string' } }, required: ['entity'] };
const REQ = { system: 'sys', prompt: 'describe wolf', jsonSchema: SCHEMA, temperature: 0.15, maxTokens: 64 };

function recorder(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), headers: init.headers, body });
    for (const [match, respond] of routes) if (String(url).includes(match)) return respond(body);
    throw new Error(`unexpected fetch ${url}`);
  };
  return { calls, fetchImpl };
}

test('box answers: via box, schema and auth forwarded', async () => {
  const { calls, fetchImpl } = recorder([['/api/text', () => json(200, { text: '{"entity":"a grey wolf"}', json: { entity: 'a grey wolf' }, model: 'qwen-instruct', ms: 900 })]]);
  const r = await tp.complete(fakeDb(BOX), REQ, { fetchImpl });
  assert.deepEqual({ ok: r.ok, via: r.via, model: r.model, json: r.json }, { ok: true, via: 'box', model: 'qwen-instruct', json: { entity: 'a grey wolf' } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://box.test:8001/api/text');
  assert.equal(calls[0].headers.Authorization, 'Bearer k');
  assert.deepEqual(calls[0].body, { system: 'sys', prompt: 'describe wolf', max_tokens: 64, temperature: 0.15, json_schema: SCHEMA });
});

test('box json missing but text parses: json recovered from text', async () => {
  const { fetchImpl } = recorder([['/api/text', () => json(200, { text: '{"entity":"x"}', json: null, model: 'm' })]]);
  const r = await tp.complete(fakeDb(BOX), REQ, { fetchImpl });
  assert.deepEqual(r.json, { entity: 'x' });
});

for (const status of [409, 503]) {
  test(`box ${status} falls back to Ollama with the same schema`, async () => {
    const { calls, fetchImpl } = recorder([
      ['/api/text', () => json(status, { detail: 'busy' })],
      ['/v1/chat/completions', () => json(200, { choices: [{ message: { content: '{"entity":"a wolf"}' } }] })],
    ]);
    const r = await tp.complete(fakeDb(BOX), REQ, { fetchImpl });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.via, 'fallback');
    assert.deepEqual(r.json, { entity: 'a wolf' });
    const fb = calls[1].body;
    assert.deepEqual(fb.messages, [{ role: 'system', content: 'sys' }, { role: 'user', content: 'describe wolf' }]);
    assert.deepEqual(fb.response_format, { type: 'json_schema', json_schema: { name: 'answer', schema: SCHEMA } });
    assert.equal(fb.temperature, 0.15);
  });
}

test('box unreachable falls back', async () => {
  const { fetchImpl } = recorder([
    ['/api/text', () => { throw new Error('ECONNREFUSED'); }],
    ['/v1/chat/completions', () => json(200, { choices: [{ message: { content: '{"entity":"a"}' } }] })],
  ]);
  const r = await tp.complete(fakeDb(BOX), REQ, { fetchImpl });
  assert.equal(r.via, 'fallback');
});

test('no text provider: straight to fallback', async () => {
  const { calls, fetchImpl } = recorder([['/v1/chat/completions', () => json(200, { choices: [{ message: { content: '{"entity":"a"}' } }] })]]);
  const r = await tp.complete(fakeDb(null), REQ, { fetchImpl });
  assert.equal(r.via, 'fallback');
  assert.equal(calls.length, 1);
});

test('box 400 is OUR bug: no fallback', async () => {
  const { calls, fetchImpl } = recorder([['/api/text', () => json(400, { detail: 'bad schema' })]]);
  const r = await tp.complete(fakeDb(BOX), REQ, { fetchImpl });
  assert.deepEqual({ ok: r.ok, via: r.via, busy: r.busy }, { ok: false, via: 'box', busy: false });
  assert.match(r.error, /400/);
  assert.equal(calls.length, 1);
});

test('boxOnly + 409: busy failure, no fallback call', async () => {
  const { calls, fetchImpl } = recorder([['/api/text', () => json(409, {})]]);
  const r = await tp.complete(fakeDb(BOX), REQ, { fetchImpl, boxOnly: true });
  assert.deepEqual({ ok: r.ok, busy: r.busy, via: r.via }, { ok: false, busy: true, via: 'box' });
  assert.equal(calls.length, 1);
});

test('boxOnly + no provider: not busy (waiting would never end)', async () => {
  const r = await tp.complete(fakeDb(null), REQ, { fetchImpl: async () => { throw new Error('no call expected'); }, boxOnly: true });
  assert.deepEqual({ ok: r.ok, busy: r.busy }, { ok: false, busy: false });
});

test('both fail: error names both', async () => {
  const { fetchImpl } = recorder([
    ['/api/text', () => json(503, {})],
    ['/v1/chat/completions', () => json(500, {})],
  ]);
  const r = await tp.complete(fakeDb(BOX), REQ, { fetchImpl });
  assert.equal(r.ok, false);
  assert.match(r.error, /503.*fallback.*500/);
});

test('listTextModels maps values', async () => {
  const { calls, fetchImpl } = recorder([['/api/text/models', () => json(200, [{ value: 'qwen', label: 'Qwen', loaded: false }])]]);
  const r = await tp.listTextModels(BOX, { fetchImpl });
  assert.deepEqual(r, { ok: true, models: ['qwen'] });
  assert.equal(calls[0].headers.Authorization, 'Bearer k');
});

// --- Fix round 1 ---

test('malformed base_url: complete() never throws, no fetch call, no fallback', async () => {
  const provider = { ...BOX, base_url: 'not a url' };
  const r = await tp.complete(fakeDb(provider), REQ, { fetchImpl: async () => { throw new Error('no call expected'); } });
  assert.deepEqual({ ok: r.ok, via: r.via, busy: r.busy }, { ok: false, via: 'box', busy: false });
  assert.match(r.error, /base_url/);
});

test('malformed base_url: listTextModels never throws', async () => {
  const provider = { ...BOX, base_url: 'not a url' };
  const r = await tp.listTextModels(provider, { fetchImpl: async () => { throw new Error('no call expected'); } });
  assert.equal(r.ok, false);
  assert.match(r.error, /base_url/);
});

test('db lookup rejects: complete() never throws, no fetch call', async () => {
  const badDb = { query: async () => { throw new Error('connection refused'); } };
  const r = await tp.complete(badDb, REQ, { fetchImpl: async () => { throw new Error('no call expected'); } });
  assert.deepEqual({ ok: r.ok, via: r.via, busy: r.busy }, { ok: false, via: 'box', busy: false });
  assert.match(r.error, /could not read the text provider/);
});

for (const status of [500, 502, 504]) {
  test(`box ${status} falls back (server fault, not 409/503 busy)`, async () => {
    const { calls, fetchImpl } = recorder([
      ['/api/text', () => json(status, {})],
      ['/v1/chat/completions', () => json(200, { choices: [{ message: { content: '{"entity":"a"}' } }] })],
    ]);
    const r = await tp.complete(fakeDb(BOX), REQ, { fetchImpl });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.via, 'fallback');
    assert.equal(calls.length, 2);
  });
}

test('boxOnly + box 500: ok:false, busy:false, no fallback call', async () => {
  const { calls, fetchImpl } = recorder([['/api/text', () => json(500, {})]]);
  const r = await tp.complete(fakeDb(BOX), REQ, { fetchImpl, boxOnly: true });
  assert.deepEqual({ ok: r.ok, busy: r.busy, via: r.via }, { ok: false, busy: false, via: 'box' });
  assert.equal(calls.length, 1);
});

// --- Task 5: non-box text providers (ollama / openai_compatible) ---

const OLLAMA = {
  id: 11, name: 'ollama', adapter: 'ollama', model: 'llama3:8b', base_url: 'http://o:11434', auth_header_name: null, auth_token: null, modality: 'text',
};
const chatOk = (content) => json(200, { choices: [{ message: { content } }] });

test('ollama provider: POSTs /v1/chat/completions with its model, via provider', async () => {
  const { calls, fetchImpl } = recorder([['/v1/chat/completions', () => chatOk('{"entity":"a wolf"}')]]);
  const r = await tp.complete(fakeDb(OLLAMA), REQ, { fetchImpl });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.via, 'provider');
  assert.equal(r.text, '{"entity":"a wolf"}');
  assert.deepEqual(r.json, { entity: 'a wolf' });
  assert.equal(r.model, 'llama3:8b');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://o:11434/v1/chat/completions');
  assert.equal(calls[0].body.model, 'llama3:8b');
  assert.deepEqual(calls[0].body.messages, [{ role: 'system', content: 'sys' }, { role: 'user', content: 'describe wolf' }]);
});

test('openai provider: bearer token is sent', async () => {
  const p = { ...OLLAMA, adapter: 'openai_compatible', base_url: 'http://api.test/', auth_token: 'sk-1' };
  const { calls, fetchImpl } = recorder([['/v1/chat/completions', () => chatOk('hi')]]);
  const r = await tp.complete(fakeDb(p), { ...REQ, jsonSchema: null }, { fetchImpl });
  assert.equal(r.ok, true, r.error);
  assert.equal(calls[0].headers.Authorization, 'Bearer sk-1');
  assert.equal(calls[0].body.response_format, undefined);
});

test('NULL-adapter provider still POSTs /api/text with no model key (regression)', async () => {
  const { calls, fetchImpl } = recorder([['/api/text', () => json(200, { text: 'x', model: 'm' })]]);
  const r = await tp.complete(fakeDb({ ...BOX, adapter: null, model: 'qwen' }), REQ, { fetchImpl });
  assert.equal(r.via, 'box');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/text$/);
  assert.equal('model' in calls[0].body, false);
});

test('openai provider answering 401: ok:false and NO fallback call', async () => {
  const p = { ...OLLAMA, adapter: 'openai_compatible' };
  const { calls, fetchImpl } = recorder([['/v1/chat/completions', () => json(401, { error: 'bad key' })]]);
  const r = await tp.complete(fakeDb(p), REQ, { fetchImpl });
  assert.deepEqual({ ok: r.ok, via: r.via, busy: r.busy }, { ok: false, via: 'provider', busy: false });
  assert.match(r.error, /401/);
  assert.equal(calls.length, 1, 'only the provider was asked');
});

test('ollama 503 falls back to the CPU model; boxOnly refuses to', async () => {
  const routes = [['o:11434', () => json(503, {})], ['localhost:20434', () => chatOk('{"entity":"a"}')]];
  const a = recorder(routes);
  const r = await tp.complete(fakeDb(OLLAMA), REQ, { fetchImpl: a.fetchImpl });
  assert.equal(r.via, 'fallback');
  assert.equal(a.calls.length, 2);
  const b = recorder(routes);
  const rb = await tp.complete(fakeDb(OLLAMA), REQ, { fetchImpl: b.fetchImpl, boxOnly: true });
  assert.deepEqual({ ok: rb.ok, busy: rb.busy, via: rb.via }, { ok: false, busy: true, via: 'provider' });
  assert.equal(b.calls.length, 1);
});

test('ollama with a blank model: error, no network call, no fallback', async () => {
  for (const model of ['', '  ', null]) {
    const r = await tp.complete(fakeDb({ ...OLLAMA, model }), REQ, { fetchImpl: async () => { throw new Error('no call expected'); } });
    assert.deepEqual({ ok: r.ok, error: r.error, via: r.via }, { ok: false, error: 'text provider has no model', via: 'provider' });
  }
});

test('ollama malformed base_url: no fetch, no fallback', async () => {
  const r = await tp.complete(fakeDb({ ...OLLAMA, base_url: 'not a url' }), REQ, { fetchImpl: async () => { throw new Error('no call expected'); } });
  assert.deepEqual({ ok: r.ok, via: r.via }, { ok: false, via: 'provider' });
  assert.match(r.error, /base_url/);
});

test('isBoxText: NULL/box adapters are box, ollama/openai are not', () => {
  assert.equal(tp.isBoxText({ adapter: null }), true);
  assert.equal(tp.isBoxText({}), true);
  assert.equal(tp.isBoxText({ adapter: 'box' }), true);
  assert.equal(tp.isBoxText({ adapter: 'ollama' }), false);
  assert.equal(tp.isBoxText({ adapter: 'openai_compatible' }), false);
});

test('listTextModels by adapter: ollama /api/tags, openai /v1/models, box unchanged', async () => {
  const o = recorder([['/api/tags', () => json(200, { models: [{ name: 'llama3:8b' }] })]]);
  assert.deepEqual(await tp.listTextModels(OLLAMA, { fetchImpl: o.fetchImpl }), { ok: true, models: ['llama3:8b'] });
  assert.match(o.calls[0].url, /\/api\/tags$/);
  const a = recorder([['/v1/models', () => json(200, { data: [{ id: 'gpt-x' }] })]]);
  assert.deepEqual(await tp.listTextModels({ ...OLLAMA, adapter: 'openai_compatible' }, { fetchImpl: a.fetchImpl }), { ok: true, models: ['gpt-x'] });
  assert.match(a.calls[0].url, /\/v1\/models$/);
});
