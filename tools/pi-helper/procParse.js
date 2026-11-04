'use strict';
// Pure parsing of the board snapshot (see SNAPSHOT_COMMAND in sampler.js) and the
// delta maths between two snapshots. Nothing here throws: a bad part is a null.
const EXCLUDED_IFACE = /^(lo|docker.*|veth.*|br-.*)$/;

const num = (s) => {
  const t = String(s ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
};

function sections(text) {
  const out = {};
  let name = null;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^=== (\w+)\s*$/.exec(line);
    if (m) { name = m[1]; out[name] = []; } else if (name) out[name].push(line);
  }
  return out;
}

function parseCpu(lines = []) {
  const line = lines.find((l) => /^cpu\s/.test(l));
  if (!line) return null;
  const f = line.trim().split(/\s+/).slice(1, 9).map(num);
  if (f.length < 8 || f.some((v) => v === null)) return null;
  const [user, nice, system, idle, iowait, irq, softirq, steal] = f;
  const busy = user + nice + system + irq + softirq + steal;
  return { busy, total: busy + idle + iowait };
}

function parseMem(lines = []) {
  const kb = (key) => {
    const l = lines.find((x) => x.startsWith(`${key}:`));
    const m = l && /:\s*(\d+)\s*kB/.exec(l);
    return m ? Number(m[1]) : null;
  };
  const total = kb('MemTotal');
  const avail = kb('MemAvailable');
  if (total === null) return { memUsedMb: null, memTotalMb: null };
  return {
    memTotalMb: Math.round(total / 1024),
    memUsedMb: avail === null ? null : Math.round((total - avail) / 1024),
  };
}

function parseNet(lines = []) {
  const net = {};
  for (const l of lines) {
    const i = l.indexOf(':');
    if (i < 0) continue;
    const iface = l.slice(0, i).trim();
    if (!iface || /\s/.test(iface) || EXCLUDED_IFACE.test(iface)) continue;
    // "eth0:12345 ..." has no space after the colon when the counter is wide.
    const f = l.slice(i + 1).trim().split(/\s+/);
    const rx = num(f[0]);
    const tx = num(f[8]);
    if (rx === null || tx === null) continue;
    net[iface] = { rx, tx };
  }
  return net;
}

function parseDisk(lines = []) {
  const row = lines.filter((l) => /\s\/\s*$/.test(l)).pop();
  const m = row && /(\d+)%/.exec(row);
  return m ? Number(m[1]) : null;
}

const firstCount = (lines = []) => {
  const l = lines.map((x) => x.trim()).find((x) => x !== '');
  return l === undefined ? null : num(l);
};

function parseSnapshot(text) {
  const s = sections(text);
  const conntrack = firstCount(s.conntrack);
  return {
    cpu: parseCpu(s.stat),
    ...parseMem(s.meminfo),
    diskPct: parseDisk(s.df),
    // conntrack sees container traffic; ss in the host namespace does not.
    connections: conntrack !== null ? conntrack : firstCount(s.conns),
    net: parseNet(s.netdev),
  };
}

const round1 = (n) => Math.round(n * 10) / 10;

// prev = { t, snapshot } of the last VALID snapshot, or null. snapshot = null means the
// board could not be read. extra = { pingMs, cloudflareMs, ngrokMs }.
function nextSample(prev, snapshot, now, extra = {}) {
  const ping = extra.pingMs ?? null;
  const cf = extra.cloudflareMs ?? null;
  const ng = extra.ngrokMs ?? null;
  if (!snapshot) {
    return { t: now, online: false, cpuPct: null, memUsedMb: null, memTotalMb: null, diskPct: null, connections: null, net: {}, pingMs: null, cloudflareMs: null, ngrokMs: null };
  }
  const dt = prev ? (now - prev.t) / 1000 : 0;
  const usable = prev && dt > 0;
  let cpuPct = null;
  if (usable && prev.snapshot.cpu && snapshot.cpu) {
    const dBusy = snapshot.cpu.busy - prev.snapshot.cpu.busy;
    const dTotal = snapshot.cpu.total - prev.snapshot.cpu.total;
    if (dBusy >= 0 && dTotal > 0) cpuPct = round1(Math.min(100, (dBusy / dTotal) * 100));
  }
  const net = {};
  for (const [iface, cur] of Object.entries(snapshot.net || {})) {
    const old = usable ? prev.snapshot.net?.[iface] : null;
    const rate = (a, b) => (old && a >= b ? Math.round((a - b) / dt) : null);
    net[iface] = old ? { inBps: rate(cur.rx, old.rx), outBps: rate(cur.tx, old.tx) } : { inBps: null, outBps: null };
  }
  return {
    t: now,
    online: true,
    cpuPct,
    memUsedMb: snapshot.memUsedMb ?? null,
    memTotalMb: snapshot.memTotalMb ?? null,
    diskPct: snapshot.diskPct ?? null,
    connections: snapshot.connections ?? null,
    net,
    pingMs: ping,
    cloudflareMs: cf,
    ngrokMs: ng,
  };
}

module.exports = { parseSnapshot, nextSample };
