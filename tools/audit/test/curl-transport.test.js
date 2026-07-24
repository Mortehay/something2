'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  createCurlTransport,
  escapeConfigValue,
  STATUS_MARKER,
  DEFAULT_CONNECT_TIMEOUT_SECONDS,
  DEFAULT_MAX_TIME_SECONDS,
} = require('../lib/curl-transport.js');

// Fakes the injectable process runner so no real `curl` (or any subprocess)
// is ever spawned by this suite. Mirrors defaultRunner's contract:
// ({ command, args, input }) => Promise<{ spawnError, code, stdout, stderr }>.
function fakeRunner(script) {
  const calls = [];
  const queue = script.slice();
  const impl = async ({ command, args, input }) => {
    calls.push({ command, args, input });
    const next = queue.shift();
    if (!next) throw new Error('unexpected curl invocation');
    return next;
  };
  impl.calls = calls;
  return impl;
}

function okResult(body, status) {
  return { spawnError: null, code: 0, stdout: `${body}${STATUS_MARKER}${status}`, stderr: '' };
}

test('GET builds argv with no secrets and a config-file body on stdin', async () => {
  const runner = fakeRunner([okResult(JSON.stringify({ results: [] }), 200)]);
  const fetchImpl = createCurlTransport({ runner });

  const res = await fetchImpl('https://api.plane.so/api/v1/labels/', {
    method: 'GET',
    headers: { 'X-API-Key': 'plane_api_supersecret123', 'User-Agent': 'curl/8.5.0' },
  });

  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(await res.text(), JSON.stringify({ results: [] }));

  const call = runner.calls[0];
  assert.strictEqual(call.command, 'curl');
  // Only non-secret, fixed flags belong in argv. `--config -` is what routes
  // everything else (url, method, headers, body) through stdin instead.
  assert.deepStrictEqual(call.args, [
    '--silent',
    '--show-error',
    '--connect-timeout',
    String(DEFAULT_CONNECT_TIMEOUT_SECONDS),
    '--max-time',
    String(DEFAULT_MAX_TIME_SECONDS),
    '--config',
    '-',
  ]);
  assert.ok(!call.args.join(' ').includes('plane_api_supersecret123'), 'argv must not carry the API key');
  // The key does reach curl — just via stdin, not argv.
  assert.ok(call.input.includes('X-API-Key: plane_api_supersecret123'));
  assert.ok(call.input.includes('request = "GET"'));
  assert.ok(call.input.includes('url = "https://api.plane.so/api/v1/labels/"'));
});

test('POST places the JSON body in the config, not argv, and never follows -L', async () => {
  const runner = fakeRunner([okResult(JSON.stringify({ id: 'i9' }), 201)]);
  const fetchImpl = createCurlTransport({ runner });

  await fetchImpl('https://api.plane.so/api/v1/issues/', {
    method: 'POST',
    headers: { 'X-API-Key': 'secret-key', 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Fix authz' }),
  });

  const call = runner.calls[0];
  assert.ok(!call.args.join(' ').includes('secret-key'));
  assert.ok(!call.args.some((a) => a.includes('-L')), 'must not blindly follow redirects');
  assert.ok(call.input.includes('request = "POST"'));
  assert.ok(call.input.includes('data-raw = "{\\"name\\":\\"Fix authz\\"}"'));
});

test('PATCH sends the patch body via the request method in the config', async () => {
  const runner = fakeRunner([okResult(JSON.stringify({ id: 'i9' }), 200)]);
  const fetchImpl = createCurlTransport({ runner });

  await fetchImpl('https://api.plane.so/api/v1/issues/i9/', {
    method: 'PATCH',
    headers: { 'X-API-Key': 'secret-key' },
    body: JSON.stringify({ priority: 'high' }),
  });

  const call = runner.calls[0];
  assert.ok(!call.args.join(' ').includes('secret-key'));
  assert.ok(call.input.includes('request = "PATCH"'));
  assert.ok(call.input.includes('data-raw = "{\\"priority\\":\\"high\\"}"'));
});

test('DELETE sends no body and still avoids the key in argv', async () => {
  const runner = fakeRunner([{ spawnError: null, code: 0, stdout: `${STATUS_MARKER}204`, stderr: '' }]);
  const fetchImpl = createCurlTransport({ runner });

  const res = await fetchImpl('https://api.plane.so/api/v1/issues/i9/', {
    method: 'DELETE',
    headers: { 'X-API-Key': 'secret-key' },
  });

  assert.strictEqual(res.status, 204);
  assert.strictEqual(await res.text(), '');
  const call = runner.calls[0];
  assert.ok(!call.args.join(' ').includes('secret-key'));
  assert.ok(call.input.includes('request = "DELETE"'));
  assert.ok(!call.input.includes('data-raw'), 'DELETE has no body to send');
});

test('a value containing quotes and backslashes is escaped safely for the config file', async () => {
  const runner = fakeRunner([okResult('{}', 200)]);
  const fetchImpl = createCurlTransport({ runner });

  const body = JSON.stringify({ name: 'quote " and backslash \\ test' });
  await fetchImpl('https://api.plane.so/api/v1/issues/', {
    method: 'POST',
    headers: { 'X-API-Key': 'k' },
    body,
  });

  const call = runner.calls[0];
  // Every line must still parse as one config statement: no unescaped `"`
  // may terminate the data-raw value early. Compare against the module's own
  // escaping primitive (unit-tested separately below) rather than a
  // hand-typed literal, since backslash escaping is easy to miscount by eye.
  const expectedLine = `data-raw = "${escapeConfigValue(body)}"`;
  assert.ok(call.input.includes(expectedLine), `expected to find:\n${expectedLine}\nin:\n${call.input}`);
});

test('escapeConfigValue round-trips through curl config quoting rules', () => {
  // curl unescapes \\ -> \ and \" -> " inside a double-quoted config value.
  // Reproduce that unescaping here and confirm it recovers the original
  // string for a value containing both backslashes and quotes.
  function curlUnescape(escaped) {
    let out = '';
    for (let i = 0; i < escaped.length; i += 1) {
      if (escaped[i] === '\\' && i + 1 < escaped.length) {
        i += 1;
        out += escaped[i];
      } else {
        out += escaped[i];
      }
    }
    return out;
  }

  const original = 'quote " and backslash \\ and both \\" together';
  assert.strictEqual(curlUnescape(escapeConfigValue(original)), original);
});

test('a curl process failure to launch (binary missing) raises a distinct, clear error', async () => {
  const enoent = Object.assign(new Error('spawn curl ENOENT'), { code: 'ENOENT' });
  const runner = fakeRunner([{ spawnError: enoent, code: null, stdout: '', stderr: '' }]);
  const fetchImpl = createCurlTransport({ runner });

  await assert.rejects(
    () => fetchImpl('https://api.plane.so/api/v1/labels/', { method: 'GET', headers: {} }),
    (error) => {
      assert.match(error.message, /curl transport failed to launch/);
      assert.match(error.message, /ENOENT/);
      assert.strictEqual(error.curlSpawnError, true);
      // Must not read like Plane rejected the request.
      assert.ok(!/Plane/.test(error.message));
      return true;
    }
  );
});

test('a non-zero curl exit code raises a distinct error naming the exit code, not an HTTP status', async () => {
  const runner = fakeRunner([{ spawnError: null, code: 6, stdout: '', stderr: 'curl: (6) Could not resolve host: api.plane.so' }]);
  const fetchImpl = createCurlTransport({ runner });

  await assert.rejects(
    () => fetchImpl('https://api.plane.so/api/v1/labels/', { method: 'GET', headers: {} }),
    (error) => {
      assert.match(error.message, /curl exited with status 6/);
      assert.match(error.message, /Could not resolve host/);
      assert.strictEqual(error.curlExitCode, 6);
      return true;
    }
  );
});

test('a non-2xx HTTP response (e.g. a Cloudflare block page) is returned, not thrown, so PlaneClient can inspect it', async () => {
  const html = '<!DOCTYPE html><html><body>Attention Required! Cloudflare Ray ID: abc123</body></html>';
  const runner = fakeRunner([okResult(html, 403)]);
  const fetchImpl = createCurlTransport({ runner });

  const res = await fetchImpl('https://api.plane.so/api/v1/issues/', {
    method: 'POST',
    headers: { 'X-API-Key': 'k' },
    body: '{}',
  });

  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.status, 403);
  assert.strictEqual(await res.text(), html);
});

// Regression coverage: `--silent` suppresses curl's own error output, so
// without a timeout a hung connection (bad host that accepts but never
// responds, a dropped connection mid-handshake) blocks the sync forever with
// no output at all — indistinguishable from the process just being slow.
test('every request carries a connect and overall timeout in argv, with sensible defaults', async () => {
  const runner = fakeRunner([okResult('{}', 200)]);
  const fetchImpl = createCurlTransport({ runner });

  await fetchImpl('https://api.plane.so/api/v1/labels/', { method: 'GET', headers: {} });

  const call = runner.calls[0];
  assert.ok(call.args.includes('--connect-timeout'), 'argv must include --connect-timeout');
  assert.ok(call.args.includes('--max-time'), 'argv must include --max-time');
  assert.strictEqual(
    call.args[call.args.indexOf('--connect-timeout') + 1],
    String(DEFAULT_CONNECT_TIMEOUT_SECONDS)
  );
  assert.strictEqual(
    call.args[call.args.indexOf('--max-time') + 1],
    String(DEFAULT_MAX_TIME_SECONDS)
  );
});

test('connect and overall timeouts are overridable per transport', async () => {
  const runner = fakeRunner([okResult('{}', 200)]);
  const fetchImpl = createCurlTransport({ runner, connectTimeoutSeconds: 3, maxTimeSeconds: 12 });

  await fetchImpl('https://api.plane.so/api/v1/labels/', { method: 'GET', headers: {} });

  const call = runner.calls[0];
  assert.strictEqual(call.args[call.args.indexOf('--connect-timeout') + 1], '3');
  assert.strictEqual(call.args[call.args.indexOf('--max-time') + 1], '12');
});

test('missing status marker in stdout raises a clear parse error instead of silently miscounting', async () => {
  const runner = fakeRunner([{ spawnError: null, code: 0, stdout: 'not what curl should have produced', stderr: '' }]);
  const fetchImpl = createCurlTransport({ runner });

  await assert.rejects(
    () => fetchImpl('https://api.plane.so/api/v1/labels/', { method: 'GET', headers: {} }),
    /status marker/
  );
});
