'use strict';
// The sampler's history: every sample is appended to a jsonl file and loaded again on start, kept
// 30 days. In memory it is two tiers, so a 30 day range is cheap to answer: the last 25 h of raw
// samples, and everything older folded into 5 minute buckets of sums and counts. A query averages
// whichever it needs into at most about 500 buckets.
const fs = require('node:fs');
const path = require('node:path');

const SAMPLE_INTERVAL_MS = 15_000;
const HOUR = 3_600_000;
const RETENTION_MS = 30 * 24 * HOUR;
const COMPACT_EVERY_MS = HOUR;
const RAW_KEEP_MS = 25 * HOUR; // covers the 24 h range from raw samples
const COARSE_MS = 300_000;
const TARGET_POINTS = 500;
const FIELDS = ['cpuPct', 'memUsedMb', 'memTotalMb', 'diskPct', 'connections', 'pingMs', 'cloudflareMs', 'ngrokMs'];

const RANGES = {
  '15m': 15 * 60_000, '1h': HOUR, '6h': 6 * HOUR, '24h': 24 * HOUR, '7d': 7 * 24 * HOUR, '30d': RETENTION_MS,
};

// The bucket a range is answered in: raw samples up to 1 h, then range / 500 rounded UP to a multiple
// of the sample interval (below 24 h) or of the 5 minute tier (above), so the tiers line up.
function bucketFor(rangeMs) {
  const want = rangeMs / TARGET_POINTS;
  if (want <= SAMPLE_INTERVAL_MS) return SAMPLE_INTERVAL_MS;
  const unit = rangeMs > 24 * HOUR - 1 ? COARSE_MS : SAMPLE_INTERVAL_MS;
  return Math.ceil(want / unit) * unit;
}

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const newAcc = () => ({ n: 0, online: false, sum: {}, cnt: {}, net: {} });

function addSample(acc, s) {
  acc.n += 1;
  if (s.online !== false) acc.online = true;
  for (const k of FIELDS) {
    if (finite(s[k])) { acc.sum[k] = (acc.sum[k] || 0) + s[k]; acc.cnt[k] = (acc.cnt[k] || 0) + 1; }
  }
  if (s.net && typeof s.net === 'object') {
    for (const [iface, v] of Object.entries(s.net)) {
      const slot = acc.net[iface] || (acc.net[iface] = { inBps: { s: 0, c: 0 }, outBps: { s: 0, c: 0 } });
      for (const d of ['inBps', 'outBps']) {
        if (v && finite(v[d])) { slot[d].s += v[d]; slot[d].c += 1; }
      }
    }
  }
}

function mergeAcc(into, from) {
  into.n += from.n;
  into.online = into.online || from.online;
  for (const k of Object.keys(from.sum)) {
    into.sum[k] = (into.sum[k] || 0) + from.sum[k];
    into.cnt[k] = (into.cnt[k] || 0) + from.cnt[k];
  }
  for (const [iface, v] of Object.entries(from.net)) {
    const slot = into.net[iface] || (into.net[iface] = { inBps: { s: 0, c: 0 }, outBps: { s: 0, c: 0 } });
    for (const d of ['inBps', 'outBps']) { slot[d].s += v[d].s; slot[d].c += v[d].c; }
  }
}

const avg = (sum, count) => (count > 0 ? Math.round((sum / count) * 100) / 100 : null);

// A bucket with no reading for a field is null, never 0.
function accToSample(acc, t) {
  const out = { t, online: acc.n === 0 ? null : acc.online };
  for (const k of FIELDS) out[k] = avg(acc.sum[k] || 0, acc.cnt[k] || 0);
  out.net = {};
  for (const [iface, v] of Object.entries(acc.net)) {
    out.net[iface] = { inBps: avg(v.inBps.s, v.inBps.c), outBps: avg(v.outBps.s, v.outBps.c) };
  }
  return out;
}

function createMetricsStore({ file = null, now = Date.now, log = (m) => console.error(m) } = {}) {
  let raw = [];
  let coarse = []; // [{ b, acc }] ascending
  let lastCompact = now();
  let warned = false;

  function foldOld(cutoff) {
    let i = 0;
    while (i < raw.length && raw[i].t < cutoff) {
      const b = Math.floor(raw[i].t / COARSE_MS) * COARSE_MS;
      let tail = coarse[coarse.length - 1];
      if (!tail || tail.b !== b) { tail = { b, acc: newAcc() }; coarse.push(tail); }
      addSample(tail.acc, raw[i]);
      i += 1;
    }
    if (i) raw = raw.slice(i);
    const drop = now() - RETENTION_MS;
    let j = 0;
    while (j < coarse.length && coarse[j].b + COARSE_MS <= drop) j += 1;
    if (j) coarse = coarse.slice(j);
  }

  function insert(s) {
    if (raw.length === 0 || s.t >= raw[raw.length - 1].t) raw.push(s);
    else { // out of order (only seen while loading a hand edited file): keep it sorted
      let k = raw.length;
      while (k > 0 && raw[k - 1].t > s.t) k -= 1;
      raw.splice(k, 0, s);
    }
  }

  const warn = (what, e) => {
    if (warned) return;
    warned = true;
    log(`pi-helper: ${what} (${file}): ${e && e.message ? e.message : e}. Sampling continues; history may not be saved.`);
  };

  // Rewrites the file with only what is inside the retention window, atomically. Reads the file, so it
  // also drops a corrupt line.
  function compact() {
    lastCompact = now();
    if (!file) return;
    try {
      const keep = readLines(file).samples.filter((s) => s.t >= now() - RETENTION_MS);
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, keep.map((s) => `${JSON.stringify(s)}\n`).join(''));
      fs.renameSync(tmp, file);
      warned = false;
    } catch (e) { warn('could not compact the metrics file', e); }
  }

  function load() {
    if (!file) return;
    let info;
    try { info = readLines(file); } catch (e) {
      if (e.code !== 'ENOENT') warn('could not read the metrics file', e);
      return;
    }
    const cutoff = now() - RETENTION_MS;
    info.samples.sort((a, b) => a.t - b.t);
    for (const s of info.samples) if (s.t >= cutoff) insert(s);
    foldOld(now() - RAW_KEEP_MS);
    // A truncated last line (no newline) would swallow the next append, so rewrite it clean.
    if (info.bad > 0 || info.samples.some((s) => s.t < cutoff) || !info.endsWithNewline) compact();
  }

  function add(sample) {
    insert(sample);
    foldOld(now() - RAW_KEEP_MS);
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify(sample)}\n`);
      warned = false;
    } catch (e) { warn('could not append to the metrics file', e); }
    if (now() - lastCompact >= COMPACT_EVERY_MS) compact();
  }

  // -> { bucketMs, samples } or null for an unknown range.
  function query(range) {
    if (!Object.hasOwn(RANGES, range)) return null;
    const span = RANGES[range];
    const cutoff = now() - span;
    const bucketMs = bucketFor(span);
    if (bucketMs === SAMPLE_INTERVAL_MS) return { bucketMs, samples: raw.filter((s) => s.t >= cutoff) };
    const buckets = new Map();
    const slot = (t) => {
      const k = Math.floor(t / bucketMs);
      let acc = buckets.get(k);
      if (!acc) { acc = newAcc(); buckets.set(k, acc); }
      return acc;
    };
    for (const c of coarse) if (c.b + COARSE_MS > cutoff) mergeAcc(slot(c.b), c.acc);
    for (const s of raw) if (s.t >= cutoff) addSample(slot(s.t), s);
    if (buckets.size === 0) return { bucketMs, samples: [] };
    const keys = [...buckets.keys()];
    const lo = Math.min(...keys);
    const hi = Math.max(...keys);
    const samples = [];
    for (let k = lo; k <= hi; k += 1) samples.push(accToSample(buckets.get(k) || newAcc(), k * bucketMs + Math.floor(bucketMs / 2)));
    return { bucketMs, samples };
  }

  const latest = () => (raw.length ? raw[raw.length - 1] : null);
  const size = () => raw.length + coarse.reduce((n, c) => n + c.acc.n, 0);

  load();
  return { add, query, latest, compact, size };
}

// Parses a jsonl file; a line that is not JSON or has no finite t is counted and skipped.
function readLines(file) {
  const text = fs.readFileSync(file, 'utf8');
  const samples = [];
  let bad = 0;
  for (const line of text.split('\n')) {
    if (line === '') continue;
    try {
      const s = JSON.parse(line);
      if (s && typeof s === 'object' && finite(s.t)) samples.push(s); else bad += 1;
    } catch { bad += 1; }
  }
  return { samples, bad, endsWithNewline: text === '' || text.endsWith('\n') };
}

module.exports = { createMetricsStore, bucketFor, RANGES, SAMPLE_INTERVAL_MS, RETENTION_MS };
