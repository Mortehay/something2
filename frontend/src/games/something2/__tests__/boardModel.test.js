import { describe, it, expect } from 'vitest';
import {
  updateLabel, dialogLabels,
  historyRow, shortVersion, chartPoints, RANGES, rangeMs, latestValue, statusLine, confirmText, safeUrl, fmtBps, seedTotals, seedBlockers,
  actionReason, jobPollMs, jobResultText, canOfferRestart, SAMPLE_INTERVAL_MS, autoMax, previewExpired, PREVIEW_TTL_MS, latestGate, tunnelState,
  fmtLinkAge, ngrokUsageText, watcherNote, DIALOG_LABELS,
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

describe('chartPoints with bucketMs (long ranges)', () => {
  const B = 5_400_000; // 30d buckets
  const mk = (i) => ({ t: 1_000_000 + i * B, online: true, v: 5 });
  const opts = { width: 100, height: 50, max: 10 };
  it('joins neighbouring buckets that a fixed 37.5 s limit would have broken', () => {
    const s = [mk(0), mk(1), mk(2)];
    expect(chartPoints(s, (x) => x.v, opts)).toHaveLength(3);
    expect(chartPoints(s, (x) => x.v, { ...opts, bucketMs: B })).toHaveLength(1);
  });
  it('still breaks where more than 2.5 buckets are missing', () => {
    expect(chartPoints([mk(0), mk(3)], (x) => x.v, { ...opts, bucketMs: B })).toHaveLength(2);
  });
  it('a null bucket is a gap, not a zero', () => {
    const s = [mk(0), { ...mk(1), v: null }, mk(2)];
    expect(chartPoints(s, (x) => x.v, { ...opts, bucketMs: B })).toHaveLength(2);
  });
  it('without bucketMs the 15 s interval is the default', () => {
    expect(chartPoints([at(0, { v: 1 }), at(3, { v: 1 })], (x) => x.v, opts)).toHaveLength(2);
  });
});

describe('ranges', () => {
  it('offers 15m, 1h, 6h, 24h, 7d and 30d', () => {
    expect(RANGES.map((r) => r.id)).toEqual(['15m', '1h', '6h', '24h', '7d', '30d']);
    expect(rangeMs('30d')).toBe(30 * 24 * 3600 * 1000);
    expect(rangeMs('7d')).toBe(7 * 24 * 3600 * 1000);
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
    // Without file counts (an older answer) the sentence still says art and audio are copied.
    expect(confirmText('seed', preview)).toBe("11 added, 2 changed, 3 removed, 5 overwritten with git's version. Balance changes made directly on the board are lost. Players and progress are not touched. It also copies the art and audio from git to the board's storage, which can take an hour or more. Maps are separate.");
    const lead = "11 added, 2 changed, 3 removed, 5 overwritten with git's version. Balance changes made directly on the board are lost. Players and progress are not touched.";
    expect(confirmText('seed', { ...preview, files: { art: 12, audio: 2258, artTotal: 1329, audioTotal: 7202 } })).toBe(`${lead} It also copies 12 of 1,329 art files and 2,258 of 7,202 audio files from git to the board's storage, which takes about 7 minutes. Maps are separate.`);
    expect(confirmText('seed', { ...preview, files: { art: 0, audio: 0, artTotal: 1329, audioTotal: 7202 } })).toBe(`${lead} All 1,329 art files and 7,202 audio files are already in the board's storage, so nothing is copied. Checking them takes about 4 minutes. Maps are separate.`);
    expect(confirmText('seed', preview)).not.toMatch(/not included|placeholder/);
  });
  it('maps: says what is applied, what is kept and what really changes', () => {
    const text = confirmText('maps');
    expect(text).toBe("Apply the laptop's maps (p5-descent, then vale-region) to the board, then restart the game. Players are disconnected. Accounts, characters and items are kept, and no world is removed. A world the maps change is regenerated and its creatures are placed again. Waypoints the maps no longer name are forgotten, including by players who had lit them.");
    // seed-map.js upserts worlds by name and never deletes one, so a character is never moved to another world.
    expect(text).not.toMatch(/removed world|moves to the entry world/);
  });
  it('cloudflare stop', () => {
    expect(confirmText('cloudflare-stop')).toBe('The current link stops working, and players outside your network cannot connect unless another link is running. Starting it again gives a new address.');
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
    expect(dialogLabels('maps', custom)).toEqual({ title: 'Apply maps', confirm: 'Apply maps' });
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
    expect(jobResultText({ kind: 'maps', state: 'ok' })).toEqual({ tone: 'ok', text: 'Apply maps completed. Run Seed from git again so music reaches the new worlds.' });
    expect(jobResultText({ kind: 'maps', state: 'failed' })).toEqual({ tone: 'bad', text: 'Apply maps failed.' });
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

describe('canOfferRestart (SOMET-722)', () => {
  const st = (name, state) => ({ name, state });
  it('offers it for a finished seed and a seed that failed after something was applied', () => {
    expect(canOfferRestart({ kind: 'seed', state: 'ok', steps: [] })).toBe(true);
    expect(canOfferRestart({ kind: 'seed', state: 'failed', steps: [st('Check the board seed tooling', 'ok'), st('Seed catalogs', 'ok'), st('Seed art', 'failed')] })).toBe(true);
  });
  it('does not offer it for a seed that failed before anything was applied', () => {
    expect(canOfferRestart({ kind: 'seed', state: 'failed', steps: [st('Check the board seed tooling', 'failed')] })).toBe(false);
    expect(canOfferRestart({ kind: 'seed', state: 'failed', steps: [st('Check the board seed tooling', 'ok'), st('Seed catalogs', 'failed')] })).toBe(false);
  });
  it('offers it for a failed Apply maps, and for a finished one only if it did not restart', () => {
    expect(canOfferRestart({ kind: 'maps', state: 'failed', steps: [st('p5-descent', 'ok'), st('vale-region', 'failed')] })).toBe(true);
    expect(canOfferRestart({ kind: 'maps', state: 'ok', steps: [st('p5-descent', 'ok'), st('vale-region', 'ok'), st('restart', 'ok')] })).toBe(false);
    expect(canOfferRestart({ kind: 'maps', state: 'ok', steps: [st('p5-descent', 'ok')] })).toBe(true);
  });
  it('never offers it for running jobs, other kinds, or no job', () => {
    expect(canOfferRestart({ kind: 'seed', state: 'running', steps: [] })).toBe(false);
    expect(canOfferRestart({ kind: 'update', state: 'ok' })).toBe(false);
    expect(canOfferRestart({ kind: 'restart', state: 'ok' })).toBe(false);
    expect(canOfferRestart(null)).toBe(false);
  });
});

describe('historyRow', () => {
  const e = (o = {}) => ({ id: 'a-1', kind: 'update', state: 'ok', startedAt: '2026-11-04T10:00:00.000Z', finishedAt: '2026-11-04T10:07:05.000Z', steps: [], ...o });
  it('names the action, the result and the duration', () => {
    expect(historyRow(e())).toMatchObject({ name: 'Update', result: 'Succeeded', tone: 'ok', duration: '7 min 5 s' });
    expect(historyRow(e({ kind: 'maps', state: 'failed' }))).toMatchObject({ name: 'Apply maps', result: 'Failed', tone: 'bad' });
  });
  it('names a tunnel action by its tunnel', () => {
    expect(historyRow(e({ kind: 'tunnel', steps: [{ name: 'stop ngrok', state: 'ok' }] })).name).toBe('ngrok link');
  });
  it('an unknown kind or missing times do not throw', () => {
    expect(historyRow({ id: 'x', kind: 'odd', state: 'running' })).toMatchObject({ name: 'odd', duration: null, result: 'Running' });
  });
});

describe('shortVersion', () => {
  it('is the first 8 characters of a commit id, and empty for anything else', () => {
    expect(shortVersion('0123456789abcdef0123456789abcdef01234567')).toBe('01234567');
    expect(shortVersion(null)).toBe('');
    expect(shortVersion(42)).toBe('');
  });
});

describe('tunnel switch text (SOMET-738)', () => {
  it('fmtLinkAge keeps the two largest units', () => {
    expect(fmtLinkAge(45 * 60)).toBe('45 min');
    expect(fmtLinkAge(19 * 3600 + 12 * 60)).toBe('19 h 12 min');
    expect(fmtLinkAge(12 * 3600)).toBe('12 h');
    expect(fmtLinkAge(3 * 86400 + 2 * 3600)).toBe('3 d 2 h');
    expect(fmtLinkAge(null)).toBe(null);
    expect(fmtLinkAge(-1)).toBe(null);
  });
  it('names no reset date: ngrok resets on the billing cycle, which is not known here', () => {
    const u = { month: '2026-12', since: Date.UTC(2026, 11, 1), outBytes: 0, outLimitBytes: 1e9, outPercent: 0, requests: 0, requestLimit: 20000, requestPercent: 0 };
    const { limit } = ngrokUsageText({ usage: u, limitReached: true });
    expect(limit).toContain('billing cycle');
    expect(limit).not.toMatch(/\b1(st)?\b|Jan/);
  });
  it('usage warns from 80%, on either allowance', () => {
    const base = { month: '2026-11', since: 0, outBytes: 1, outLimitBytes: 1e9, outPercent: 0, requests: 1, requestLimit: 20000, requestPercent: 0 };
    expect(ngrokUsageText({ usage: base }).warn).toBe(false);
    expect(ngrokUsageText({ usage: { ...base, outPercent: 80 } }).warn).toBe(true);
    expect(ngrokUsageText({ usage: { ...base, requestPercent: 80 } }).warn).toBe(true);
    expect(ngrokUsageText({})).toBe(null);
  });
  it('every switch has a dialog that says the old link survives a failure', () => {
    for (const k of ['ngrok-switch', 'cloudflare-switch']) {
      expect(DIALOG_LABELS[k].confirm).toBe('Switch');
      expect(confirmText(k)).toContain('keeps running');
    }
  });
});

describe('watcherNote (SOMET-738)', () => {
  it('says nothing when the timer is current, missing, or the helper sends nothing', () => {
    expect(watcherNote({ installed: true, stale: false, files: [] })).toBeNull();
    expect(watcherNote({ installed: false, stale: false, files: [] })).toBeNull();
    expect(watcherNote(undefined)).toBeNull();
  });

  it('names what breaks and the command that fixes it when the copy differs', () => {
    const note = watcherNote({ installed: true, stale: true, files: ['reconcile-url.sh'] });
    expect(note).toMatch(/published page and CI hook/);
    expect(note).toContain('make pi-watch-install');
  });
});
