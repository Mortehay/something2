'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createMetricsStore, bucketFor, RETENTION_MS } = require('./metricsStore');
const { createSampler } = require('./sampler');

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const tmp = (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-metrics-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return path.join(d, 'pi-metrics.jsonl');
};
const sample = (t, over = {}) => ({
  t, online: true, cpuPct: 10, memUsedMb: 500, memTotalMb: 4000, diskPct: 20, connections: 3,
  net: { end0: { inBps: 100, outBps: 50 } }, pingMs: 4, cloudflareMs: null, ngrokMs: null, ...over,
});
const silent = { log: () => {} };

test('history survives a restart', (t) => {
  const file = tmp(t);
  const a = createMetricsStore({ file, now: () => NOW, ...silent });
  for (let i = 0; i < 5; i += 1) a.add(sample(NOW - (5 - i) * 15_000, { cpuPct: i }));
  const b = createMetricsStore({ file, now: () => NOW, ...silent });
  const got = b.query('15m').samples;
  assert.deepEqual(got.map((s) => s.cpuPct), [0, 1, 2, 3, 4]);
  assert.equal(b.latest().cpuPct, 4);
  // and the restarted store keeps appending to the same file
  b.add(sample(NOW, { cpuPct: 9 }));
  assert.equal(createMetricsStore({ file, now: () => NOW, ...silent }).query('15m').samples.length, 6);
});

test('a corrupt line is skipped, and a truncated last line does not swallow the next sample', (t) => {
  const file = tmp(t);
  const good = (i) => JSON.stringify(sample(NOW - i * 15_000, { cpuPct: i }));
  fs.writeFileSync(file, `${good(4)}\nnot json at all\n{"t":"x"}\n${good(3)}\n{"t":${NOW - 15_000},"cpu`);
  const s = createMetricsStore({ file, now: () => NOW, ...silent });
  assert.deepEqual(s.query('15m').samples.map((x) => x.cpuPct), [4, 3]);
  s.add(sample(NOW, { cpuPct: 7 }));
  const again = createMetricsStore({ file, now: () => NOW, ...silent });
  assert.deepEqual(again.query('15m').samples.map((x) => x.cpuPct), [4, 3, 7]);
  assert.ok(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).every((l) => JSON.parse(l)));
});

test('old samples are dropped after 30 days', (t) => {
  const file = tmp(t);
  let now = NOW;
  const s = createMetricsStore({ file, now: () => now, ...silent });
  s.add(sample(now, { cpuPct: 1 }));
  now += 29 * DAY;
  s.add(sample(now, { cpuPct: 2 }));
  assert.equal(s.size(), 2);
  now += 2 * DAY; // the first is now 31 days old; the hourly compaction runs on the next add
  s.add(sample(now, { cpuPct: 3 }));
  assert.equal(s.size(), 2);
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((x) => x.cpuPct), [2, 3]);
  assert.ok(lines.every((x) => x.t >= now - RETENTION_MS));
  // a start also drops them
  fs.appendFileSync(file, `${JSON.stringify(sample(now - 40 * DAY, { cpuPct: 99 }))}\n`);
  const re = createMetricsStore({ file, now: () => now, ...silent });
  assert.equal(re.size(), 2);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('"cpuPct":99'));
});

test('compaction is at most hourly', (t) => {
  const file = tmp(t);
  let now = NOW;
  const s = createMetricsStore({ file, now: () => now, ...silent });
  s.add(sample(now));
  fs.appendFileSync(file, 'garbage\n');
  now += 30 * 60_000;
  s.add(sample(now));
  assert.ok(fs.readFileSync(file, 'utf8').includes('garbage'));
  now += 31 * 60_000;
  s.add(sample(now));
  assert.ok(!fs.readFileSync(file, 'utf8').includes('garbage'));
});

test('a write error is logged once and sampling carries on', (t) => {
  const dir = path.dirname(tmp(t));
  const file = path.join(dir, 'a-directory'); // appending to a directory fails
  fs.mkdirSync(file);
  const logs = [];
  const s = createMetricsStore({ file, now: () => NOW, log: (m) => logs.push(m) });
  s.add(sample(NOW - 15_000, { cpuPct: 1 }));
  s.add(sample(NOW, { cpuPct: 2 }));
  assert.equal(logs.length, 1);
  assert.deepEqual(s.query('15m').samples.map((x) => x.cpuPct), [1, 2]);
});

test('range buckets: raw up to 1 h, about 500 points beyond', () => {
  assert.equal(bucketFor(15 * 60_000), 15_000);
  assert.equal(bucketFor(3_600_000), 15_000);
  for (const [range, ms] of [['6h', 6 * 3_600_000], ['24h', DAY], ['7d', 7 * DAY], ['30d', 30 * DAY]]) {
    const b = bucketFor(ms);
    assert.ok(ms / b <= 500 && ms / b > 250, `${range} ${ms / b}`);
  }
});

test('downsampling averages, keeps gaps as null and never turns one into zero', (t) => {
  const s = createMetricsStore({ file: null, now: () => NOW });
  const b = bucketFor(6 * 3_600_000); // 45 s
  const start = Math.floor((NOW - 2 * 3_600_000) / b) * b;
  // bucket 0: cpu 10 and 30 (avg 20), ping only on one sample; bucket 1: cpu never read; bucket 2: no samples at all; bucket 3: offline; bucket 4: cpu 50
  s.add(sample(start + 1000, { cpuPct: 10, pingMs: 8 }));
  s.add(sample(start + 16_000, { cpuPct: 30, pingMs: null }));
  s.add(sample(start + b + 1000, { cpuPct: null, pingMs: null }));
  s.add({ t: start + 3 * b + 1000, online: false, cpuPct: null, memUsedMb: null, memTotalMb: null, diskPct: null, connections: null, net: {}, pingMs: null, cloudflareMs: null, ngrokMs: null });
  s.add(sample(start + 4 * b + 1000, { cpuPct: 50, net: { end0: { inBps: null, outBps: 10 } } }));
  const r = s.query('6h');
  assert.equal(r.bucketMs, b);
  const got = r.samples;
  assert.equal(got.length, 5);
  assert.equal(got[0].cpuPct, 20);
  assert.equal(got[0].pingMs, 8);
  assert.equal(got[0].net.end0.inBps, 100);
  assert.equal(got[1].cpuPct, null);
  assert.equal(got[1].pingMs, null);
  assert.equal(got[1].diskPct, 20);
  assert.equal(got[2].online, null);
  assert.equal(got[2].cpuPct, null);
  assert.equal(got[2].memUsedMb, null);
  assert.deepEqual(got[2].net, {});
  assert.equal(got[3].online, false);
  assert.equal(got[3].cpuPct, null);
  assert.equal(got[4].cpuPct, 50);
  assert.equal(got[4].net.end0.inBps, null); // a missing rate stays null, not 0
  assert.equal(got[4].net.end0.outBps, 10);
  for (const x of got) for (const v of [x.cpuPct, x.pingMs, x.memUsedMb]) assert.ok(v === null || v > 0);
});

test('long ranges fold older samples into the coarse tier without losing the averages', (t) => {
  let now = NOW;
  const s = createMetricsStore({ file: null, now: () => now });
  // 3 days of samples, cpu constant 40 for the first day then 60
  for (let i = 0; i < 3 * 5760; i += 1) { now = NOW + i * 15_000; s.add(sample(now, { cpuPct: i < 5760 ? 40 : 60 })); }
  const r = s.query('7d');
  assert.ok(r.samples.length <= 520);
  assert.equal(r.samples[0].cpuPct, 40);
  assert.equal(r.samples[r.samples.length - 1].cpuPct, 60);
  assert.equal(s.size(), 3 * 5760);
  assert.ok(s.query('24h').samples.every((x) => x.cpuPct === 60 || x.cpuPct === null || x.cpuPct > 59));
});

test('GET /metrics for 30d over a generated 170k line file answers fast', async (t) => {
  const file = tmp(t);
  const lines = [];
  const T0 = Date.now() - 30 * DAY;
  for (let i = 0; i < 172_800; i += 1) lines.push(JSON.stringify(sample(T0 + i * 15_000, { cpuPct: i % 100 })));
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  const t0 = process.hrtime.bigint();
  const sampler = createSampler({ file, runner: { env: () => ({}), ssh: async () => null } });
  const loadMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const { metricsRoute, createServer } = require('./server');
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-srv-'));
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));
  const live = await createServer({ root: runDir, runDir, routes: { 'GET /metrics': metricsRoute(sampler) } }).start();
  t.after(() => live.close());
  const token = fs.readFileSync(path.join(runDir, 'pi-helper.token'), 'utf8').trim();
  const get = () => new Promise((resolve, reject) => {
    const req = http.request({ socketPath: path.join(runDir, 'pi-helper.sock'), path: '/metrics?range=30d', headers: { 'X-Pi-Helper-Token': token } }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve(JSON.parse(b)));
    });
    req.on('error', reject); req.end();
  });
  await get();
  const q0 = process.hrtime.bigint();
  const body = await get();
  const reqMs = Number(process.hrtime.bigint() - q0) / 1e6;
  console.log(`30d: load ${loadMs.toFixed(0)} ms, response ${reqMs.toFixed(1)} ms, ${body.samples.length} points, bucket ${body.bucketMs} ms`);
  assert.ok(body.samples.length <= 520 && body.samples.length > 400);
  assert.equal(body.bucketMs, bucketFor(30 * DAY));
  assert.ok(reqMs < 500, `${reqMs} ms`);
});
