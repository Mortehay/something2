require('./helpers/auth.js');
// SOMET-642. Git proxy routes against a FAKE helper (an http server on a temp
// unix socket + a temp token file). No real helper, no git, scratch DB only.
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
const { withSeedSyncLock } = require('./helpers/seedSyncTest.js');
const seedExportRoutes = require('../src/api/seedExportRoutes.js');
const jobs = require('../src/services/seedSync/jobs.js');
const { suggestCommitMessage } = require('../src/services/gitHelperClient.js');

const DB_URL = process.env.TEST_DATABASE_URL;
const TOKEN = 'tok-abc';
const handlersRef = {}; // lets one test swap in a blocking fake handler

function fakeHelper(dir, handlers) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const rec = { method: req.method, url: req.url, token: req.headers['x-git-helper-token'], body: raw ? JSON.parse(raw) : null };
      calls.push(rec);
      const h = handlers[`${req.method} ${req.url}`];
      const out = h ? await h(rec) : [404, { error: 'not_found' }];
      if (out === 'destroy') { req.socket.destroy(); return; } // helper dies mid-request
      const [code, body] = out;
      const data = JSON.stringify(body);
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(data);
    });
  });
  const sock = path.join(dir, 'git-helper.sock');
  return new Promise((resolve) => server.listen(sock, () => resolve({ server, calls, sock })));
}

async function makeUser(pool, role) {
  const username = `sx-git-${role}-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const r = await pool.query('INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id, token_version', [username, 'x', role]);
  return { id: r.rows[0].id, auth: `Bearer ${signToken({ userId: r.rows[0].id, username, role, tokenVersion: r.rows[0].token_version })}` };
}

const STATUS = {
  branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, otherDirty: [], headSubject: 'x', lastFetchAt: null,
  seedsDirty: ['backend/seeds/sync/items.json', 'backend/seeds/sync/biomes.json', 'backend/seeds/sync/items.json'],
};

// body(ctx): ctx = { pool, admin, player, helper, app, tokenFile, dir, watermark }.
// opts.helper false = no helper started (socket path points nowhere).
function gitTest(name, body, { helper: withHelper = true, handlers = {} } = {}) {
  test(name, async (t) => {
    if (!DB_URL) {
      const msg = 'TEST_DATABASE_URL not set -- skipping (seed_export git routes)';
      if (process.env.CI) assert.fail(msg);
      t.skip(msg);
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-routes-'));
    const tokenFile = path.join(dir, 'git-helper.token');
    const prev = {};
    for (const k of ['GIT_HELPER_SOCKET', 'GIT_HELPER_TOKEN_FILE', 'GIT_HELPER_URL', 'SEED_PC_LABEL']) prev[k] = process.env[k];
    delete process.env.GIT_HELPER_URL;
    process.env.GIT_HELPER_SOCKET = path.join(dir, 'git-helper.sock');
    process.env.GIT_HELPER_TOKEN_FILE = tokenFile;
    process.env.SEED_PC_LABEL = 'test-pc';
    if (withHelper) fs.writeFileSync(tokenFile, `${TOKEN}\n`);
    const helper = withHelper ? await fakeHelper(dir, handlers) : null;
    const pool = new Pool({ connectionString: DB_URL, max: 4, connectionTimeoutMillis: 3000 });
    t.after(async () => {
      for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      if (helper) { helper.server.closeAllConnections(); await new Promise((r) => helper.server.close(r)); }
      fs.rmSync(dir, { recursive: true, force: true });
      await pool.end().catch(() => {});
    });
    await withSeedSyncLock(pool, async () => {
      const watermark = (await pool.query('SELECT coalesce(max(id), 0)::int AS m FROM seed_export_runs')).rows[0].m;
      const users = [];
      try {
        const admin = await makeUser(pool, 'admin'); users.push(admin.id);
        const player = await makeUser(pool, 'player'); users.push(player.id);
        const app = express();
        app.use(express.json());
        app.use('/api/seed-export', seedExportRoutes(pool, {}));
        await body({ pool, admin, player, helper, app, tokenFile, dir, watermark });
      } finally {
        await pool.query("DELETE FROM seed_export_runs WHERE id > $1 AND group_id = 'git'", [watermark]).catch(() => {});
        await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [users]).catch(() => {});
      }
    });
  });
}

const gitRuns = async (pool, watermark) => (await pool.query(
  "SELECT * FROM seed_export_runs WHERE id > $1 AND group_id = 'git' ORDER BY id", [watermark])).rows;
const U = '/api/seed-export/git';

test('suggestCommitMessage names the changed groups once, in order', () => {
  const prev = process.env.SEED_PC_LABEL;
  process.env.SEED_PC_LABEL = 'lab';
  try {
    assert.strictEqual(suggestCommitMessage(STATUS.seedsDirty), 'seed export: items, biomes from lab');
    assert.strictEqual(suggestCommitMessage(['backend/seeds/sync/a.json', 'backend/seeds/maps/x.map.json', 'backend/seeds/sync/sub/b.json']), 'seed export: a from lab');
    assert.strictEqual(suggestCommitMessage([]), 'seed export: seeds from lab');
  } finally { if (prev === undefined) delete process.env.SEED_PC_LABEL; else process.env.SEED_PC_LABEL = prev; }
});

gitTest('git routes require admin', async ({ app, player, helper }) => {
  for (const [m, p] of [['get', '/status'], ['post', '/fetch'], ['post', '/pull'], ['post', '/commit'], ['post', '/push']]) {
    const anon = await request(app)[m](`${U}${p}`).send({ message: 'x' });
    assert.strictEqual(anon.status, 401, `${m} ${p}`);
    const pl = await request(app)[m](`${U}${p}`).set('Authorization', player.auth).send({ message: 'x' });
    assert.strictEqual(pl.status, 403, `${m} ${p}`);
  }
  assert.strictEqual(helper.calls.length, 0, 'the helper is never reached by a non-admin');
}, { handlers: {} });

gitTest('status passes the helper status through with the token and a suggested message', async ({ app, admin, helper }) => {
  const res = await request(app).get(`${U}/status`).set('Authorization', admin.auth);
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.body.available, true);
  assert.strictEqual(res.body.branch, 'main');
  assert.deepStrictEqual(res.body.seedsDirty, STATUS.seedsDirty);
  assert.strictEqual(res.body.suggestedMessage, 'seed export: items, biomes from test-pc');
  assert.deepStrictEqual(helper.calls.map((c) => [c.method, c.url, c.token]), [['GET', '/status', TOKEN]]);
}, { handlers: { 'GET /status': () => [200, STATUS] } });

gitTest('status degrades when the socket or the token is missing', async ({ app, admin, tokenFile }) => {
  const want = { available: false, reason: 'helper_unavailable', hint: 'Run make git-helper on this PC' };
  const noSock = await request(app).get(`${U}/status`).set('Authorization', admin.auth);
  assert.strictEqual(noSock.status, 200);
  assert.deepStrictEqual(noSock.body, want);
  fs.writeFileSync(tokenFile, 'x');
  fs.rmSync(tokenFile);
  const noTok = await request(app).get(`${U}/status`).set('Authorization', admin.auth);
  assert.deepStrictEqual(noTok.body, want);
}, { helper: false });

gitTest('status degrades on a refused connection and on a rejected token', async ({ app, admin, dir }) => {
  const want = { available: false, reason: 'helper_unavailable', hint: 'Run make git-helper on this PC' };
  // A stale socket file nobody listens on: ECONNREFUSED.
  const net = require('node:net');
  const stale = path.join(dir, 'git-helper.sock');
  await new Promise((r) => { const s = net.createServer().listen(stale, () => { s.close(r); }); });
  fs.writeFileSync(path.join(dir, 'git-helper.token'), 'tok');
  const res = await request(app).get(`${U}/status`).set('Authorization', admin.auth);
  assert.deepStrictEqual(res.body, want);
}, { helper: false });

gitTest('status degrades when the helper rejects the token (it restarted)', async ({ app, admin, tokenFile }) => {
  fs.writeFileSync(tokenFile, 'stale-token\n');
  const res = await request(app).get(`${U}/status`).set('Authorization', admin.auth);
  assert.strictEqual(res.body.available, false);
  assert.strictEqual(res.body.reason, 'helper_unavailable');
}, { handlers: { 'GET /status': (r) => (r.token === TOKEN ? [200, STATUS] : [401, { error: 'unauthorized' }]) } });

gitTest('the token is read on every call', async ({ app, admin, tokenFile }) => {
  const a = await request(app).get(`${U}/status`).set('Authorization', admin.auth);
  assert.strictEqual(a.body.available, true);
  fs.writeFileSync(tokenFile, 'rotated\n');
  const b = await request(app).get(`${U}/status`).set('Authorization', admin.auth);
  assert.strictEqual(b.body.available, false);
}, { handlers: { 'GET /status': (r) => (r.token === TOKEN ? [200, STATUS] : [401, { error: 'unauthorized' }]) } });

gitTest('pull, push and commit pass the helper answer through and record a run each', async ({ pool, app, admin, helper, watermark }) => {
  const h = { Authorization: admin.auth };
  const pull = await request(app).post(`${U}/pull`).set(h);
  assert.strictEqual(pull.status, 200, pull.text);
  assert.strictEqual(pull.body.output, 'Fast-forward');
  const commit = await request(app).post(`${U}/commit`).set(h).send({ message: 'seed export: items from pc' });
  assert.strictEqual(commit.status, 200, commit.text);
  const push = await request(app).post(`${U}/push`).set(h);
  assert.strictEqual(push.status, 200, push.text);
  const fetched = await request(app).post(`${U}/fetch`).set(h);
  assert.strictEqual(fetched.status, 200, fetched.text);
  assert.deepStrictEqual(helper.calls.map((c) => `${c.method} ${c.url}`), ['POST /pull', 'POST /commit', 'POST /push', 'POST /fetch']);
  assert.deepStrictEqual(helper.calls[1].body, { message: 'seed export: items from pc' });
  assert.ok(helper.calls.every((c) => c.token === TOKEN));
  const runs = await gitRuns(pool, watermark);
  assert.deepStrictEqual(runs.map((r) => [r.group_id, r.action, r.status]), [
    ['git', 'git_pull', 'ok'], ['git', 'git_commit', 'ok'], ['git', 'git_push', 'ok'],
  ]);
  assert.ok(runs.every((r) => r.pc_label === 'test-pc' && r.finished_at));
  assert.strictEqual(runs[1].summary.output, 'committed');
  assert.strictEqual(runs[1].summary.headSubject, 'seed export: items from pc');
}, {
  handlers: {
    'POST /pull': () => [200, { ok: true, op: 'pull', output: 'Fast-forward', status: { headSubject: 'h1' } }],
    'POST /commit': (r) => [200, { ok: true, op: 'commit', output: 'committed', status: { headSubject: r.body.message } }],
    'POST /push': () => [200, { ok: true, op: 'push', output: 'pushed', status: {} }],
    'POST /fetch': () => [200, { ok: true, op: 'fetch', output: '', status: {} }],
  },
});

gitTest('helper refusals come back as 409 with the helper code, and the run is failed', async ({ pool, app, admin, watermark }) => {
  const h = { Authorization: admin.auth };
  const expect = { pull: 'dirty', commit: 'nothing_to_commit', push: 'behind' };
  for (const [op, code] of Object.entries(expect)) {
    const res = await request(app).post(`${U}/${op}`).set(h).send({ message: 'm' });
    assert.strictEqual(res.status, 409, `${op} ${res.text}`);
    assert.strictEqual(res.body.error, code);
    assert.ok(res.body.message);
  }
  const runs = await gitRuns(pool, watermark);
  assert.deepStrictEqual(runs.map((r) => [r.action, r.status, r.error]), [
    ['git_pull', 'failed', 'dirty'], ['git_commit', 'failed', 'nothing_to_commit'], ['git_push', 'failed', 'behind'],
  ]);
}, {
  handlers: {
    'POST /pull': () => [409, { error: 'dirty', message: 'tree is dirty' }],
    'POST /commit': () => [409, { error: 'nothing_to_commit', message: 'nothing staged' }],
    'POST /push': () => [409, { error: 'behind', message: 'pull first' }],
  },
});

gitTest('a git failure on the helper is passed through as 502 and recorded failed', async ({ pool, app, admin, watermark }) => {
  const res = await request(app).post(`${U}/push`).set('Authorization', admin.auth);
  assert.strictEqual(res.status, 502);
  assert.strictEqual(res.body.ok, false);
  const runs = await gitRuns(pool, watermark);
  assert.strictEqual(runs[0].status, 'failed');
  assert.strictEqual(runs[0].summary.output, 'permission denied');
}, { handlers: { 'POST /push': () => [502, { ok: false, op: 'push', output: 'permission denied', status: {} }] } });

gitTest('commit needs a message, and a bad body from the helper stays a 400', async ({ app, admin, helper }) => {
  const h = { Authorization: admin.auth };
  for (const body of [{}, { message: '' }, { message: '   ' }, { message: 5 }]) {
    const res = await request(app).post(`${U}/commit`).set(h).send(body);
    assert.strictEqual(res.status, 400, JSON.stringify(body));
  }
  assert.strictEqual(helper.calls.length, 0);
});

gitTest('actions answer 503 helper_unavailable when the helper is down, and release the runner', async ({ pool, app, admin, watermark }) => {
  const h = { Authorization: admin.auth };
  for (const op of ['fetch', 'pull', 'commit', 'push']) {
    const res = await request(app).post(`${U}/${op}`).set(h).send({ message: 'm' });
    assert.strictEqual(res.status, 503, op);
    assert.strictEqual(res.body.error, 'helper_unavailable');
    assert.strictEqual(res.body.hint, 'Run make git-helper on this PC');
  }
  assert.strictEqual(jobs.isBusy(), false, 'a failed call does not leave the runner held');
  const runs = await gitRuns(pool, watermark);
  assert.deepStrictEqual(runs.map((r) => [r.action, r.status]), [['git_pull', 'failed'], ['git_commit', 'failed'], ['git_push', 'failed']]);
}, { helper: false });

gitTest('a helper that drops the connection mid-action is a 503 flagged midAction; a missing token is not', async ({ app, admin, tokenFile }) => {
  const h = { Authorization: admin.auth };
  const mid = await request(app).post(`${U}/push`).set(h);
  assert.strictEqual(mid.status, 503);
  assert.strictEqual(mid.body.error, 'helper_unavailable');
  assert.strictEqual(mid.body.midAction, true);
  assert.strictEqual(jobs.isBusy(), false);
  fs.rmSync(tokenFile);
  const before = await request(app).post(`${U}/push`).set(h);
  assert.strictEqual(before.status, 503);
  assert.ok(!before.body.midAction, 'token missing before sending is not mid-action');
}, { handlers: { 'POST /push': () => 'destroy' } });

gitTest('a busy refusal with no running job carries a readable message', async ({ app, admin }) => {
  const release = jobs.holdExternal('other');
  try {
    const res = await request(app).post(`${U}/fetch`).set('Authorization', admin.auth);
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.error, 'busy');
    assert.strictEqual(res.body.message, 'Another git action or seed job is running');
  } finally { release(); }
}, { handlers: {} });

gitTest('a git action is refused 409 busy while a seed job runs', async ({ pool, app, admin, helper, watermark }) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const job = jobs.startJob({ groupId: 'art', action: 'export', run: async () => { await gate; return {}; } });
  try {
    for (const op of ['fetch', 'pull', 'commit', 'push']) {
      const res = await request(app).post(`${U}/${op}`).set('Authorization', admin.auth).send({ message: 'm' });
      assert.strictEqual(res.status, 409, op);
      assert.strictEqual(res.body.error, 'busy');
      assert.strictEqual(res.body.job.id, job.id);
    }
  } finally {
    release();
    for (let i = 0; i < 500 && jobs.isBusy(); i++) await new Promise((r) => setTimeout(r, 10));
  }
  assert.strictEqual(helper.calls.length, 0);
  assert.strictEqual((await gitRuns(pool, watermark)).length, 0, 'a refused action records no run');
}, { handlers: {} });

gitTest('a seed export is refused 409 busy while a git action runs', async ({ pool, app, admin }) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let entered;
  const inFlight = new Promise((r) => { entered = r; });
  // The fake helper's pull blocks until released.
  handlersRef.pull = async () => { entered(); await gate; return [200, { ok: true, op: 'pull', output: 'ok', status: {} }]; };
  const h = { Authorization: admin.auth };
  const pulling = request(app).post(`${U}/pull`).set(h).then((r) => r);
  await Promise.race([inFlight, new Promise((_, rej) => setTimeout(() => rej(new Error('pull never reached the helper')), 3000))]);
  try {
    const exp = await request(app).post('/api/seed-export/groups/art/export').set(h);
    assert.strictEqual(exp.status, 409, exp.text);
    assert.strictEqual(exp.body.error, 'busy');
    assert.strictEqual(exp.body.job, null);
    assert.throws(() => jobs.startJob({ groupId: 'art', action: 'export', run: async () => ({}) }), (e) => e.code === 'busy');
    const second = await request(app).post(`${U}/push`).set(h);
    assert.strictEqual(second.status, 409, 'two git actions never overlap');
    assert.strictEqual(second.body.error, 'busy');
  } finally {
    release();
  }
  assert.strictEqual((await pulling).status, 200);
  assert.strictEqual(jobs.isBusy(), false, 'released after the action');
  void pool;
}, { handlers: { 'POST /pull': () => handlersRef.pull() } });
