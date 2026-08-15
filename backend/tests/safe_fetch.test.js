const test = require('node:test');
const assert = require('node:assert');
const { unsafeUrlReason, assertSafeUrl, redactUrl, safeFetch } = require('../src/services/safeFetch');
const { fetchModels } = require('../src/services/providerDiscovery');

// --- What is and is not allowed -----------------------------------------

test('a LAN http URL is allowed, because that is the whole point', () => {
  // This guard must NOT block private addresses: the target is somebody's
  // desktop on the LAN. Blocking it would defeat the feature.
  assert.strictEqual(unsafeUrlReason('http://192.168.1.20:7860/sdapi/v1/txt2img'), null);
  assert.strictEqual(unsafeUrlReason('http://localhost:7860'), null);
  assert.strictEqual(unsafeUrlReason('https://gpu.lan/generate'), null);
});

test('non-http schemes are refused', () => {
  for (const bad of ['file:///etc/passwd', 'ftp://h/x', 'gopher://h', 'data:text/plain,x']) {
    assert.match(unsafeUrlReason(bad) || '', /not allowed|absolute/, `${bad} must be refused`);
  }
});

test('credentials embedded in the URL are refused', () => {
  assert.match(unsafeUrlReason('http://user:pass@host/x'), /credentials/);
  assert.match(unsafeUrlReason('http://user@host/x'), /credentials/);
});

test('assertSafeUrl throws with a redacted URL, never the raw one', () => {
  assert.throws(() => assertSafeUrl('file:///etc/shadow'), /refusing to call/);
  try {
    assertSafeUrl('http://u:secretpw@host/x');
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(!err.message.includes('secretpw'), `password leaked into: ${err.message}`);
  }
});

test('redactUrl strips credentials and query strings', () => {
  // API keys hide in query strings, and error strings end up in logs.
  assert.ok(!redactUrl('http://h/x?api_key=sk-secret').includes('sk-secret'));
  assert.ok(!redactUrl('http://u:pw@h/x').includes('pw'));
  assert.strictEqual(redactUrl('http://h:7860/generate'), 'http://h:7860/generate');
  assert.strictEqual(redactUrl('nonsense'), '[unparseable url]');
});

// --- Redirects -----------------------------------------------------------

function redirectTo(location, status = 302) {
  return { status, ok: false, headers: { get: (h) => (h === 'location' ? location : null) } };
}
function ok200() {
  return { status: 200, ok: true, headers: { get: () => 'application/json' }, json: async () => ({}) };
}

test('a same-origin redirect is followed and keeps the auth header', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, auth: init.headers.Authorization });
    return seen.length === 1 ? redirectTo('/moved') : ok200();
  };
  const res = await safeFetch('http://box:7860/a', { headers: { Authorization: 'sk-secret' } }, { fetchImpl });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(seen[1].url, 'http://box:7860/moved');
  assert.strictEqual(seen[1].auth, 'sk-secret', 'a same-origin hop may keep the token');
});

test('a cross-origin redirect drops the auth header', async () => {
  // The token belongs to the host the admin configured. A 302 to another host
  // must not carry it there.
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, headers: init.headers });
    return seen.length === 1 ? redirectTo('http://evil.example/steal') : ok200();
  };
  await safeFetch('http://box:7860/a', { headers: { Authorization: 'sk-secret' } }, { fetchImpl });
  assert.strictEqual(seen[1].url, 'http://evil.example/steal');
  const forwarded = JSON.stringify(seen[1].headers);
  assert.ok(!forwarded.includes('sk-secret'), `token followed the redirect: ${forwarded}`);
});

test('a redirect to a non-http scheme is refused outright', async () => {
  const fetchImpl = async () => redirectTo('file:///etc/passwd');
  await assert.rejects(
    safeFetch('http://box:7860/a', {}, { fetchImpl }),
    /unusable URL/,
  );
});

test('a redirect loop is capped rather than followed forever', async () => {
  const fetchImpl = async () => redirectTo('/again');
  await assert.rejects(
    safeFetch('http://box:7860/a', {}, { fetchImpl, maxRedirects: 2 }),
    /redirected more than 2 times/,
  );
});

test('a non-redirect response is returned untouched', async () => {
  const fetchImpl = async () => ok200();
  const res = await safeFetch('http://box:7860/a', {}, { fetchImpl });
  assert.strictEqual(res.status, 200);
});

// --- The guard is actually wired into the call paths ---------------------

test('discovery refuses a file:// base_url at call time, not just at save time', async () => {
  // The column can be edited straight in psql, so the save-time check in
  // aiProviders.js cannot be the only one.
  let called = false;
  const fetchImpl = async () => { called = true; return ok200(); };
  const out = await fetchModels(
    { base_url: 'file:///etc/passwd', models_path: '', models_pointer: '' },
    { fetchImpl },
  );
  assert.strictEqual(out.ok, false);
  assert.strictEqual(called, false, 'the transport must never be reached for a refused scheme');
  assert.match(out.error, /not allowed|refusing/);
});

// --- Size caps, exercised against a REAL body stream ---------------------
// These matter because res.json()/res.arrayBuffer() buffer the whole body
// before any limit can apply, handing an untrusted service a free
// memory-exhaustion primitive. A stubbed .json() would not prove the cap, so
// these build an actual ReadableStream.

const { readCapped, readJsonCapped } = require('../src/services/safeFetch');

function streamedResponse(text) {
  const bytes = Buffer.from(text, 'utf8');
  let sent = 0;
  let cancelled = false;
  const res = {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => {
          if (sent >= bytes.length) return { done: true, value: undefined };
          // 8 bytes at a time, so a cap can bite part-way through.
          const chunk = bytes.subarray(sent, sent + 8);
          sent += chunk.length;
          return { done: false, value: new Uint8Array(chunk) };
        },
        cancel: async () => { cancelled = true; },
      }),
    },
  };
  return { res, bytesSent: () => sent, wasCancelled: () => cancelled, total: bytes.length };
}

test('readCapped abandons an oversized body part-way instead of buffering it', async () => {
  const big = 'x'.repeat(10000);
  const s = streamedResponse(big);
  const out = await readCapped(s.res, 64);
  assert.match(out.error || '', /size cap/);
  assert.ok(s.bytesSent() < s.total,
    `must stop early: read ${s.bytesSent()} of ${s.total} bytes`);
  assert.ok(s.wasCancelled(), 'the reader must be cancelled, not left dangling');
});

test('readCapped returns the whole body when it fits', async () => {
  const s = streamedResponse('hello world');
  const out = await readCapped(s.res, 1024);
  assert.strictEqual(out.buffer.toString('utf8'), 'hello world');
});

test('readJsonCapped parses within the cap and refuses beyond it', async () => {
  const small = streamedResponse(JSON.stringify({ models: ['a', 'b'] }));
  assert.deepStrictEqual((await readJsonCapped(small.res, 1024)).json, { models: ['a', 'b'] });

  const huge = streamedResponse(JSON.stringify({ pad: 'y'.repeat(50000) }));
  const out = await readJsonCapped(huge.res, 128);
  assert.match(out.error || '', /size cap/);
  assert.ok(huge.bytesSent() < huge.total, 'an oversized JSON body must not be fully read');
});

test('readJsonCapped reports malformed JSON rather than throwing', async () => {
  const s = streamedResponse('{not json');
  const out = await readJsonCapped(s.res, 1024);
  assert.match(out.error || '', /not valid JSON/);
});

test('a body that is neither streamable nor bufferable is reported, not silently uncapped', async () => {
  const out = await readCapped({ ok: true, status: 200 }, 1024);
  assert.match(out.error || '', /not readable/);
});
