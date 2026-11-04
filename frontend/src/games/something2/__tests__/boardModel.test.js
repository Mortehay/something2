import { describe, it, expect } from 'vitest';
import {
  updateLabel, dialogLabels,
  chartPoints, latestValue, statusLine, confirmText, safeUrl, fmtBps, seedTotals, seedBlockers,
  actionReason, jobPollMs, jobResultText, SAMPLE_INTERVAL_MS, autoMax, previewExpired, PREVIEW_TTL_MS, latestGate, tunnelState,
} from '../boardModel.js';

const at = (i, extra = {}) => ({ t: 1_000_000 + i * SAMPLE_INTERVAL_MS, online: true, ...extra });
const runs = (vals, opts = {}) => chartPoints(vals.map((v, i) => at(i, { v })), (s) => s.v, { width: 100, height: 50, max: 10, ...opts });

describe('chartPoints', () => {
  it('splits on null and never draws a point at zero', () => {
    const r = runs([1, null, 2, 3]);
    expect(r).toHaveLength(2);
    // y for value 1 on a 0..10 scale of height 50 is 45; a null must not read as 0 (y=50).
    expect(r.join(' ')).not.toMatch(/,50(\.0+)?(\s|$)/);
    expect(r[1].split(' ')).toHaveLength(2);
  });
  it('treats NaN, Infinity and non-numbers as gaps', () => {
    expect(runs([1, NaN, 2, Infinity, 'x', 3])).toHaveLength(3);
  });
  it('breaks where the time between points exceeds 2.5 intervals', () => {
    const s = [at(0, { v: 1 }), at(1, { v: 2 }), at(5, { v: 3 }), at(6, { v: 4 })];
    expect(chartPoints(s, (x) => x.v, { width: 100, height: 50, max: 10 })).toHaveLength(2);
    const ok = [at(0, { v: 1 }), at(2, { v: 2 })]; // 2 intervals: joined
    expect(chartPoints(ok, (x) => x.v, { width: 100, height: 50, max: 10 })).toHaveLength(1);
  });
  it('an offline sample is a gap even when its metrics are present', () => {
    const s = [at(0, { v: 1 }), { ...at(1, { v: 5 }), online: false }, at(2, { v: 2 })];
    expect(chartPoints(s, (x) => x.v, { width: 100, height: 50, max: 10 })).toHaveLength(2);
  });
  it('lays x over the given from/to range, not the sample extent', () => {
    const s = [at(0, { v: 1 }), at(1, { v: 1 })];
    const from = at(0).t; const to = from + 10 * SAMPLE_INTERVAL_MS;
    const [line] = chartPoints(s, (x) => x.v, { width: 100, height: 50, max: 10, from, to });
    const xs = line.split(' ').map((p) => Number(p.split(',')[0]));
    expect(xs).toEqual([0, 10]);
  });
  it('clamps values above max and returns [] for no samples', () => {
    const [line] = runs([50, 50]);
    expect(line).toContain(',0');
    expect(chartPoints([], () => 1, { width: 10, height: 10, max: 1 })).toEqual([]);
    expect(chartPoints(null, () => 1, { width: 10, height: 10, max: 1 })).toEqual([]);
  });
});

describe('chartPoints with carryMs (latency probed once a minute)', () => {
  const vals = [40, null, null, null, 44, null, null, null, null, null, null];
  const carry = (opts) => chartPoints(vals.map((v, i) => at(i, { v })), (s) => s.v, { width: 100, height: 50, max: 100, ...opts });
  it('samples between probes carry the last latency: one unbroken line', () => {
    const r = carry({ carryMs: 60000 });
    // probes at 0 and 4 join into one run with the carried samples; without carry each probe is a lone dot.
    expect(r).toHaveLength(1);
    expect(carry({})).toHaveLength(2);
  });
  it('a reading older than 60 s is a gap again, never a stale value', () => {
    const r = carry({ carryMs: 60000 });
    // after the probe at i=4 only i=5..8 (15..60 s) carry; 9 and 10 stay null: 9 points, none later
    expect(r).toHaveLength(1);
    expect(r[0].split(' ')).toHaveLength(9);
  });
  it('an offline sample is never filled', () => {
    const s = [at(0, { v: 40 }), { ...at(1), online: false, v: null }, at(2, { v: null })];
    expect(chartPoints(s, (x) => x.v, { width: 100, height: 50, max: 100, carryMs: 60000 })).toHaveLength(2);
  });
});

describe('latestValue', () => {
  it('is the newest non-null reading, else null', () => {
    const s = [at(0, { v: 3 }), at(1, { v: 7 }), at(2, { v: null })];
    expect(latestValue(s, (x) => x.v)).toBe(7);
    expect(latestValue([at(0, { v: null })], (x) => x.v)).toBeNull();
    expect(latestValue(undefined, (x) => x.v)).toBeNull();
  });
});

describe('statusLine', () => {
  const base = { available: true, online: true, behindMain: 3, commit: 'a1b2c3d', host: 'opiz03' };
  it('names the count when behind', () => {
    expect(statusLine(base)).toEqual({ tone: 'warn', text: expect.stringContaining('3 commits behind main') });
    expect(statusLine({ ...base, behindMain: 1 }).text).toContain('1 commit behind main');
  });
  it('up to date, and unknown when behindMain is null', () => {
    expect(statusLine({ ...base, behindMain: 0 }).tone).toBe('ok');
    const u = statusLine({ ...base, behindMain: null });
    expect(u.text).toMatch(/unknown/i);
  });
  it('offline says the board is off or unreachable', () => {
    const o = statusLine({ ...base, online: false });
    expect(o.tone).toBe('bad');
    expect(o.text).toMatch(/off or unreachable/);
  });
});

describe('confirmText', () => {
  it('update uses the commit count, or no count when unknown', () => {
    expect(confirmText('update', { behindMain: 12 })).toBe('Merge main into orangepi and build orangepi. Move the board to the latest main (12 commits). The game restarts and players are disconnected. The update can change characters. The backup taken first is the way back.');
    expect(confirmText('update', { behindMain: null })).toContain('Move the board to the latest main. The game restarts');
    expect(confirmText('update', { behindMain: null })).not.toMatch(/\(|null/);
    expect(confirmText('update', { behindMain: 1 })).toContain('(1 commit)');
    // 0 commits behind: the count would read "(0 commits)"; say the latest main instead.
    const zero = confirmText('update', { behindMain: 0 });
    expect(zero).toContain('Move the board to the latest main. The game restarts');
    expect(zero).not.toContain('0 commits');
  });
  it('seed totals add over groups', () => {
    const preview = { needsUpdate: false, groups: [{ group: 'a', add: 1, change: 2, remove: 3, overwrite: 4 }, { group: 'b', add: 10, change: 0, remove: 0, overwrite: 1 }] };
    expect(seedTotals(preview)).toEqual({ add: 11, change: 2, remove: 3, overwrite: 5 });
    expect(confirmText('seed', preview)).toBe("11 added, 2 changed, 3 removed, 5 overwritten with git's version. Balance changes made directly on the board are lost. Players and progress are not touched. Art, audio and maps are not included.");
  });
  it('cloudflare stop', () => {
    expect(confirmText('cloudflare-stop')).toBe('The current link stops working. Starting it again gives a new address, and CI deploys need repairing, which Start does for you.');
  });
});

describe('seedBlockers', () => {
  it('names groups that are blocked or refused, none otherwise', () => {
    expect(seedBlockers({ groups: [{ group: 'alpha', blocked: 0 }] })).toBeNull();
    const r = seedBlockers({ groups: [{ group: 'alpha', blocked: 2 }, { group: 'beta', refused: 'nope' }, { group: 'gamma', blocked: 0 }] });
    expect(r).toContain('alpha');
    expect(r).toContain('beta');
    expect(r).not.toContain('gamma');
  });
});

describe('safeUrl', () => {
  it('passes http(s) only', () => {
    expect(safeUrl('https://x.example/a')).toBe('https://x.example/a');
    expect(safeUrl('http://x.example')).toBe('http://x.example');
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('data:text/html,hi')).toBeNull();
    expect(safeUrl('not a url')).toBeNull();
    expect(safeUrl(null)).toBeNull();
  });
});

describe('fmtBps', () => {
  it('uses KB/s then MB/s', () => {
    expect(fmtBps(180_000)).toBe('180 KB/s');
    expect(fmtBps(2_500_000)).toBe('2.5 MB/s');
    expect(fmtBps(0)).toBe('0 KB/s');
  });
});

describe('actionReason / jobPollMs', () => {
  it('a running job and an offline board each give a reason', () => {
    expect(actionReason({ online: true }, { state: 'running' })).toMatch(/running/);
    expect(actionReason({ online: false }, null)).toMatch(/offline/);
    expect(actionReason({ online: true }, { state: 'ok' })).toBeNull();
  });
  it('polls the job every 2 s while running, else 15 s', () => {
    expect(jobPollMs({ state: 'running' })).toBe(2000);
    expect(jobPollMs(null)).toBe(15000);
    expect(jobPollMs({ state: 'failed' })).toBe(15000);
  });
});

describe('in-flight requests', () => {
  it('a request in flight gives a reason even with no job and an online board', () => {
    expect(actionReason({ online: true }, null, true)).toMatch(/in progress|sending/i);
    expect(actionReason({ online: true }, null, false)).toBeNull();
  });
});

describe('no NaN reaches a chart', () => {
  const bad = (v) => /NaN|Infinity|undefined|null/.test(String(v));
  it('all-null samples draw nothing and auto-scale to a finite positive max', () => {
    const s = [at(0, { v: null }), at(1, { v: null })];
    expect(chartPoints(s, (x) => x.v, { width: 100, height: 50, max: 0 })).toEqual([]);
    const m = autoMax(s, [(x) => x.v], null);
    expect(Number.isFinite(m)).toBe(true);
    expect(m).toBeGreaterThan(0);
  });
  it('max=0 and auto max with zero readings stay finite', () => {
    const s = [at(0, { v: 0 }), at(1, { v: 0 })];
    const lines = chartPoints(s, (x) => x.v, { width: 100, height: 50, max: 0 });
    expect(lines.some(bad)).toBe(false);
    expect(autoMax(s, [(x) => x.v], 0)).toBeGreaterThan(0);
    expect(autoMax(s, [(x) => x.v], 80)).toBe(80);
  });
  it('a single sample with from equal to to has no NaN', () => {
    const t = at(0).t;
    const lines = chartPoints([at(0, { v: 3 })], (x) => x.v, { width: 100, height: 50, max: 10, from: t, to: t });
    expect(lines.some(bad)).toBe(false);
  });
});

describe('preview freshness', () => {
  it('expires 5 minutes after it loaded', () => {
    expect(PREVIEW_TTL_MS).toBe(5 * 60 * 1000);
    const p = { state: 'ready', loadedAt: 1000, data: {} };
    expect(previewExpired(p, 1000 + PREVIEW_TTL_MS - 1)).toBe(false);
    expect(previewExpired(p, 1000 + PREVIEW_TTL_MS)).toBe(true);
    expect(previewExpired({ state: 'loading' }, 9e12)).toBe(false);
  });
  it('an older reply is not current once a newer request started', () => {
    const g = latestGate();
    const a = g.next();
    expect(g.isCurrent(a)).toBe(true);
    const b = g.next();
    expect(g.isCurrent(a)).toBe(false);
    expect(g.isCurrent(b)).toBe(true);
  });
});

describe('tunnelState', () => {
  it('only on and off are known; anything else is unknown', () => {
    expect(tunnelState({ state: 'on' })).toBe('on');
    expect(tunnelState({ state: 'off' })).toBe('off');
    expect(tunnelState({ state: 'starting' })).toBe('unknown');
    expect(tunnelState(undefined)).toBe('unknown');
    expect(tunnelState(null)).toBe('unknown');
  });
});

describe('branch names from the helper (SOMET-719)', () => {
  const base = { available: true, online: true, behindMain: 3, commit: 'a1b2c3d', host: 'opiz03' };
  const custom = { ...base, sourceBranch: 'dev', buildBranch: 'build' };
  it('labels follow the configured source branch, main when absent', () => {
    expect(updateLabel(custom)).toBe('Update to latest dev');
    expect(updateLabel(base)).toBe('Update to latest main');
    expect(dialogLabels('update', custom).title).toBe('Update to latest dev');
    expect(dialogLabels('restart', custom).title).toBe('Restart the game');
  });
  it('badge and dialog name both branches', () => {
    expect(statusLine(custom).text).toBe('3 commits behind dev');
    expect(statusLine({ ...custom, behindMain: 0 }).text).toBe('Up to date with dev');
    expect(statusLine({ ...custom, behindMain: null }).text).toBe('Behind dev: unknown');
    expect(confirmText('update', custom)).toContain('Merge dev into build and build build. Move the board to the latest dev (3 commits).');
    expect(confirmText('update', custom)).not.toContain('main');
  });
});

describe('jobResultText (SOMET-718)', () => {
  const sha = 'abcdef0123456789abcdef0123456789abcdef01';
  it('update ok names the short sha', () => {
    expect(jobResultText({ kind: 'update', state: 'ok', targetSha: sha })).toEqual({ tone: 'ok', text: 'Update completed. The board is running abcdef01.' });
  });
  it('update failed names the failed step', () => {
    const job = { kind: 'update', state: 'failed', steps: [{ name: 'backup', state: 'ok' }, { name: 'ci', state: 'failed' }, { name: 'deploy', state: 'pending' }] };
    expect(jobResultText(job)).toEqual({ tone: 'bad', text: 'Update failed at ci.' });
  });
  it('seed, restart and tunnels', () => {
    expect(jobResultText({ kind: 'seed', state: 'ok' }).text).toBe('Seed from git completed.');
    expect(jobResultText({ kind: 'seed', state: 'failed' }).text).toBe('Seed from git failed.');
    expect(jobResultText({ kind: 'restart', state: 'ok' }).text).toBe('Restart completed.');
    expect(jobResultText({ kind: 'restart', state: 'failed' }).text).toBe('Restart failed.');
    const t = (name, state) => jobResultText({ kind: 'tunnel', state, steps: [{ name, state }] }).text;
    expect(t('Start ngrok tunnel', 'ok')).toBe('ngrok link completed.');
    expect(t('Stop cloudflare tunnel', 'failed')).toBe('Cloudflare link failed.');
  });
  it('is null while running or without a job', () => {
    expect(jobResultText({ kind: 'update', state: 'running' })).toBeNull();
    expect(jobResultText(null)).toBeNull();
  });
});

describe('statusLine after an update (SOMET-718)', () => {
  const st = { available: true, online: true, sourceBranch: 'main' };
  it('at the tip it says Up to date with the source, good tone', () => {
    expect(statusLine({ ...st, behindMain: 0 })).toEqual({ tone: 'ok', text: 'Up to date with main' });
  });
  it('behind stays a count even when the last update succeeded', () => {
    expect(statusLine({ ...st, behindMain: 2, lastJob: { kind: 'update', state: 'ok' } }).text).toBe('2 commits behind main');
  });
});
