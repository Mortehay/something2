import { describe, it, expect, vi, beforeEach } from 'vitest';
import toast from 'react-hot-toast';
import { toastWorldsError, WORLDS_ERROR_TOAST_ID } from '../useWorlds.js';

// F-023: MapsAdmin destructured {worlds, isLoadingWorlds} from useWorlds()
// and never read worldsError, so a failed /api/worlds fetch rendered the
// same "no maps yet" empty state as a genuinely empty catalog — no toast,
// no visible difference. The fix centralizes the error->toast mapping in
// useWorlds() itself (toastWorldsError) so every caller gets it for free,
// mirroring the pattern Something2.jsx already used for itself.
vi.mock('react-hot-toast', () => ({
  default: { error: vi.fn(), success: vi.fn() },
}));

beforeEach(() => {
  toast.error.mockClear();
});

describe('toastWorldsError', () => {
  it('surfaces a failed /api/worlds fetch as a visible toast', () => {
    toastWorldsError(new Error('Failed to fetch worlds'));
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith(
      'Failed to load worlds: Failed to fetch worlds',
      { id: WORLDS_ERROR_TOAST_ID },
    );
  });

  it('does nothing when the query has no error (the genuinely-empty-catalog case)', () => {
    toastWorldsError(null);
    toastWorldsError(undefined);
    expect(toast.error).not.toHaveBeenCalled();
  });

  // Since the sidebar-nav split, GameShell and GameView are both mounted on
  // /game and both call useWorlds(), so a single failed fetch reached this
  // helper twice and stacked two identical toasts. Every call must carry the
  // same id -- that is what makes react-hot-toast update the live toast instead
  // of adding another. Asserting the id is stable ACROSS calls is the part that
  // catches a regression; asserting one call's shape is not enough.
  it('uses one stable toast id, so two mounted callers cannot stack duplicates', () => {
    toastWorldsError(new Error('Failed to fetch worlds'));   // GameShell
    toastWorldsError(new Error('Failed to fetch worlds'));   // GameView

    expect(toast.error).toHaveBeenCalledTimes(2);
    const ids = toast.error.mock.calls.map(([, opts]) => opts?.id);
    expect(ids).toEqual([WORLDS_ERROR_TOAST_ID, WORLDS_ERROR_TOAST_ID]);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBeTruthy();
  });
});
