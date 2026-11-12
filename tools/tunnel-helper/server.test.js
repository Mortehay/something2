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
    start: async (provider, mode, { onStarting } = {}) => {
      if (provider !== 'ngrok' && provider !== 'cloudflare') throw new BadRequest('Unknown tunnel provider.');
      if (mode === 'slow') await gate;
      // Like the real start: `starting` first, then the long part.
      if (mode === 'bg') { onStarting({ provider, state: 'starting', mode }); await gate; return { provider, state: 'on', mode }; }
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

test('readEnv: export prefix, inline comments, quoted values keep #', () => {
  const { readEnv } = require('./server');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'th-'));
  fs.writeFileSync(path.join(dir, '.env'), [
    'export NGROK_DOMAIN=a.ngrok.app # reserved',
    'NGROK_AUTHTOKEN="ab#cd" # note',
    "OTHER='x y'",
    'PLAIN=v#notcomment',
  ].join('\n'));
  assert.deepEqual(readEnv(dir), { NGROK_DOMAIN: 'a.ngrok.app', NGROK_AUTHTOKEN: 'ab#cd', OTHER: 'x y', PLAIN: 'v#notcomment' });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('events: bad since is 400; a cursor ahead of next resends from 0', async (t) => {
  const fake = fakeTunnels();
  const seenSince = [];
  fake.events = (since) => { seenSince.push(since); return since === 0 ? { events: [{ id: 5 }], next: 5 } : { events: [], next: 5 }; };
  const b = await boot(fake); t.after(b.close);
  assert.equal((await b.call('GET', '/events?since=abc')).status, 400);
  assert.equal((await b.call('GET', '/events?since=-1')).status, 400);
  const r = await b.call('GET', '/events?since=999');
  assert.deepEqual(r.body, { events: [{ id: 5 }], next: 5 });
  assert.deepEqual(seenSince, [999, 0]);
});

test('docker failure during start or stop is 503 docker_unavailable', async (t) => {
  const fake = fakeTunnels();
  fake.start = async () => { throw new Error('Cannot connect to the Docker daemon'); };
  fake.stop = async () => { throw new Error('spawn docker ENOENT'); };
  const b = await boot(fake); t.after(b.close);
  const s = await b.call('POST', '/start', { provider: 'ngrok', mode: 'built' });
  assert.equal(s.status, 503);
  assert.equal(s.body.error, 'docker_unavailable');
  assert.equal((await b.call('POST', '/stop', { provider: 'ngrok' })).status, 503);
  // and the busy flag was released
  fake.stop = async (p) => ({ provider: p, state: 'off' });
  assert.equal((await b.call('POST', '/stop', { provider: 'ngrok' })).status, 200);
});

test('composeRunner runs docker compose from root with the Makefile form', async (t) => {
  const { composeRunner } = require('./server');
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'thb-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thr-'));
  const out = path.join(bin, 'out.txt');
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\n{ pwd; for a in "$@"; do echo "$a"; done; } > "${out}"\necho hello\n`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; fs.rmSync(bin, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true }); });
  const r = await composeRunner(root)(['--profile', 'tunnel', 'ps']);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), 'hello');
  const [cwd, ...argv] = fs.readFileSync(out, 'utf8').trim().split('\n');
  assert.equal(fs.realpathSync(cwd), fs.realpathSync(root));
  assert.deepEqual(argv, ['compose', '--project-directory', root, '--env-file', '.env', '-f', 'compose/develop/docker-compose.yml', '--profile', 'tunnel', 'ps']);
});

test('start answers with the starting card at once; the lock holds until the start finishes', async (t) => {
  const fake = fakeTunnels();
  const b = await boot(fake); t.after(b.close);
  const first = await b.call('POST', '/start', { provider: 'cloudflare', mode: 'bg' });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { provider: 'cloudflare', state: 'starting', mode: 'bg' });
  const second = await b.call('POST', '/start', { provider: 'ngrok', mode: 'built' });
  assert.equal(second.status, 409);
  assert.equal(second.body.error, 'busy_op');
  assert.equal((await b.call('POST', '/stop', { provider: 'cloudflare' })).status, 409);
  fake.release();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await b.call('POST', '/stop', { provider: 'cloudflare' })).status, 200);
});

test('a background start that throws after starting releases the lock without crashing the helper', async (t) => {
  const fake = fakeTunnels();
  let fail;
  fake.start = (provider, mode, { onStarting }) => new Promise((_, reject) => { onStarting({ provider, state: 'starting', mode }); fail = reject; });
  const b = await boot(fake); t.after(b.close);
  assert.equal((await b.call('POST', '/start', { provider: 'ngrok', mode: 'built' })).body.state, 'starting');
  fail(new Error('boom'));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await b.call('POST', '/stop', { provider: 'ngrok' })).status, 200);
});

test('drain waits for a background start that already answered', async () => {
  const fake = fakeTunnels();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'th-'));
  const srv = createServer({ root: dir, runDir: dir, drainMs: 3000, env: {}, createTunnels: () => fake });
  const h = await srv.start();
  const token = fs.readFileSync(path.join(dir, 'tunnel-helper.token'), 'utf8').trim();
  const status = await new Promise((resolve) => {
    const req = http.request({ socketPath: path.join(dir, 'tunnel-helper.sock'), method: 'POST', path: '/start',
      headers: { 'X-Tunnel-Helper-Token': token } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.end(JSON.stringify({ provider: 'ngrok', mode: 'bg' }));
  });
  assert.equal(status, 200);
  let released = false;
  setTimeout(() => { released = true; fake.release(); }, 200);
  assert.equal(await h.drain(), true);
  assert.equal(released, true, 'drain returned only after the start finished');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('composeRunner: 120 s default limit, a caller-given limit for the web build', async () => {
  const { composeRunner, COMPOSE_TIMEOUT_MS } = require('./server');
  const seen = [];
  const exec = (_bin, _args, opts, cb) => { seen.push(opts.timeout); cb(null, '', ''); };
  const run = composeRunner('/nowhere', exec);
  await run(['ps']);
  await run(['up', '-d', '--build', 'web'], { timeoutMs: 600000 });
  assert.equal(COMPOSE_TIMEOUT_MS, 120000);
  assert.deepEqual(seen, [120000, 600000]);
});

test('events: a restarted helper whose clock stepped back resends from 0 (real createTunnels)', async (t) => {
  const { createTunnels: real } = require('./tunnels');
  const STALE_CURSOR = Date.parse('2026-11-12T12:00:00Z');
  const behind = STALE_CURSOR - 60000;
  // No containers, every call succeeds: enough for one start to emit `started`.
  const compose = async () => ({ code: 0, stdout: '', stderr: '' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'th-'));
  let tunnels;
  const srv = createServer({
    root: dir, runDir: dir, drainMs: 500, env: {},
    createTunnels: (opts) => {
      tunnels = real({ ...opts, compose, now: () => behind, viteUp: async () => true,
        logs: async () => 'INF |  https://r-s.trycloudflare.com  |\n', sleep: async () => {} });
      return tunnels;
    },
  });
  const h = await srv.start();
  t.after(async () => { await h.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const token = fs.readFileSync(path.join(dir, 'tunnel-helper.token'), 'utf8').trim();
  const get = (url) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath: path.join(dir, 'tunnel-helper.sock'), method: 'GET', path: url,
      headers: { 'X-Tunnel-Helper-Token': token } }, (res) => {
      let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => resolve(JSON.parse(s)));
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal((await tunnels.start('cloudflare', 'live')).state, 'on');
  const r = await get(`/events?since=${STALE_CURSOR}`);
  assert.deepEqual(r.events.map((e) => e.kind), ['started'], 'resent from 0');
  assert.ok(r.next < STALE_CURSOR);
  // A reader that is caught up gets nothing new and keeps its cursor.
  const again = await get(`/events?since=${r.next}`);
  assert.deepEqual(again, { events: [], next: r.next });
});
