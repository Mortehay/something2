// Tunnels admin routes against the private test DB with a fake helper client and fake traffic.
// Never talks to a real helper, docker, ngrok or cloudflared.
require('./helpers/auth.js');
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');
const { Pool } = require('pg');
const { signToken } = require('../src/auth/tokens.js');
const tunnelRoutes = require('../src/api/tunnelRoutes.js');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const SECRET = 'ngrok-secret-token-should-never-leak';
const off = (provider) => ({ provider, state: 'off', mode: null, url: null, startedAt: null, error: null });

class HelperUnavailable extends Error {}

function fakeClient() {
  const c = {
    down: false,
    calls: [],
    status: { cloudflare: off('cloudflare'), ngrok: off('ngrok') },
    reply: null,
    HelperUnavailable,
    HINT: 'Run make tunnel-helper on this PC',
    async call(method, route, payload) {
      c.calls.push({ method, route, payload });
      if (c.down) throw new HelperUnavailable('tunnel helper unreachable');
      if (c.reply) return c.reply;
      if (route === '/status') return { status: 200, body: c.status };
      return { status: 200, body: { ...off(payload.provider), state: 'on', mode: payload.mode || null, url: 'https://quiet-fox-1.trycloudflare.com' } };
    },
  };
  return c;
}

let pool;
let admin;
let player;
const users = [];
const sessionIds = [];

async function makeUser(role) {
  const username = `tun-routes-${role}-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const r = await pool.query('INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id, token_version', [username, 'x', role]);
  users.push(r.rows[0].id);
  return { id: r.rows[0].id, username, auth: `Bearer ${signToken({ userId: r.rows[0].id, username, role, tokenVersion: r.rows[0].token_version })}` };
}

function appWith(client, traffic = { countFor: () => 0 }) {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/tunnels', tunnelRoutes(pool, { client, traffic }));
  return app;
}

test.before(async () => {
  if (!DB_URL) return;
  pool = new Pool({ connectionString: DB_URL, max: 3 });
  admin = await makeUser('admin');
  player = await makeUser('player');
  process.env.TUNNEL_TAB_ENABLED = 'true';
  process.env.NGROK_AUTHTOKEN = SECRET;
});
test.after(async () => {
  if (!pool) return;
  await pool.query('DELETE FROM tunnel_sessions WHERE id = ANY($1::int[])', [sessionIds]);
  await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [users]);
  delete process.env.TUNNEL_TAB_ENABLED;
  delete process.env.NGROK_AUTHTOKEN;
  await pool.end();
});

const needDb = (name, fn) => test(name, async (t) => { if (!DB_URL) return t.skip('no DB'); return fn(t); });

needDb('non-admin gets 403, no token 401', async () => {
  const app = appWith(fakeClient());
  await request(app).get('/api/admin/tunnels').set('Authorization', player.auth).expect(403);
  await request(app).get('/api/admin/tunnels').expect(401);
});

needDb('404 when TUNNEL_TAB_ENABLED is not true (per request)', async () => {
  const app = appWith(fakeClient());
  process.env.TUNNEL_TAB_ENABLED = 'false';
  try {
    await request(app).get('/api/admin/tunnels').set('Authorization', admin.auth).expect(404);
    await request(app).post('/api/admin/tunnels/ngrok/start').set('Authorization', admin.auth).expect(404);
  } finally { process.env.TUNNEL_TAB_ENABLED = 'true'; }
  await request(app).get('/api/admin/tunnels').set('Authorization', admin.auth).expect(200);
});

needDb('status merges players from traffic by host and reports registrationMode', async () => {
  const c = fakeClient();
  c.status.cloudflare = { provider: 'cloudflare', state: 'on', mode: 'built', url: 'https://quiet-fox-1.trycloudflare.com', startedAt: 'x', error: null };
  const seen = [];
  const app = appWith(c, { countFor: (h) => { seen.push(h); return h === 'quiet-fox-1.trycloudflare.com' ? 3 : 99; } });
  const r = await request(app).get('/api/admin/tunnels').set('Authorization', admin.auth).expect(200);
  assert.strictEqual(r.body.available, true);
  assert.strictEqual(r.body.tunnels.cloudflare.players, 3);
  assert.strictEqual(r.body.tunnels.ngrok.players, 0);
  assert.deepStrictEqual(seen, ['quiet-fox-1.trycloudflare.com']);
  assert.ok(['open', 'invite', 'closed'].includes(r.body.registrationMode));
});

needDb('helper down: status 200 available:false, start 503 with hint', async () => {
  const c = fakeClient(); c.down = true;
  const app = appWith(c);
  const s = await request(app).get('/api/admin/tunnels').set('Authorization', admin.auth).expect(200);
  assert.deepStrictEqual(s.body, { available: false, hint: 'Run make tunnel-helper on this PC' });
  const p = await request(app).post('/api/admin/tunnels/ngrok/start').set('Authorization', admin.auth).send({}).expect(503);
  assert.deepStrictEqual(p.body, { error: 'helper_unavailable', hint: 'Run make tunnel-helper on this PC' });
});

needDb('bad provider and bad mode are 400 and never reach the helper', async () => {
  const c = fakeClient();
  const app = appWith(c);
  await request(app).post('/api/admin/tunnels/bogus/start').set('Authorization', admin.auth).send({}).expect(400);
  await request(app).post('/api/admin/tunnels/bogus/stop').set('Authorization', admin.auth).expect(400);
  await request(app).post('/api/admin/tunnels/ngrok/start').set('Authorization', admin.auth).send({ mode: 'weird' }).expect(400);
  assert.strictEqual(c.calls.length, 0);
});

needDb('start defaults mode to built; live passes through; stop sends provider only', async () => {
  const c = fakeClient();
  const app = appWith(c);
  await request(app).post('/api/admin/tunnels/cloudflare/start').set('Authorization', admin.auth).send({}).expect(200);
  await request(app).post('/api/admin/tunnels/ngrok/start').set('Authorization', admin.auth).send({ mode: 'live' }).expect(200);
  await request(app).post('/api/admin/tunnels/ngrok/stop').set('Authorization', admin.auth).expect(200);
  assert.deepStrictEqual(c.calls.map((x) => [x.route, x.payload]), [
    ['/start', { provider: 'cloudflare', mode: 'built' }],
    ['/start', { provider: 'ngrok', mode: 'live' }],
    ['/stop', { provider: 'ngrok' }],
  ]);
});

needDb('helper 409 busy_op and 503 docker_unavailable pass through; helper 400 is 400', async () => {
  const c = fakeClient();
  const app = appWith(c);
  for (const [status, error] of [[409, 'busy_op'], [503, 'docker_unavailable'], [400, 'bad_request']]) {
    c.reply = { status, body: { error, message: `m-${error}`, extra: SECRET } };
    const r = await request(app).post('/api/admin/tunnels/ngrok/start').set('Authorization', admin.auth).send({}).expect(status);
    assert.deepStrictEqual(r.body, { error, message: `m-${error}` });
  }
});

needDb('history: shape, newest first, usernames, events, days window', async () => {
  const mk = async (provider, startedAt, endedAt, reason, peak) => {
    const r = await pool.query(
      `INSERT INTO tunnel_sessions (provider, mode, url, started_at, ended_at, end_reason, peak_players)
       VALUES ($1,'built','https://h.example',$2,$3,$4,$5) RETURNING id`, [provider, startedAt, endedAt, reason, peak]);
    sessionIds.push(r.rows[0].id);
    return r.rows[0].id;
  };
  const now = Date.now();
  const old = await mk('ngrok', new Date(now - 10 * 86400e3).toISOString(), new Date(now - 10 * 86400e3 + 60e3).toISOString(), 'switched_off', 0);
  const recent = await mk('cloudflare', new Date(now - 3600e3).toISOString(), new Date(now - 1800e3).toISOString(), 'went_down', 1);
  await pool.query('INSERT INTO tunnel_session_players (session_id, user_id, first_seen) VALUES ($1,$2,now())', [recent, player.id]);
  await pool.query(`INSERT INTO tunnel_session_events (session_id, provider, at, kind, detail) VALUES ($1,'cloudflare',now(),'http_5xx','GET /x 500')`, [recent]);
  const app = appWith(fakeClient());
  const r = await request(app).get('/api/admin/tunnels/history?days=30').set('Authorization', admin.auth).expect(200);
  const mine = r.body.sessions.filter((s) => sessionIds.includes(s.id));
  assert.deepStrictEqual(mine.map((s) => s.id), [recent, old]);
  const s = mine[0];
  assert.deepStrictEqual(Object.keys(s).sort(), ['durationSec', 'endReason', 'endedAt', 'error', 'events', 'id', 'mode', 'peakPlayers', 'players', 'provider', 'startedAt', 'url']);
  assert.strictEqual(s.durationSec, 1800);
  assert.deepStrictEqual(s.players, [player.username]);
  assert.strictEqual(s.events.length, 1);
  assert.deepStrictEqual(Object.keys(s.events[0]).sort(), ['at', 'detail', 'kind']);
  assert.strictEqual(s.endReason, 'went_down');
  const short = await request(app).get('/api/admin/tunnels/history?days=1').set('Authorization', admin.auth).expect(200);
  assert.deepStrictEqual(short.body.sessions.filter((x) => sessionIds.includes(x.id)).map((x) => x.id), [recent]);
});

needDb('no env secret appears in any response', async () => {
  const c = fakeClient();
  const app = appWith(c);
  const bodies = [];
  bodies.push((await request(app).get('/api/admin/tunnels').set('Authorization', admin.auth)).text);
  bodies.push((await request(app).get('/api/admin/tunnels/history').set('Authorization', admin.auth)).text);
  bodies.push((await request(app).post('/api/admin/tunnels/ngrok/start').set('Authorization', admin.auth).send({})).text);
  c.down = true;
  bodies.push((await request(app).get('/api/admin/tunnels').set('Authorization', admin.auth)).text);
  c.reply = { status: 500, body: { error: 'x', token: SECRET } };
  c.down = false;
  bodies.push((await request(app).post('/api/admin/tunnels/ngrok/stop').set('Authorization', admin.auth)).text);
  for (const b of bodies) assert.ok(!b.includes(SECRET), b);
});

needDb('status: helper 500 is 502 helper_error, 503 passes through', async () => {
  const c = fakeClient();
  const app = appWith(c);
  c.reply = { status: 500, body: { error: 'boom', token: SECRET } };
  const r = await request(app).get('/api/admin/tunnels').set('Authorization', admin.auth).expect(502);
  assert.deepStrictEqual(r.body, { error: 'helper_error' });
  c.reply = { status: 503, body: { error: 'docker_unavailable', message: 'no docker' } };
  const d = await request(app).get('/api/admin/tunnels').set('Authorization', admin.auth).expect(503);
  assert.deepStrictEqual(d.body, { error: 'docker_unavailable', message: 'no docker' });
});

needDb('start drops unknown helper fields', async () => {
  const c = fakeClient();
  c.reply = { status: 200, body: { ...off('ngrok'), state: 'on', url: 'https://a.ngrok.app', secret: SECRET } };
  const app = appWith(c);
  const r = await request(app).post('/api/admin/tunnels/ngrok/start').set('Authorization', admin.auth).send({}).expect(200);
  assert.deepStrictEqual(Object.keys(r.body).sort(), ['error', 'mode', 'players', 'provider', 'startedAt', 'state', 'url']);
  assert.ok(!r.text.includes(SECRET));
});

needDb('history days clamps to the 30-day window', async () => {
  const mk = async (ageDays) => {
    const r = await pool.query(
      `INSERT INTO tunnel_sessions (provider, mode, started_at, ended_at, end_reason)
       VALUES ('ngrok','built', now() - ($1::int * interval '1 day'), now() - ($1::int * interval '1 day') + interval '1 minute', 'switched_off') RETURNING id`, [ageDays]);
    sessionIds.push(r.rows[0].id);
    return r.rows[0].id;
  };
  const in20 = await mk(20);
  const old40 = await mk(40);
  const app = appWith(fakeClient());
  for (const q of ['999', 'abc']) {
    const r = await request(app).get(`/api/admin/tunnels/history?days=${q}`).set('Authorization', admin.auth).expect(200);
    const ids = r.body.sessions.map((s) => s.id);
    assert.ok(ids.includes(in20), q);
    assert.ok(!ids.includes(old40), q);
  }
});
