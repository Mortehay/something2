'use strict';
// Samples the board every intervalMs into a ring buffer for GET /metrics.
const childProcess = require('node:child_process');
const { parseSnapshot, nextSample } = require('./procParse');
const { createMetricsStore, RANGES } = require('./metricsStore');

const SNAPSHOT_COMMAND = 'echo "=== stat"; head -1 /proc/stat; echo "=== meminfo"; grep -E "^(MemTotal|MemAvailable):" /proc/meminfo; '
  + 'echo "=== netdev"; cat /proc/net/dev; echo "=== df"; df -P /; echo "=== conns"; ss -Htn state established 2>/dev/null | wc -l; '
  + 'echo "=== conntrack"; cat /proc/sys/net/netfilter/nf_conntrack_count 2>/dev/null';

const SNAPSHOT_TIMEOUT_MS = 10_000;
const LATENCY_TIMEOUT_MS = 5000;
const DEFAULT_INTERVAL_MS = 15_000;
// A public tunnel URL is fetched at most this often per tunnel; ngrok's free plan may cap monthly requests.
const TUNNEL_PROBE_MS = 60_000;

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
  intervalMs = DEFAULT_INTERVAL_MS, file = null, store = null, now = Date.now, readCounters = null,
  setInterval: setIv = setInterval, clearInterval: clearIv = clearInterval,
} = {}) {
  // file: where the history is persisted (null = memory only). Loaded here, so it survives a restart.
  const history = store || createMetricsStore({ file, now });
  let prev = null; // { t, snapshot } of the last valid snapshot
  let running = false;
  let timer = null;

  // Between probes a tunnel's latency is null in the sample; the chart carries the last reading for 60 s.
  const lastProbe = {};
  const tunnelMs = (name, tunnel) => {
    if (!(tunnel && tunnel.verified && tunnel.url)) return Promise.resolve(null);
    const t = now();
    if (lastProbe[name] !== undefined && t - lastProbe[name] < TUNNEL_PROBE_MS) return Promise.resolve(null);
    lastProbe[name] = t;
    return safe(() => fetchLatency(`${tunnel.url.replace(/\/+$/, '')}/api/health`));
  };

  // The game's counters -> { players, mobKillsPerMin, pvpKillsPerMin }, all null when they could not be
  // read (an older image has no listener). A rate needs two readings in a row; totals that went down
  // mean the backend restarted, and that interval has no rate either.
  let prevCounters = null; // { t, mobKills, pvpKills }
  async function gameFields() {
    const blank = { players: null, mobKillsPerMin: null, pvpKillsPerMin: null };
    if (!readCounters) return blank;
    let c = null;
    try { c = await readCounters(); } catch { /* no reading */ }
    if (!c) { prevCounters = null; return blank; }
    const t = now();
    const rate = (cur, old) => {
      const mins = prevCounters ? (t - prevCounters.t) / 60_000 : 0;
      return mins > 0 && cur >= old ? Math.round(((cur - old) / mins) * 10) / 10 : null;
    };
    const out = {
      players: c.online,
      mobKillsPerMin: rate(c.mobKills, prevCounters && prevCounters.mobKills),
      pvpKillsPerMin: rate(c.pvpKills, prevCounters && prevCounters.pvpKills),
    };
    prevCounters = { t, mobKills: c.mobKills, pvpKills: c.pvpKills };
    return out;
  }

  async function tick() {
    if (running) return; // a skipped tick stores nothing
    running = true;
    try {
      let sshDoneAt = null;
      const host = runner.env().ORANGEPI_ADDRESS;
      const tunnels = getTunnels() || {};
      const [res, pingMs, cloudflareMs, ngrokMs] = await Promise.all([
        // t is taken the moment ssh answers: rates divide by this interval, not by ping/fetch time.
        runner.ssh(SNAPSHOT_COMMAND, { timeoutMs: SNAPSHOT_TIMEOUT_MS, reuse: true }).catch(() => null)
          .then((r) => { sshDoneAt = now(); return r; }),
        safe(() => ping(host)), tunnelMs('cloudflare', tunnels.cloudflare), tunnelMs('ngrok', tunnels.ngrok),
      ]);
      const t = sshDoneAt ?? now();
      const snapshot = res && res.code === 0 && !res.timedOut ? parseSnapshot(res.stdout) : null;
      // Only once the board has answered: an offline board would hold each tick until the script times out.
      const game = snapshot ? await gameFields() : (prevCounters = null, {});
      const sample = nextSample(prev, snapshot, t, { pingMs, cloudflareMs, ngrokMs, ...game });
      prev = snapshot ? { t, snapshot } : null;
      history.add(sample);
    } finally {
      running = false;
    }
  }

  // -> { bucketMs, samples } | null for an unknown range. Long ranges are averaged per bucket.
  const query = (range) => history.query(range);
  const samples = (range) => { const r = history.query(range); return r ? r.samples : null; };

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

  return { start, stop, tick, samples, query, latest: history.latest };
}

module.exports = { TUNNEL_PROBE_MS, createSampler, SNAPSHOT_COMMAND, parsePingMs, RANGES };
