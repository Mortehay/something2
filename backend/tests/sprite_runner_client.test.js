const test = require('node:test');
const assert = require('node:assert');
const { createClient } = require('../scripts/lib/spriteRunnerClient.js');

// A scripted fake fetch: each call shifts the next handler off the queue and
// asserts the request, then returns a Response-like object.
function fakeFetch(handlers) {
  const queue = [...handlers];
  return async (url, init) => {
    const h = queue.shift();
    if (!h) throw new Error(`unexpected fetch to ${url}`);
    return h(url, init || {});
  };
}
function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('login posts credentials and returns the token', async () => {
  const fetch = fakeFetch([
    (url, init) => {
      assert.equal(url, 'http://api/api/auth/login');
      assert.equal(init.method, 'POST');
      assert.deepEqual(JSON.parse(init.body), { username: 'admin', password: 'pw' });
      return jsonResponse(200, { token: 'TKN', user: { role: 'admin' } });
    },
  ]);
  const c = createClient({ baseUrl: 'http://api', fetch });
  assert.equal(await c.login('admin', 'pw'), 'TKN');
});

test('login throws on non-2xx', async () => {
  const fetch = fakeFetch([() => jsonResponse(401, { error: 'bad creds' })]);
  const c = createClient({ baseUrl: 'http://api', fetch });
  await assert.rejects(() => c.login('admin', 'pw'), /login.*401/);
});

test('startJob routes creature to sprite-jobs with the right body', async () => {
  const fetch = fakeFetch([
    (url, init) => {
      assert.equal(url, 'http://api/api/sprite-jobs');
      assert.equal(init.headers.Authorization, 'Bearer TKN');
      assert.deepEqual(JSON.parse(init.body),
        { entity_type: 'Wolf', base_prompt: 'a wolf', seed: 101, frames: 1, backend: 'sd-turbo' });
      return jsonResponse(201, { job_id: 'abc123', recipe: {} });
    },
  ]);
  const c = createClient({ baseUrl: 'http://api', fetch });
  const r = await c.startJob('TKN',
    { kind: 'creature', name: 'Wolf', prompt: 'a wolf', seed: 101, frames: 1, backend: 'sd-turbo' });
  assert.deepEqual(r, { jobId: 'abc123', route: 'sprite-jobs' });
});

test('startJob routes object to entity-jobs', async () => {
  const fetch = fakeFetch([
    (url) => { assert.equal(url, 'http://api/api/entity-jobs'); return jsonResponse(201, { job_id: 'obj9' }); },
  ]);
  const c = createClient({ baseUrl: 'http://api', fetch });
  const r = await c.startJob('TKN',
    { kind: 'object', name: 'Tree', prompt: 'a tree', seed: 301, frames: 1, backend: null });
  assert.equal(r.route, 'entity-jobs');
  assert.equal(r.jobId, 'obj9');
});

test('pollJob returns on done and passes through the result', async () => {
  const fetch = fakeFetch([
    () => jsonResponse(200, { status: 'running', result: null }),
    () => jsonResponse(200, { status: 'done', result: { atlas_key: 'sprites/Wolf/atlas.png' } }),
  ]);
  const c = createClient({ baseUrl: 'http://api', fetch, sleep: async () => {} });
  const out = await c.pollJob('TKN', 'sprite-jobs', 'abc123', { intervalMs: 1, timeoutMs: 10000 });
  assert.equal(out.status, 'done');
  assert.equal(out.result.atlas_key, 'sprites/Wolf/atlas.png');
});

test('pollJob returns on error status', async () => {
  const fetch = fakeFetch([() => jsonResponse(200, { status: 'error', error: 'backend blew up' })]);
  const c = createClient({ baseUrl: 'http://api', fetch, sleep: async () => {} });
  const out = await c.pollJob('TKN', 'sprite-jobs', 'abc123', { intervalMs: 1, timeoutMs: 10000 });
  assert.equal(out.status, 'error');
  assert.equal(out.error, 'backend blew up');
});

test('pollJob throws on timeout', async () => {
  const fetch = fakeFetch(Array.from({ length: 50 }, () => () => jsonResponse(200, { status: 'running' })));
  let clock = 0;
  const c = createClient({ baseUrl: 'http://api', fetch, sleep: async (ms) => { clock += ms; }, now: () => clock });
  await assert.rejects(
    () => c.pollJob('TKN', 'sprite-jobs', 'abc123', { intervalMs: 100, timeoutMs: 300 }),
    /timed out/,
  );
});
