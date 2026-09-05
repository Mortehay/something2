const test = require('node:test');
const assert = require('node:assert');
const wg = require('../src/services/worldGenService.js');

// A provider row shaped like the ones this repo's ai_providers table actually
// holds -- note auth_header_name is NULL on both live rows, which is the case
// the header test below exists for.
const ROW = {
  id: 4,
  name: 'desktop gpu',
  base_url: 'http://192.168.0.217:8001/sdapi/v1/txt2img',
  auth_header_name: null,
  auth_token: 'sk_test_token',
  enabled: true,
  is_active: false,
};
const db = (rows = [ROW]) => ({ query: async () => ({ rows }) });

// Records what the client sent, and answers whatever the test asked for.
// A real Response is used rather than a hand-rolled stub because readCapped
// explicitly refuses a body that is neither a stream nor a buffer -- a stub
// that skipped it would be testing the error path by accident.
function recorder(reply) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body });
    if (typeof reply === 'function') return reply(String(url), opts);
    return reply;
  };
  return { calls, fetchImpl };
}
const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json' },
});

test('the base URL\'s ORIGIN is what the world service is reached on, not its path', async () => {
  const { origin, providerName } = await wg.resolveWorldService(db());
  // base_url points at the image endpoint; worlds live at a different path on
  // the same host, so anything that kept /sdapi/v1/txt2img would 404 forever.
  assert.equal(origin, 'http://192.168.0.217:8001');
  assert.equal(providerName, 'desktop gpu');
});

test('a NULL auth_header_name still sends Authorization: Bearer', async () => {
  // The live rows carry no header name. An earlier version of the provider
  // code dropped the credential entirely in that case and the service answered
  // "missing token" -- a configured-but-unsent credential. Pinned here because
  // this client shares that helper and would inherit the same silence.
  const { calls, fetchImpl } = recorder(json({ items: [], total: 0 }));
  await wg.listWorlds(db(), { fetchImpl });
  assert.equal(calls[0].headers.Authorization, 'Bearer sk_test_token');
  assert.equal(calls[0].url, 'http://192.168.0.217:8001/api/worlds');
});

test('401 is an auth failure with a message, NOT an empty list', async () => {
  // The acceptance criterion this whole error taxonomy exists for: the
  // generator's author shipped auth failure and unreachable-host both
  // rendering as an empty list, indistinguishable from "nothing generated
  // yet". An empty items array here would be that bug, reproduced.
  const { fetchImpl } = recorder(json({ detail: 'Invalid or revoked token' }, 401));
  await assert.rejects(
    () => wg.listWorlds(db(), { fetchImpl }),
    (err) => {
      assert.equal(err.name, 'WorldGenError');
      assert.equal(err.code, 'auth_failed');
      assert.match(err.message, /rejected the bearer token/);
      assert.match(err.message, /desktop gpu/, 'must name which connector supplied the token');
      return true;
    },
  );
});

test('a transport failure is reported as unreachable, naming the host', async () => {
  const fetchImpl = async () => { throw new Error('fetch failed'); };
  await assert.rejects(
    () => wg.listWorlds(db(), { fetchImpl }),
    (err) => {
      assert.equal(err.code, 'unreachable');
      assert.match(err.message, /192\.168\.0\.217:8001/);
      return true;
    },
  );
});

test('404 is not_found and does not masquerade as a service error', async () => {
  const { fetchImpl } = recorder(json({ detail: 'no such region' }, 404));
  await assert.rejects(
    () => wg.getWorldSpec(db(), 'nope', { fetchImpl }),
    (err) => { assert.equal(err.code, 'not_found'); assert.equal(err.status, 404); return true; },
  );
});

test('a service error surfaces the service\'s own detail rather than replacing it', async () => {
  const { fetchImpl } = recorder(json({ detail: 'target_per_screen must be > 0' }, 400));
  await assert.rejects(
    () => wg.createWorld(db(), { name: 'x' }, { fetchImpl }),
    (err) => {
      assert.equal(err.code, 'service_error');
      assert.match(err.message, /target_per_screen must be > 0/);
      return true;
    },
  );
});

test('no configured connector is its own code, not a generic failure', async () => {
  await assert.rejects(
    () => wg.listWorlds(db([])),
    (err) => { assert.equal(err.code, 'not_configured'); assert.equal(err.status, 503); return true; },
  );
});

test('region names that could escape the URL or the filename are refused', async () => {
  // The download route interpolates this name into a PATH. The regex is what
  // makes that safe, so it is pinned here rather than left to path.join.
  for (const bad of ['../../etc/passwd', 'a/b', '', '.', 'x'.repeat(65), 'a b', 'a?b=1', '-lead']) {
    assert.throws(() => wg.assertName(bad), /region name must be/i, `should reject ${JSON.stringify(bad)}`);
  }
  for (const ok of ['emerald-reach', 'a', 'A_b-9', 'x'.repeat(64)]) {
    assert.equal(wg.assertName(ok), ok);
  }
});

test('PATCH sends ONLY the fields it was given', async () => {
  // The generator carries over every field a PATCH omits, including the biome
  // plan -- that is the contract the "raise the target, biomes must not
  // change" acceptance criterion rests on. Round-tripping a whole object back
  // would silently pin fields the caller never meant to freeze.
  const { calls, fetchImpl } = recorder(json({ name: 'emerald-reach', worlds: 8 }));
  await wg.patchWorld(db(), 'emerald-reach', { target_per_screen: 9 }, { fetchImpl });
  assert.equal(calls[0].method, 'PATCH');
  assert.deepEqual(JSON.parse(calls[0].body), { target_per_screen: 9 });
  assert.equal(calls[0].headers['Content-Type'], 'application/json');
});

test('the preview comes back as bytes with its content type, not as JSON', async () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const { fetchImpl } = recorder(new Response(png, { status: 200, headers: { 'content-type': 'image/png' } }));
  const out = await wg.getPreview(db(), 'emerald-reach', { fetchImpl });
  assert.equal(out.contentType, 'image/png');
  assert.ok(Buffer.isBuffer(out.buffer));
  assert.deepEqual(out.buffer, png);
});
