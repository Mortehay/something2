import { describe, it, expect, vi } from 'vitest';

// SOMET-535 rework 3. The hook must USE queuePollInterval: an idle queue that
// returns `false` here never refetches, so a job queued from outside the page
// stays invisible until a reload. useQuery is stubbed to capture the options
// the hook actually passes.
let captured = null;
vi.mock('@tanstack/react-query', () => ({
  useQuery: (opts) => { captured = opts; return { data: undefined }; },
  useMutation: () => ({}),
  useQueryClient: () => ({}),
}));

const { useArtQueue } = await import('../useArtConsole.js');
const { QUEUE_POLL_BUSY_MS, QUEUE_POLL_IDLE_MS } = await import('../artProgress.js');

const at = (data) => captured.refetchInterval({ state: { data } });

describe('useArtQueue refetch interval', () => {
  it('polls an idle queue slowly instead of stopping', () => {
    useArtQueue();
    expect(at({ run: { running: false }, stats: { queued: 0, running: 0 } })).toBe(QUEUE_POLL_IDLE_MS);
    expect(at(undefined)).toBe(QUEUE_POLL_IDLE_MS);
  });
  it('polls outstanding work fast', () => {
    useArtQueue();
    expect(at({ run: null, stats: { queued: 3, running: 0 } })).toBe(QUEUE_POLL_BUSY_MS);
  });
});
