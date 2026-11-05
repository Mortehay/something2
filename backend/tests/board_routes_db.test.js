require('./helpers/auth.js');
// SOMET-718. Board proxy routes against a FAKE pi helper (http server on a temp
// unix socket + temp token file). No real helper, scratch DB only.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const request = require('supertest');
const { Pool } = require('pg');
const { signToken } = require('../src/auth/tokens.js');

const DB_URL = process.env.TEST_DATABASE_URL;
const TOKEN = 'pi-tok';
const HINT = 'Run make pi-helper on this PC';

function fakeHelper(dir, handlers) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      calls.push({ method: req.method, url: req.url, token: req.headers['x-pi-helper-token'], raw });
      const h = handlers[`${req.method} ${req.url}`];
      const out = h ? await h() : [404, { error: 'not_found' }];
      if (out === 'destroy') { req.socket.destroy(); return; }
      res.writeHead(out[0], { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out[1]));
    });
  });
  const sock = path.join(dir, 'pi-helper.sock');
  return new Promise((resolve) => server.listen(sock, () => resolve({ server, calls })));
}

async function makeUser(pool, role) {
  const username = `board-${role}-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const r = await pool.query('INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id, token_version', [username, 'x', role]);
  return { id: r.rows[0].id, auth: `Bearer ${signToken({ userId: r.rows[0].id, username, role, tokenVersion: r.rows[0].token_version })}` };
}

const JOB = { id: 'j1', kind: 'update', status: 'running' };

function boardTest(name, body, { helper: withHelper = true, handlers = {} } = {}) {
  test(name, async (t) => {
    if (!DB_URL) {
      const msg = 'TEST_DATABASE_URL not set -- skipping (board routes)';
      if (process.env.CI) assert.fail(msg);
      t.skip(msg);
      return;
    }
    const boardRoutes = require('../src/api/boardRoutes.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-routes-'));
    const tokenFile = path.join(dir, 'pi-helper.token');
    const prev = {};
    for (const k of ['PI_HELPER_SOCKET', 'PI_HELPER_TOKEN_FILE', 'PI_HELPER_URL']) prev[k] = process.env[k];
    delete process.env.PI_HELPER_URL;
    process.env.PI_HELPER_SOCKET = path.join(dir, 'pi-helper.sock');
    process.env.PI_HELPER_TOKEN_FILE = tokenFile;
    if (withHelper) fs.writeFileSync(tokenFile, `${TOKEN}\n`);
    const helper = withHelper ? await fakeHelper(dir, handlers) : null;
    const pool = new Pool({ connectionString: DB_URL, max: 4, connectionTimeoutMillis: 3000 });
    const users = [];
    t.after(async () => {
      for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      if (helper) { helper.server.closeAllConnections(); await new Promise((r) => helper.server.close(r)); }
      fs.rmSync(dir, { recursive: true, force: true });
      await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [users]).catch(() => {});
      await pool.end().catch(() => {});
    });
    const admin = await makeUser(pool, 'admin'); users.push(admin.id);
    const player = await makeUser(pool, 'player'); users.push(player.id);
    const app = express();
    app.use(express.json());
    app.use('/api/board', boardRoutes(pool));
    await body({ app, admin, player, helper, pool });
  });
}

const ROUTES = [
  ['get', '/status'], ['get', '/metrics?range=1h'], ['get', '/history'], ['get', '/history/abc-1'], ['get', '/job'], ['get', '/seed/preview'],
  ['post', '/update'], ['post', '/seed/apply'], ['post', '/maps/apply'], ['post', '/restart'],
  ['post', '/tunnel/cloudflare/start'], ['post', '/tunnel/cloudflare/stop'],
  ['post', '/tunnel/ngrok/start'], ['post', '/tunnel/ngrok/stop'],
];
const U = '/api/board';

boardTest('every route needs admin', async ({ app, player, helper }) => {
  for (const [m, p] of ROUTES) {
    const anon = await request(app)[m](`${U}${p}`).send({});
    assert.strictEqual(anon.status, 401, `${m} ${p}`);
    const pl = await request(app)[m](`${U}${p}`).set('Authorization', player.auth).send({});
    assert.strictEqual(pl.status, 403, `${m} ${p}`);
  }
  assert.strictEqual(helper.calls.length, 0);
});

boardTest('GET routes pass through with the token', async ({ app, admin, helper }) => {
  const s = await request(app).get(`${U}/status`).set('Authorization', admin.auth);
  assert.strictEqual(s.status, 200);
  assert.deepStrictEqual(s.body, { available: true, online: true });
  const m = await request(app).get(`${U}/metrics?range=6h`).set('Authorization', admin.auth);
  assert.deepStrictEqual(m.body, { samples: [] });
  const j = await request(app).get(`${U}/job`).set('Authorization', admin.auth);
  assert.strictEqual(j.status, 200);
  assert.strictEqual(j.body, null);
  const p = await request(app).get(`${U}/seed/preview`).set('Authorization', admin.auth);
  assert.strictEqual(p.body.needsUpdate, false);
  assert.ok(helper.calls.length === 4 && helper.calls.every((c) => c.token === TOKEN));
}, { handlers: {
  'GET /status': async () => [200, { online: true }],
  'GET /metrics?range=6h': async () => [200, { samples: [] }],
  'GET /job': async () => [200, null],
  'GET /seed/preview': async () => [200, { needsUpdate: false, groups: [] }],
} });

boardTest('a bad range gives 400 and never reaches the helper', async ({ app, admin, helper }) => {
  for (const q of ['?range=2h', '', '?range=1h&x=1;rm']) {
    const r = await request(app).get(`${U}/metrics${q}`).set('Authorization', admin.auth);
    if (q === '?range=1h&x=1;rm') assert.strictEqual(r.status, 200); else assert.strictEqual(r.status, 400, q);
  }
  // only extra query values are dropped, not forwarded
  assert.deepStrictEqual(helper.calls.map((c) => c.url), ['/metrics?range=1h']);
}, { handlers: { 'GET /metrics?range=1h': async () => [200, { samples: [] }] } });

boardTest('every chart range is accepted and forwarded, a longer one is not', async ({ app, admin, helper }) => {
  for (const r of ['15m', '1h', '6h', '24h', '7d', '30d']) {
    const res = await request(app).get(`${U}/metrics?range=${r}`).set('Authorization', admin.auth);
    assert.strictEqual(res.status, 200, r);
    assert.deepStrictEqual(res.body, { bucketMs: 15000, samples: [] }, r);
  }
  const bad = await request(app).get(`${U}/metrics?range=90d`).set('Authorization', admin.auth);
  assert.strictEqual(bad.status, 400);
  assert.strictEqual(helper.calls.length, 6);
}, { handlers: Object.fromEntries(['15m', '1h', '6h', '24h', '7d', '30d'].map((r) => [`GET /metrics?range=${r}`, async () => [200, { bucketMs: 15000, samples: [] }]])) });

boardTest('action history is admin only, forwarded, and the id is validated', async ({ app, admin, player, helper }) => {
  assert.strictEqual((await request(app).get(`${U}/history`)).status, 401);
  assert.strictEqual((await request(app).get(`${U}/history/abc-1`).set('Authorization', player.auth)).status, 403);
  assert.strictEqual(helper.calls.length, 0);
  const list = await request(app).get(`${U}/history`).set('Authorization', admin.auth);
  assert.deepStrictEqual(list.body, { entries: [{ id: 'abc-1', kind: 'update' }] });
  const one = await request(app).get(`${U}/history/abc-1`).set('Authorization', admin.auth);
  assert.strictEqual(one.body.log, 'hello');
  const missing = await request(app).get(`${U}/history/zzz`).set('Authorization', admin.auth);
  assert.strictEqual(missing.status, 404);
  for (const bad of ['..%2Fsecret', 'a%20b', 'x;rm', 'a'.repeat(100)]) {
    const r = await request(app).get(`${U}/history/${bad}`).set('Authorization', admin.auth);
    assert.strictEqual(r.status, 400, bad);
  }
  assert.deepStrictEqual(helper.calls.map((c) => c.url), ['/history', '/history/abc-1', '/history/zzz']);
}, { handlers: {
  'GET /history': async () => [200, { entries: [{ id: 'abc-1', kind: 'update' }] }],
  'GET /history/abc-1': async () => [200, { id: 'abc-1', log: 'hello' }],
  'GET /history/zzz': async () => [404, { error: 'not_found', message: 'No such action in the history.' }],
} });

boardTest('POSTs return the job, send no body, and 409 busy passes through', async ({ app, admin, helper }) => {
  const r = await request(app).post(`${U}/update`).set('Authorization', admin.auth).send({ evil: 'x' });
  assert.strictEqual(r.status, 202);
  assert.deepStrictEqual(r.body, JOB);
  assert.strictEqual(helper.calls[0].raw, '');
  const t = await request(app).post(`${U}/tunnel/ngrok/start`).set('Authorization', admin.auth);
  assert.strictEqual(t.status, 202);
  const b = await request(app).post(`${U}/restart`).set('Authorization', admin.auth);
  assert.strictEqual(b.status, 409);
  assert.strictEqual(b.body.error, 'busy');
}, { handlers: {
  'POST /update': async () => [202, JOB],
  'POST /tunnel/ngrok/start': async () => [202, JOB],
  'POST /restart': async () => [409, { error: 'busy', message: 'busy' }],
} });

boardTest('POST /maps/apply needs admin, takes no arguments and returns the job', async ({ app, admin, helper }) => {
  const r = await request(app).post(`${U}/maps/apply?spec=evil`).set('Authorization', admin.auth).send({ spec: 'evil', list: ['x'] });
  assert.strictEqual(r.status, 202);
  assert.deepStrictEqual(r.body, { ...JOB, kind: 'maps' });
  // Nothing from the query or the body goes to the helper: the specs are a fixed list over there.
  assert.deepStrictEqual(helper.calls.map((c) => [c.method, c.url, c.raw]), [['POST', '/maps/apply', '']]);
}, { handlers: { 'POST /maps/apply': async () => [202, { ...JOB, kind: 'maps' }] } });

boardTest('an unknown tunnel name or action gives 400 and never reaches the helper', async ({ app, admin, helper }) => {
  for (const p of ['/tunnel/evil/start', '/tunnel/ngrok/explode', '/tunnel/..%2Fx/start']) {
    const r = await request(app).post(`${U}${p}`).set('Authorization', admin.auth);
    assert.ok([400, 404].includes(r.status), p);
  }
  assert.strictEqual((await request(app).post(`${U}/tunnel/evil/start`).set('Authorization', admin.auth)).status, 400);
  assert.strictEqual(helper.calls.length, 0);
});

boardTest('helper down: status is 200 unavailable, other routes 503', async ({ app, admin }) => {
  const s = await request(app).get(`${U}/status`).set('Authorization', admin.auth);
  assert.strictEqual(s.status, 200);
  assert.deepStrictEqual(s.body, { available: false, reason: 'helper_unavailable', hint: HINT });
  const g = await request(app).get(`${U}/job`).set('Authorization', admin.auth);
  assert.strictEqual(g.status, 503);
  assert.strictEqual(g.body.error, 'helper_unavailable');
  assert.strictEqual(g.body.hint, HINT);
  const p = await request(app).post(`${U}/update`).set('Authorization', admin.auth);
  assert.strictEqual(p.status, 503);
  assert.strictEqual(p.body.midAction, undefined);
}, { helper: false });

boardTest('a request mid-action reports midAction', async ({ app, admin }) => {
  const r = await request(app).post(`${U}/update`).set('Authorization', admin.auth);
  assert.strictEqual(r.status, 503);
  assert.strictEqual(r.body.midAction, true);
}, { handlers: { 'POST /update': async () => 'destroy' } });

boardTest('board_offline 503 passes through; other helper statuses become a bare 502', async ({ app, admin }) => {
  const o = await request(app).get(`${U}/seed/preview`).set('Authorization', admin.auth);
  assert.strictEqual(o.status, 503);
  assert.strictEqual(o.body.error, 'board_offline');
  const r = await request(app).post(`${U}/restart`).set('Authorization', admin.auth);
  assert.strictEqual(r.status, 502);
  assert.deepStrictEqual(r.body, { error: 'helper_error', message: 'The helper returned an error' });
  assert.ok(!JSON.stringify(r.body).includes('SECRET'));
}, { handlers: {
  'GET /seed/preview': async () => [503, { error: 'board_offline', message: 'down' }],
  'POST /restart': async () => [500, { error: 'boom', detail: 'SECRET stack' }],
} });

boardTest('a preview_failed 502 passes through for the seed preview only', async ({ app, admin }) => {
  const p = await request(app).get(`${U}/seed/preview`).set('Authorization', admin.auth);
  assert.strictEqual(p.status, 502);
  assert.deepStrictEqual(p.body, { error: 'preview_failed', message: 'The seed preview for items failed (exit 1): boom' });
  // The same body from any other route stays generic.
  const r = await request(app).post(`${U}/restart`).set('Authorization', admin.auth);
  assert.strictEqual(r.status, 502);
  assert.deepStrictEqual(r.body, { error: 'helper_error', message: 'The helper returned an error' });
}, { handlers: {
  'GET /seed/preview': async () => [502, { error: 'preview_failed', message: 'The seed preview for items failed (exit 1): boom' }],
  'POST /restart': async () => [502, { error: 'preview_failed', message: 'should not pass' }],
} });

test('the app mounts no /api/board without BOARD_TAB_ENABLED=1', async () => {
  const { mountBoardRoutes } = require('../src/api/boardRoutes.js');
  const pool = { query: async () => ({ rows: [] }) };
  for (const [env, expected] of [[{}, 404], [{ BOARD_TAB_ENABLED: '0' }, 404], [{ BOARD_TAB_ENABLED: '1' }, 401]]) {
    const app = express();
    mountBoardRoutes(app, pool, env);
    const r = await request(app).get('/api/board/status');
    assert.strictEqual(r.status, expected, JSON.stringify(env));
  }
});

test('index.js mounts the board routes through mountBoardRoutes', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');
  assert.match(src, /mountBoardRoutes\(app, guardPool, process\.env\)/);
});

boardTest('status while the helper drains (503 shutting_down) reads as unavailable', async ({ app, admin }) => {
  const s = await request(app).get(`${U}/status`).set('Authorization', admin.auth);
  assert.strictEqual(s.status, 200);
  assert.deepStrictEqual(s.body, { available: false, reason: 'helper_unavailable', hint: HINT });
}, { handlers: { 'GET /status': async () => [503, { error: 'shutting_down' }] } });
