import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// SOMET-718: the Orange Pi tab states. SSR render (vitest is node-env).
vi.mock('../useBoard.js', () => ({}));
const { BoardAdminView } = await import('../BoardAdmin.jsx');

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
  it('the seed note says art is not included', () => {
    expect(view()).toMatch(/Art isn(?:'|&#x27;)t included, so world objects stay placeholder boxes/);
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
});
