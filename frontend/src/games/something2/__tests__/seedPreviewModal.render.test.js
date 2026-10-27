import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';

// SOMET-640: a busy refusal keeps the preview open and says why.
let applyState;
vi.mock('../useSeedExport.js', () => ({
  useSeedPreview: () => ({
    isLoading: false, error: null, refetch: vi.fn(),
    data: { signature: 's1', warnings: [], tables: [{ table: 'quests' }], rows: [
      { syncUuid: 'u1', table: 'quests', key: 'Q1', kind: 'changed', defaultDecision: 'git', fields: [], blockedReason: null },
    ] },
  }),
  useApplySeed: () => applyState,
}));
const { default: SeedPreviewModal } = await import('../SeedPreviewModal.jsx');
const group = { id: 'quests', label: 'Quests' };

describe('SeedPreviewModal busy refusal', () => {
  it('shows the busy alert when apply failed busy', () => {
    const err = Object.assign(new Error('Another export or seed is running'), { code: 'busy' });
    applyState = { mutate: vi.fn(), isPending: false, error: err };
    const html = renderToString(h(SeedPreviewModal, { group, onClose: () => {} }));
    expect(html).toMatch(/role="alert"[^>]*>Another export or seed is running</);
  });
  it('no alert for other refusals or when idle', () => {
    applyState = { mutate: vi.fn(), isPending: false, error: Object.assign(new Error('x'), { code: 'stale_preview' }) };
    expect(renderToString(h(SeedPreviewModal, { group, onClose: () => {} }))).not.toContain('role="alert"');
    applyState = { mutate: vi.fn(), isPending: false, error: null };
    expect(renderToString(h(SeedPreviewModal, { group, onClose: () => {} }))).not.toContain('role="alert"');
  });
  it('Apply is disabled with the busy tooltip while a job runs', () => {
    applyState = { mutate: vi.fn(), isPending: false, error: null };
    const html = renderToString(h(SeedPreviewModal, { group, onClose: () => {}, busy: true }));
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="Another export or seed is running"[^>]*>Apply</);
  });
});
