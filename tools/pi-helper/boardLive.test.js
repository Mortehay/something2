'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const {
  createBoardLive, parseSummonRequest, readCommand, SUMMON_SCRIPT, SUMMON_ABORT_MS, SUMMON_TIMEOUT_MS, BACKEND_CONTAINER,
  NO_LISTENER_TEXT, NO_LISTENER_EXIT, REFUSED_EXIT, UNKNOWN_EXIT, UNREACHABLE_TEXT, SUMMON_UNREACHABLE_TEXT, OUTCOME_UNKNOWN_TEXT,
} = require('./boardLive');
const { createJobs, BusyError } = require('./jobs');
const { createSampler, SNAPSHOT_COMMAND } = require('./sampler');
const { createMetricsStore } = require('./metricsStore');
const { nextSample, parseSnapshot } = require('./procParse');
const { createRunner } = require('./boardRunner');
const { liveRoutes } = require('./server');
const { BadRequest } = require('../helper-core/helperServer');
const { scratch } = require('./testkit');

const settled = async (jobs) => { while (jobs.isRunning()) await new Promise((r) => { setImmediate(r); }); return jobs.current(); };

// The real script through a shell, quoted the way remote.sh's quote_args quotes it for the board.
function runSummonScript(args, env = {}) {
  const quoted = spawnSync('bash', ['-c', 'for a in "$@"; do printf " %q" "$a"; done', '_', 'node', '-e', SUMMON_SCRIPT, ...args], { encoding: 'utf8' }).stdout;
  return new Promise((resolve) => {
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
      handler(req, raw, res, (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      });
    });
  });
  return new Promise((r) => { server.listen(0, '127.0.0.1', () => r({ server, seen, port: server.address().port })); });
}

const readRunner = (fn) => { const calls = []; return { calls, ssh: async (cmd, opts) => { calls.push({ cmd, opts }); return fn(cmd); } }; };
const summonRunner = (fn) => { const calls = []; return { calls, script: async (name, args, opts) => { calls.push({ name, args, opts }); return fn(args); } }; };
const SUMMON = { owner: 'dungeon', name: 'B', world: 'W', replaces: null };

// A fake board: stub docker and wget on PATH. docker runs the `sh -c` it was given with the container's
// environment, so what expands, and where, is what really expands.
function fakeBoard(t, { containerEnv = {}, wget = 'echo "$@" >> "$OUT/urls"; echo \'{"players":[]}\'', noTimeout = false, docker = null } = {}) {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'pi-board-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'wget'), `#!/bin/bash\n${wget}\n`, { mode: 0o755 });
  const envText = Object.entries(containerEnv).map(([k, v]) => `export ${k}=${v}; `).join('');
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/bash\n${docker || `echo "$2" >> "$OUT/containers"; ${envText}exec bash -c "$5"`}\n`, { mode: 0o755 });
  for (const tool of ['head', 'grep', 'cat', 'df', 'ss', 'wc', 'bash', 'sh', 'env', ...(noTimeout ? [] : ['timeout'])]) {
    const real = spawnSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
    if (real) fs.symlinkSync(real, path.join(bin, tool));
  }
  const run = (cmd) => spawnSync('/bin/bash', ['-c', cmd], { encoding: 'utf8', env: { PATH: bin, OUT: dir } });
  return { run, read: (name) => fs.readFileSync(path.join(dir, name), 'utf8') };
}

test('the container name is the one compose gives the backend', () => {
  const compose = fs.readFileSync(path.join(__dirname, '../../compose/orangepi/docker-compose.yml'), 'utf8');
  assert.match(compose, /^name: something2-orangepi$/m);
  assert.equal(BACKEND_CONTAINER, 'something2-orangepi-backend-1');
  assert.ok(SNAPSHOT_COMMAND.includes(BACKEND_CONTAINER));
});

test('a read expands the port inside the container, not on the board', (t) => {
  const b = fakeBoard(t, { containerEnv: { BOARD_INTERNAL_PORT: 3102 } });
  const r = b.run(readCommand('/players'));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { players: [] });
  assert.match(b.read('urls'), /http:\/\/127\.0\.0\.1:3102\/players/);
  assert.match(b.read('containers'), new RegExp(BACKEND_CONTAINER));
});

test('a read on an older image exits 3; a failed wget does not', (t) => {
  assert.equal(fakeBoard(t).run(readCommand('/bosses')).status, NO_LISTENER_EXIT);
  const failing = fakeBoard(t, { containerEnv: { BOARD_INTERNAL_PORT: 3102 }, wget: 'exit 1' }).run(readCommand('/bosses'));
  assert.equal(failing.status, 1);
  assert.throws(() => readCommand('/counters; rm -rf /'));
});

test('the snapshot: its game section, the port expanded in the container, a good exit code', (t) => {
  const b = fakeBoard(t, { containerEnv: { BOARD_INTERNAL_PORT: 3102 }, wget: 'echo "$@" >> "$OUT/urls"; echo \'{"online":3,"mobKills":5,"pvpKills":1}\'' });
  const r = b.run(SNAPSHOT_COMMAND);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(parseSnapshot(r.stdout).game, { online: 3, mobKills: 5, pvpKills: 1 });
  assert.match(b.read('urls'), /127\.0\.0\.1:3102\/counters/);
});

for (const [label, opts] of [
  ['an older image, no port', {}],
  ['wget failing', { containerEnv: { BOARD_INTERNAL_PORT: 3102 }, wget: 'exit 1' }],
  ['no container', { docker: 'exit 1' }],
  ['docker missing its daemon', { docker: 'echo "Cannot connect" >&2; exit 125' }],
  ['no timeout command on the board', { noTimeout: true, containerEnv: { BOARD_INTERNAL_PORT: 3102 } }],
]) {
  test(`the snapshot stays a healthy board with ${label}: exit 0, the rest parsed, game null`, (t) => {
    const wgetEcho = { wget: opts.wget || 'exit 1' };
    const r = fakeBoard(t, { ...opts, ...wgetEcho }).run(SNAPSHOT_COMMAND);
    assert.equal(r.status, 0, r.stderr);
    const parsed = parseSnapshot(r.stdout);
    assert.equal(parsed.game, null);
    assert.ok(parsed.memTotalMb > 0);
    assert.ok(parsed.cpu);
  });
}

test('a hung docker costs the snapshot 3 s, not its 10 s limit', (t) => {
  const started = Date.now();
  const r = fakeBoard(t, { docker: 'exec sleep 30' }).run(`${SNAPSHOT_COMMAND}`);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Date.now() - started < 6000, `took ${Date.now() - started} ms`);
});

test('reads go over the shared ssh connection, with only the fixed routes', async () => {
  const runner = readRunner(() => ({ code: 0, stdout: '{"players":[{"name":"a"}]}' }));
  const live = createBoardLive({ runner });
  assert.deepEqual(await live.players(), { available: true, players: [{ name: 'a' }] });
  assert.equal(runner.calls[0].opts.reuse, true);
  assert.equal(runner.calls[0].cmd, readCommand('/players'));
  assert.ok(!runner.calls[0].cmd.includes('node'), 'a read boots no node');
});

test('"press Update" only for an image with no port; every other failure says something else', async () => {
  const older = await createBoardLive({ runner: readRunner(() => ({ code: NO_LISTENER_EXIT, stdout: '' })) }).players();
  assert.deepEqual(older, { available: false, reason: 'no_listener', message: NO_LISTENER_TEXT });
  for (const r of [{ code: 255, stdout: '' }, { code: 1, stdout: '' }, { code: 124, stdout: '' }, { code: 127, stdout: '' }, { code: null, stdout: '', timedOut: true }, { code: 0, stdout: 'not json' }, { code: 0, stdout: '5' }]) {
    const out = await createBoardLive({ runner: readRunner(() => r) }).bosses();
    assert.deepEqual(out, { available: false, reason: 'unreachable', message: UNREACHABLE_TEXT }, JSON.stringify(r));
  }
  const throwing = await createBoardLive({ runner: { ssh: async () => { throw new Error('boom'); } } }).players();
  assert.equal(throwing.reason, 'unreachable');
});

test('reads share one call, and go back to the board only after the cache', async () => {
  let t = 0;
  const runner = readRunner(() => ({ code: 0, stdout: '{"players":[]}' }));
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

test('the summon script: a real POST, the body survives any name, the abort time is an argument', async (t) => {
  const l = await fakeListener((req, raw, res, send) => send(200, { echoed: raw }));
  t.after(() => l.server.close());
  const evil = { owner: 'dungeon', name: "$(touch /tmp/x) `id` 'q' \"d\"", world: 'The Abyss: Hub; rm -rf /', replaces: null };
  const b64 = Buffer.from(JSON.stringify(evil)).toString('base64');
  const r = await runSummonScript(['5000', b64], { BOARD_INTERNAL_PORT: String(l.port) });
  assert.equal(r.code, 0);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.status, 200);
  assert.deepEqual(JSON.parse(parsed.body.echoed), evil);
  assert.equal(l.seen[0].method, 'POST');
  assert.equal(l.seen[0].url, '/bosses/summon');
});

test('the summon script exits: 3 with no port, 4 when refused, 5 past its abort time', async (t) => {
  const b64 = Buffer.from('{}').toString('base64');
  assert.equal((await runSummonScript(['5000', b64])).code, NO_LISTENER_EXIT);
  const closed = await fakeListener(() => {});
  const closedPort = closed.port;
  await new Promise((r) => { closed.server.close(r); });
  assert.equal((await runSummonScript(['5000', b64], { BOARD_INTERNAL_PORT: String(closedPort) })).code, REFUSED_EXIT);
  const l = await fakeListener(() => { /* never answers */ });
  t.after(() => { l.server.closeAllConnections(); l.server.close(); });
  const started = Date.now();
  assert.equal((await runSummonScript(['200', b64], { BOARD_INTERNAL_PORT: String(l.port) })).code, UNKNOWN_EXIT);
  assert.ok(Date.now() - started < 4000, 'the argument set the abort, not a fixed 6 s');
});

test('a summon goes through the allow-listed script, with an abort shorter than its limit', async () => {
  const runner = summonRunner(() => ({ code: 0, stdout: JSON.stringify({ status: 200, body: { ok: true, message: 'ok' } }) }));
  const jobs = createJobs();
  liveRoutes({ live: createBoardLive({ runner }), jobs })['POST /bosses/summon'](SUMMON);
  await settled(jobs);
  const { name, args, opts } = runner.calls[0];
  assert.equal(name, 'remote.sh');
  assert.deepEqual(args.slice(0, 3), ['backend', 'node', '-e']);
  assert.equal(args[4], String(SUMMON_ABORT_MS));
  assert.ok(SUMMON_ABORT_MS < SUMMON_TIMEOUT_MS);
  assert.equal(opts.timeoutMs, SUMMON_TIMEOUT_MS);
  assert.deepEqual(JSON.parse(Buffer.from(args[5], 'base64').toString()), SUMMON);
});

for (const [label, r, text] of [
  ['the runner timing out', { code: null, stdout: '', timedOut: true }, OUTCOME_UNKNOWN_TEXT],
  ['its own abort or a broken reply', { code: UNKNOWN_EXIT, stdout: '' }, OUTCOME_UNKNOWN_TEXT],
  ['ssh dropping mid-way', { code: 255, stdout: '' }, OUTCOME_UNKNOWN_TEXT],
  ['an unreadable answer', { code: 0, stdout: 'junk' }, OUTCOME_UNKNOWN_TEXT],
  ['a refused connection', { code: REFUSED_EXIT, stdout: '' }, SUMMON_UNREACHABLE_TEXT],
  ['the container not running', { code: 1, stdout: '' }, SUMMON_UNREACHABLE_TEXT],
  ['an older image', { code: NO_LISTENER_EXIT, stdout: '' }, NO_LISTENER_TEXT],
]) {
  test(`a summon with ${label} says what is known`, async () => {
    const jobs = createJobs();
    liveRoutes({ live: createBoardLive({ runner: summonRunner(() => r) }), jobs })['POST /bosses/summon'](SUMMON);
    const job = await settled(jobs);
    assert.equal(job.state, 'failed');
    assert.equal(job.error, text);
  });
}

test('parseSummonRequest: exactly the four fields', () => {
  assert.deepEqual(parseSummonRequest({ owner: 'world', name: 'a', world: 'b', replaces: 'c' }), { owner: 'world', name: 'a', world: 'b', replaces: 'c' });
  assert.equal(parseSummonRequest(SUMMON).replaces, null);
  for (const bad of [null, [], 'x', {}, { owner: 'world', name: 'a' }, { owner: 'world', name: 'a', world: 'b' }, { owner: 'x', name: 'a', world: 'b', replaces: null }, { owner: 'world', name: 'a', world: 'b', replaces: null, z: 1 },
    { owner: 'world', name: 1, world: 'b', replaces: null }, { owner: 'world', name: 'a', world: '', replaces: null }, { owner: 'world', name: 'a'.repeat(121), world: 'b', replaces: null }, { owner: 'world', name: 'a', world: 'b', replaces: 5 }]) {
    assert.throws(() => parseSummonRequest(bad), BadRequest, JSON.stringify(bad));
  }
});

test('a summon is a job: its refusal fails it with the reason, and it goes to the history', async () => {
  const done = [];
  const jobs = createJobs({ onDone: (j) => done.push(j) });
  const refusal = { code: 0, stdout: JSON.stringify({ status: 409, body: { ok: false, error: 'not_loaded', message: 'Dungeon One is not loaded.' } }) };
  const routes = liveRoutes({ live: createBoardLive({ runner: summonRunner(() => refusal) }), jobs });
  const started = routes['POST /bosses/summon']({ owner: 'dungeon', name: 'B', world: 'Dungeon One', replaces: null });
  assert.equal(started.kind, 'summon');
  const job = await settled(jobs);
  assert.equal(job.state, 'failed');
  assert.equal(job.error, 'Dungeon One is not loaded.');
  assert.equal(done[0].kind, 'summon');
});

test('a summon that works names what happened; an older image says to press Update', async () => {
  const jobs = createJobs();
  const ok = { code: 0, stdout: JSON.stringify({ status: 200, body: { ok: true, message: 'B summoned in W.' } }) };
  let routes = liveRoutes({ live: createBoardLive({ runner: summonRunner(() => ok) }), jobs });
  routes['POST /bosses/summon']({ owner: 'world', name: 'B', world: 'W', replaces: null });
  let job = await settled(jobs);
  assert.equal(job.state, 'ok');
  assert.equal(job.steps[0].detail, 'B summoned in W.');
  routes = liveRoutes({ live: createBoardLive({ runner: summonRunner(() => ({ code: 3, stdout: '' })) }), jobs });
  routes['POST /bosses/summon']({ owner: 'world', name: 'B', world: 'W', replaces: null });
  job = await settled(jobs);
  assert.equal(job.state, 'failed');
  assert.equal(job.error, NO_LISTENER_TEXT);
});

test('busy rules apply to a summon, and a bad body starts nothing', async () => {
  const jobs = createJobs();
  let release;
  jobs.start('update', [{ name: 'slow', run: () => new Promise((r) => { release = r; }) }]);
  const routes = liveRoutes({ live: createBoardLive({ runner: summonRunner(() => ({ code: 0, stdout: '' })) }), jobs });
  assert.throws(() => routes['POST /bosses/summon']({ owner: 'world', name: 'B', world: 'W', replaces: null }), BusyError);
  assert.throws(() => routes['POST /bosses/summon']({ owner: 'world' }), BadRequest);
  await new Promise((r) => { setImmediate(r); });
  release();
  await settled(jobs);
  assert.equal(jobs.current().kind, 'update');
});

// Two snapshots' worth of the board through the real sampler.
const snapshotWith = (game) => {
  const base = fs.readFileSync(path.join(__dirname, 'fixtures/board-snapshot.txt'), 'utf8').split('=== game')[0];
  return game === undefined ? base : `${base}=== game\n${game === null ? '' : JSON.stringify(game)}\n`;
};
function samplerRig(games) {
  let t = 1_000_000;
  const store = createMetricsStore({ now: () => t });
  const runner = { env: () => ({}), ssh: async () => ({ code: 0, stdout: snapshotWith(games.shift()), timedOut: false }) };
  const s = createSampler({ runner, ping: async () => 1, fetchLatency: async () => 1, store, now: () => t });
  return { s, store, advance: (ms) => { t += ms; } };
}

test('the sampler reads one ssh: no script, no extra process per sample', async () => {
  let scripts = 0;
  const calls = [];
  const runner = {
    env: () => ({}), script: async () => { scripts += 1; return { code: 0, stdout: '' }; },
    ssh: async (cmd) => { calls.push(cmd); return { code: 0, stdout: snapshotWith({ online: 1, mobKills: 0, pvpKills: 0 }), timedOut: false }; },
  };
  const s = createSampler({ runner, ping: async () => 1, fetchLatency: async () => 1 });
  await s.tick();
  assert.equal(scripts, 0);
  assert.equal(calls.length, 1);
  assert.equal(s.latest().players, 1);
});

test('the sampler turns counters into rates per minute', async () => {
  const { s, store, advance } = samplerRig([
    { online: 2, mobKills: 10, pvpKills: 1 }, { online: 3, mobKills: 16, pvpKills: 2 }, { online: 3, mobKills: 16, pvpKills: 2 },
  ]);
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
  const { s, store, advance } = samplerRig([{ online: 1, mobKills: 50, pvpKills: 5 }, { online: 1, mobKills: 2, pvpKills: 0 }, { online: 1, mobKills: 5, pvpKills: 0 }]);
  await s.tick();
  advance(15_000);
  await s.tick();
  assert.equal(store.latest().mobKillsPerMin, null);
  advance(15_000);
  await s.tick();
  assert.equal(store.latest().mobKillsPerMin, 12);
});

for (const [label, game] of [['no section', undefined], ['an empty section', null], ['junk', { online: 'x' }]]) {
  test(`a snapshot with ${label}: the three fields are null, the board is online`, async () => {
    const { s, store } = samplerRig([game]);
    await s.tick();
    const cur = store.latest();
    assert.equal(cur.online, true);
    assert.ok(cur.memTotalMb > 0);
    assert.equal(cur.players, null);
    assert.equal(cur.mobKillsPerMin, null);
    assert.equal(cur.pvpKillsPerMin, null);
  });
}

test('a gap in the counters breaks the rate rather than averaging across it', async () => {
  const { s, store, advance } = samplerRig([{ online: 1, mobKills: 1, pvpKills: 0 }, null, { online: 1, mobKills: 9, pvpKills: 0 }]);
  await s.tick();
  advance(15_000);
  await s.tick();
  advance(15_000);
  await s.tick();
  assert.equal(store.latest().players, 1);
  assert.equal(store.latest().mobKillsPerMin, null);
});

test('an offline sample has the three fields null', async () => {
  const runner = { env: () => ({}), ssh: async () => ({ code: 255, stdout: '', timedOut: false }) };
  const s = createSampler({ runner, ping: async () => null, fetchLatency: async () => null, now: () => 1 });
  await s.tick();
  assert.equal(s.latest().online, false);
  assert.equal(s.latest().players, null);
});

test('the store keeps the three fields, raw and averaged over a long range', () => {
  // Both samples fall in one 180 s bucket of the 24 h range.
  let t = 180_000 * 2000;
  const store = createMetricsStore({ now: () => t });
  const base = { ...nextSample(null, { memUsedMb: 1, memTotalMb: 2, diskPct: 3, connections: 4, cpu: null, net: {} }, t), players: 4, mobKillsPerMin: 6, pvpKillsPerMin: 1 };
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
