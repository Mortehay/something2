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
