import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ImageManager } from '../ImageManager.js';

// A controllable stand-in for the browser's Image: it never loads on its own,
// the test decides when each request succeeds or fails.
let started;
class FakeImage {
  set src(v) { this._src = v; this.corsAtStart = this.crossOrigin; started.push(this); }
  get src() { return this._src; }
}

beforeEach(() => { started = []; vi.stubGlobal('Image', FakeImage); vi.useFakeTimers(); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('ImageManager', () => {
  // SOMET-765. Art comes from the API origin; without CORS mode the image
  // taints every canvas it is drawn into, and any pixel read of it throws.
  it('requests every image in CORS mode, set before the request starts', () => {
    const im = new ImageManager(2, 10);
    im.load('a', '/a.png');
    expect(started[0].corsAtStart).toBe('anonymous');
  });

  it('keeps at most maxConcurrent requests in flight and starts the next as one finishes', async () => {
    const im = new ImageManager(2, 10);
    const done = ['a', 'b', 'c', 'd'].map((n) => im.load(n, `/${n}.png`));
    expect(started.map((i) => i.src)).toEqual(['/a.png', '/b.png']);
    started[0].onload();
    await done[0];
    expect(started.map((i) => i.src)).toEqual(['/a.png', '/b.png', '/c.png']);
    expect(im.get('a')).toBe(started[0]);
    expect(im.get('c')).toBeNull();
  });

  it('a priority load goes ahead of everything still queued', () => {
    const im = new ImageManager(1, 10);
    im.load('a', '/a.png');
    im.load('b', '/b.png');
    im.load('p', '/p.png', { priority: true });
    started[0].onload();
    expect(started[1].src).toBe('/p.png');
  });

  it('pause starts nothing new, lets in-flight requests finish, and resume refills the slots', async () => {
    const im = new ImageManager(2, 10);
    const done = ['a', 'b', 'c', 'd'].map((n) => im.load(n, `/${n}.png`));
    im.pause();
    started[0].onload();
    await done[0];
    expect(im.get('a')).toBe(started[0]);
    expect(started).toHaveLength(2);
    im.load('e', '/e.png');
    expect(started).toHaveLength(2);
    im.resume();
    expect(started.map((i) => i.src)).toEqual(['/a.png', '/b.png', '/c.png']);
    started[1].onload();
    expect(started.map((i) => i.src)).toEqual(['/a.png', '/b.png', '/c.png', '/d.png']);
  });

  it('a retry that comes due during a pause waits for resume', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const im = new ImageManager(2, 10);
    im.load('a', '/a.png');
    im.pause();
    started[0].onerror();
    vi.advanceTimersByTime(10);
    expect(started).toHaveLength(1);
    im.resume();
    expect(started).toHaveLength(2);
    expect(started[1].src).toBe('/a.png');
  });

  it('retries a failed image once, then resolves on the fallback without hanging', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const im = new ImageManager(2, 10);
    const p = im.load('a', '/a.png');
    started[0].onerror();
    expect(started).toHaveLength(1);
    vi.advanceTimersByTime(10);
    expect(started).toHaveLength(2);
    started[1].onerror();
    await p;
    expect(im.get('a')).toBeNull();
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  it('a retry that succeeds loads normally and logs no error', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const im = new ImageManager(2, 10);
    const p = im.load('a', '/a.png');
    started[0].onerror();
    vi.advanceTimersByTime(10);
    started[1].onload();
    await p;
    expect(im.get('a')).toBe(started[1]);
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });
});

describe('ImageManager repeat requests (world transitions re-request everything)', () => {
  it('a loaded image is not reset or re-queued by a second load of the same path', async () => {
    const im = new ImageManager(2, 10);
    const p = im.load('a', '/a.png');
    started[0].onload();
    await p;
    const img = im.get('a');
    expect(img).toBe(started[0]);
    await im.load('a', '/a.png');
    expect(im.get('a')).toBe(img); // still drawable, never went back to null
    expect(started).toHaveLength(1); // and no second request
  });

  it('a duplicate of an in-flight or queued load shares its promise and starts nothing new', async () => {
    const im = new ImageManager(1, 10);
    const first = im.load('a', '/a.png');
    const queued = im.load('b', '/b.png');
    const dupA = im.load('a', '/a.png');
    const dupB = im.load('b', '/b.png');
    expect(dupA).toBe(first);
    expect(dupB).toBe(queued);
    expect(started).toHaveLength(1);
    started[0].onload();
    await first;
    expect(started).toHaveLength(2);
    started[1].onload();
    await queued;
    expect(im.get('b')).toBe(started[1]);
  });

  it('a different path under the same name does reload (re-approved art)', async () => {
    const im = new ImageManager(2, 10);
    const p = im.load('a', '/a.png?v=1');
    started[0].onload();
    await p;
    const p2 = im.load('a', '/a.png?v=2');
    expect(started).toHaveLength(2);
    expect(started[1].src).toBe('/a.png?v=2');
    started[1].onload();
    await p2;
    expect(im.get('a')).toBe(started[1]);
  });

  it('an image that finally failed is retried by the next load', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const im = new ImageManager(2, 10);
    const p = im.load('a', '/a.png');
    started[0].onerror();
    vi.advanceTimersByTime(10);
    started[1].onerror();
    await p;
    expect(im.get('a')).toBeNull();
    const again = im.load('a', '/a.png');
    expect(started).toHaveLength(3);
    started[2].onload();
    await again;
    expect(im.get('a')).toBe(started[2]);
    err.mockRestore();
  });

  it('a priority repeat promotes a job that is still waiting in the queue', () => {
    const im = new ImageManager(1, 10);
    im.load('a', '/a.png');
    im.load('b', '/b.png');
    im.load('c', '/c.png');
    im.load('c', '/c.png', { priority: true });
    started[0].onload();
    expect(started[1].src).toBe('/c.png');
  });

  it('stats(): counts each distinct request once, settles on load, and counts a final failure', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const im = new ImageManager(2, 10);
    im.load('a', '/a.png');
    im.load('a', '/a.png'); // duplicate request is a no-op, not a second job
    im.load('b', '/b.png');
    expect(im.stats()).toEqual({ total: 2, settled: 0, failed: 0, pending: 2 });
    started[0].onload();
    expect(im.stats()).toMatchObject({ settled: 1, pending: 1 });
    started[1].onerror();          // first failure: retried, not settled yet
    expect(im.stats()).toMatchObject({ settled: 1, failed: 0 });
    vi.advanceTimersByTime(10);
    started[2].onerror();          // second failure: gives up
    expect(im.stats()).toEqual({ total: 2, settled: 2, failed: 1, pending: 0 });
  });
});

describe('ImageManager.whenSettled (SOMET-742)', () => {
  it('moves the named images ahead of the queue, in the order asked, and resolves once they land', async () => {
    const im = new ImageManager(1, 10);
    for (const n of ['a', 'b', 'c', 'd']) im.load(n, `/${n}.png`);
    let done = false;
    const wait = im.whenSettled(['d', 'c'], { timeoutMs: 1000 }).then((r) => { done = true; return r; });
    started[0].onload();
    expect(started[1].src).toBe('/d.png');
    started[1].onload();
    expect(started[2].src).toBe('/c.png');
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);
    started[2].onload();
    expect(await wait).toEqual({ timedOut: false });
  });

  it('gives up at the limit with the image still pending, and the image can still land later', async () => {
    const im = new ImageManager(1, 10);
    im.load('a', '/a.png');
    const wait = im.whenSettled(['a'], { timeoutMs: 500 });
    await vi.advanceTimersByTimeAsync(500);
    expect(await wait).toEqual({ timedOut: true });
    started[0].onload();
    expect(im.get('a')).toBe(started[0]);
  });

  it('a failed image counts as finished after its one retry: no extra requests', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const im = new ImageManager(2, 10);
    im.load('a', '/a.png');
    const wait = im.whenSettled(['a'], { timeoutMs: 1000 });
    started[0].onerror();
    await vi.advanceTimersByTimeAsync(10);
    started[1].onerror();
    expect(await wait).toEqual({ timedOut: false });
    await vi.advanceTimersByTimeAsync(5000);
    expect(started.length).toBe(2);
  });

  it('a waited-for image that fails retries ahead of the queue, not behind the catalogue', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const im2 = new ImageManager(1, 10);
    for (const n of ['w', 'x', 'y']) im2.load(n, `/${n}.png`);
    im2.whenSettled(['w'], { timeoutMs: 1000 });
    started[0].onerror();
    await vi.advanceTimersByTimeAsync(10);
    expect(started[1].src).toBe('/x.png');
    started[1].onload();
    expect(started[2].src).toBe('/w.png');
  });

  it('loaded and never-requested names do not hold the wait, and leave no timer behind', async () => {
    const im = new ImageManager(2, 10);
    const p = im.load('a', '/a.png');
    started[0].onload();
    await p;
    expect(await im.whenSettled(['a', 'never-asked-for'], { timeoutMs: 1000 })).toEqual({ timedOut: false });
    expect(vi.getTimerCount()).toBe(0);
  });
});

// Amber Stance final review I1: the "Loading textures…" chip and the amber
// ready signal share ONE rule -- nothing pending, held for quietMs.
describe('ImageManager.isQuiet', () => {
  it('quiet only after nothing has been pending for quietMs, measured from when the last job settled', () => {
    let t = 0;
    const im = new ImageManager(2, 10, () => t);
    im.load('a', '/a.png');
    t = 5000;
    expect(im.isQuiet(t, 1000)).toBe(false); // pending
    started[0].onload();                      // settles at t=5000
    t = 5999;
    expect(im.isQuiet(t, 1000)).toBe(false);
    t = 6000;
    expect(im.isQuiet(t, 1000)).toBe(true);
  });

  it('a new job ends the quiet, and the window restarts when it settles', () => {
    let t = 0;
    const im = new ImageManager(2, 10, () => t);
    im.load('a', '/a.png');
    started[0].onload();
    t = 3000;
    expect(im.isQuiet(t, 1000)).toBe(true);
    im.load('b', '/b.png');
    expect(im.isQuiet(t, 1000)).toBe(false);
    t = 3500;
    started[1].onload();
    t = 4000;
    expect(im.isQuiet(t, 1000)).toBe(false);
    t = 4500;
    expect(im.isQuiet(t, 1000)).toBe(true);
  });

  it('a repeat load of an already-loaded image does not end the quiet', () => {
    let t = 0;
    const im = new ImageManager(2, 10, () => t);
    im.load('a', '/a.png');
    started[0].onload();
    t = 2000;
    im.load('a', '/a.png');
    expect(im.isQuiet(t, 1000)).toBe(true);
  });

  it('a final failure counts as settled (same as the chip), a pending retry does not', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let t = 0;
    const im = new ImageManager(2, 10, () => t);
    im.load('a', '/a.png');
    started[0].onerror();
    t = 5000;
    expect(im.isQuiet(t, 1000)).toBe(false); // retry still to come
    vi.advanceTimersByTime(10);
    started[1].onerror();                     // gives up at t=5000
    t = 6000;
    expect(im.isQuiet(t, 1000)).toBe(true);
  });

  it('nothing requested yet: quiet counts from construction', () => {
    let t = 100;
    const im = new ImageManager(2, 10, () => t);
    expect(im.isQuiet(1099, 1000)).toBe(false);
    expect(im.isQuiet(1100, 1000)).toBe(true);
  });
});
