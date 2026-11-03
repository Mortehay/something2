import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchAchievements, setActiveTitle } from '../achievementsClient.js';

afterEach(() => vi.restoreAllMocks());

const reply = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });

describe('achievementsClient', () => {
  it('fetchAchievements GETs the character route', async () => {
    const f = vi.fn(async () => reply({ ok: true, achievements: [{ key: 'a' }], titles: [], activeTitle: null, counters: {} }));
    vi.stubGlobal('fetch', f);
    const data = await fetchAchievements(7);
    expect(f.mock.calls[0][0]).toBe('/api/achievements/character/7');
    expect(data.achievements).toHaveLength(1);
  });

  it('fetchAchievements without a character returns an empty journal and does not fetch', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    expect((await fetchAchievements(null)).achievements).toEqual([]);
    expect(f).not.toHaveBeenCalled();
  });

  it('surfaces the server error text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply({ ok: false, error: 'Not your character' }, false, 403)));
    await expect(fetchAchievements(7)).rejects.toThrow('Not your character');
  });

  it('setActiveTitle POSTs and resolves the active title (null clears)', async () => {
    const f = vi.fn(async (_u, opts) => reply({ ok: true, activeTitle: JSON.parse(opts.body).title }));
    vi.stubGlobal('fetch', f);
    expect(await setActiveTitle(7, 'Hero')).toBe('Hero');
    expect(f.mock.calls[0][0]).toBe('/api/achievements/title');
    expect(f.mock.calls[0][1].method).toBe('POST');
    expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({ characterId: 7, title: 'Hero' });
    expect(await setActiveTitle(7, null)).toBeNull();
  });

  it('setActiveTitle throws on { ok:false } and on HTTP errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply({ ok: false, error: 'Title not earned' })));
    await expect(setActiveTitle(7, 'X')).rejects.toThrow('Title not earned');
    vi.stubGlobal('fetch', vi.fn(async () => reply({}, false, 500)));
    await expect(setActiveTitle(7, 'X')).rejects.toThrow('500');
  });
});
