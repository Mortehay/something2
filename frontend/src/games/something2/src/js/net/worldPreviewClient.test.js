import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchWorldPreview } from './worldPreviewClient.js';

afterEach(() => vi.restoreAllMocks());

describe('fetchWorldPreview', () => {
  it('GETs the preview endpoint for the world and returns JSON', async () => {
    const body = { world_id: 'w1', data: [['grass', 'water']] };
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => body });
    const res = await fetchWorldPreview('w1');
    expect(global.fetch).toHaveBeenCalledWith(expect.stringMatching(/\/api\/worlds\/w1\/preview$/));
    expect(res).toEqual(body);
  });

  it('throws on a non-ok response', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    await expect(fetchWorldPreview('nope')).rejects.toThrow(/HTTP 404/);
  });
});
