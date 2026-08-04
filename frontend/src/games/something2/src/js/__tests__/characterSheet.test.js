// SOMET-242 Task 10: the in-game character sheet. Frontend vitest runs in a
// plain node environment (no DOM, no jsdom, no RTL -- see vitest.config.js),
// so CharacterSheet.jsx cannot be rendered here. What CAN be verified
// directly: the pure helpers it exports (xpProgress, respecDisabled,
// progressionChanged) and progressionClient.js against a stubbed fetch.
// The one thing that genuinely cannot be executed -- which key opens the
// panel -- is asserted against the component's raw source text instead, and
// is labelled as such in both the test name and the report.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { xpProgress, respecDisabled, progressionChanged, STAT_KEYS } from '../../../CharacterSheet.jsx';
import { fetchProgression, allocateStat, respec } from '../net/progressionClient.js';

afterEach(() => vi.restoreAllMocks());

describe('xpProgress', () => {
  it('reports the position inside the current level (level 3, floor 300, xpToNext(3) 300)', () => {
    // Level 3's floor is XP_BASE*(3-1)*3/2 = 300; xpToNext(3) = XP_BASE*3 = 300.
    // experience 450 is 150 into that 300-wide band -> 50%. Literal expected
    // values, not a recomputation of the same formula the code under test uses.
    const result = xpProgress({ level: 3, experience: 450 });
    expect(result).toEqual({ into: 150, need: 300, pct: 50 });
  });

  it('does not divide by Infinity at max level (50) -- returns a finite, full bar', () => {
    // xpFloor(50) = XP_BASE*49*50/2 = 122500 (backend/src/services/playerStats.js
    // formula, mirrored in xpCurve.js). Picking experience exactly at that floor
    // as a literal, rather than calling xpFloor() to derive it, keeps this a
    // literal-value assertion.
    const result = xpProgress({ level: 50, experience: 122500 });
    expect(result).toEqual({ into: 0, need: 0, pct: 100 });
    expect(Number.isFinite(result.into)).toBe(true);
    expect(Number.isFinite(result.need)).toBe(true);
    expect(Number.isFinite(result.pct)).toBe(true);
  });

  it('past max-level floor still returns finite numbers (grinding at level 50)', () => {
    const result = xpProgress({ level: 50, experience: 999999 });
    expect(result).toEqual({ into: 877499, need: 0, pct: 100 });
    expect(Number.isFinite(result.into)).toBe(true);
  });
});

describe('respecDisabled', () => {
  // Boundary behaviour at, just below, and just above the cost.
  const cost = 150;
  it('is disabled just below the cost', () => {
    expect(respecDisabled(cost - 1, cost)).toBe(true);
  });
  it('is enabled exactly at the cost', () => {
    expect(respecDisabled(cost, cost)).toBe(false);
  });
  it('is enabled just above the cost', () => {
    expect(respecDisabled(cost + 1, cost)).toBe(false);
  });
});

describe('progressionChanged', () => {
  const p1 = {
    experience: 450, level: 3, stat_points: 2,
    strength: 5, dexterity: 5, constitution: 5, intelligence: 5, wisdom: 5, charisma: 5,
  };

  it('is false for a fresh object with identical values (the zero-XP no-op push)', () => {
    // A new object reference (as every websocket message is), but every
    // display-relevant field is numerically identical -- this is exactly the
    // shape of the server's "progression pushed even when awarded XP is 0"
    // frame the sheet must not flicker or refetch on.
    const p2 = { ...p1 };
    expect(p2).not.toBe(p1); // sanity: genuinely a different reference
    expect(progressionChanged(p1, p2)).toBe(false);
  });

  it('is true when experience actually moved', () => {
    const p2 = { ...p1, experience: 460 };
    expect(progressionChanged(p1, p2)).toBe(true);
  });

  it('is true when a stat changed (allocate) even if experience did not', () => {
    const p2 = { ...p1, constitution: 6, stat_points: 1 };
    expect(progressionChanged(p1, p2)).toBe(true);
  });

  it('is true for the very first snapshot (prev is null)', () => {
    expect(progressionChanged(null, p1)).toBe(true);
  });

  it('is false when there is no next snapshot yet', () => {
    expect(progressionChanged(p1, null)).toBe(false);
  });
});

describe('STAT_KEYS', () => {
  it('lists all six stats, matching the backend whitelist order', () => {
    expect(STAT_KEYS).toEqual(['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma']);
  });
});

describe('progressionClient.fetchProgression', () => {
  it('GETs /api/progression and returns the bundle', async () => {
    const body = {
      progression: { level: 1, experience: 0, stat_points: 0 },
      stats: { maxHp: 100 },
      xpFloor: 0,
      xpToNext: 100,
      respecCost: 50,
    };
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => body });
    const res = await fetchProgression('http://x');
    expect(global.fetch).toHaveBeenCalledWith('http://x/api/progression', expect.any(Object));
    expect(res).toEqual(body);
  });

  it('throws the server error message on a non-ok response', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: 'boom' }) });
    await expect(fetchProgression('http://x')).rejects.toThrow(/boom/);
  });
});

describe('progressionClient.allocateStat', () => {
  it('posts the stat and count, and returns the new bundle', async () => {
    const body = {
      progression: { level: 1, experience: 0, stat_points: 1, constitution: 6 },
      stats: { maxHp: 110 },
    };
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => body });
    const res = await allocateStat('constitution', 1, 'http://x');

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('http://x/api/progression/allocate');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ stat: 'constitution', count: 1 });
    expect(res).toEqual(body);
  });

  it('throws the server error message on a 400 (bad allocation)', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: 'not enough points' }) });
    await expect(allocateStat('constitution', 5, 'http://x')).rejects.toThrow(/not enough points/);
  });
});

describe('progressionClient.respec', () => {
  it('POSTs /api/progression/respec and returns the refunded bundle', async () => {
    const body = {
      progression: { level: 3, experience: 450, stat_points: 6, strength: 5, dexterity: 5, constitution: 5, intelligence: 5, wisdom: 5, charisma: 5 },
      stats: { maxHp: 100 },
      gold: 50,
    };
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => body });
    const res = await respec('http://x');
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('http://x/api/progression/respec');
    expect(opts.method).toBe('POST');
    expect(res).toEqual(body);
  });

  it('throws the server error message on a 402 (cannot afford)', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 402, json: async () => ({ error: 'not enough gold', cost: 150 }) });
    await expect(respec('http://x')).rejects.toThrow(/not enough gold/);
  });
});

// SOURCE-TEXT ONLY: the node vitest env cannot render CharacterSheet.jsx, so
// which physical key opens/closes the panel cannot be exercised end-to-end
// (that requires the deferred browser pass). This inspects the raw source
// text instead, and is explicitly NOT behavioural evidence.
describe('CharacterSheet keyboard toggle (source-text, not behavioural)', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../../../CharacterSheet.jsx', import.meta.url)), 'utf8',
  );

  it("source-text: the toggle guard checks for 'c', not 'm'", () => {
    expect(source).toMatch(/e\.key\.toLowerCase\(\)\s*!==\s*'c'/);
  });

  it("source-text: the toggle guard does not also fire on 'm' (the minimap's key)", () => {
    expect(source).not.toMatch(/e\.key\.toLowerCase\(\)\s*!==\s*'m'/);
  });
});
