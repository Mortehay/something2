'use strict';
// The helper runs against an injected fake createTunnels: no docker, no tunnel.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createServer } = require('./server');
const { BadRequest } = require('../helper-core/helperServer');

async function boot(fake) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'th-'));
  let seen;
  const srv = createServer({
    root: dir, runDir: dir, drainMs: 500, env: { NGROK_AUTHTOKEN: 'tok-secret-123456', NGROK_DOMAIN: 'x.ngrok.app' },
    createTunnels: (opts) => { seen = opts; return fake; },
  });
  const h = await srv.start();
  const token = fs.readFileSync(path.join(dir, 'tunnel-helper.token'), 'utf8').trim();
  const call = (method, url, body, tok = token) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ socketPath: path.join(dir, 'tunnel-helper.sock'), method, path: url,
      headers: { ...(tok ? { 'X-Tunnel-Helper-Token': tok } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}) } }, (res) => {
      let s = ''; res.on('data', (c) => { s += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(s) }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
  return { call, seen: () => seen, close: async () => { await h.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

function fakeTunnels() {
  let release;
  const gate = new Promise((r) => { release = r; });
  return {
    release,
    status: async () => ({ cloudflare: { state: 'off' }, ngrok: { state: 'off' } }),
    start: async (provider, mode) => {
      if (provider !== 'ngrok' && provider !== 'cloudflare') throw new BadRequest('Unknown tunnel provider.');
      if (mode === 'slow') await gate;
      return { provider, state: 'on', mode };
    },
    stop: async (provider) => ({ provider, state: 'off' }),
    events: (since) => ({ events: [], next: Number(since) }),
  };
}

test('no token is 401', async (t) => {
  const b = await boot(fakeTunnels()); t.after(b.close);
  assert.equal((await b.call('GET', '/status', undefined, null)).status, 401);
  assert.equal((await b.call('GET', '/status', undefined, 'wrong')).status, 401);
});

test('start returns the card state; bad provider is 400', async (t) => {
  const b = await boot(fakeTunnels()); t.after(b.close);
  const ok = await b.call('POST', '/start', { provider: 'ngrok', mode: 'built' });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { provider: 'ngrok', state: 'on', mode: 'built' });
  const bad = await b.call('POST', '/start', { provider: 'x' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'bad_request');
});

test('a second concurrent start or stop is 409 busy_op', async (t) => {
  const fake = fakeTunnels();
  const b = await boot(fake); t.after(b.close);
  const first = b.call('POST', '/start', { provider: 'ngrok', mode: 'slow' });
  await new Promise((r) => setTimeout(r, 50));
  const second = await b.call('POST', '/start', { provider: 'cloudflare', mode: 'built' });
  assert.equal(second.status, 409);
  assert.equal(second.body.error, 'busy_op');
  assert.equal((await b.call('POST', '/stop', { provider: 'ngrok' })).status, 409);
  fake.release();
  assert.equal((await first).status, 200);
  assert.equal((await b.call('POST', '/stop', { provider: 'ngrok' })).status, 200);
});

test('events returns {events, next}', async (t) => {
  const b = await boot(fakeTunnels()); t.after(b.close);
  const r = await b.call('GET', '/events?since=0');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { events: [], next: 0 });
});

test('status failure is 503 docker_unavailable, not 500', async (t) => {
  const fake = fakeTunnels();
  fake.status = async () => { throw new Error('Cannot connect to the Docker daemon'); };
  const b = await boot(fake); t.after(b.close);
  const r = await b.call('GET', '/status');
  assert.equal(r.status, 503);
  assert.equal(r.body.error, 'docker_unavailable');
  assert.match(r.body.message, /Docker daemon/);
});

test('secrets and domain from env reach createTunnels, never a response', async (t) => {
  const b = await boot(fakeTunnels()); t.after(b.close);
  assert.deepEqual(b.seen().secrets, ['tok-secret-123456']);
  assert.equal(b.seen().ngrokDomain, 'x.ngrok.app');
  assert.equal(typeof b.seen().compose, 'function');
  assert.ok(!JSON.stringify(await b.call('GET', '/status')).includes('tok-secret'));
});

test('drain waits for an in-flight start', async (t) => {
  const fake = fakeTunnels();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'th-'));
  const srv = createServer({ root: dir, runDir: dir, drainMs: 3000, env: {}, createTunnels: () => fake });
  const h = await srv.start();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const token = fs.readFileSync(path.join(dir, 'tunnel-helper.token'), 'utf8').trim();
  const p = new Promise((resolve) => {
    const req = http.request({ socketPath: path.join(dir, 'tunnel-helper.sock'), method: 'POST', path: '/start',
      headers: { 'X-Tunnel-Helper-Token': token } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.end(JSON.stringify({ provider: 'ngrok', mode: 'slow' }));
  });
  await new Promise((r) => setTimeout(r, 50));
  const drained = h.drain();
  setTimeout(fake.release, 200);
  assert.equal(await drained, true);
  assert.equal(await p, 200);
});
