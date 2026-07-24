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
      // A response can supply raw HTML via `text` (Cloudflare block pages
      // aren't JSON) or a plain object via `body` (JSON-stringified for you).
      text: async () => (next.text !== undefined ? next.text : JSON.stringify(next.body)),
    };
  };
  impl.calls = calls;
  return impl;
}

function fakeSleepSpy() {
  const calls = [];
  const impl = async (ms) => {
    calls.push(ms);
  };
  impl.calls = calls;
  return impl;
}

// A trimmed version of the page that actually blocked the live sync
// (Ray ID a203d1cb8fb85b5a) — HTML, not JSON, with Cloudflare markers.
const CLOUDFLARE_BLOCK_HTML = [
  '<!DOCTYPE html>',
  '<html><head><title>Attention Required! | Cloudflare</title></head>',
  '<body><div class="cf-error-details">',
  '<h1>Attention Required!</h1>',
  '<p>You are unable to access api.plane.so</p>',
  '<p>Ray ID: a203d1cb8fb85b5a &bull; Performance &amp; security by Cloudflare</p>',
  '</div></body></html>',
].join('\n');

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

// Regression coverage for the live sync (F-001 -> SOMET-165, then a
// Cloudflare 403 block on the very next write, Ray ID a203d1cb8fb85b5a).

test('a Cloudflare-style HTML 403 is retried and succeeds on a later attempt', async () => {
  const impl = fakeFetch([
    { status: 403, text: CLOUDFLARE_BLOCK_HTML },
    { status: 403, text: CLOUDFLARE_BLOCK_HTML },
    { status: 200, body: { results: [{ id: 'l1' }] } },
  ]);
  const sleepImpl = fakeSleepSpy();
  const client = new PlaneClient({ apiKey: 'plane_api_secret', fetchImpl: impl, sleepImpl });

  const result = await client.listLabels();

  assert.deepStrictEqual(result, [{ id: 'l1' }]);
  assert.strictEqual(impl.calls.length, 3);
  // Exponential backoff: each wait strictly longer than the last.
  assert.strictEqual(sleepImpl.calls.length, 2);
  assert.ok(sleepImpl.calls[1] > sleepImpl.calls[0], `expected backoff to grow: ${sleepImpl.calls}`);
});

test('a genuine JSON 403 is not retried and fails immediately', async () => {
  const impl = fakeFetch([{ status: 403, body: { error: 'Invalid API key.' } }]);
  const sleepImpl = fakeSleepSpy();
  const client = new PlaneClient({ apiKey: 'bad-key', fetchImpl: impl, sleepImpl });

  await assert.rejects(() => client.listLabels(), /403.*Invalid API key/s);
  assert.strictEqual(impl.calls.length, 1, 'a genuine authz failure must not be retried');
  assert.deepStrictEqual(sleepImpl.calls, []);
});

test('a genuine JSON 429 from Plane itself is retried like a rate limit', async () => {
  const impl = fakeFetch([
    { status: 429, body: { error: 'rate limited' } },
    { status: 200, body: { results: [] } },
  ]);
  const sleepImpl = fakeSleepSpy();
  const client = new PlaneClient({ apiKey: 'k', fetchImpl: impl, sleepImpl });

  const result = await client.listLabels();
  assert.deepStrictEqual(result, []);
  assert.strictEqual(impl.calls.length, 2);
});

test('retries are capped and the final error names the exhaustion', async () => {
  const impl = fakeFetch([
    { status: 403, text: CLOUDFLARE_BLOCK_HTML },
    { status: 403, text: CLOUDFLARE_BLOCK_HTML },
    { status: 403, text: CLOUDFLARE_BLOCK_HTML },
    { status: 403, text: CLOUDFLARE_BLOCK_HTML },
  ]);
  const sleepImpl = fakeSleepSpy();
  const client = new PlaneClient({ apiKey: 'plane_api_secret', fetchImpl: impl, sleepImpl, maxAttempts: 4 });

  await assert.rejects(() => client.listLabels(), /after 4 attempts/);
  assert.strictEqual(impl.calls.length, 4);
  assert.strictEqual(sleepImpl.calls.length, 3);
});

test('the exhaustion error never contains the API key (it travels as a header, not in the body)', async () => {
  const impl = fakeFetch([
    { status: 403, text: CLOUDFLARE_BLOCK_HTML },
    { status: 403, text: CLOUDFLARE_BLOCK_HTML },
  ]);
  const sleepImpl = fakeSleepSpy();
  const client = new PlaneClient({
    apiKey: 'plane_api_supersecret123',
    fetchImpl: impl,
    sleepImpl,
    maxAttempts: 2,
  });

  await assert.rejects(
    () => client.listLabels(),
    (error) => {
      assert.ok(!error.message.includes('plane_api_supersecret123'), error.message);
      return true;
    }
  );
});
