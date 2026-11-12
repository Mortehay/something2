import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchMe, withTimeout, ME_TIMEOUT_MS } from '../accountApi.js';
import { isMeAnswer } from '../../../../../../context/authState.js';

// A backend that accepts the request and never answers must not leave the /me probe pending forever: fetchMe
// rejects after ME_TIMEOUT_MS, which AuthContext turns into probe 'failed' (the gate fails open).

const realFetch = globalThis.fetch;
afterEach(() => { vi.useRealTimers(); globalThis.fetch = realFetch; });

// A fetch that never settles on its own -- only an abort ends it, the way a real fetch does.
function hangingFetch() {
  const seen = [];
  globalThis.fetch = vi.fn((url, init = {}) => {
    seen.push(init.signal);
    return new Promise((resolve, reject) => {
      if (init.signal) init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
  });
  return seen;
}

describe('fetchMe timeout', () => {
  it('is about 8 seconds', () => {
    expect(ME_TIMEOUT_MS).toBe(8000);
  });

  it('rejects once the timeout passes on a hanging backend, and not before', async () => {
    vi.useFakeTimers();
    const seen = hangingFetch();
    let settled = null;
    const p = fetchMe().then(() => { settled = 'resolved'; }, () => { settled = 'rejected'; });
    await vi.advanceTimersByTimeAsync(ME_TIMEOUT_MS - 1);
    expect(settled).toBe(null);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(settled).toBe('rejected');
    expect(seen[0]).toBeDefined();
    expect(seen[0].aborted).toBe(true);
  });

  it('a body that hangs past the timeout is a failure, not an empty answer', async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn(async (url, init) => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: () => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }),
    }));
    const p = fetchMe();
    const check = expect(p).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(ME_TIMEOUT_MS);
    await check;
  });

  it('a prompt answer resolves and clears the timer', async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ emailRequired: false }) }));
    await expect(fetchMe()).resolves.toEqual({ emailRequired: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('withTimeout clears its timer after a rejection too', async () => {
    vi.useFakeTimers();
    await expect(withTimeout(1000, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('isMeAnswer', () => {
  it('needs a boolean emailRequired', () => {
    expect(isMeAnswer({ emailRequired: false })).toBe(true);
    expect(isMeAnswer({ emailRequired: true, email: null })).toBe(true);
    // A non-JSON 200 reads as {} in fetchMe; that is not an answer.
    expect(isMeAnswer({})).toBe(false);
    expect(isMeAnswer(null)).toBe(false);
    expect(isMeAnswer({ emailRequired: 'false' })).toBe(false);
    expect(isMeAnswer('<html>')).toBe(false);
  });
});
