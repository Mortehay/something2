'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createServer } = require('./server');

function get(sock, url, token) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: sock, path: url, headers: token ? { 'X-Pi-Helper-Token': token } : {} }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b) }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function boot(t, opts = {}) {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-srv-'));
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const h = createServer({ root: runDir, runDir, routes: { 'GET /status': () => ({ ok: 1 }) }, ...opts });
  const live = await h.start();
  t.after(() => live.close());
  return { runDir, live, sock: path.join(runDir, 'pi-helper.sock'), token: fs.readFileSync(path.join(runDir, 'pi-helper.token'), 'utf8').trim() };
}

test('server answers 401 with no token, 404 for unknown routes, 200 for a route', async (t) => {
  const { sock, token, runDir } = await boot(t);
  assert.equal((await get(sock, '/status')).status, 401);
  assert.equal((await get(sock, '/status', 'wrong')).status, 401);
  assert.equal((await get(sock, '/nope', token)).status, 404);
  assert.deepEqual((await get(sock, '/status', token)).body, { ok: 1 });
  assert.equal(fs.statSync(path.join(runDir, 'pi-helper.token')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(sock).mode & 0o777, 0o600);
});

test('server refuses to start if a helper is already live on the socket', async (t) => {
  const { runDir } = await boot(t);
  const second = createServer({ root: runDir, runDir, routes: {} });
  await assert.rejects(() => second.start(), /already listening/);
});

test('server refuses a socket path over the unix limit', async (t) => {
  const runDir = path.join(os.tmpdir(), 'x'.repeat(110));
  await assert.rejects(() => createServer({ root: runDir, runDir }).start(), /unix socket limit/);
});

test('drain waits for busy work, then aborts at the cap and returns false', async (t) => {
  let aborted = false;
  const { live } = await boot(t, { drainMs: 150, busy: () => !aborted, abort: () => { aborted = true; } });
  assert.equal(await live.drain(), false);
  assert.equal(aborted, true);
});
