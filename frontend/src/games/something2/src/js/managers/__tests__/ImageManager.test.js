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
