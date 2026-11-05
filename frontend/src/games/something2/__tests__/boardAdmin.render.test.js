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
    expect(html).toContain('Seed copies catalogs, art and audio from git. Creature and character animation sheets are not included yet. It may take a while. Maps are separate.');
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
