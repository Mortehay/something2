'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createSampler, SNAPSHOT_COMMAND, parsePingMs } = require('./sampler');

const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/board-snapshot.txt'), 'utf8');
const ok = (stdout) => ({ code: 0, output: stdout, stdout, stderr: '', timedOut: false });
const bad = { code: 255, output: 'down', stdout: '', stderr: 'down', timedOut: false };

function rig(over = {}) {
  let t = 1_000_000;
  const calls = [];
  const runner = {
    env: () => ({ ORANGEPI_ADDRESS: '203.0.113.9' }),
    ssh: async (cmd, opts) => { calls.push({ cmd, opts }); return over.ssh ? over.ssh(cmd, opts) : ok(fixture); },
  };
  const s = createSampler({
    runner,
    ping: async () => 4.5,
    fetchLatency: async () => 80,
    getTunnels: () => ({}),
    now: () => t,
    ...over.opts,
  });
  return { s, calls, advance: (ms) => { t += ms; } };
}

test('the snapshot command is the fixed one, with a 10 s limit and a reused connection', async () => {
  const { s, calls } = rig();
  await s.tick();
  assert.equal(calls[0].cmd, SNAPSHOT_COMMAND);
  assert.match(SNAPSHOT_COMMAND, /^echo "=== stat"; head -1 \/proc\/stat;/);
  assert.equal(calls[0].opts.timeoutMs, 10_000);
  assert.equal(calls[0].opts.reuse, true);
});

test('a good tick stores an online sample with ping', async () => {
  const { s } = rig();
  await s.tick();
  const [x] = s.samples('15m');
  assert.equal(x.online, true);
  assert.equal(x.pingMs, 4.5);
  assert.equal(x.memTotalMb, 3921);
  assert.equal(x.cpuPct, null);
});

test('a failed snapshot stores online false, and the next good sample has null rates', async () => {
  let mode = 'ok';
  const { s, advance } = rig({ ssh: () => (mode === 'ok' ? ok(fixture) : bad) });
  await s.tick(); advance(15_000);
  await s.tick(); advance(15_000);
  mode = 'bad';
  await s.tick(); advance(15_000);
  mode = 'ok';
  await s.tick();
  const all = s.samples('15m');
  assert.deepEqual(all.map((x) => x.online), [true, true, false, true]);
  assert.deepEqual(all[1].net.end0, { inBps: 0, outBps: 0 });
  assert.equal(all[2].memTotalMb, null);
  assert.deepEqual(all[3].net.end0, { inBps: null, outBps: null });
  assert.equal(all[3].cpuPct, null);
});

test('a timed out snapshot is a failed sample', async () => {
  const { s } = rig({ ssh: async () => ({ code: null, output: '', stdout: fixture, stderr: '', timedOut: true }) });
  await s.tick();
  assert.equal(s.samples('15m')[0].online, false);
});

test('the ring keeps 1440 samples', async () => {
  const { s, advance } = rig({ opts: { capacity: undefined } });
  for (let i = 0; i < 1445; i += 1) { await s.tick(); advance(1000); }
  const all = s.samples('6h');
  assert.equal(all.length, 1440);
  assert.equal(all[0].t, 1_000_000 + 5 * 1000);
});

test('samples(range) returns only the last 15 minutes / 1 h / 6 h, and null for others', async () => {
  const { s, advance } = rig();
  for (let i = 0; i < 100; i += 1) { await s.tick(); advance(15_000); }
  // window is measured from now (the clock sits one interval past the last sample)
  assert.equal(s.samples('15m').length, 60);
  assert.equal(s.samples('1h').length, 100);
  assert.equal(s.samples('6h').length, 100);
  assert.equal(s.samples('2h'), null);
  assert.equal(s.samples(undefined), null);
});

test('a hung snapshot does not stack and a skipped tick stores nothing', async () => {
  let release;
  let started = 0;
  const { s } = rig({ ssh: () => { started += 1; return new Promise((r) => { release = () => r(ok(fixture)); }); } });
  const first = s.tick();
  await s.tick();
  await s.tick();
  assert.equal(started, 1);
  assert.equal(s.samples('15m').length, 0);
  release();
  await first;
  assert.equal(s.samples('15m').length, 1);
  const again = s.tick();
  assert.equal(started, 2);
  release();
  await again;
});

test('tunnel latency is measured only for verified tunnels, null on failure', async () => {
  const urls = [];
  const { s } = rig({
    opts: {
      getTunnels: () => ({
        cloudflare: { state: 'on', verified: true, url: 'https://a.example' },
        ngrok: { state: 'on', verified: false, url: null },
      }),
      fetchLatency: async (url) => { urls.push(url); return 120; },
    },
  });
  await s.tick();
  const [x] = s.samples('15m');
  assert.equal(x.cloudflareMs, 120);
  assert.equal(x.ngrokMs, null);
  assert.deepEqual(urls, ['https://a.example/api/health']);

  const { s: s2 } = rig({
    opts: { getTunnels: () => ({ ngrok: { verified: true, url: 'https://n.example' } }), fetchLatency: async () => { throw new Error('x'); } },
  });
  await s2.tick();
  assert.equal(s2.samples('15m')[0].ngrokMs, null);
});

test('a throwing ping gives null, not a failed sample', async () => {
  const { s } = rig({ opts: { ping: async () => { throw new Error('no ping'); } } });
  await s.tick();
  const [x] = s.samples('15m');
  assert.equal(x.online, true);
  assert.equal(x.pingMs, null);
});

test('start schedules ticks, stop clears the timer', async () => {
  const timers = [];
  const cleared = [];
  const { s } = rig({ opts: { intervalMs: 15_000, setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearInterval: (id) => cleared.push(id) } });
  s.start();
  s.start();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 15_000);
  s.stop();
  assert.deepEqual(cleared, [1]);
});

test('parsePingMs reads time= and returns null otherwise', () => {
  assert.equal(parsePingMs('64 bytes from 1.2.3.4: icmp_seq=1 ttl=64 time=3.42 ms'), 3.42);
  assert.equal(parsePingMs('Request timeout'), null);
  assert.equal(parsePingMs(''), null);
});

test('t is taken when the snapshot ssh resolves, not after slow tunnel fetches', async () => {
  let clock = 1_000_000;
  const { s } = rig({
    ssh: async () => { clock += 100; return ok(fixture); },
    opts: {
      now: () => clock,
      getTunnels: () => ({ cloudflare: { verified: true, url: 'https://a.example' } }),
      fetchLatency: async () => { await new Promise((r) => setTimeout(r, 50)); clock += 4000; return 80; },
    },
  });
  await s.tick();
  assert.equal(s.samples('15m')[0].t, 1_000_100);
});

test('a sample at the same time as the previous one gives null rates, not Infinity', async () => {
  const { s } = rig();
  await s.tick();
  await s.tick(); // clock never moved: dt = 0
  const second = s.samples('15m')[1];
  assert.equal(second.cpuPct, null);
  assert.deepEqual(second.net.end0, { inBps: null, outBps: null });
});
