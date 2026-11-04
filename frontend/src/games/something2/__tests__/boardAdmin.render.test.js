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
    expect(html).toContain('Seed copies catalogs, art and audio from git. It may take a while. Maps are separate.');
    expect(html).not.toMatch(/placeholder boxes|Art isn(?:'|&#x27;)t included/);
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
