'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { PlaneClient } = require('../lib/plane.js');

function fakeFetch(responses) {
  const calls = [];
  const queue = responses.slice();
  const impl = async (url, options) => {
    calls.push({ url, options });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected request to ${url}`);
    return {
      ok: next.status < 400,
      status: next.status,
      text: async () => JSON.stringify(next.body),
    };
  };
  impl.calls = calls;
  return impl;
}

test('sends the API key and a browser-like user agent', async () => {
  const impl = fakeFetch([{ status: 200, body: { results: [] } }]);
  const client = new PlaneClient({ apiKey: 'plane_api_secret', fetchImpl: impl });

  await client.listLabels();

  const headers = impl.calls[0].options.headers;
  assert.strictEqual(headers['X-API-Key'], 'plane_api_secret');
  assert.strictEqual(headers['User-Agent'], 'curl/8.5.0');
});

test('listLabels returns the results array', async () => {
  const impl = fakeFetch([{ status: 200, body: { results: [{ id: 'l1', name: 'K' }] } }]);
  const client = new PlaneClient({ apiKey: 'k', fetchImpl: impl });

  assert.deepStrictEqual(await client.listLabels(), [{ id: 'l1', name: 'K' }]);
});

test('listIssues follows pagination until next_cursor is absent', async () => {
  const impl = fakeFetch([
    { status: 200, body: { results: [{ id: 'i1' }], next_cursor: 'c2', next_page_results: true } },
    { status: 200, body: { results: [{ id: 'i2' }], next_page_results: false } },
  ]);
  const client = new PlaneClient({ apiKey: 'k', fetchImpl: impl });

  const issues = await client.listIssues({});
  assert.deepStrictEqual(issues.map((i) => i.id), ['i1', 'i2']);
  assert.strictEqual(impl.calls.length, 2);
  assert.ok(impl.calls[1].url.includes('cursor=c2'));
});

test('createIssue posts the body and returns the created issue', async () => {
  const impl = fakeFetch([{ status: 201, body: { id: 'i9', sequence_id: 200 } }]);
  const client = new PlaneClient({ apiKey: 'k', fetchImpl: impl });

  const created = await client.createIssue({
    name: 'Fix authz',
    description_html: '<p>body</p>',
    priority: 'urgent',
    labels: ['l1'],
    parent: 'epic-1',
  });

  assert.deepStrictEqual(created, { id: 'i9', sequence_id: 200 });
  const sent = JSON.parse(impl.calls[0].options.body);
  assert.strictEqual(sent.name, 'Fix authz');
  assert.strictEqual(sent.parent, 'epic-1');
  assert.strictEqual(impl.calls[0].options.method, 'POST');
});

test('updateIssue issues a PATCH', async () => {
  const impl = fakeFetch([{ status: 200, body: { id: 'i9' } }]);
  const client = new PlaneClient({ apiKey: 'k', fetchImpl: impl });

  await client.updateIssue('i9', { priority: 'high' });
  assert.strictEqual(impl.calls[0].options.method, 'PATCH');
  assert.deepStrictEqual(JSON.parse(impl.calls[0].options.body), { priority: 'high' });
});

test('a non-ok response raises an error naming the status and body', async () => {
  const impl = fakeFetch([{ status: 403, body: { error: 'forbidden' } }]);
  const client = new PlaneClient({ apiKey: 'k', fetchImpl: impl });

  await assert.rejects(() => client.listLabels(), /403.*forbidden/s);
});
