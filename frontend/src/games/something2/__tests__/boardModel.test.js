import { describe, it, expect } from 'vitest';
import {
  chartPoints, latestValue, statusLine, confirmText, safeUrl, fmtBps, seedTotals, seedBlockers,
  actionReason, jobPollMs, SAMPLE_INTERVAL_MS,
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
    expect(confirmText('update', { behindMain: 12 })).toBe('Move the board to the latest main (12 commits). The game restarts and players are disconnected. The update can change characters. The backup taken first is the way back.');
    expect(confirmText('update', { behindMain: null })).toContain('Move the board to the latest main. The game restarts');
    expect(confirmText('update', { behindMain: null })).not.toMatch(/\(|null/);
    expect(confirmText('update', { behindMain: 1 })).toContain('(1 commit)');
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
