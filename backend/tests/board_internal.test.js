require('./helpers/auth.js');
// SOMET-720. The board's internal listener: off unless asked for, loopback only, a port
// nothing publishes, and no such routes on the public app.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');
const { startBoardInternal, boardInternalHandler } = require('../src/api/boardInternal.js');

const ORANGEPI = path.join(__dirname, '..', '..', 'compose', 'orangepi');
const COMPOSE = fs.readFileSync(path.join(ORANGEPI, 'docker-compose.yml'), 'utf8');
const CADDY = fs.readFileSync(path.join(ORANGEPI, 'caddy', 'Caddyfile'), 'utf8');
const PORT = /BOARD_INTERNAL_PORT=(\d+)/.exec(COMPOSE)?.[1];

const fakeLive = {
  counters: () => ({ online: 2, mobKills: 3, pvpKills: 4 }),
  players: async () => ({ players: [{ name: 'a' }] }),
  bosses: async () => ({ bosses: [{ name: 'b' }] }),
  summon: async (body) => ({ status: 200, body: { ok: true, echo: body } }),
};

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
const listening = (s) => new Promise((r) => { if (s.listening) r(); else s.once('listening', r); });
const closed = (s) => new Promise((r) => { s.close(r); });

function connects(host, port) {
  return new Promise((resolve) => {
    const c = net.connect({ host, port });
    const done = (v) => { c.destroy(); resolve(v); };
    c.setTimeout(1000, () => done(false));
    c.once('connect', () => done(true));
    c.once('error', () => done(false));
  });
}

test('it starts only when enabled, and only on a real port', async () => {
  const port = await freePort();
  assert.equal(startBoardInternal(fakeLive, {}), null);
  assert.equal(startBoardInternal(fakeLive, { BOARD_INTERNAL_PORT: String(port) }), null);
  assert.equal(startBoardInternal(fakeLive, { BOARD_INTERNAL_ENABLED: '0', BOARD_INTERNAL_PORT: String(port) }), null);
  const orig = console.error;
  console.error = () => {};
  try {
    for (const bad of [undefined, '', 'abc', '0', '70000', '3102; rm']) {
      assert.equal(startBoardInternal(fakeLive, { BOARD_INTERNAL_ENABLED: '1', BOARD_INTERNAL_PORT: bad }), null, String(bad));
    }
  } finally { console.error = orig; }
});

test('bound to loopback: reachable there and refused on every other address of this machine', async () => {
  const port = await freePort();
  const s = startBoardInternal(fakeLive, { BOARD_INTERNAL_ENABLED: '1', BOARD_INTERNAL_PORT: String(port) });
  assert.ok(s);
  await listening(s);
  try {
    assert.equal(s.address().address, '127.0.0.1');
    assert.equal(await connects('127.0.0.1', port), true);
    const others = Object.values(os.networkInterfaces()).flat().filter((i) => !i.internal && i.family === 'IPv4');
    for (const i of others) assert.equal(await connects(i.address, port), false, i.address);
  } finally { await closed(s); }
});

test('a port it cannot bind is logged, never thrown', async () => {
  const blocker = net.createServer();
  await new Promise((r) => { blocker.listen(0, '127.0.0.1', r); });
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    const s = startBoardInternal(fakeLive, { BOARD_INTERNAL_ENABLED: '1', BOARD_INTERNAL_PORT: String(blocker.address().port) });
    await new Promise((r) => { s.once('error', r); });
    assert.ok(errors.some((e) => /listener failed/.test(e)));
  } finally { console.error = orig; await closed(blocker); }
});

test('the routes: exact method and path, a small JSON body', async () => {
  const app = boardInternalHandler(fakeLive);
  assert.deepEqual((await request(app).get('/counters')).body, { online: 2, mobKills: 3, pvpKills: 4 });
  assert.deepEqual((await request(app).get('/players')).body, { players: [{ name: 'a' }] });
  assert.deepEqual((await request(app).get('/bosses')).body, { bosses: [{ name: 'b' }] });
  const okSummon = await request(app).post('/bosses/summon').send({ owner: 'world' });
  assert.equal(okSummon.status, 200);
  assert.deepEqual(okSummon.body.echo, { owner: 'world' });
  for (const [m, p] of [['post', '/players'], ['get', '/bosses/summon'], ['get', '/'], ['delete', '/bosses'], ['get', '/players/x'], ['get', '/players?x=1']]) {
    assert.equal((await request(app)[m](p)).status, 404, `${m} ${p}`);
  }
  const notJson = await request(app).post('/bosses/summon').set('Content-Type', 'application/json').send('{nope');
  assert.equal(notJson.status, 400);
  const big = await request(app).post('/bosses/summon').send({ name: 'x'.repeat(2000) });
  assert.equal(big.status, 400);
});

test('a failure inside answers 500 without its message', async () => {
  const orig = console.error;
  console.error = () => {};
  try {
    const res = await request(boardInternalHandler({ ...fakeLive, players: async () => { throw new Error('secret detail'); } })).get('/players');
    assert.equal(res.status, 500);
    assert.doesNotMatch(JSON.stringify(res.body), /secret detail/);
  } finally { console.error = orig; }
});

test('the board compose enables it on a port it publishes nowhere', () => {
  assert.match(COMPOSE, /- BOARD_INTERNAL_ENABLED=1/);
  assert.ok(PORT, 'a fixed port');
  assert.notEqual(PORT, '3101', 'not the public listener');
  // Every published or exposed port line in the file.
  const published = COMPOSE.split('\n').filter((l) => /^\s*-\s*["']?[\d.:$]*\d+:\d+/.test(l));
  for (const l of published) assert.ok(!l.includes(PORT), l);
  assert.doesNotMatch(COMPOSE, new RegExp(`expose:[\\s\\S]{0,40}${PORT}`));
});

test('Caddy has no route to it', () => {
  assert.ok(!CADDY.includes(PORT), 'the port is not in the Caddyfile');
  const upstreams = [...CADDY.matchAll(/reverse_proxy\s+(\S+)/g)].map((m) => m[1]);
  assert.ok(upstreams.length > 0, 'the Caddyfile was read');
  for (const u of upstreams) assert.ok(!u.endsWith(`:${PORT}`), u);
});

test('the dev compose does not enable it', () => {
  const dev = fs.readFileSync(path.join(__dirname, '..', '..', 'compose', 'develop', 'docker-compose.yml'), 'utf8');
  assert.doesNotMatch(dev, /BOARD_INTERNAL/);
});

test('the public app has no such routes', async () => {
  const { app } = require('../src/index.js');
  const paths = ['/players', '/bosses', '/counters', '/bosses/summon', '/internal/players', '/board/players',
    '/api/players', '/api/bosses', '/api/counters', '/api/bosses/summon'];
  for (const p of paths) {
    assert.equal((await request(app).get(p)).status, 404, `GET ${p}`);
    assert.equal((await request(app).post(p).send({ owner: 'world', name: 'x', world: 'y' })).status, 404, `POST ${p}`);
  }
});
