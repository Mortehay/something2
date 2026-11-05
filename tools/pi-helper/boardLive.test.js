'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { createBoardLive, parseSummonRequest, FETCH_SCRIPT, NO_LISTENER_TEXT } = require('./boardLive');
const { createJobs, BusyError } = require('./jobs');
const { createSampler } = require('./sampler');
const { createMetricsStore } = require('./metricsStore');
const { nextSample } = require('./procParse');
const { createRunner } = require('./boardRunner');
const { liveRoutes } = require('./server');
const { BadRequest } = require('../helper-core/helperServer');
const { scratch } = require('./testkit');

// The fixed script, really run by node, with its arguments arriving as a board shell would pass them.
function runScript(args, env = {}) {
  const quoted = spawnSync('bash', ['-c', 'for a in "$@"; do printf " %q" "$a"; done', '_', 'node', '-e', FETCH_SCRIPT, ...args], { encoding: 'utf8' }).stdout;
  return new Promise((resolve) => {
    const { spawn } = require('node:child_process');
    const c = spawn('bash', ['-c', quoted], { env: { PATH: process.env.PATH, ...env } });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('close', (code) => resolve({ code, stdout: out, timedOut: false }));
  });
}

function fakeListener(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      seen.push({ method: req.method, url: req.url, raw });
      const [status, body] = handler(req, raw);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  return new Promise((r) => { server.listen(0, '127.0.0.1', () => r({ server, seen, port: server.address().port })); });
}

const runnerOver = (fn) => { const calls = []; return { calls, script: async (name, args, opts) => { calls.push({ name, args, opts }); return fn(args); } }; };

test('the fixed script really fetches the listener, and a summon body survives any name', async (t) => {
  const l = await fakeListener((req, raw) => [200, { echoed: raw || null }]);
  t.after(() => l.server.close());
  const liveRun = createBoardLive({ runner: runnerOver((args) => runScript(args.slice(4), { BOARD_INTERNAL_PORT: String(l.port) })) });
  const get = await liveRun.ask('GET', '/players');
  assert.deepEqual(get, { ok: true, status: 200, body: { echoed: null } });
  assert.equal(l.seen[0].method, 'GET');
  assert.equal(l.seen[0].url, '/players');
  const evil = { owner: 'dungeon', name: "$(touch /tmp/x) `id` 'q' \"d\"", world: 'The Abyss: Hub; rm -rf /' };
  const post = await liveRun.ask('POST', '/bosses/summon', evil);
  assert.equal(post.status, 200);
  assert.deepEqual(JSON.parse(post.body.echoed), evil);
});

test('an older board image: no port in its environment, so no_listener, and it is not an error', async () => {
  const live = createBoardLive({ runner: runnerOver((args) => runScript(args.slice(4))) });
  assert.deepEqual(await live.ask('GET', '/players'), { ok: false, reason: 'no_listener' });
  assert.deepEqual(await live.players(), { available: false, reason: 'no_listener', message: NO_LISTENER_TEXT });
  assert.equal(await live.counters(), null);
});

test('a new image with the listener down reads the same way', async () => {
  const live = createBoardLive({ runner: runnerOver((args) => runScript(args.slice(4), { BOARD_INTERNAL_PORT: '1' })) });
  assert.deepEqual(await live.ask('GET', '/bosses'), { ok: false, reason: 'no_listener' });
});

test('through the real runner and remote.sh path: only the allow-listed script, with the fixed arguments', async (t) => {
  const s = scratch(t);
  s.script('remote.sh', 'printf "%s\\n" "$@" > args.txt; echo \'{"status":200,"body":{"online":1,"mobKills":2,"pvpKills":3}}\'');
  const runner = createRunner({ root: s.root, env: s.env });
  const live = createBoardLive({ runner });
  assert.deepEqual(await live.counters(), { online: 1, mobKills: 2, pvpKills: 3 });
  const args = require('node:fs').readFileSync(`${s.root}/args.txt`, 'utf8').split('\n');
  assert.deepEqual(args.slice(0, 3), ['backend', 'node', '-e']);
  assert.ok(args.includes('/counters'));
});

test('an unreachable board, a timeout or junk output are "unreachable", never thrown', async () => {
  for (const r of [{ code: 255, stdout: '' }, { code: 1, stdout: '' }, { code: null, stdout: '', timedOut: true }, { code: 0, stdout: 'not json' }, { code: 0, stdout: '{"status":"x"}' }]) {
    const live = createBoardLive({ runner: runnerOver(() => r), cacheMs: 0 });
    assert.deepEqual(await live.ask('GET', '/players'), { ok: false, reason: 'unreachable' }, JSON.stringify(r));
    assert.equal((await live.players()).available, false);
    assert.equal(await live.counters(), null);
  }
  const throwing = createBoardLive({ runner: { script: async () => { throw new Error('boom'); } } });
  assert.equal(await throwing.counters(), null);
});

test('reads share one call, and go back to the board only after the cache', async () => {
  let t = 0;
  const runner = runnerOver(() => ({ code: 0, stdout: '{"status":200,"body":{"players":[]}}' }));
  const live = createBoardLive({ runner, now: () => t });
  const [a, b] = await Promise.all([live.players(), live.players()]);
  assert.deepEqual(a, { available: true, players: [] });
  assert.deepEqual(b, a);
  assert.equal(runner.calls.length, 1);
  t += 4000;
  await live.players();
  assert.equal(runner.calls.length, 1, 'still cached');
  t += 2000;
  await live.players();
  assert.equal(runner.calls.length, 2);
});

test('the sampler never reads players or bosses: nobody asked', async () => {
  const runner = {
    env: () => ({ ORANGEPI_ADDRESS: 'x' }), ssh: async () => ({ code: 0, stdout: '', timedOut: false }),
    ...runnerOver(() => ({ code: 0, stdout: '{"status":200,"body":{"online":1,"mobKills":0,"pvpKills":0}}' })),
  };
  const live = createBoardLive({ runner });
  const fs = require('node:fs');
  const fixture = fs.readFileSync(`${__dirname}/fixtures/board-snapshot.txt`, 'utf8');
  runner.ssh = async () => ({ code: 0, stdout: fixture, timedOut: false });
  const s = createSampler({ runner, ping: async () => 1, fetchLatency: async () => 1, readCounters: () => live.counters() });
  await s.tick();
  const routes = runner.calls.map((c) => c.args[5]);
  assert.deepEqual(routes, ['/counters']);
});

test('parseSummonRequest: exactly the three fields', () => {
  assert.deepEqual(parseSummonRequest({ owner: 'world', name: 'a', world: 'b' }), { owner: 'world', name: 'a', world: 'b' });
  for (const bad of [null, [], 'x', {}, { owner: 'world', name: 'a' }, { owner: 'x', name: 'a', world: 'b' }, { owner: 'world', name: 'a', world: 'b', z: 1 },
    { owner: 'world', name: 1, world: 'b' }, { owner: 'world', name: 'a', world: '' }, { owner: 'world', name: 'a'.repeat(121), world: 'b' }]) {
    assert.throws(() => parseSummonRequest(bad), BadRequest, JSON.stringify(bad));
  }
});

const settled = async (jobs) => { while (jobs.isRunning()) await new Promise((r) => { setImmediate(r); }); return jobs.current(); };

test('a summon is a job: its refusal fails it with the reason, and it goes to the history', async () => {
  const done = [];
  const jobs = createJobs({ onDone: (j) => done.push(j) });
  const refusal = { code: 0, stdout: JSON.stringify({ status: 409, body: { ok: false, error: 'not_loaded', message: 'Dungeon One is not loaded.' } }) };
  const routes = liveRoutes({ live: createBoardLive({ runner: runnerOver(() => refusal) }), jobs });
  const started = routes['POST /bosses/summon']({ owner: 'dungeon', name: 'B', world: 'Dungeon One' });
  assert.equal(started.kind, 'summon');
  const job = await settled(jobs);
  assert.equal(job.state, 'failed');
  assert.equal(job.error, 'Dungeon One is not loaded.');
  assert.equal(done[0].kind, 'summon');
});

test('a summon that works names what happened; an older image says to press Update', async () => {
  const jobs = createJobs();
  const ok = { code: 0, stdout: JSON.stringify({ status: 200, body: { ok: true, message: 'B summoned in W.' } }) };
  let routes = liveRoutes({ live: createBoardLive({ runner: runnerOver(() => ok) }), jobs });
  routes['POST /bosses/summon']({ owner: 'world', name: 'B', world: 'W' });
  let job = await settled(jobs);
  assert.equal(job.state, 'ok');
  assert.equal(job.steps[0].detail, 'B summoned in W.');
  routes = liveRoutes({ live: createBoardLive({ runner: runnerOver(() => ({ code: 3, stdout: '' })) }), jobs });
  routes['POST /bosses/summon']({ owner: 'world', name: 'B', world: 'W' });
  job = await settled(jobs);
  assert.equal(job.state, 'failed');
  assert.equal(job.error, NO_LISTENER_TEXT);
});

test('busy rules apply to a summon, and a bad body starts nothing', async () => {
  const jobs = createJobs();
  let release;
  jobs.start('update', [{ name: 'slow', run: () => new Promise((r) => { release = r; }) }]);
  const routes = liveRoutes({ live: createBoardLive({ runner: runnerOver(() => ({ code: 0, stdout: '' })) }), jobs });
  assert.throws(() => routes['POST /bosses/summon']({ owner: 'world', name: 'B', world: 'W' }), BusyError);
  assert.throws(() => routes['POST /bosses/summon']({ owner: 'world' }), BadRequest);
  await new Promise((r) => { setImmediate(r); });
  release();
  await settled(jobs);
  assert.equal(jobs.current().kind, 'update');
});

const fixtureSnapshot = () => require('node:fs').readFileSync(`${__dirname}/fixtures/board-snapshot.txt`, 'utf8');
function samplerRig(readCounters) {
  let t = 1_000_000;
  const store = createMetricsStore({ now: () => t });
  const runner = { env: () => ({}), ssh: async () => ({ code: 0, stdout: fixtureSnapshot(), timedOut: false }) };
  const s = createSampler({ runner, ping: async () => 1, fetchLatency: async () => 1, store, now: () => t, readCounters });
  return { s, store, advance: (ms) => { t += ms; } };
}

test('the sampler turns counters into rates per minute', async () => {
  const seq = [
    { online: 2, mobKills: 10, pvpKills: 1 }, { online: 3, mobKills: 16, pvpKills: 2 },
    { online: 3, mobKills: 16, pvpKills: 2 },
  ];
  const { s, store, advance } = samplerRig(async () => seq.shift());
  await s.tick();
  let cur = store.latest();
  assert.equal(cur.players, 2);
  assert.equal(cur.mobKillsPerMin, null, 'one reading has no rate');
  advance(30_000);
  await s.tick();
  cur = store.latest();
  assert.equal(cur.players, 3);
  assert.equal(cur.mobKillsPerMin, 12);
  assert.equal(cur.pvpKillsPerMin, 2);
  advance(30_000);
  await s.tick();
  assert.equal(store.latest().mobKillsPerMin, 0, 'zero is a reading');
});

test('a backend restart (totals fall) gives no rate for that interval, not a negative one', async () => {
  const seq = [{ online: 1, mobKills: 50, pvpKills: 5 }, { online: 1, mobKills: 2, pvpKills: 0 }, { online: 1, mobKills: 5, pvpKills: 0 }];
  const { s, store, advance } = samplerRig(async () => seq.shift());
  await s.tick();
  advance(15_000);
  await s.tick();
  assert.equal(store.latest().mobKillsPerMin, null);
  advance(15_000);
  await s.tick();
  assert.equal(store.latest().mobKillsPerMin, 12);
});

test('an older image: the three fields are null and the rest of the sample is there', async () => {
  const { s, store } = samplerRig(async () => null);
  await s.tick();
  const cur = store.latest();
  assert.equal(cur.online, true);
  assert.ok(cur.memTotalMb > 0);
  assert.equal(cur.players, null);
  assert.equal(cur.mobKillsPerMin, null);
  assert.equal(cur.pvpKillsPerMin, null);
});

test('a counter read that throws loses only its own fields', async () => {
  const { s, store } = samplerRig(async () => { throw new Error('boom'); });
  await s.tick();
  assert.equal(store.latest().online, true);
  assert.equal(store.latest().players, null);
});

test('an offline board does not run the counter script at all', async () => {
  let reads = 0;
  const runner = { env: () => ({}), ssh: async () => ({ code: 255, stdout: '', timedOut: false }) };
  const s = createSampler({ runner, ping: async () => null, fetchLatency: async () => null, now: () => 1, readCounters: async () => { reads += 1; return null; } });
  await s.tick();
  assert.equal(reads, 0);
  assert.equal(s.latest().players, null);
});

test('the store keeps the three fields, raw and averaged over a long range', () => {
  // Both samples fall in one 180 s bucket of the 24 h range.
  let t = 180_000 * 2000;
  const store = createMetricsStore({ now: () => t });
  const base = nextSample(null, { memUsedMb: 1, memTotalMb: 2, diskPct: 3, connections: 4, cpu: null, net: {} }, t, { players: 4, mobKillsPerMin: 6, pvpKillsPerMin: 1 });
  store.add(base);
  t += 15_000;
  store.add({ ...base, t, players: 2, mobKillsPerMin: 2, pvpKillsPerMin: 1 });
  const raw = store.query('15m').samples;
  assert.equal(raw[0].players, 4);
  assert.equal(raw[1].mobKillsPerMin, 2);
  const [bucket] = store.query('24h').samples;
  assert.equal(bucket.players, 3);
  assert.equal(bucket.mobKillsPerMin, 4);
  assert.equal(bucket.pvpKillsPerMin, 1);
});
