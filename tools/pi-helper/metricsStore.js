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
const FUTURE_SLACK_MS = 60_000; // a clock a little ahead is fine; days ahead is a bad sample
const FIELDS = ['cpuPct', 'memUsedMb', 'memTotalMb', 'diskPct', 'connections', 'pingMs', 'cloudflareMs', 'ngrokMs', 'players', 'mobKillsPerMin', 'pvpKillsPerMin'];

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
  // An offline sample's board readings are stale: only a ping that was really measured counts.
  const keys = s.online === false ? ['pingMs'] : FIELDS;
  for (const k of keys) {
    if (finite(s[k])) { acc.sum[k] = (acc.sum[k] || 0) + s[k]; acc.cnt[k] = (acc.cnt[k] || 0) + 1; }
  }
  if (s.online !== false && s.net && typeof s.net === 'object') {
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
  let dirty = false; // the last append failed, so the file may end mid-line

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

  // Rewrites the file from memory (what is kept): older history as one line per 5 minute bucket of sums
  // and counts, the last 25 h as samples. Atomic, and it never reads or parses the file.
  function compact() {
    lastCompact = now();
    if (!file) return;
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      const drop = now() - RETENTION_MS;
      const out = coarse.filter((c) => c.b + COARSE_MS > drop).map((c) => `${JSON.stringify({ coarse: 1, b: c.b, acc: c.acc })}\n`);
      for (const s of raw) out.push(`${JSON.stringify(s)}\n`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, out.join(''), { mode: 0o600 });
      fs.renameSync(tmp, file);
      dirty = false;
      warned = false;
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
      warn('could not compact the metrics file', e);
    }
  }

  const sane = (s) => finite(s.t) && s.t <= now() + FUTURE_SLACK_MS;
  const validAcc = (c) => c && finite(c.b) && c.acc && typeof c.acc === 'object' && finite(c.acc.n)
    && c.acc.sum && c.acc.cnt && c.acc.net && typeof c.acc.sum === 'object';

  function load() {
    if (!file) return;
    let info;
    try { info = readLines(file); } catch (e) {
      if (e.code !== 'ENOENT') warn('could not read the metrics file', e);
      return;
    }
    const cutoff = now() - RETENTION_MS;
    let bad = info.bad;
    const live = info.samples.filter((s) => {
      if (s.t < cutoff) return false;
      if (!sane(s)) { bad += 1; return false; }
      return true;
    });
    live.sort((a, b) => a.t - b.t);
    for (const s of live) insert(s);
    for (const c of info.coarse) {
      if (!validAcc(c)) { bad += 1; continue; }
      if (c.b + COARSE_MS > cutoff && c.b <= now() + FUTURE_SLACK_MS) coarse.push({ b: c.b, acc: c.acc }); else bad += 1;
    }
    coarse.sort((a, b) => a.b - b.b);
    const before = raw.length;
    foldOld(now() - RAW_KEEP_MS);
    // A truncated last line (no newline) would swallow the next append, and a file of old raw lines is
    // big, so a start with anything to clean rewrites it (from memory).
    if (bad > 0 || raw.length !== before || info.samples.length !== live.length || !info.endsWithNewline) compact();
  }

  function add(sample) {
    if (!sample || !sane(sample)) return; // a future-dated sample would sit in every range for days
    insert(sample);
    foldOld(now() - RAW_KEEP_MS);
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // After a failed append the file may end mid-line: start on a fresh line so two samples are not glued.
      fs.appendFileSync(file, `${dirty ? '\n' : ''}${JSON.stringify(sample)}\n`, { mode: 0o600 });
      dirty = false;
      warned = false;
    } catch (e) { dirty = true; warn('could not append to the metrics file', e); }
    if (now() - lastCompact >= COMPACT_EVERY_MS) compact();
  }

  // -> { bucketMs, samples } or null for an unknown range.
  function query(range) {
    if (!Object.hasOwn(RANGES, range)) return null;
    const span = RANGES[range];
    const cutoff = now() - span;
    const bucketMs = bucketFor(span);
    if (bucketMs === SAMPLE_INTERVAL_MS) return { bucketMs, samples: raw.filter((s) => s.t >= cutoff && s.t <= now()) };
    const buckets = new Map();
    const slot = (t) => {
      const k = Math.floor(t / bucketMs);
      let acc = buckets.get(k);
      if (!acc) { acc = newAcc(); buckets.set(k, acc); }
      return acc;
    };
    const upto = now();
    for (const c of coarse) if (c.b + COARSE_MS > cutoff && c.b <= upto) mergeAcc(slot(c.b), c.acc);
    for (const s of raw) if (s.t >= cutoff && s.t <= upto) addSample(slot(s.t), s);
    if (buckets.size === 0) return { bucketMs, samples: [] };
    const keys = [...buckets.keys()];
    const lo = Math.min(...keys);
    const hi = Math.min(Math.max(...keys), lo + Math.ceil(span / bucketMs) + 2);
    const samples = [];
    for (let k = lo; k <= hi; k += 1) samples.push(accToSample(buckets.get(k) || newAcc(), k * bucketMs + Math.floor(bucketMs / 2)));
    return { bucketMs, samples };
  }

  const latest = () => (raw.length ? raw[raw.length - 1] : null); // raw never holds a future sample
  const size = () => raw.length + coarse.reduce((n, c) => n + c.acc.n, 0);

  load();
  return { add, query, latest, compact, size };
}

// Parses a jsonl file (samples, and coarse bucket lines); a line that is not JSON or has no finite t is counted and skipped.
function readLines(file) {
  const text = fs.readFileSync(file, 'utf8');
  const samples = [];
  const coarse = [];
  let bad = 0;
  for (const line of text.split('\n')) {
    if (line === '') continue;
    try {
      const s = JSON.parse(line);
      if (s && typeof s === 'object' && s.coarse === 1) coarse.push(s);
      else if (s && typeof s === 'object' && finite(s.t)) samples.push(s); else bad += 1;
    } catch { bad += 1; }
  }
  return { samples, coarse, bad, endsWithNewline: text === '' || text.endsWith('\n') };
}

module.exports = { createMetricsStore, bucketFor, RANGES, SAMPLE_INTERVAL_MS, RETENTION_MS };
