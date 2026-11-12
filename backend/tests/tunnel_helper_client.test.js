// The tunnel helper client against a local unix socket that never answers or refuses: no
// real helper, docker or tunnel. Pins the difference between "timed out mid-action" and
// "not there".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createHelperClient } = require('../src/services/helperClient.js');

function clientFor(dir, timeoutMs) {
  process.env.THC_TEST_SOCKET = path.join(dir, 'h.sock');
  process.env.THC_TEST_TOKEN = path.join(dir, 'h.token');
  fs.writeFileSync(process.env.THC_TEST_TOKEN, 'tok\n');
  return createHelperClient({
    socketEnv: 'THC_TEST_SOCKET', urlEnv: 'THC_TEST_URL_UNSET', tokenEnv: 'THC_TEST_TOKEN',
    defaultSocket: '/nonexistent', defaultTokenFile: '/nonexistent', tokenHeader: 'X-Test-Token', label: 'test helper', timeoutMs,
  });
}

test('a helper that does not answer in time: HelperUnavailable with timedOut and midAction', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thc-'));
  const srv = http.createServer(() => { /* never answers */ });
  await new Promise((r) => srv.listen(path.join(dir, 'h.sock'), r));
  t.after(() => { srv.closeAllConnections(); srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const { call, HelperUnavailable } = clientFor(dir, 100);
  const err = await call('POST', '/start', { provider: 'cloudflare' }).then(() => null, (e) => e);
  assert.ok(err instanceof HelperUnavailable);
  assert.equal(err.timedOut, true);
  assert.equal(err.midAction, true);
});

test('no helper listening: HelperUnavailable, not timedOut', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { call, HelperUnavailable } = clientFor(dir, 100);
  const err = await call('POST', '/start', {}).then(() => null, (e) => e);
  assert.ok(err instanceof HelperUnavailable);
  assert.equal(err.timedOut, false);
  assert.equal(err.midAction, false);
});
