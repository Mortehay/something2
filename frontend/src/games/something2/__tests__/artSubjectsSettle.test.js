// The REAL useArtSubjects hook re-reads the catalogue when a batch ends
// (SOMET-538 re-validation, mutant M7).
//
// artProgress.test.js proves batchJustSettled's truth table, but nothing called
// the hook, so `if (false && batchJustSettled(...))` inside it stayed green --
// and that refetch is the only thing that shows the last subjects of a run
// without a manual reload. This drives the hook itself through a run.
import {
  describe, it, expect, vi, beforeEach,
} from 'vitest';
import { createRuntime } from './artConsoleWiring.helpers.js';

const rt = createRuntime();
const invalidateQueries = vi.fn();
const queryCalls = [];

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    useState: (...a) => rt.hooks.useState(...a),
    useRef: (...a) => rt.hooks.useRef(...a),
    useMemo: (...a) => rt.hooks.useMemo(...a),
    useCallback: (...a) => rt.hooks.useCallback(...a),
    useEffect: (...a) => rt.hooks.useEffect(...a),
  };
});
vi.mock('@tanstack/react-query', () => ({
  useQuery: (opts) => { queryCalls.push(opts); return { data: undefined, isLoading: false, error: null }; },
  useQueryClient: () => ({ invalidateQueries }),
  useMutation: () => ({}),
}));

const { useArtSubjects } = await import('../useArtConsole.js');

const renderLive = (live) => rt.render(() => useArtSubjects({ live }));

describe('useArtSubjects: catalogue refetch when a batch settles', () => {
  beforeEach(() => {
    rt.slots = [];
    invalidateQueries.mockClear();
    queryCalls.length = 0;
  });

  it('refetches the catalogue exactly once on the running -> idle edge', () => {
    renderLive(true);
    renderLive(true);
    expect(invalidateQueries).not.toHaveBeenCalled();
    renderLive(false);
    expect(invalidateQueries).toHaveBeenCalledTimes(1);
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['art-subjects'] });
    // Staying idle is not another edge.
    renderLive(false);
    expect(invalidateQueries).toHaveBeenCalledTimes(1);
  });

  it('does not refetch when a page opens idle, or when a run starts', () => {
    renderLive(false);
    renderLive(false);
    renderLive(true);
    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it('a second run ending refetches again', () => {
    renderLive(true);
    renderLive(false);
    renderLive(true);
    renderLive(false);
    expect(invalidateQueries).toHaveBeenCalledTimes(2);
  });

  it('polls only while live, and reads the same key it invalidates', () => {
    renderLive(true);
    renderLive(false);
    expect(queryCalls[0].refetchInterval).toBe(15000);
    expect(queryCalls[1].refetchInterval).toBe(false);
    expect(queryCalls[0].queryKey).toEqual(['art-subjects']);
  });
});
