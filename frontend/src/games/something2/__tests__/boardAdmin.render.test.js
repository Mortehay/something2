import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// SOMET-718: the Orange Pi tab states. SSR render (vitest is node-env).
vi.mock('../useBoard.js', () => ({}));
const { BoardAdminView } = await import('../BoardAdmin.jsx');
const { ConfirmDialog } = await import('../BoardActions.jsx');

const NOW = 2_000_000_000_000;
const tun = (o = {}) => ({ state: 'off', url: null, verified: false, ageSeconds: null, ...o });
const status = (o = {}) => ({
  available: true, online: true, host: 'opiz03', commit: 'a1b2c3d', behindMain: 12, healthCode: 200, checkedAt: NOW,
  tunnels: { cloudflare: tun(), ngrok: tun() }, ...o,
});
const samples = Array.from({ length: 20 }, (_, i) => ({
  t: NOW - (20 - i) * 15000, online: true, cpuPct: 20 + i, memUsedMb: 1200, memTotalMb: 3900, diskPct: 40,
  connections: 3, net: { eth0: { inBps: 180000, outBps: 620000 } }, pingMs: 4, cloudflareMs: 30, ngrokMs: 50,
}));
const view = (p = {}) => renderToStaticMarkup(h(BoardAdminView, {
  status: status(), samples, job: null, preview: null, range: '1h', now: NOW, onAction: () => {}, onRange: () => {}, ...p,
}));
const btn = (html, text) => (html.match(new RegExp(`<button[^>]*>${text}</button>`)) || [])[0] || '';

describe('Action history panel', () => {
  const entries = [
    { id: 'b-2', kind: 'update', state: 'failed', startedAt: '2026-11-04T10:00:00.000Z', finishedAt: '2026-11-04T10:07:05.000Z', error: 'The deploy failed', steps: [] },
    { id: 'a-1', kind: 'restart', state: 'ok', startedAt: '2026-11-03T09:00:00.000Z', finishedAt: '2026-11-03T09:00:20.000Z', steps: [] },
  ];
  it('lists time, name, result and duration, with no log until one is opened', () => {
    const html = view({ history: entries });
    expect(html).toContain('Action history');
    expect(html).toContain('Update');
    expect(html).toContain('Failed');
    expect(html).toContain('7 min 5 s');
    expect(html).toContain('Restart');
    expect(html).toContain('Succeeded');
    expect(html).not.toContain('<pre');
  });
  it('an empty history says so', () => {
    expect(view({ history: [] })).toContain('No actions recorded yet');
  });
  it('the opened entry shows its log as text, never as markup', () => {
    const evil = '<img src=x onerror=alert(1)> $(touch x)';
    const html = view({ history: entries, historySelected: 'b-2', historyEntry: { ...entries[0], log: evil, error: '<b>bad</b>' } });
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;b&gt;bad&lt;/b&gt;');
  });
  it('shows a loading note while the opened entry is fetched', () => {
    expect(view({ history: entries, historySelected: 'a-1', historyEntry: null })).toContain('Loading the log');
  });
});

const V1 = '0123456789abcdef0123456789abcdef01234567';
const V0 = 'fedcba9876543210fedcba9876543210fedcba98';
const release = (o = {}) => ({
  version: V1, previousVersion: V0, at: '2026-11-04T10:00:00.000Z', sourceBranch: 'main', buildBranch: 'orangepi', ciUrl: 'https://github.com/o/r/actions/runs/9',
  commits: [{ sha: 'a'.repeat(40), subject: 'Add the thing', author: 'Ann' }, { sha: 'b'.repeat(40), subject: '<script>alert(1)</script> $(touch x)', author: 'Bob' }],
  truncated: 0, ...o,
});

describe('Version and Releases', () => {
  it('the status line shows Version with the first 8 characters', () => {
    const html = view({ status: status({ version: V1 }) });
    expect(html).toContain('Version');
    expect(html).toContain('01234567');
    expect(html).not.toContain('0123456789abcdef');
  });
  it('no Version when the helper does not know one', () => {
    expect(view({ status: status() })).not.toContain('Version <');
    expect(view({ status: status() })).not.toMatch(/Version\s*<code/);
  });
  it('lists each release with its version, time and commit subjects as text', () => {
    const html = view({ releases: { source: 'board', releases: [release()] } });
    expect(html).toContain('Releases');
    expect(html).toContain('01234567');
    expect(html).toContain('<details');
    expect(html).toContain('Add the thing');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; $(touch x)');
    expect(html).not.toContain('<script>');
    expect(html).toContain('2 commits');
  });
  it('says what a release lacks: a note, a hook deploy, a truncated list, the laptop copy', () => {
    const html = view({ releases: { source: 'laptop', releases: [release({ commits: [], note: 'No earlier release is recorded', viaHook: true, observed: true, truncated: 7 }), release({ truncated: 7, viaHook: undefined })] } });
    expect(html).toContain('No earlier release is recorded');
    expect(html).toContain('Deployed outside a completed Update');
    expect(html).not.toContain('by CI');
    expect(html).toContain('seen at');
    expect(html).toContain('7 more not shown');
    expect(html).toContain('copy on this PC');
  });
  it('a baseline is labelled neutrally and is not called a deploy', () => {
    const html = view({ releases: { source: 'board', releases: [release({ baseline: true, observed: true, previousVersion: null, commits: [], note: 'The version the board was running when the release history began.' })] } });
    expect(html).toContain('Version in place when history began');
    expect(html).toContain('seen at');
    expect(html).not.toContain('Deployed outside');
  });
  it('an update release shows its time plainly', () => {
    const html = view({ releases: { source: 'board', releases: [release()] } });
    expect(html).not.toContain('seen at');
    expect(html).not.toContain('Deployed outside');
  });
  it('an empty or missing list says so and never throws', () => {
    expect(view({ releases: { source: 'board', releases: [] } })).toContain('No releases recorded yet');
    expect(view({ releases: undefined })).toContain('Releases');
  });
});

describe('BoardAdminView ranges', () => {
  it('has a button for every range and marks the chosen one', () => {
    const html = view({ range: '7d' });
    for (const label of ['15 min', '1 h', '6 h', '24 h', '7 days', '30 days']) expect(btn(html, label)).toContain('<button');
    expect(btn(html, '7 days')).toContain('aria-pressed="true"');
    expect(btn(html, '1 h')).toContain('aria-pressed="false"');
  });
  it('the axis names the long range', () => {
    expect(view({ range: '30d', bucketMs: 5_400_000 })).toContain('-30 days');
  });
});

describe('BoardAdminView', () => {
  it('helper down shows the start command and no action buttons', () => {
    const html = view({ status: { available: false, reason: 'helper_unavailable', hint: 'Run `make pi-helper` first' }, samples: [] });
    expect(html).toContain('make pi-helper');
    expect(html).not.toContain('Update to latest main');
    expect(html).not.toContain('Seed from git');
  });
  it('404 from status explains the tab only works on the workstation', () => {
    const html = view({ status: { available: false, reason: 'not_mounted' }, samples: [] });
    expect(html).toContain('This tab only works in the admin panel on the workstation.');
    expect(html).not.toContain('<button');
  });
  it('a tunnel link renders only when verified', () => {
    const u = 'https://example.ngrok-free.dev';
    const bad = view({ status: status({ tunnels: { cloudflare: tun(), ngrok: tun({ state: 'on', url: u, verified: false }) } }) });
    expect(bad).not.toContain(u);
    expect(bad).not.toContain('>Copy<');
    const good = view({ status: status({ tunnels: { cloudflare: tun(), ngrok: tun({ state: 'on', url: u, verified: true }) } }) });
    expect(good).toContain(`href="${u}"`);
    expect(good).toContain('rel="noopener noreferrer"');
    expect(good).toContain('>Copy<');
  });
  it('a non-http url never becomes a link', () => {
    const html = view({ status: status({ tunnels: { cloudflare: tun(), ngrok: tun({ state: 'on', url: 'javascript:alert(1)', verified: true }) } }) });
    expect(html).not.toContain('javascript:');
  });
  it('actions are disabled with a reason while a job runs', () => {
    const html = view({ job: { id: '1', kind: 'update', state: 'running', startedAt: NOW, steps: [], log: '' } });
    expect(btn(html, 'Update to latest main')).toContain('disabled');
    expect(btn(html, 'Update to latest main')).toContain('title="A job is running"');
    expect(btn(html, 'Seed from git')).toContain('disabled');
  });
  it('actions are disabled when the board is offline', () => {
    const html = view({ status: status({ online: false }) });
    expect(btn(html, 'Update to latest main')).toContain('disabled');
    expect(btn(html, 'Update to latest main')).toContain('The board is offline');
    expect(html).toMatch(/off or unreachable/);
  });
  it('idle and online leaves Update enabled', () => {
    expect(btn(view(), 'Update to latest main')).not.toContain('disabled');
  });
  it('the failed job shows the step, the error and the CI link', () => {
    const job = { id: '2', kind: 'update', state: 'failed', startedAt: NOW - 5000, finishedAt: NOW, error: 'migrate exploded',
      steps: [{ name: 'pull', state: 'ok', detail: '' }, { name: 'migrate', state: 'failed', detail: 'exit 1' }], log: 'line <b>x</b>',
      ciUrl: 'https://github.com/o/r/actions/runs/1' };
    const html = view({ job });
    expect(html).toContain('migrate');
    expect(html).toContain('migrate exploded');
    expect(html).toContain('href="https://github.com/o/r/actions/runs/1"');
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
  it('a javascript: ciUrl is not linked', () => {
    const html = view({ job: { id: '2', kind: 'update', state: 'failed', startedAt: NOW, finishedAt: NOW, steps: [], log: '', error: 'x', ciUrl: 'javascript:alert(1)' } });
    expect(html).not.toContain('javascript:');
  });
  it('the seed note says it copies catalogs, art and audio, may take a while, and that maps are separate', () => {
    const html = view();
    expect(html).toContain('Seed copies catalogs, art, creature and character animation sheets, and audio from git. It may take a while. Maps are separate.');
    expect(html).not.toMatch(/placeholder boxes|Art isn(?:'|&#x27;)t included/);
  });
  it('Game version has an Apply maps button that follows the same disabled rules as the others', () => {
    expect(btn(view(), 'Apply maps')).not.toBe('');
    expect(btn(view(), 'Apply maps')).not.toContain('disabled');
    const running = view({ job: { id: '1', kind: 'update', state: 'running', startedAt: NOW, steps: [], log: '' } });
    expect(btn(running, 'Apply maps')).toContain('disabled');
    expect(btn(running, 'Apply maps')).toContain('title="A job is running"');
    expect(btn(view({ status: status({ online: false }) }), 'Apply maps')).toContain('The board is offline');
  });
  it('a finished maps job shows its plain result and offers no extra Restart (it restarted)', () => {
    const html = view({ job: { id: '4', kind: 'maps', state: 'ok', startedAt: NOW - 9000, finishedAt: NOW, steps: [{ name: 'p5-descent', state: 'ok' }, { name: 'vale-region', state: 'ok' }, { name: 'restart', state: 'ok' }], log: '' } });
    expect(html).toContain('Apply maps completed.');
    expect(html).toContain('Last action: Apply maps');
    expect(btn(html, 'Restart')).toBe('');
  });
  it('a failed maps job offers Restart (the message tells the owner to press it)', () => {
    const html = view({ job: { id: '5', kind: 'maps', state: 'failed', error: 'x', startedAt: NOW - 9000, finishedAt: NOW, steps: [{ name: 'p5-descent', state: 'ok' }, { name: 'vale-region', state: 'failed' }], log: '' } });
    expect(btn(html, 'Restart')).not.toBe('');
  });
  it('a seed that failed before applying anything offers no Restart', () => {
    const html = view({ job: { id: '6', kind: 'seed', state: 'failed', error: 'x', startedAt: NOW - 9000, finishedAt: NOW, steps: [{ name: 'Check the board seed tooling', state: 'failed' }], log: '' } });
    expect(btn(html, 'Restart')).toBe('');
  });
  it('a finished seed offers Restart with the old-data note', () => {
    const html = view({ job: { id: '3', kind: 'seed', state: 'ok', startedAt: NOW - 9000, finishedAt: NOW, steps: [], log: '' } });
    expect(html).toContain('running game still uses the old data until it is restarted');
    expect(btn(html, 'Restart')).not.toBe('');
  });
  it('no Restart offer after a finished update', () => {
    const html = view({ job: { id: '3', kind: 'update', state: 'ok', startedAt: NOW - 9000, finishedAt: NOW, steps: [], log: '' } });
    expect(btn(html, 'Restart')).toBe('');
  });
  it('charts show the latest value, or No data', () => {
    const html = view();
    expect(html).toContain('CPU');
    expect(html).toContain('39%');
    expect(html).toContain('1.2 / 3.9 GB');
    const none = view({ samples: [] });
    expect(none).toContain('No data');
  });
  it('network labels say In and Out for one interface, name them for several', () => {
    expect(view()).toMatch(/>In</);
    const multi = samples.map((s) => ({ ...s, net: { eth0: { inBps: 1, outBps: 2 }, wlan0: { inBps: 3, outBps: 4 } } }));
    const html = view({ samples: multi });
    expect(html).toContain('eth0 in');
    expect(html).toContain('wlan0 out');
  });
  it('offline samples leave a visible gap in the line', () => {
    const gappy = samples.map((s, i) => (i >= 8 && i < 12 ? { ...s, online: false } : s));
    const lines = (html) => (html.match(/<polyline/g) || []).length;
    expect(lines(view({ samples: gappy }))).toBeGreaterThan(lines(view()));
  });

  it('actions are disabled while a request is in flight', () => {
    const html = view({ pending: true });
    expect(btn(html, 'Update to latest main')).toContain('disabled');
    expect(btn(html, 'Seed from git')).toContain('disabled');
    expect(btn(html, 'Start')).toContain('disabled');
  });
  it('offline: says last seen, shows no tunnel link or Copy', () => {
    const u = 'https://example.ngrok-free.dev';
    const html = view({ status: status({ online: false, tunnels: { cloudflare: tun(), ngrok: tun({ state: 'on', url: u, verified: true }) } }) });
    expect(html).toContain('last seen');
    expect(html).not.toContain('Running <code');
    expect(html).not.toContain(u);
    expect(html).not.toContain('>Copy<');
  });
  it('a failed poll that keeps old data says when the status was last checked', () => {
    const html = view({ staleSince: NOW - 90000 });
    expect(html).toMatch(/Could not refresh.*last checked/i);
    expect(view()).not.toMatch(/last checked/i);
  });
  it('an on tunnel with no verified link says it is not answering and offers Stop', () => {
    const html = view({ status: status({ tunnels: { cloudflare: tun(), ngrok: tun({ state: 'on', url: 'https://x.example', verified: false }) } }) });
    expect(html).toContain("Running, but the link isn&#x27;t answering");
    expect(html).not.toContain('waiting');
    expect(btn(html, 'Stop')).not.toBe('');
  });
  it('with the other link on, a stopped link offers a switch; with both off, a start', () => {
    const u = 'https://x.trycloudflare.com';
    const on = view({ status: status({ tunnels: { cloudflare: tun({ state: 'on', url: u, verified: true }), ngrok: tun({ state: 'off' }) } }) });
    expect(on).toContain('Switch to ngrok');
    const off = view({ status: status({ tunnels: { cloudflare: tun({ state: 'off' }), ngrok: tun({ state: 'off' }) } }) });
    expect(off).not.toContain('Switch to');
    expect(off).toContain('Start');
  });

  it('a running job says in words why the tunnel buttons are disabled', () => {
    const html = view({
      status: status({ tunnels: { cloudflare: tun({ state: 'on', url: 'https://x.trycloudflare.com', verified: true }), ngrok: tun({ state: 'off' }) } }),
      job: { kind: 'seed', state: 'running', steps: [] },
    });
    expect(html).toContain('A job is running. Start, Stop and Switch work again once it finishes.');
  });

  it('ngrok shows its usage as percentages, and its refusal instead of a link', () => {
    const usage = { month: '2026-11', since: Date.UTC(2026, 10, 5), outBytes: 120000000, outLimitBytes: 1000000000, outPercent: 12, requests: 400, requestLimit: 20000, requestPercent: 2 };
    const fine = view({ status: status({ tunnels: { cloudflare: tun({ state: 'off' }), ngrok: tun({ state: 'on', url: 'https://n.ngrok-free.dev', verified: true, usage }) } }) });
    expect(fine).toContain('0.12 GB of 1.0 GB out (12%)');
    expect(fine).toContain('400 of 20,000 requests (2%)');
    expect(fine).toContain('Estimate from this board since 5 Nov');
    expect(fine).toContain('https://n.ngrok-free.dev');
    const refused = view({ status: status({ tunnels: { cloudflare: tun({ state: 'off' }), ngrok: tun({ state: 'on', url: 'https://n.ngrok-free.dev', verified: true, usage, limitReached: true }) } }) });
    expect(refused).toContain('used its allowance for the month');
    expect(refused).toContain('until 1 Dec');
    expect(refused).not.toContain('>https://n.ngrok-free.dev<');
  });

  it('Cloudflare shows its age and earlier links, and invents no time left', () => {
    const html = view({ status: status({ tunnels: { ngrok: tun({ state: 'off' }), cloudflare: tun({ state: 'on', url: 'https://x.trycloudflare.com', verified: true, ageSeconds: 69120, pastLinkSeconds: [46800, 43200] }) } }) });
    expect(html).toContain('Up 19 h 12 min.');
    expect(html).toContain('Earlier links lasted: 13 h, 12 h.');
    expect(html).toContain('the time left is not known');
  });

  it('a missing tunnels object is Unknown, with no Start', () => {
    const html = view({ status: status({ tunnels: undefined }) });
    expect(html).toContain('Unknown');
    expect(html).not.toContain('Stopped');
    expect(btn(html, 'Start')).toBe('');
  });
  it('an unrecognised tunnel state is Unknown, with no Start', () => {
    const html = view({ status: status({ tunnels: { cloudflare: tun({ state: 'starting' }), ngrok: tun() } }) });
    expect(html).toContain('Unknown');
    expect((html.match(/>Start</g) || []).length).toBe(1);
  });
  it('the midAction notice stays inline in the Last action box', () => {
    const html = view({ notice: 'unknown whether the action happened' });
    expect(html).toContain('unknown whether the action happened');
  });
  it('the Update dialog button label comes from an explicit map', () => {
    const html = renderToStaticMarkup(h(ConfirmDialog, { kind: 'restart', status: status(), job: null, pending: false, preview: null, now: NOW, onConfirm: () => {}, onClose: () => {}, onPreviewAgain: () => {} }));
    expect(btn(html, 'Restart')).not.toBe('');
  });
});

describe('branch names in the UI (SOMET-719)', () => {
  it('the button and dialog use the helper-reported branches', () => {
    const st = status({ sourceBranch: 'dev', buildBranch: 'build' });
    const html = view({ status: st });
    expect(btn(html, 'Update to latest dev')).toContain('<button');
    expect(html).not.toContain('Update to latest main');
    const d = renderToStaticMarkup(h(ConfirmDialog, { kind: 'update', status: st, job: null, pending: false, preview: null, now: NOW, onConfirm: () => {}, onClose: () => {}, onPreviewAgain: () => {} }));
    expect(d).toContain('Update to latest dev');
    expect(d).toContain('Merge dev into build and build build');
  });
});

describe('ConfirmDialog', () => {
  const dlg = (p) => renderToStaticMarkup(h(ConfirmDialog, { kind: 'update', status: status(), job: null, pending: false, preview: null, now: NOW, onConfirm: () => {}, onClose: () => {}, onPreviewAgain: () => {}, ...p }));
  it('the seed dialog shows how many art and audio files will be copied', () => {
    const preview = { state: 'ready', loadedAt: NOW - 1000, data: { needsUpdate: false, groups: [{ group: 'items', add: 0, change: 0, remove: 0, overwrite: 0, blocked: 0 }], files: { art: 1364, audio: 7205 } } };
    const html = dlg({ kind: 'seed', preview });
    expect(html).toContain('1,364 art files and 7,205 audio files');
  });
  it('the Apply maps dialog shows the maps copy and confirms with Apply maps', () => {
    const html = dlg({ kind: 'maps' });
    expect(html).toContain("Apply the laptop&#x27;s maps (p5-descent, then vale-region) to the board, then restart the game.");
    expect(btn(html, 'Apply maps')).not.toBe('');
    expect(btn(html, 'Apply maps')).not.toContain('disabled');
    expect(btn(dlg({ kind: 'maps', job: { id: '1', kind: 'seed', state: 'running' } }), 'Apply maps')).toContain('disabled');
  });
  it('confirm disables when the board goes offline with the dialog open', () => {
    const html = dlg({ status: status({ online: false }) });
    expect(btn(html, 'Update')).toContain('disabled');
    expect(btn(html, 'Update')).toContain('The board is offline');
  });
  it('confirm disables when a job starts or a request is in flight', () => {
    expect(btn(dlg({ job: { id: '1', kind: 'seed', state: 'running' } }), 'Update')).toContain('disabled');
    expect(btn(dlg({ pending: true }), 'Update')).toContain('disabled');
    expect(btn(dlg(), 'Update')).not.toContain('disabled');
  });
  it('the update dialog never says 0 commits', () => {
    expect(dlg({ status: status({ behindMain: 0 }) })).not.toContain('0 commits');
  });
  it('an old seed preview disables Apply and offers Preview again', () => {
    const preview = { state: 'ready', loadedAt: NOW - 5 * 60 * 1000, data: { needsUpdate: false, groups: [{ group: 'a', add: 1, change: 0, remove: 0, overwrite: 0, blocked: 0 }] } };
    const old = dlg({ kind: 'seed', preview });
    expect(btn(old, 'Apply')).toContain('disabled');
    expect(old).toContain('Preview again');
    const fresh = dlg({ kind: 'seed', preview: { ...preview, loadedAt: NOW - 1000 } });
    expect(btn(fresh, 'Apply')).not.toContain('disabled');
    expect(fresh).not.toContain('Preview again');
  });
});

describe('finished job result (SOMET-718)', () => {
  it('the Last action box leads with the plain result', () => {
    const job = { id: 'j', kind: 'update', state: 'ok', targetSha: 'abcdef0123456789', steps: [{ name: 'backup', state: 'ok' }], log: '' };
    const html = view({ job });
    expect(html).toContain('Update completed. The board is running abcdef01.');
    expect(html).toContain('var(--s2-success)');
    const bad = view({ job: { ...job, state: 'failed', error: 'boom', steps: [{ name: 'ci', state: 'failed' }] } });
    expect(bad).toContain('Update failed at ci.');
    expect(bad).toContain('boom');
  });
});

describe('the hook posts Apply maps to the route', () => {
  it('useBoard.js maps the action to /maps/apply', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../useBoard.js', import.meta.url), 'utf8');
    expect(src).toMatch(/maps: '\/maps\/apply'/);
  });
});

// SOMET-720. Players and bosses.
const { PlayersTable, BossesTable, SummonDialog } = await import('../BoardLive.jsx');
const { summonConfirm, summonBlock, summonBody, bossStatus, bossKey, bossPlayersThere } = await import('../boardModel.js');

const player = (o = {}) => ({
  name: 'tester_one', level: 12, world: 'Starting vale', sessionSeconds: 2520, sessionStart: '2026-11-04T10:00:00Z',
  mobKills: 256, pvpKills: 0, mobKillsPerMin: 6.1, pvpKillsPerMin: 0, deaths: 2,
  lifetime: { mobKills: 900, pvpKills: 4, deaths: 9, bossKills: 1, playSeconds: 9000, sessions: 3 }, pingMs: 41.4, ...o,
});
const worldUp = { owner: 'world', name: 'Gorgon', tier: 'world', world: 'Starting vale', players: 3, status: 'alive', hpPct: 62, fighters: 2, summonWorld: { name: 'Starting vale', players: 3 }, replaces: 'Gorgon' };
const worldDown = { owner: 'world', name: 'Ember King', tier: 'world', world: null, players: null, status: 'not_spawned', nextRotationSeconds: null, summonWorld: { name: 'Starting vale', players: 3 }, replaces: 'Gorgon', replacesFighters: 2 };
const dungeonDead = { owner: 'dungeon', name: 'Bone Regent', tier: 'dungeon_end', world: 'Ossuary', players: 1, status: 'dead', secondsUntilReturn: 420 };
const dungeonFar = { owner: 'dungeon', name: 'Shade Herald', tier: 'dungeon_elite', world: 'Deep Hall', players: 0, status: 'not_loaded' };
const bossTable = (bosses, p = {}) => renderToStaticMarkup(h(BossesTable, {
  data: { available: true, bosses }, status: status(), job: null, onSummon: () => {}, ...p,
}));

describe('Players online table', () => {
  it('names, session and rates, with ping and a total', () => {
    const html = renderToStaticMarkup(h(PlayersTable, { data: { available: true, players: [player()] } }));
    expect(html).toContain('Players online (1)');
    expect(html).toContain('tester_one');
    expect(html).toContain('Starting vale');
    expect(html).toContain('42 min');
    expect(html).toContain('6.1');
    expect(html).toContain('41 ms');
    expect(html).toContain('904');
  });
  it('ping before the first pong and an unknown level show a dash', () => {
    const html = renderToStaticMarkup(h(PlayersTable, { data: { available: true, players: [player({ pingMs: null, level: null })] } }));
    expect(html).not.toContain(' ms');
    expect(html).toContain('–');
  });
  it('nobody online says so', () => {
    expect(renderToStaticMarkup(h(PlayersTable, { data: { available: true, players: [] } }))).toContain('Nobody is playing');
  });
  it('an older board image says to press Update, as text', () => {
    const html = renderToStaticMarkup(h(PlayersTable, { data: { available: false, reason: 'no_listener', message: 'Press Update.' } }));
    expect(html).toContain('Press Update.');
    expect(html).not.toContain('<table');
  });
  it('a name with markup in it is text', () => {
    const html = renderToStaticMarkup(h(PlayersTable, { data: { available: true, players: [player({ name: '<img src=x onerror=alert(1)>' })] } }));
    expect(html).toContain('&lt;img src=x');
    expect(html).not.toContain('<img src=x');
  });
});

describe('Bosses table', () => {
  it('each status in words, not colour alone', () => {
    const html = bossTable([worldUp, worldDown, dungeonDead, dungeonFar]);
    expect(html).toContain('Alive');
    expect(html).toContain('62% HP, 2 have fought it');
    expect(bossTable([{ ...worldUp, fighters: 1 }])).toContain('1 has fought it');
    expect(html).toContain('Players there');
    expect(html).toContain('Not spawned');
    expect(html).toContain('next rotation after the current boss');
    expect(html).toContain('Dead');
    expect(html).toContain('back in 7 min');
    expect(html).toContain('Not loaded');
    expect(html).toContain('Dungeon end');
    expect(html).toContain('Dungeon elite');
  });
  it('Resummon for a live or dead boss, Summon now otherwise', () => {
    expect(btn(bossTable([worldUp]), 'Resummon')).not.toBe('');
    expect(btn(bossTable([dungeonDead]), 'Resummon')).not.toBe('');
    expect(btn(bossTable([worldDown]), 'Summon now')).not.toBe('');
  });
  it('an unloaded dungeon has its button disabled, with the reason', () => {
    const b = btn(bossTable([dungeonFar]), 'Summon now');
    expect(b).toContain('disabled');
    expect(b).toContain('not loaded');
  });
  it('no world loaded disables a world boss', () => {
    const b = btn(bossTable([{ ...worldDown, summonWorld: null, replaces: null }]), 'Summon now');
    expect(b).toContain('disabled');
    expect(b).toContain('nobody is playing');
  });
  it('a running job or an offline board disables every summon', () => {
    expect(btn(bossTable([worldDown], { job: { id: 'j', kind: 'update', state: 'running' } }), 'Summon now')).toContain('disabled');
    expect(btn(bossTable([worldDown], { status: status({ online: false }) }), 'Summon now')).toContain('disabled');
  });
  it('an older board image says to press Update', () => {
    const html = bossTable([], { data: { available: false, reason: 'no_listener', message: 'Press Update.' } });
    expect(html).toContain('Press Update.');
  });
});

describe('Summon dialog', () => {
  const dialog = (boss, p = {}) => renderToStaticMarkup(h(SummonDialog, { boss, status: status(), job: null, onConfirm: () => {}, onClose: () => {}, ...p }));
  it('a world boss names the boss, the world, the players and what it replaces', () => {
    const html = dialog(worldDown);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('Ember King');
    expect(html).toContain('World: Starting vale');
    expect(html).toContain('Players in that world: 3');
    expect(html).toContain('This replaces Gorgon');
  });
  it('resummoning the live world boss does not call it a different boss', () => {
    const html = dialog(worldUp);
    expect(html).toContain('It is up now');
    expect(html).not.toContain('This replaces Gorgon');
  });
  it('a dungeon boss names its world and players, and says what happens', () => {
    const html = dialog(dungeonDead);
    expect(html).toContain('Bone Regent');
    expect(html).toContain('World: Ossuary');
    expect(html).toContain('Players in that world: 1');
    expect(html).toContain('clears its timer');
  });
  it('a dungeon gone unloaded while open blocks the confirm and says so', () => {
    const html = dialog(dungeonFar);
    expect(html).toContain('not loaded');
    expect(btn(html, 'Summon now')).toContain('disabled');
  });
  it('a boss that left the list leaves nothing to confirm', () => {
    const html = dialog(null);
    expect(html).toContain('no longer on the list');
    expect(html).not.toContain('--s2-btn-primary');
  });
  it('a boss name with markup is text', () => {
    const html = dialog({ ...dungeonDead, name: '<script>x</script>' });
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>x');
  });
  it('a job started while it is open blocks the confirm', () => {
    expect(btn(dialog(worldDown, { job: { id: 'j', kind: 'seed', state: 'running' } }), 'Summon now')).toContain('disabled');
  });
});

describe('Summon rules', () => {
  it('a fight on says who loses it, on whichever boss goes; no fight says nothing', () => {
    expect(summonConfirm(worldDown).lines.join(' ')).toContain('2 fighters lose their progress and get no loot.');
    expect(summonConfirm({ ...worldDown, replacesFighters: 1 }).lines.join(' ')).toContain('1 fighter loses their progress and gets no loot.');
    expect(summonConfirm({ ...worldDown, replacesFighters: 0 }).lines.join(' ')).not.toContain('progress');
    const alive = { owner: 'dungeon', name: 'B', tier: 'dungeon_end', world: 'W', players: 1, status: 'alive', hpPct: 50, fighters: 3 };
    expect(summonConfirm(alive).lines.join(' ')).toContain('3 fighters lose');
    expect(summonConfirm(dungeonDead).lines.join(' ')).not.toContain('progress');
  });
  it('Players there is for the world Where shows', () => {
    // A live boss in a non-arena world, with the next summon landing elsewhere.
    expect(bossPlayersThere({ ...worldUp, players: 5, summonWorld: { name: 'Other', players: 9 } })).toBe(5);
    expect(bossPlayersThere(worldDown)).toBe(3);
    expect(bossPlayersThere(dungeonDead)).toBe(1);
    expect(bossPlayersThere({ ...worldDown, summonWorld: null })).toBeNull();
  });
  it('sends where the dialog named: the summon world for a world boss, the placement for a dungeon', () => {
    expect(summonBody(worldDown)).toEqual({ owner: 'world', name: 'Ember King', world: 'Starting vale', replaces: 'Gorgon' });
    expect(summonBody(dungeonDead)).toEqual({ owner: 'dungeon', name: 'Bone Regent', world: 'Ossuary', replaces: null });
  });
  it('a world boss on a post keeps its own row for the dungeon owner', () => {
    expect(bossKey(worldUp)).not.toBe(bossKey({ ...worldUp, owner: 'dungeon' }));
    expect(summonBlock({ owner: 'dungeon', status: 'alive' })).toBeNull();
  });
  it('a dead boss past its timer but held back by players says so', () => {
    expect(bossStatus({ ...dungeonDead, secondsUntilReturn: 0 }).detail).toContain('no player is near');
  });
  it('confirm text carries the title and the button', () => {
    expect(summonConfirm(dungeonDead).title).toBe('Resummon Bone Regent?');
    expect(summonConfirm(worldDown).confirm).toBe('Summon now');
  });
});

describe('Live charts', () => {
  const live = samples.map((s, i) => ({ ...s, players: 2, mobKillsPerMin: 4 + i, pvpKillsPerMin: 1 }));
  it('Players and Kills per min read the latest sample', () => {
    const html = view({ samples: live });
    expect(html).toContain('aria-label="Players chart"');
    expect(html).toContain('aria-label="Kills per min chart"');
    expect(html).toContain('Mobs 23.0');
    expect(html).toContain('PvP 1.0');
  });
  it('samples from before the listener are "No data", never zero', () => {
    const html = view({ samples });
    const players = html.slice(html.indexOf('aria-label="Players chart"'), html.indexOf('aria-label="Kills per min chart"'));
    expect(players).toContain('No data');
    expect(players).not.toContain('<polyline');
  });
  it('the tables sit under the charts in the same page', () => {
    const html = view({ samples: live, players: { available: true, players: [player()] }, bosses: { available: true, bosses: [worldUp] } });
    expect(html.indexOf('aria-label="Network chart"')).toBeLessThan(html.indexOf('aria-label="Players online"'));
    expect(html.indexOf('aria-label="Players online"')).toBeLessThan(html.indexOf('aria-label="Bosses"'));
  });
  it('a summon job has a name in Last action and the history', () => {
    const html = view({ job: { id: 'j', kind: 'summon', state: 'failed', error: 'Deep Hall is not loaded.', steps: [{ name: 'Summon Shade Herald', state: 'failed' }] } });
    expect(html).toContain('Summon failed.');
    expect(html).toContain('Deep Hall is not loaded.');
    expect(view({ history: [{ id: 'j', kind: 'summon', state: 'ok', steps: [] }] })).toContain('Summon');
  });
});
