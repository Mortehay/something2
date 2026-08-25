import { describe, it, expect } from 'vitest';
import { createMinimapLoop } from '../minimapLoop.js';

// A stand-in for requestAnimationFrame that lets a test drive time by hand and,
// crucially, count how many callbacks are outstanding. "How many loops are
// running" is exactly the thing SOMET-361 is about, and it is invisible unless
// something counts registrations.
function fakeScheduler() {
  let nextHandle = 1;
  const pending = new Map();
  let registrations = 0;
  const cancelled = [];
  return {
    requestFrame(cb) {
      const h = nextHandle++;
      pending.set(h, cb);
      registrations += 1;
      return h;
    },
    cancelFrame(h) {
      cancelled.push(h);
      pending.delete(h);
    },
    // Fire every currently-pending callback at timestamp `t`. Callbacks that
    // re-register land in `pending` for the next call, not this one.
    tick(t) {
      const due = [...pending.values()];
      pending.clear();
      for (const cb of due) cb(t);
    },
    pendingCount: () => pending.size,
    registrations: () => registrations,
    cancelled,
  };
}

// One second of 60fps frames, 1-indexed so the first timestamp is non-zero.
function runOneSecond(s, fps = 60) {
  for (let i = 1; i <= fps; i += 1) s.tick((i * 1000) / fps);
}

const FIFTEEN_HZ = 1000 / 15;

describe('createMinimapLoop', () => {
  function build(opts = {}) {
    const s = fakeScheduler();
    const ticks = [];
    const draws = [];
    const loop = createMinimapLoop({
      requestFrame: s.requestFrame,
      cancelFrame: s.cancelFrame,
      drawIntervalMs: FIFTEEN_HZ,
      onTick: (now) => ticks.push(now),
      onDraw: (now) => draws.push(now),
      ...opts,
    });
    return { s, loop, ticks, draws };
  }

  // AC 2: "Draw rate is capped at the chosen cadence, verified by counting
  // drawMinimap calls over a simulated second."
  it('caps drawing at the cadence while ticking at frame rate', () => {
    const { s, loop, ticks, draws } = build();
    loop.start();
    runOneSecond(s);

    expect(ticks).toHaveLength(60);            // every frame, unthrottled
    expect(draws.length).toBeLessThanOrEqual(15);
    expect(draws.length).toBeGreaterThan(8);   // still redrawing, not frozen

    // No two draws closer together than the interval -- the actual guarantee.
    for (let i = 1; i < draws.length; i += 1) {
      expect(draws[i] - draws[i - 1]).toBeGreaterThanOrEqual(FIFTEEN_HZ);
    }
  });

  it('draws every frame when the interval is 0', () => {
    const { s, loop, draws } = build({ drawIntervalMs: 0 });
    loop.start();
    runOneSecond(s);
    expect(draws).toHaveLength(60);
  });

  // Guards the -Infinity seed: a 0 seed would swallow the first draw on any
  // page whose rAF clock starts below the interval.
  it('draws on the very first frame', () => {
    const { s, loop, draws } = build();
    loop.start();
    s.tick(4); // a timestamp well below the interval
    expect(draws).toEqual([4]);
  });

  // AC 1: "Only one rAF loop exists ... whether or not the expand modal is
  // open." The modal no longer starts its own loop, so the remaining way to get
  // two is starting this one twice.
  it('never has more than one frame outstanding, and start() is idempotent', () => {
    const { s, loop, ticks } = build();
    loop.start();
    loop.start();
    loop.start();
    expect(s.pendingCount()).toBe(1);

    for (let i = 1; i <= 10; i += 1) {
      s.tick(i * 16.7);
      expect(s.pendingCount()).toBe(1); // one in flight, always
    }
    expect(ticks).toHaveLength(10);     // not 30 -- the extra starts did nothing
  });

  // AC 5: "Both loops are cleaned up on unmount and on hide (M) -- no leaked rAF."
  it('stops cleanly and cancels the pending frame', () => {
    const { s, loop, ticks } = build();
    loop.start();
    s.tick(16.7);
    expect(loop.isRunning()).toBe(true);

    loop.stop();
    expect(loop.isRunning()).toBe(false);
    expect(s.cancelled).toHaveLength(1);
    expect(s.pendingCount()).toBe(0);

    s.tick(33.4);
    expect(ticks).toHaveLength(1); // nothing ran after stop
  });

  // The race that makes unmount unsafe: a frame already scheduled when stop()
  // is called would otherwise still fire once, touching a canvas React has
  // detached. cancelFrame is best-effort; the running flag is the real guard.
  it('does not run a frame that was already scheduled when it stopped', () => {
    const s = fakeScheduler();
    const ticks = [];
    const loop = createMinimapLoop({
      requestFrame: s.requestFrame,
      cancelFrame: () => {},          // a scheduler that ignores cancellation
      drawIntervalMs: FIFTEEN_HZ,
      onTick: () => ticks.push(1),
      onDraw: () => {},
    });
    loop.start();
    loop.stop();
    s.tick(16.7);
    expect(ticks).toHaveLength(0);
  });

  it('restarts after a stop and draws immediately again', () => {
    const { s, loop, draws } = build();
    loop.start();
    s.tick(10);
    loop.stop();
    loop.start();
    s.tick(20); // only 10ms later, but a fresh start must not be throttled
    expect(draws).toEqual([10, 20]);
    expect(s.pendingCount()).toBe(1);
  });

  it('stop() is idempotent and does not cancel twice', () => {
    const { s, loop } = build();
    loop.start();
    loop.stop();
    loop.stop();
    expect(s.cancelled).toHaveLength(1);
  });

  // AC 3 in spirit: the refetch edge check rides on onTick, so it must never be
  // starved by the draw throttle. A tick with no draw still happens.
  it('ticks on frames where it does not draw', () => {
    const { s, loop, ticks, draws } = build();
    loop.start();
    s.tick(16.7);   // draws (first frame)
    s.tick(33.4);   // too soon to draw
    s.tick(50.1);   // still too soon
    expect(ticks).toEqual([16.7, 33.4, 50.1]);
    expect(draws).toEqual([16.7]);
  });
});
