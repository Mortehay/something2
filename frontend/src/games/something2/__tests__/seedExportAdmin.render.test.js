import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// SOMET-640 (plan 3): a binary group's row shows its background job; while
// any job runs, every export and seed button is disabled. SSR render (vitest
// is node-env, no DOM).
vi.mock('../useSeedExport.js', () => ({}));
const { GroupRow } = await import('../SeedExportAdmin.jsx');

const art = { id: 'art', label: 'Art', binary: true, status: 'local_edits', localEdits: 3, gitChanges: 0, inGit: { exported_at: '2026-10-19T10:00:00Z', exported_by: 'desk' }, lastExport: null, lastSeed: null };
const quests = { id: 'quests', label: 'Quests', binary: false, status: 'local_edits', localEdits: 1, gitChanges: 0, inGit: { exported_at: '2026-10-19T10:00:00Z', exported_by: 'desk' }, lastExport: null, lastSeed: null };
const running = { id: 7, groupId: 'art', action: 'export', phase: 'download', done: 120, total: 1100, status: 'running', error: null, cancelRequested: false };
const BUSY = 'title="Another export or seed is running"';
const row = (g, job) => renderToStaticMarkup(h('table', null, h('tbody', null, h(GroupRow, {
  g, job, restartRequired: false, onExport: () => {}, onSeed: () => {}, onBadge: () => {}, onCancel: () => {},
}))));
const btn = (html, text) => (html.match(new RegExp(`<button[^>]*>${text}</button>`)) || [])[0] || '';

describe('GroupRow with a running job', () => {
  it('the job\'s binary row shows progress and an enabled Cancel; Export and Seed are disabled', () => {
    const html = row(art, running);
    expect(html).toContain('<progress');
    expect(html).toContain('Downloading art 120 / 1100');
    expect(btn(html, 'Cancel')).not.toContain('disabled');
    expect(btn(html, 'Export')).toContain('disabled');
    expect(btn(html, 'Export')).toContain(BUSY);
    expect(btn(html, 'Seed…')).toContain('disabled');
    expect(btn(html, 'Seed…')).toContain(BUSY);
  });
  it('a requested cancel disables Cancel and says Cancelling…', () => {
    const html = row(art, { ...running, cancelRequested: true });
    expect(html).toContain('Cancelling…');
    expect(btn(html, 'Cancel')).toContain('disabled');
  });
  it('another group\'s buttons are disabled with the busy tooltip and show no progress', () => {
    const html = row(quests, running);
    expect(html).not.toContain('<progress');
    expect(btn(html, 'Export')).toContain(BUSY);
    expect(btn(html, 'Seed…')).toContain(BUSY);
  });
  it('idle: buttons enabled; a failed job shows its error and up to 5 rows', () => {
    const failed = { ...running, status: 'failed', error: 'regenerate or clear these images first', errorDetails: { rows: Array.from({ length: 6 }, (_, i) => ({ key: `img${i}` })) } };
    const html = row(art, failed);
    expect(btn(html, 'Export')).not.toContain('disabled');
    expect(html).not.toContain('<progress');
    expect(html).toContain('Failed: regenerate or clear these images first');
    expect(html).toContain('img0, img1, img2, img3, img4 +1 more');
    expect(row(quests, null)).not.toContain('disabled');
  });
});
