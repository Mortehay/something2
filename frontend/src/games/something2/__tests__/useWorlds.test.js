import { describe, it, expect, vi, beforeEach } from 'vitest';
import toast from 'react-hot-toast';
import { toastWorldsError, WORLDS_ERROR_TOAST_ID, worldsRequestUrl } from '../useWorlds.js';

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

// SOMET-276: GET /api/worlds now requires auth and scopes its response to
// the caller's active character. useWorlds() itself can't be rendered in
// this suite (no DOM testing library -- see autoJoin.js's own note), so this
// pins the one piece of new logic with real branching: whether/how
// character_id is threaded into the request URL. The auth-header fix
// (useWorlds() now sends authHeaders() like every mutation in this file
// already did) is exercised for real via the backend route-guard/projection
// tests plus the manual curl pass in the PR description, not here.
describe('worldsRequestUrl', () => {
  it('omits character_id entirely when none is known (e.g. before a character is selected)', () => {
    expect(worldsRequestUrl('http://api.test', undefined)).toBe('http://api.test/api/worlds');
    expect(worldsRequestUrl('http://api.test', null)).toBe('http://api.test/api/worlds');
  });

  it('appends character_id when the active character is known', () => {
    expect(worldsRequestUrl('http://api.test', 42)).toBe('http://api.test/api/worlds?character_id=42');
  });

  it('URL-encodes the character id', () => {
    expect(worldsRequestUrl('http://api.test', 'weird id/&')).toBe(
      'http://api.test/api/worlds?character_id=weird%20id%2F%26',
    );
  });
});
