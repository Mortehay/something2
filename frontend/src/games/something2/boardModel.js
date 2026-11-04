// SOMET-718. Pure rules for the Orange Pi tab: chart geometry, status text,
// dialog copy, which actions are allowed. No React, no fetching.

export const SAMPLE_INTERVAL_MS = 15000;
export const GAP_MS = SAMPLE_INTERVAL_MS * 2.5;
export const POLL_MS = 15000;
export const JOB_POLL_MS = 2000;
export const RANGES = [
  { id: '15m', label: '15 min', ms: 15 * 60 * 1000 },
  { id: '1h', label: '1 h', ms: 60 * 60 * 1000 },
  { id: '6h', label: '6 h', ms: 6 * 60 * 60 * 1000 },
];
export const rangeMs = (id) => (RANGES.find((r) => r.id === id) || RANGES[1]).ms;

export const NOT_MOUNTED_TEXT = 'This tab only works in the admin panel on the workstation.';

// A real finite number or null. Number(null) is 0, which would draw a gap as a
// reading of zero, so nothing here coerces.
export const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// What a sample contributes to a chart: its reading, or null when the board
// was offline at that moment (the metrics of such a sample are stale).
function reading(sample, read) {
  if (!sample || sample.online === false) return null;
  return num(read(sample));
}

const r2 = (n) => Number(n.toFixed(2));

// One polyline ("x,y x,y ...") per unbroken run. A null, an offline sample, or
// more than GAP_MS between neighbours ends a run. x runs over [from, to] (the
// selected range) when given, else over the samples' own extent.
//
// carryMs: for series the helper measures less often than it samples (the tunnel latencies, once
// a minute). A null reading within carryMs of the last measured one reuses that value, so the line
// is not broken into dots between probes; after carryMs it is a real gap again.
export const LATENCY_CARRY_MS = 60 * 1000;
export function chartPoints(samples, read, { width, height, max, from, to, carryMs } = {}) {
  if (!Array.isArray(samples) || samples.length === 0) return [];
  const ts = samples.map((s) => s && s.t).filter(Number.isFinite);
  const lo = Number.isFinite(from) ? from : Math.min(...ts);
  const hi = Number.isFinite(to) ? to : Math.max(...ts);
  const span = hi - lo || 1;
  const top = max > 0 ? max : 1;
  const out = [];
  let run = [];
  let prevT = null;
  const flush = () => {
    if (run.length === 1) run.push(run[0]); // a lone reading still draws a dot
    if (run.length) out.push(run.join(' '));
    run = [];
  };
  let lastV = null;
  let lastT = null;
  for (const s of samples) {
    let v = reading(s, read);
    if (v !== null && Number.isFinite(s.t)) { lastV = v; lastT = s.t; }
    else if (v === null && carryMs > 0 && s && s.online !== false && lastT !== null && Number.isFinite(s.t) && s.t - lastT <= carryMs) v = lastV;
    if (v === null || !Number.isFinite(s.t)) { flush(); prevT = null; continue; }
    if (prevT !== null && s.t - prevT > GAP_MS) flush();
    const x = Math.min(width, Math.max(0, ((s.t - lo) / span) * width));
    const y = height - Math.min(top, Math.max(0, v)) / top * height;
    run.push(`${r2(x)},${r2(y)}`);
    prevT = s.t;
  }
  flush();
  return out;
}

// The newest non-null reading, or null.
export function latestValue(samples, read) {
  if (!Array.isArray(samples)) return null;
  for (let i = samples.length - 1; i >= 0; i--) {
    const v = reading(samples[i], read);
    if (v !== null) return v;
  }
  return null;
}

export function fmtBps(v) {
  if (num(v) === null) return 'No data';
  if (v >= 1_000_000) return `${r1(v / 1_000_000)} MB/s`;
  return `${Math.round(v / 1000)} KB/s`;
}
const r1 = (n) => Number(n.toFixed(1));
export const fmtPct = (v) => (num(v) === null ? 'No data' : `${Math.round(v)}%`);
export const fmtMs = (v) => (num(v) === null ? 'No data' : `${Math.round(v)} ms`);
export const fmtGb = (mb) => `${r1(mb / 1000)}`;

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// The branch names come from the helper's /status; `main` and `orangepi` when absent.
export const sourceName = (status) => status?.sourceBranch || 'main';
export const buildName = (status) => status?.buildBranch || 'orangepi';
export const updateLabel = (status) => `Update to latest ${sourceName(status)}`;

export function statusLine(status) {
  if (!status) return { tone: 'info', text: 'Checking the board…' };
  if (status.available === false) return { tone: 'warn', text: 'Board status unavailable' };
  if (!status.online) return { tone: 'bad', text: 'The board is off or unreachable' };
  const b = status.behindMain;
  const src = sourceName(status);
  if (b === null || b === undefined) return { tone: 'info', text: `Behind ${src}: unknown` };
  if (b > 0) return { tone: 'warn', text: `${plural(b, 'commit')} behind ${src}` };
  return { tone: 'ok', text: `Up to date with ${src}` };
}

export function seedTotals(preview) {
  const t = { add: 0, change: 0, remove: 0, overwrite: 0 };
  for (const g of preview?.groups || []) for (const k of Object.keys(t)) t[k] += num(g[k]) || 0;
  return t;
}

// null when every group can be applied, else a sentence naming those that cannot.
export function seedBlockers(preview) {
  const bad = (preview?.groups || []).filter((g) => (num(g.blocked) || 0) > 0 || g.refused);
  if (bad.length === 0) return null;
  return `Cannot apply: ${bad.map((g) => g.group).join(', ')} ${bad.length === 1 ? 'is' : 'are'} blocked or refused. Fix ${bad.length === 1 ? 'it' : 'them'} before seeding.`;
}

// kind: 'update' (ctx = status), 'seed' (ctx = preview), 'restart',
// 'cloudflare-stop', 'ngrok-stop', 'cloudflare-start', 'ngrok-start'.
export function confirmText(kind, ctx) {
  switch (kind) {
    case 'update': {
      const n = ctx?.behindMain;
      // 0 or unknown: a count would read "(0 commits)", which says nothing useful.
      const src = sourceName(ctx);
      const build = buildName(ctx);
      const where = !(n > 0) ? `the latest ${src}` : `the latest ${src} (${plural(n, 'commit')})`;
      return `Merge ${src} into ${build} and build ${build}. Move the board to ${where}. The game restarts and players are disconnected. The update can change characters. The backup taken first is the way back.`;
    }
    case 'seed': {
      const t = seedTotals(ctx);
      return `${t.add} added, ${t.change} changed, ${t.remove} removed, ${t.overwrite} overwritten with git's version. Balance changes made directly on the board are lost. Players and progress are not touched. Art, audio and maps are not included.`;
    }
    case 'restart': return 'Restart the game on the board. Players are disconnected.';
    case 'cloudflare-stop': return 'The current link stops working. Starting it again gives a new address, and CI deploys need repairing, which Start does for you.';
    case 'ngrok-stop': return 'The current link stops working. Starting it again gives a new address.';
    case 'cloudflare-start': return 'Start the Cloudflare link. It gets a new address, and CI deploys are repaired for it.';
    case 'ngrok-start': return 'Start the ngrok link. It gets a new address.';
    default: return '';
  }
}

export const SEED_NOTE = "Seed copies catalogs from git. Art isn't included, so world objects stay placeholder boxes.";
export const RESTART_NOTE_TEXT = 'The running game still uses the old data until it is restarted.';
export const MID_ACTION_TEXT = "The helper stopped partway: it's unknown whether the action happened. The current job is shown below.";

export const jobRunning = (job) => job?.state === 'running';
export const jobPollMs = (job) => (jobRunning(job) ? JOB_POLL_MS : POLL_MS);

// Why an action can't be started right now, or null.
export function actionReason(status, job, pending = false) {
  if (jobRunning(job)) return 'A job is running';
  if (pending) return 'A request is in progress';
  if (!status || status.online === false) return 'The board is offline';
  return null;
}

// Only http(s) URLs become links; anything else (javascript:, data:) is dropped.
export function safeUrl(u) {
  if (typeof u !== 'string') return null;
  try {
    const p = new URL(u);
    return p.protocol === 'http:' || p.protocol === 'https:' ? u : null;
  } catch { return null; }
}

// A tunnel's link is shown only once the helper has verified it answers.
export function tunnelLink(tunnel) {
  return tunnel && tunnel.state === 'on' && tunnel.verified ? safeUrl(tunnel.url) : null;
}

// ms epoch or ISO string -> ms, else null.
export const toMs = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
};

export function jobDuration(job) {
  const a = toMs(job?.startedAt); const b = toMs(job?.finishedAt);
  if (a === null || b === null) return null;
  const s = Math.max(0, Math.round((b - a) / 1000));
  return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`;
}

const JOB_NAMES = { update: 'Update', seed: 'Seed', restart: 'Restart', tunnel: 'Tunnel' };
export const jobTitle = (job) => {
  if (!job) return 'Last action';
  const d = jobDuration(job);
  return `Last action: ${JOB_NAMES[job.kind] || job.kind} (${job.state}${d ? `, ${d}` : ''})`;
};

const RESULT_NAMES = { seed: 'Seed from git', restart: 'Restart' };
// The plain one-line result of a finished job: { tone: 'ok' | 'bad', text }, or null while it runs.
export function jobResultText(job) {
  if (!job || (job.state !== 'ok' && job.state !== 'failed')) return null;
  const ok = job.state === 'ok';
  const tone = ok ? 'ok' : 'bad';
  if (job.kind === 'update') {
    if (ok) return { tone, text: `Update completed. The board is running ${String(job.targetSha || '').slice(0, 8) || 'the new version'}.` };
    const failed = (job.steps || []).find((s) => s.state === 'failed');
    return { tone, text: failed ? `Update failed at ${failed.name}.` : 'Update failed.' };
  }
  let name = RESULT_NAMES[job.kind];
  if (!name && job.kind === 'tunnel') {
    const m = /ngrok|cloudflare/i.exec((job.steps || []).map((s) => s.name).join(' '));
    name = m ? (m[0].toLowerCase() === 'ngrok' ? 'ngrok link' : 'Cloudflare link') : 'Tunnel';
  }
  return { tone, text: `${name || job.kind} ${ok ? 'completed' : 'failed'}.` };
}

// The last lines of a log; a log can be long and the tab is not a log viewer.
export const logTail = (log, n = 30) => String(log || '').split('\n').slice(-n).join('\n').trim();

// Chart series definitions. Colours are tokens (--s2-*), assigned in fixed order.
export const SERIES_COLORS = ['var(--s2-accent)', 'var(--s2-warning)', 'var(--s2-btn-purple)', 'var(--s2-tab-items)', 'var(--s2-success)'];

export function networkSeries(samples) {
  const ifaces = [];
  for (const s of samples || []) for (const k of Object.keys(s?.net || {})) if (!ifaces.includes(k)) ifaces.push(k);
  const single = ifaces.length === 1;
  const out = [];
  ifaces.forEach((name, i) => {
    out.push({ key: `${name}:in`, label: single ? 'In' : `${name} in`, color: SERIES_COLORS[(i * 2) % SERIES_COLORS.length], read: (s) => s.net?.[name]?.inBps });
    out.push({ key: `${name}:out`, label: single ? 'Out' : `${name} out`, color: SERIES_COLORS[(i * 2 + 1) % SERIES_COLORS.length], dash: true, read: (s) => s.net?.[name]?.outBps });
  });
  return out;
}

export const PING_SERIES = [
  { key: 'board', label: 'Board', color: SERIES_COLORS[0], read: (s) => s.pingMs },
  { key: 'cloudflare', label: 'Cloudflare', color: SERIES_COLORS[1], read: (s) => s.cloudflareMs, carryMs: LATENCY_CARRY_MS },
  { key: 'ngrok', label: 'ngrok', color: SERIES_COLORS[2], read: (s) => s.ngrokMs, carryMs: LATENCY_CARRY_MS },
];

// Highest value to plot: the fixed max when it is a positive number, else the
// largest reading plus headroom, never 0 (a divisor) and never NaN.
export function autoMax(samples, reads, max) {
  if (num(max) !== null && max > 0) return max;
  let hi = 0;
  for (const s of samples || []) {
    if (!s || s.online === false) continue;
    for (const read of reads) hi = Math.max(hi, num(read(s)) ?? 0);
  }
  return hi > 0 ? hi * 1.15 : 1;
}

// A seed preview is a snapshot; Apply carries nothing, so it goes stale.
export const PREVIEW_TTL_MS = 5 * 60 * 1000;
export const previewExpired = (preview, now) => (
  preview?.state === 'ready' && Number.isFinite(preview.loadedAt) && now - preview.loadedAt >= PREVIEW_TTL_MS
);

// Request ordering: only the reply to the newest request may be kept.
export function latestGate() {
  let n = 0;
  return { next: () => { n += 1; return n; }, isCurrent: (id) => id === n };
}

// The API only says 'on' or 'off'; a missing object or anything else is unknown.
export const tunnelState = (tunnel) => (tunnel?.state === 'on' || tunnel?.state === 'off' ? tunnel.state : 'unknown');

export const DIALOG_LABELS = {
  update: { title: 'Update to latest main', confirm: 'Update' }, // title: see dialogLabels
  seed: { title: 'Seed from git', confirm: 'Apply' },
  restart: { title: 'Restart the game', confirm: 'Restart' },
  'cloudflare-stop': { title: 'Stop the Cloudflare link', confirm: 'Stop' },
  'cloudflare-start': { title: 'Start the Cloudflare link', confirm: 'Start' },
  'ngrok-stop': { title: 'Stop the ngrok link', confirm: 'Stop' },
  'ngrok-start': { title: 'Start the ngrok link', confirm: 'Start' },
};

// DIALOG_LABELS with the update title following the configured source branch.
export const dialogLabels = (kind, status) => (kind === 'update'
  ? { ...DIALOG_LABELS.update, title: updateLabel(status) }
  : DIALOG_LABELS[kind]);
