import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchWorldOverview, needsRefetch } from './worldOverviewClient.js';

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
