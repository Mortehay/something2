'use strict';
// Samples the board every intervalMs into a ring buffer for GET /metrics.
const childProcess = require('node:child_process');
const { parseSnapshot, nextSample } = require('./procParse');

const SNAPSHOT_COMMAND = 'echo "=== stat"; head -1 /proc/stat; echo "=== meminfo"; grep -E "^(MemTotal|MemAvailable):" /proc/meminfo; '
  + 'echo "=== netdev"; cat /proc/net/dev; echo "=== df"; df -P /; echo "=== conns"; ss -Htn state established 2>/dev/null | wc -l; '
  + 'echo "=== conntrack"; cat /proc/sys/net/netfilter/nf_conntrack_count 2>/dev/null';

const SNAPSHOT_TIMEOUT_MS = 10_000;
const LATENCY_TIMEOUT_MS = 5000;
const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_CAPACITY = 1440; // 6 h at 15 s
const RANGES = { '15m': 15 * 60_000, '1h': 60 * 60_000, '6h': 6 * 60 * 60_000 };

function parsePingMs(text) {
  const m = /time[=<]([\d.]+)\s*ms/.exec(String(text ?? ''));
  return m ? Number(m[1]) : null;
}

function defaultPing(host) {
  return new Promise((resolve) => {
    if (!host) return resolve(null);
    childProcess.execFile('ping', ['-c1', '-W2', host], { timeout: 4000 }, (err, stdout) => resolve(err ? null : parsePingMs(stdout)));
  });
}

async function defaultFetchLatency(url) {
  const t0 = process.hrtime.bigint();
  const res = await fetch(url, { headers: { 'ngrok-skip-browser-warning': '1' }, signal: AbortSignal.timeout(LATENCY_TIMEOUT_MS) });
  await res.arrayBuffer();
  if (!res.ok) return null;
  return Math.round(Number(process.hrtime.bigint() - t0) / 1e5) / 10;
}

const safe = async (fn) => { try { const v = await fn(); return Number.isFinite(v) ? v : null; } catch { return null; } };

function createSampler({
  runner, ping = defaultPing, fetchLatency = defaultFetchLatency, getTunnels = () => ({}),
  intervalMs = DEFAULT_INTERVAL_MS, capacity = DEFAULT_CAPACITY, now = Date.now,
  setInterval: setIv = setInterval, clearInterval: clearIv = clearInterval,
} = {}) {
  const ring = [];
  let prev = null; // { t, snapshot } of the last valid snapshot
  let running = false;
  let timer = null;

  const tunnelMs = (tunnel) => (tunnel && tunnel.verified && tunnel.url
    ? safe(() => fetchLatency(`${tunnel.url.replace(/\/+$/, '')}/api/health`)) : Promise.resolve(null));

  async function tick() {
    if (running) return; // a skipped tick stores nothing
    running = true;
    try {
      const host = runner.env().ORANGEPI_ADDRESS;
      const tunnels = getTunnels() || {};
      const [res, pingMs, cloudflareMs, ngrokMs] = await Promise.all([
        runner.ssh(SNAPSHOT_COMMAND, { timeoutMs: SNAPSHOT_TIMEOUT_MS, reuse: true }).catch(() => null),
        safe(() => ping(host)), tunnelMs(tunnels.cloudflare), tunnelMs(tunnels.ngrok),
      ]);
      const t = now();
      const snapshot = res && res.code === 0 && !res.timedOut ? parseSnapshot(res.stdout) : null;
      const sample = nextSample(prev, snapshot, t, { pingMs, cloudflareMs, ngrokMs });
      prev = snapshot ? { t, snapshot } : null;
      ring.push(sample);
      if (ring.length > capacity) ring.splice(0, ring.length - capacity);
    } finally {
      running = false;
    }
  }

  function samples(range) {
    if (!Object.hasOwn(RANGES, range)) return null;
    const cutoff = now() - RANGES[range];
    return ring.filter((s) => s.t >= cutoff);
  }

  function start() {
    if (timer !== null) return;
    timer = setIv(() => { tick().catch(() => {}); }, intervalMs);
    if (timer && timer.unref) timer.unref();
    tick().catch(() => {});
  }

  function stop() {
    if (timer === null) return;
    clearIv(timer);
    timer = null;
  }

  return { start, stop, tick, samples };
}

module.exports = { createSampler, SNAPSHOT_COMMAND, parsePingMs, RANGES };
