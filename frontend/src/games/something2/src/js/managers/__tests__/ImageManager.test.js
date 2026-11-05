import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ImageManager } from '../ImageManager.js';

// A controllable stand-in for the browser's Image: it never loads on its own,
// the test decides when each request succeeds or fails.
let started;
class FakeImage {
  set src(v) { this._src = v; started.push(this); }
  get src() { return this._src; }
}

beforeEach(() => { started = []; vi.stubGlobal('Image', FakeImage); vi.useFakeTimers(); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('ImageManager', () => {
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
    await Promise.resolve();
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

  it('loaded and never-requested names do not hold the wait, and leave no timer behind', async () => {
    const im = new ImageManager(2, 10);
    const p = im.load('a', '/a.png');
    started[0].onload();
    await p;
    expect(await im.whenSettled(['a', 'never-asked-for'], { timeoutMs: 1000 })).toEqual({ timedOut: false });
    expect(vi.getTimerCount()).toBe(0);
  });
});
