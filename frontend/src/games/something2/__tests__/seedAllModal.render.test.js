import { describe, it, expect, vi } from 'vitest';
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';

// SSR render of the Seed all modal (vitest is node-env): proves it renders
// without a ReferenceError once previews resolve (SOMET-638).
const rowRed = { syncUuid: 'r1', key: 'wolf', kind: 'only_here', defaultDecision: null, fields: [], blockedReason: null };
const q = (data, extra = {}) => ({ data, isLoading: false, isFetching: false, error: null, refetch: vi.fn(), ...extra });
let queries;
vi.mock('../useSeedExport.js', () => ({
  useSeedPreviews: () => queries,
  useApplyAll: () => ({ mutate: vi.fn(), isPending: false }),
}));

const { default: SeedAllModal } = await import('../SeedAllModal.jsx');
const groups = [{ id: 'a', label: 'Creatures' }, { id: 'b', label: 'Quests' }];

describe('SeedAllModal render', () => {
  it('renders headers, red-row gate and nothing-to-change', () => {
    queries = [q({ rows: [rowRed], signature: 's1', warnings: [] }), q({ rows: [], signature: 's2', warnings: [] })];
    const html = renderToString(h(SeedAllModal, { groups, onClose: () => {} }));
    expect(html).toContain('Creatures');
    expect(html).toContain('Quests');
    expect(html).toContain('nothing to change');
    expect(html).toContain('Nothing to change — this PC already matches git.');
    expect(html).toContain('choose 1 red row first');
  });
  it('lists a group whose preview failed to load as not applied', () => {
    queries = [q({ rows: [], signature: 's1' }), q(undefined, { error: new Error('x') })];
    const html = renderToString(h(SeedAllModal, { groups, onClose: () => {} }));
    expect(html).toContain('Not applied: Quests');
    expect(html).toContain('failed to load');
  });
});
