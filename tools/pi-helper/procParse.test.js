'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseSnapshot, nextSample } = require('./procParse');

const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/board-snapshot.txt'), 'utf8');

test('parseSnapshot reads a real capture', () => {
  const s = parseSnapshot(fixture);
  assert.deepEqual(s.cpu, { busy: 48819, total: 2321806 });
  assert.equal(s.memTotalMb, 3921);
  assert.equal(s.memUsedMb, 442);
  assert.equal(s.diskPct, 7);
  assert.equal(s.connections, 16); // conntrack beats ss's 1
  assert.deepEqual(s.net.end0, { rx: 1592892, tx: 970777 });
  assert.deepEqual(s.net.wlan0, { rx: 0, tx: 0 });
});

test('connections fall back to ss when conntrack is empty', () => {
  const s = parseSnapshot(fixture.replace(/=== conntrack\n16\n/, '=== conntrack\n'));
  assert.equal(s.connections, 1);
});

test('net excludes lo, docker*, veth* and br-*', () => {
  assert.deepEqual(Object.keys(parseSnapshot(fixture).net).sort(), ['end0', 'wlan0']);
});

test('net handles a counter with no space after the colon', () => {
  const s = parseSnapshot('=== netdev\neth0:12345 1 0 0 0 0 0 0 678 1 0 0 0 0 0 0\n');
  assert.deepEqual(s.net.eth0, { rx: 12345, tx: 678 });
});

test('empty or garbled parts give null, never NaN or a throw', () => {
  for (const text of ['', 'garbage', '=== stat\ncpu  a b c\n=== meminfo\n=== df\n=== conns\nx\n=== conntrack\n']) {
    const s = parseSnapshot(text);
    assert.equal(s.cpu, null);
    assert.equal(s.memUsedMb, null);
    assert.equal(s.memTotalMb, null);
    assert.equal(s.diskPct, null);
    assert.equal(s.connections, null);
    assert.deepEqual(s.net, {});
  }
});

const snap = (busy, total, rx, tx) => ({ cpu: { busy, total }, memUsedMb: 100, memTotalMb: 200, diskPct: 5, connections: 3, net: { end0: { rx, tx } } });

test('nextSample computes rates', () => {
  const prev = { t: 1_000_000, snapshot: snap(100, 1000, 5_000_000, 100) };
  const s = nextSample(prev, snap(150, 1200, 6_500_000, 1600), 1_015_000, { pingMs: 4 });
  assert.equal(s.net.end0.inBps, 100000);
  assert.equal(s.net.end0.outBps, 100);
  assert.equal(s.cpuPct, 25); // 50 busy of 200 total
  assert.equal(s.online, true);
  assert.equal(s.pingMs, 4);
  assert.equal(s.cloudflareMs, null);
  assert.equal(s.memUsedMb, 100);
});

test('the first sample has null rates and CPU', () => {
  const s = nextSample(null, snap(150, 1200, 6_500_000, 1600), 1_015_000);
  assert.equal(s.cpuPct, null);
  assert.deepEqual(s.net.end0, { inBps: null, outBps: null });
  assert.equal(s.online, true);
});

test('a counter that went backwards gives null, not a negative', () => {
  const prev = { t: 0, snapshot: snap(500, 5000, 9_000_000, 9_000_000) };
  const s = nextSample(prev, snap(10, 100, 10, 10), 15_000);
  assert.equal(s.cpuPct, null);
  assert.deepEqual(s.net.end0, { inBps: null, outBps: null });
});

test('a failed snapshot is online false with null metrics', () => {
  const s = nextSample({ t: 0, snapshot: snap(1, 2, 3, 4) }, null, 15_000);
  assert.equal(s.online, false);
  assert.equal(s.t, 15_000);
  for (const k of ['cpuPct', 'memUsedMb', 'memTotalMb', 'diskPct', 'connections', 'pingMs', 'cloudflareMs', 'ngrokMs']) assert.equal(s[k], null, k);
  assert.deepEqual(s.net, {});
});

test('dt <= 0 gives null rates', () => {
  const prev = { t: 5000, snapshot: snap(100, 1000, 10, 10) };
  for (const now of [5000, 4000]) {
    const s = nextSample(prev, snap(200, 2000, 99, 99), now);
    assert.equal(s.cpuPct, null);
    assert.deepEqual(s.net.end0, { inBps: null, outBps: null });
  }
});
