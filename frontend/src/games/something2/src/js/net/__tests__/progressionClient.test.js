// progressionClient against a stubbed fetch. Moved out of
// src/js/__tests__/characterSheet.test.js when the standalone level popup was
// deleted (SOMET-483): the client outlived its first caller -- Game's
// _refreshProgressionBundle is what reads GET /api/progression now.
//
// `allocateStat` is deliberately absent: SOMET-470 removed stat points and the
// route with them, so its block died with the popup rather than moving here.
// `respec` survives because POST /api/progression/respec is the passive tree's
// reset (SOMET-475) and still exists server-side.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchProgression, respec } from '../progressionClient.js';
import { writeActiveCharacterId, clearActiveCharacterId }
  from '../../../../characterSession.js';

afterEach(() => vi.restoreAllMocks());

// SOMET-257 made progression per character, so every one of these endpoints
// needs a character_id and progressionClient reads it from the session store --
// the same place GameShell writes it. Without this the tab asks for nobody's
// progression and renders "character_id is required" where the stats belong;
// that is exactly what shipped once, and only the browser showed it.
const TEST_CHARACTER_ID = 77;
globalThis.localStorage = globalThis.localStorage || (() => {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
})();
writeActiveCharacterId(TEST_CHARACTER_ID);

describe('progressionClient.fetchProgression', () => {
  it('GETs /api/progression and returns the bundle', async () => {
    // The real shape as of SOMET-475/495: the composed row carries
    // sources/modifiers/passivePoints, and the bundle lifts them to the top
    // level as well. The Character tab reads xpFloor/xpToNext/respecCost off
    // this response and nothing else -- it computes no curve of its own (F2).
    const body = {
      progression: {
        level: 1, experience: 0, passive_points: 0, passivePoints: 0,
        allocatedNodeIds: [], sources: { strength: { base: 5, tree: 0, gear: 0 } }, modifiers: [],
      },
      stats: { maxHp: 100 },
      xpFloor: 0,
      xpToNext: 18,
      respecCost: 50,
      effective: { strength: 5 },
      passivePoints: 0,
      allocatedNodeIds: [],
      sources: { strength: { base: 5, tree: 0, gear: 0 } },
      modifiers: [],
    };
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => body });
    const res = await fetchProgression('http://x');
    // The character_id is pinned, not merely tolerated: the URL without it is
    // a 400 from the real server, and this assertion is what makes that a test
    // failure rather than a browser-only discovery.
    expect(global.fetch).toHaveBeenCalledWith(
      `http://x/api/progression?character_id=${TEST_CHARACTER_ID}`, expect.any(Object));
    expect(res).toEqual(body);
  });

  it("refuses to ask for nobody's progression", async () => {
    clearActiveCharacterId();
    global.fetch = vi.fn();
    try {
      await expect(fetchProgression('http://x')).rejects.toThrow(/No character selected/);
      expect(global.fetch).not.toHaveBeenCalled();
    } finally {
      writeActiveCharacterId(TEST_CHARACTER_ID);
    }
  });

  it('throws the server error message on a non-ok response', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: 'boom' }) });
    await expect(fetchProgression('http://x')).rejects.toThrow(/boom/);
  });
});

describe('progressionClient.respec', () => {
  it('POSTs /api/progression/respec and returns the bundle', async () => {
    const body = {
      progression: { level: 3, experience: 450, passivePoints: 6 },
      stats: { maxHp: 100 },
      gold: 50,
    };
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => body });
    const res = await respec('http://x');
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('http://x/api/progression/respec');
    expect(opts.method).toBe('POST');
    // A respec charges the ACCOUNT's gold but acts on the CHARACTER, so the
    // server needs both identities and gets the character one from here.
    expect(JSON.parse(opts.body)).toEqual({ character_id: TEST_CHARACTER_ID });
    expect(res).toEqual(body);
  });

  it('throws the server error message on a 402 (cannot afford)', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 402, json: async () => ({ error: 'not enough gold', cost: 150 }) });
    await expect(respec('http://x')).rejects.toThrow(/not enough gold/);
  });
});
