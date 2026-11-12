// Tunnel recorder against a real (private, migrated) database with a fake helper and real
// in-memory traffic. Never talks to a real helper, docker, ngrok or cloudflared.
const test = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { syncOnce } = require('../src/services/tunnelRecorder.js');
const { createTunnelTraffic } = require('../src/services/tunnelTraffic.js');

const DB_URL = process.env.TEST_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgres://user:password@localhost:15432/game_db';

const CF_URL = 'https://quiet-fox-1.trycloudflare.com';
const CF_HOST = 'quiet-fox-1.trycloudflare.com';
const NG_URL = 'https://my-game.ngrok.app';
const T0 = Date.parse('2026-11-12T10:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const off = (provider) => ({ provider, state: 'off', mode: null, url: null, startedAt: null, error: null });

function fakeHelper() {
  let id = 1762900000000;
  const h = {
    down: false,
    st: { cloudflare: off('cloudflare'), ngrok: off('ngrok') },
    ring: [],
    emit(provider, kind, at, detail = null) { id += 1; h.ring.push({ id, at: iso(at), provider, kind, detail }); },
    async status() { if (h.down) throw Object.assign(new Error('tunnel helper unreachable'), { code: 'helper_unavailable' }); return JSON.parse(JSON.stringify(h.st)); },
    async events(since) {
      if (h.down) throw Object.assign(new Error('tunnel helper unreachable'), { code: 'helper_unavailable' });
      const out = h.ring.filter((e) => e.id > since);
      return { events: out, next: out.length ? out[out.length - 1].id : Math.max(since, id) };
    },
  };
  return h;
}

let pool;
const users = [];
test.before(async () => {
  pool = new Pool({ connectionString: DB_URL });
  for (let i = 0; i < 4; i += 1) {
    const r = await pool.query("INSERT INTO users (username, password_hash) VALUES ($1, 'x') RETURNING id", [`tunrec_${process.pid}_${Date.now()}_${i}`]);
    users.push(r.rows[0].id);
  }
});
test.after(async () => {
  await pool.query('TRUNCATE tunnel_sessions, tunnel_session_events RESTART IDENTITY CASCADE');
  await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [users]);
  await pool.end();
});
test.beforeEach(async () => {
  await pool.query('TRUNCATE tunnel_sessions, tunnel_session_events RESTART IDENTITY CASCADE');
});

const sessions = async () => (await pool.query('SELECT * FROM tunnel_sessions ORDER BY id')).rows;
const events = async () => (await pool.query('SELECT * FROM tunnel_session_events ORDER BY id')).rows;
const players = async (sid) => (await pool.query('SELECT user_id FROM tunnel_session_players WHERE session_id = $1 ORDER BY user_id', [sid])).rows.map((r) => r.user_id);
const sync = (h, traffic, nowMs, cursor = h.cursor || (h.cursor = { since: 0 })) => syncOnce(pool, { helper: h, traffic, now: () => nowMs, cursor });

function cfOn(h, at = T0, mode = 'built') {
  h.st.cloudflare = { provider: 'cloudflare', state: 'on', mode, url: CF_URL, startedAt: iso(at), error: null };
  h.emit('cloudflare', 'started', at, CF_URL);
}

test('helper on with no open session opens exactly one session', async () => {
  const h = fakeHelper();
  cfOn(h);
  const traffic = createTunnelTraffic();
  await sync(h, traffic, T0 + 5000);
  await sync(h, traffic, T0 + 15000);
  const s = await sessions();
  assert.strictEqual(s.length, 1);
  assert.strictEqual(s[0].provider, 'cloudflare');
  assert.strictEqual(s[0].mode, 'built');
  assert.strictEqual(s[0].url, CF_URL);
  assert.strictEqual(s[0].ended_at, null);
  assert.strictEqual(s[0].started_at.toISOString(), iso(T0));
});

test('an already-running tunnel (backend restart, events gone) is adopted once', async () => {
  const h = fakeHelper();
  h.st.ngrok = { provider: 'ngrok', state: 'on', mode: 'live', url: NG_URL, startedAt: iso(T0), error: null };
  await sync(h, createTunnelTraffic(), T0 + 1000);
  await sync(h, createTunnelTraffic(), T0 + 2000);
  const s = await sessions();
  assert.deepStrictEqual(s.map((r) => [r.provider, r.mode, r.url, r.ended_at]), [['ngrok', 'live', NG_URL, null]]);
});

test('players: peak_players is the most seen at once and every account gets a row', async () => {
  const h = fakeHelper();
  cfOn(h);
  const traffic = createTunnelTraffic();
  const r1 = traffic.noteConnection({ host: CF_HOST, userId: users[0] });
  traffic.noteConnection({ host: `${CF_HOST.toUpperCase()}:443`, userId: users[1] });
  traffic.noteConnection({ host: 'localhost:15173', userId: users[3] }); // local play is not tunnel play
  await sync(h, traffic, T0 + 1000);
  r1();
  traffic.noteConnection({ host: CF_HOST, userId: users[2] });
  await sync(h, traffic, T0 + 2000);
  const [s] = await sessions();
  assert.strictEqual(s.peak_players, 2);
  assert.deepStrictEqual(await players(s.id), [users[0], users[1], users[2]].sort((a, b) => a - b));
  traffic.noteConnection({ host: CF_HOST, userId: users[0] });
  await sync(h, traffic, T0 + 3000);
  assert.strictEqual((await sessions())[0].peak_players, 3);
});

test('helper off after a stopped event closes the session as switched_off', async () => {
  const h = fakeHelper();
  cfOn(h);
  const traffic = createTunnelTraffic();
  await sync(h, traffic, T0 + 1000);
  h.st.cloudflare = off('cloudflare');
  h.emit('cloudflare', 'stopped', T0 + 60000);
  await sync(h, traffic, T0 + 61000);
  const [s] = await sessions();
  assert.strictEqual(s.end_reason, 'switched_off');
  assert.strictEqual(s.ended_at.toISOString(), iso(T0 + 60000));
});

test('closes an open session whose container is gone (no stopped event) as went_down', async () => {
  // A session left open by an earlier backend life; the helper now reports the tunnel off.
  await pool.query(`INSERT INTO tunnel_sessions (provider, mode, url, started_at) VALUES ('ngrok', 'built', $1, $2)`, [NG_URL, iso(T0)]);
  const h = fakeHelper();
  await sync(h, createTunnelTraffic(), T0 + 90000);
  const [s] = await sessions();
  assert.strictEqual(s.end_reason, 'went_down');
  assert.strictEqual(s.ended_at.toISOString(), iso(T0 + 90000));
});

test('a stop racing the status read is still switched_off and not reopened', async () => {
  const h = fakeHelper();
  cfOn(h);
  const traffic = createTunnelTraffic();
  await sync(h, traffic, T0 + 1000);
  // status still says on (read first), but the stopped event is already in the ring
  h.emit('cloudflare', 'stopped', T0 + 2000);
  await sync(h, traffic, T0 + 3000);
  const s = await sessions();
  assert.deepStrictEqual(s.map((r) => r.end_reason), ['switched_off']);
});

test('a crash (failed while on) closes the session as crashed with the error', async () => {
  const h = fakeHelper();
  cfOn(h);
  const traffic = createTunnelTraffic();
  await sync(h, traffic, T0 + 1000);
  h.st.cloudflare = off('cloudflare');
  h.emit('cloudflare', 'failed', T0 + 5000, 'tunnel-cf-built exited with code 1');
  await sync(h, traffic, T0 + 6000);
  const s = await sessions();
  assert.strictEqual(s.length, 1);
  assert.strictEqual(s[0].end_reason, 'crashed');
  assert.strictEqual(s[0].error, 'tunnel-cf-built exited with code 1');
});

test('helper failed / busy start: a failed_to_start session with the error, once', async () => {
  const h = fakeHelper();
  h.st.cloudflare = { provider: 'cloudflare', state: 'failed', mode: 'built', url: null, startedAt: null, error: 'Cloudflare gave no address within 60 s.' };
  h.emit('cloudflare', 'failed', T0, 'Cloudflare gave no address within 60 s.');
  h.st.ngrok = { provider: 'ngrok', state: 'busy', mode: 'live', url: null, startedAt: null, error: 'ngrok is busy with another project' };
  h.emit('ngrok', 'busy', T0 + 10, 'ngrok is busy with another project');
  const traffic = createTunnelTraffic();
  await sync(h, traffic, T0 + 1000);
  await sync(h, traffic, T0 + 2000);
  // A backend restart re-reads the helper's events from 0: still no duplicate.
  await sync(h, traffic, T0 + 3000, { since: 0 });
  const s = await sessions();
  assert.deepStrictEqual(s.map((r) => [r.provider, r.end_reason, r.error]), [
    ['cloudflare', 'failed_to_start', 'Cloudflare gave no address within 60 s.'],
    ['ngrok', 'failed_to_start', 'ngrok is busy with another project'],
  ]);
  for (const r of s) assert.ok(r.ended_at, 'a failed start is closed');
});

test('dropped / reconnected and tunnel-host traffic errors become event rows on the open session', async () => {
  const h = fakeHelper();
  cfOn(h);
  const traffic = createTunnelTraffic({ now: () => T0 + 4000 });
  await sync(h, traffic, T0 + 1000);
  h.emit('cloudflare', 'dropped', T0 + 2000, 'ERR Connection terminated');
  h.emit('cloudflare', 'reconnected', T0 + 3000);
  traffic.noteError({ host: CF_HOST, kind: 'http_5xx', detail: 'GET /api/worlds 500' });
  traffic.noteError({ host: `${CF_HOST}:443`, kind: 'ws_refused', detail: 'invalid token' });
  traffic.noteError({ host: 'localhost:13101', kind: 'http_5xx', detail: 'GET /api/x 500' }); // not a tunnel
  traffic.noteError({ host: 'my-game.ngrok.app', kind: 'http_5xx', detail: 'GET /api/y 500' }); // ngrok is off
  await sync(h, traffic, T0 + 5000);
  // Replay from 0 (backend restart): no duplicates.
  await sync(h, traffic, T0 + 6000, { since: 0 });
  const [s] = await sessions();
  const ev = await events();
  assert.deepStrictEqual(ev.map((e) => [e.session_id, e.provider, e.kind, e.detail]), [
    [s.id, 'cloudflare', 'dropped', 'ERR Connection terminated'],
    [s.id, 'cloudflare', 'reconnected', null],
    [s.id, 'cloudflare', 'http_5xx', 'GET /api/worlds 500'],
    [s.id, 'cloudflare', 'ws_refused', 'invalid token'],
  ]);
  assert.strictEqual(ev[0].at.toISOString(), iso(T0 + 2000));
});

test('a full replay from 0 after a restart records nothing twice', async () => {
  const h = fakeHelper();
  cfOn(h);
  h.emit('cloudflare', 'dropped', T0 + 1000, 'x');
  h.emit('cloudflare', 'reconnected', T0 + 2000);
  h.st.cloudflare = off('cloudflare');
  h.emit('cloudflare', 'stopped', T0 + 3000);
  const traffic = createTunnelTraffic();
  await sync(h, traffic, T0 + 4000);
  const before = [await sessions(), await events()];
  await sync(h, traffic, T0 + 5000, { since: 0 });
  await sync(h, traffic, T0 + 6000, { since: 0 });
  assert.deepStrictEqual([await sessions(), await events()], before);
  assert.strictEqual(before[0].length, 1);
  assert.strictEqual(before[0][0].end_reason, 'switched_off');
  assert.strictEqual(before[1].length, 2);
});

test('rows older than 30 days are purged', async () => {
  const day = 86400000;
  const old = await pool.query(`INSERT INTO tunnel_sessions (provider, mode, url, started_at, ended_at, end_reason)
    VALUES ('cloudflare', 'built', $1, $2, $2, 'switched_off') RETURNING id`, [CF_URL, iso(T0 - 40 * day)]);
  await pool.query('INSERT INTO tunnel_session_players (session_id, user_id, first_seen) VALUES ($1, $2, $3)', [old.rows[0].id, users[0], iso(T0 - 40 * day)]);
  await pool.query(`INSERT INTO tunnel_session_events (session_id, provider, at, kind) VALUES ($1, 'cloudflare', $2, 'dropped'), (NULL, 'ngrok', $2, 'http_5xx')`, [old.rows[0].id, iso(T0 - 40 * day)]);
  await pool.query(`INSERT INTO tunnel_sessions (provider, mode, url, started_at, ended_at, end_reason)
    VALUES ('cloudflare', 'built', $1, $2, $2, 'switched_off')`, [CF_URL, iso(T0 - 2 * day)]);
  await sync(fakeHelper(), createTunnelTraffic(), T0);
  const s = await sessions();
  assert.deepStrictEqual(s.map((r) => r.started_at.toISOString()), [iso(T0 - 2 * day)]);
  assert.deepStrictEqual(await events(), []);
  assert.deepStrictEqual(await players(old.rows[0].id), []);
});

test('helper unavailable: no writes and no throw', async () => {
  const h = fakeHelper();
  cfOn(h);
  h.down = true;
  const traffic = createTunnelTraffic();
  traffic.noteConnection({ host: CF_HOST, userId: users[0] });
  traffic.noteError({ host: CF_HOST, kind: 'http_5xx', detail: 'x' });
  await assert.doesNotReject(sync(h, traffic, T0 + 1000));
  assert.deepStrictEqual(await sessions(), []);
  assert.deepStrictEqual(await events(), []);
});
