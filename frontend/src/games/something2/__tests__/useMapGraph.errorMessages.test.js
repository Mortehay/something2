import { describe, it, expect, vi, beforeEach } from 'vitest';
import toast from 'react-hot-toast';
import { toastGraphError } from '../useMapGraph.js';

// Item B of the final review wave: useWorldGraph destructured only
// {data, isLoading}, so a failed /api/world-graph fetch rendered worlds: [],
// links: [], isLoadingGraph: false -- an empty canvas with a green "No
// problems found." consistency panel, a positive claim about state the
// client never received. Mirrors useWorlds.js's F-023 remedy: centralize the
// error->toast mapping in the hook itself so no call site can opt out.
vi.mock('react-hot-toast', () => ({
  default: { error: vi.fn(), success: vi.fn() },
}));

beforeEach(() => {
  toast.error.mockClear();
});

describe('toastGraphError', () => {
  it('surfaces a failed /api/world-graph fetch as a visible toast', () => {
    toastGraphError(new Error('Failed to load the world graph'));
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith('Failed to load the world graph: Failed to load the world graph');
  });

  it('does nothing when the query has no error (the genuinely-empty-graph case)', () => {
    toastGraphError(null);
    toastGraphError(undefined);
    expect(toast.error).not.toHaveBeenCalled();
  });
});
