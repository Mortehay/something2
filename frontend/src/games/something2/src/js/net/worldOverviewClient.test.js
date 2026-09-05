import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchWorldOverview, needsRefetch, createOverviewFetcher } from './worldOverviewClient.js';

afterEach(() => vi.restoreAllMocks());

describe('fetchWorldOverview', () => {
  it('GETs the overview endpoint with cx/cy and returns JSON', async () => {
    const body = { world_id: 'w1', step: 4, originCol: 0, originRow: 0, cols: 64, rows: 64, tiles: [] };
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => body });
    const res = await fetchWorldOverview('w1', 12, 34);
    expect(global.fetch).toHaveBeenCalledWith(expect.stringMatching(/\/api\/worlds\/w1\/overview\?cx=12&cy=34$/));
    expect(res).toEqual(body);
  });

  it('throws on a non-ok response', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    await expect(fetchWorldOverview('w1', 0, 0)).rejects.toThrow(/HTTP 500/);
  });
});

describe('needsRefetch', () => {
  const cached = { originCol: 0, originRow: 0, cols: 64, rows: 64, step: 4 }; // window covers tiles [0,256)
  it('is true with no cache', () => expect(needsRefetch(null, 128, 128, 32)).toBe(true));
  it('is false when the player is comfortably inside', () => expect(needsRefetch(cached, 128, 128, 32)).toBe(false));
  it('is true near the left edge', () => expect(needsRefetch(cached, 10, 128, 32)).toBe(true));
  it('is true near the bottom edge', () => expect(needsRefetch(cached, 128, 250, 32)).toBe(true));
});

// The 429 flood. maybeFetch is driven from the minimap's TICK -- every animation
// frame -- and needsRefetch(null, ...) is true by definition, so a failure that
// simply falls through to the next frame re-requests at ~60Hz for as long as it
// keeps failing. Live that took one tripped rate limiter and held it tripped:
// hundreds of 429s on /api/worlds/:id/overview and a map that never recovered.
//
// These assert the RATE, which is the actual defect. Asserting only "it retries"
// would pass on the broken version too.
describe('createOverviewFetcher backoff', () => {
  const FRAME_MS = 1000 / 60;

  // One clock for both timelines. The driver reads two: the rAF timestamp
  // passed into maybeFetch, and its own `clock` at failure time. Driving them
  // from separate counters is what a test gets wrong -- the deadline is set on
  // one and compared against the other, so the assertion measures the skew
  // rather than the backoff.
  const harness = (fetchOverview, store = { current: null }) => {
    let nowMs = 0;
    const maybeFetch = createOverviewFetcher({
      store, margin: 40, fetchOverview, clock: () => nowMs,
    });
    return {
      store,
      at: () => nowMs,
      // Advance one frame and tick. The driver's chain is microtasks, so
      // awaiting twice lets then/catch/finally settle before the next frame.
      frame: async (col = 128, row = 128) => {
        nowMs += FRAME_MS;
        maybeFetch('w1', col, row, nowMs);
        await flush();
      },
    };
  };

  // .then -> .catch -> .finally is three microtask links, and an under-flushed
  // test fails OPEN here: an un-cleared in-flight guard suppresses the next
  // request, which is indistinguishable from the backoff doing its job. So
  // flush generously rather than counting hops.
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

  const failing = () => vi.fn().mockRejectedValue(new Error('HTTP 429'));

  it('issues ONE request while the fetch keeps failing, not one per frame', async () => {
    const fetchOverview = failing();
    const h = harness(fetchOverview);
    // 29 frames ~= 483ms, i.e. every frame inside the 500ms first backoff.
    // Broken, this is 29 requests; fixed, it is 1.
    for (let f = 0; f < 29; f++) await h.frame();
    expect(fetchOverview).toHaveBeenCalledTimes(1);
    expect(h.at()).toBeLessThan(500);
  });

  it('retries when the delay elapses, and doubles it on each further failure', async () => {
    const fetchOverview = failing();
    const h = harness(fetchOverview);

    // First second: the attempt at t=0, the 500ms retry, the 1000ms+500 one is
    // not due yet. Exactly two requests in 60 frames, not 60.
    for (let f = 0; f < 60; f++) await h.frame();
    expect(fetchOverview).toHaveBeenCalledTimes(2);

    // Second second: the delay is now 1000ms, so exactly one more lands.
    for (let f = 0; f < 60; f++) await h.frame();
    expect(fetchOverview).toHaveBeenCalledTimes(3);

    // And it keeps widening rather than settling into a fixed poll: four more
    // seconds of frames buy exactly ONE more attempt (the 2000ms step lands,
    // the 4000ms one is still pending at t=6s). A fixed 500ms retry would have
    // spent eight requests over the same stretch; the broken version, 240.
    for (let f = 0; f < 240; f++) await h.frame();
    expect(fetchOverview).toHaveBeenCalledTimes(4);
  });

  it('clears the delay on the first success, so the next edge fetches at once', async () => {
    const window1 = { world_id: 'w1', originCol: 0, originRow: 0, cols: 64, rows: 64, step: 4 };
    const fetchOverview = vi.fn()
      .mockRejectedValueOnce(new Error('HTTP 429'))
      .mockResolvedValue(window1);
    const h = harness(fetchOverview);

    // Frame 1 fails and arms a 500ms delay; the retry ~500ms later succeeds.
    for (let f = 0; f < 31; f++) await h.frame();
    expect(fetchOverview).toHaveBeenCalledTimes(2);
    expect(h.store.current).toEqual(window1);

    // Player is comfortably inside the window: nothing requested.
    await h.frame();
    expect(fetchOverview).toHaveBeenCalledTimes(2);

    // Player reaches the left edge. This must go out on THIS frame -- if the
    // success had not cleared the delay, a stale deadline would swallow it.
    await h.frame(10, 128);
    expect(fetchOverview).toHaveBeenCalledTimes(3);
  });

  it('does not stall the map when the caller ticks without a timestamp', async () => {
    // Failing open, not closed: a missing `now` must cost a request, never stop
    // the map streaming forever.
    const fetchOverview = failing();
    const maybeFetch = createOverviewFetcher({
      store: { current: null }, margin: 40, fetchOverview, clock: () => 0,
    });
    for (let i = 0; i < 2; i++) {
      maybeFetch('w1', 128, 128, undefined);
      await flush();
    }
    expect(fetchOverview).toHaveBeenCalledTimes(2);
  });
});
