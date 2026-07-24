import { describe, it, expect, vi, beforeEach } from 'vitest';
import toast from 'react-hot-toast';
import { toastWorldsError } from '../useWorlds.js';

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
    expect(toast.error).toHaveBeenCalledWith('Failed to load worlds: Failed to fetch worlds');
  });

  it('does nothing when the query has no error (the genuinely-empty-catalog case)', () => {
    toastWorldsError(null);
    toastWorldsError(undefined);
    expect(toast.error).not.toHaveBeenCalled();
  });
});
