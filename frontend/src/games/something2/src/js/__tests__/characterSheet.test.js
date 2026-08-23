// SOMET-242 Task 10: the in-game character sheet. Frontend vitest runs in a
// plain node environment (no DOM, no jsdom, no RTL -- see vitest.config.js),
// so CharacterSheet.jsx cannot be rendered here. What CAN be verified
// directly: the pure helpers it exports (xpProgress, progressionChanged) and
// progressionClient.js against a stubbed fetch.
// The one thing that genuinely cannot be executed -- which key opens the
// panel -- is asserted against the component's raw source text instead, and
// is labelled as such in both the test name and the report.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { xpProgress, progressionChanged, STAT_KEYS } from '../../../CharacterSheet.jsx';
import { fetchProgression, respec } from '../net/progressionClient.js';
import { ACTIVE_CHARACTER_KEY, writeActiveCharacterId, clearActiveCharacterId }
  from '../../../characterSession.js';

afterEach(() => vi.restoreAllMocks());

// SOMET-257 made progression per character, so every one of these endpoints
// now needs a character_id and progressionClient reads it from the session
// store -- the same place GameShell writes it. Without this the sheet asks for
// nobody's progression and the panel renders "character_id is required" where
// the stats belong; that is exactly what shipped, and only the browser showed
// it.
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

// F2 rewrote xpProgress's signature: it used to recompute xpFloor/xpToNext
// itself via a local xpCurve.js (now deleted -- see the source-text section
// near the bottom of this file). It now takes `levelInfo` -- the API's own
// xpFloor/xpToNext for the level `progression` is at -- as an explicit
// second argument, so there is nothing left in this file that can drift from
// the backend's constants.
describe('xpProgress', () => {
  it('reports the position inside the current level (level 3, floor 63, xpToNext(3) 78)', () => {
    // Literal floor/xpToNext for a level-3 player under the new curve:
    // xpFloor(3) = 63, xpToNext(3) = round(18 * 3^1.33) = 78. Experience 102
    // is 39 into that 78-wide band -> 50%. Literal expected values, not a
    // recomputation of the same arithmetic the code under test performs.
    const result = xpProgress({ level: 3, experience: 102 }, { xpFloor: 63, xpToNext: 78, respecCost: 150 });
    expect(result).toEqual({ into: 39, need: 78, pct: 50 });
  });

  it('does not divide by null at max level -- xpToNext serialises as null over JSON, not Infinity', () => {
    // JSON.stringify(Infinity) is "null" (JSON has no Infinity literal), so
    // this is the actual wire shape GET /api/progression sends for a
    // level-150 player, not a synthetic Infinity. xpFloor(150) = 901212, the
    // hand-computed cumulative total of round(18 * L^1.33).
    const result = xpProgress({ level: 150, experience: 901212 }, { xpFloor: 901212, xpToNext: null, respecCost: 7500 });
    expect(result).toEqual({ into: 0, need: 0, pct: 100 });
    expect(Number.isFinite(result.into)).toBe(true);
    expect(Number.isFinite(result.need)).toBe(true);
    expect(Number.isFinite(result.pct)).toBe(true);
  });

  it('past max-level floor still returns finite numbers (grinding at level 150)', () => {
    const result = xpProgress({ level: 150, experience: 999999 }, { xpFloor: 901212, xpToNext: null, respecCost: 7500 });
    expect(result).toEqual({ into: 98787, need: 0, pct: 100 });
    expect(Number.isFinite(result.into)).toBe(true);
  });

  it('returns an empty (not "MAX LEVEL") bar when no levelInfo has loaded yet', () => {
    // Distinguishes "still loading" from "genuinely max level" -- both used
    // to collapse to the same need:0 shape, which would have flashed "MAX
    // LEVEL" for a level-1 character for one frame on every open.
    const result = xpProgress({ level: 1, experience: 0 }, null);
    expect(result).toEqual({ into: 0, need: 0, pct: 0 });
  });
});

// F2's lesson, restated for the surface that still exists: the sheet must
// never re-declare a backend constant locally. xpCurve.js was deleted for
// exactly that, and the respec button that consumed RESPEC_BASE is now gone
// too (SOMET-470 -- with stat_points removed there is nothing left for a
// respec to refund until the passive tree lands, so a respec button would
// charge gold for nothing). Matches a declaration, not a mention -- the
// module header talks about all three by name on purpose.
describe('CharacterSheet holds no local copy of a backend constant', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../../../CharacterSheet.jsx', import.meta.url)), 'utf8');

  it('declares neither XP_BASE, MAX_LEVEL nor RESPEC_BASE', () => {
    expect(source).not.toMatch(/\b(const|let|var)\s+(XP_BASE|MAX_LEVEL|RESPEC_BASE)\b/);
  });

  it('renders no allocate or respec control', () => {
    expect(source).not.toContain('PlusButton');
    expect(source).not.toContain('RespecButton');
    expect(source).not.toContain('allocateStat');
  });
});

describe('progressionChanged', () => {
  const p1 = {
    experience: 450, level: 3, passive_points: 2,
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

  it('is true when the passive-point count changed', () => {
    const p2 = { ...p1, passive_points: 1 };
    expect(progressionChanged(p1, p2)).toBe(true);
  });

  it('is true for the very first snapshot (prev is null)', () => {
    expect(progressionChanged(null, p1)).toBe(true);
  });

  it('is false when there is no next snapshot yet', () => {
    expect(progressionChanged(p1, null)).toBe(false);
  });
});

// D1's original write-through (`applyMutationResponse`, which used to be
// exported from CharacterSheet.jsx and applied an allocate/respec HTTP
// response straight into the sheet's displayed progression) was REMOVED by
// the F1 fix, not merely changed -- see CharacterSheet.jsx's module header
// and Game.js's applyGoldResult doc comment for the full reasoning. Its
// tests are removed along with it rather than left pointing at dead code.
// The F1 regression test ("a newer push survives a later, older-HTTP-shaped
// call") now lives in
// src/js/core/__tests__/progressionSnapshot.test.js, next to
// Game.applyGoldResult and getProgressionSnapshot, since the actual fix is a
// Game.js-level guarantee (progression has exactly one writer), not
// something this file's remaining exports can demonstrate on their own.

describe('STAT_KEYS', () => {
  it('lists all six stats, matching the backend whitelist order', () => {
    expect(STAT_KEYS).toEqual(['strength', 'dexterity', 'constitution', 'intelligence', 'wisdom', 'charisma']);
  });
});

describe('progressionClient.fetchProgression', () => {
  it('GETs /api/progression and returns the bundle', async () => {
    const body = {
      progression: { level: 1, experience: 0, passive_points: 0 },
      stats: { maxHp: 100 },
      xpFloor: 0,
      xpToNext: 18,
      respecCost: 50,
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

  it('refuses to ask for nobody\'s progression', async () => {
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
      progression: { level: 3, experience: 450, passive_points: 6, strength: 5, dexterity: 5, constitution: 5, intelligence: 5, wisdom: 5, charisma: 5 },
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

// SOURCE-TEXT ONLY: the node vitest env cannot render CharacterSheet.jsx, so
// which physical key opens/closes the panel cannot be exercised end-to-end
// (that requires the deferred browser pass). This inspects the raw source
// text instead, and is explicitly NOT behavioural evidence.
describe('CharacterSheet keyboard toggle (source-text, not behavioural)', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../../../CharacterSheet.jsx', import.meta.url)), 'utf8',
  );

  it("source-text: the toggle guard checks for 'c', not 'm'", () => {
    // bfd67ab made this layout-independent: the letter from e.key, or the
    // physical key from e.code. Asserting the old `!== 'c'` shape is what went
    // red -- the guard is still there, written differently.
    expect(source).toMatch(/\(e\.key \|\| ''\)\.toLowerCase\(\) === 'c'/);
    expect(source).toMatch(/e\.code === 'KeyC'/);
  });

  it("source-text: the toggle guard does not also fire on 'm' (the minimap's key)", () => {
    expect(source).not.toMatch(/toLowerCase\(\) === 'm'/);
    expect(source).not.toMatch(/e\.code === 'KeyM'/);
  });
});

// SOURCE-TEXT ONLY, same caveat as above. D2 was "the sheet completely
// occludes the HUD" -- the canvas-drawn HP/MP/SP/Gold block sits at the
// canvas's own top-left corner, and the panel used to be pinned to
// top:20/left:20 too. This only proves the CSS declarations changed to a
// different corner; it cannot prove the two no longer visually overlap on a
// real, possibly letterboxed canvas (canvas-pixel space and this panel's
// CSS-px space are not the same coordinate system -- see the D2 fix commit
// for why). Placement was ultimately confirmed correct by the coordinator in
// the browser, not by this or any other automated test.
describe('CharacterSheet placement (source-text, not behavioural)', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../../../CharacterSheet.jsx', import.meta.url)), 'utf8',
  );

  it('source-text: the panel is anchored to the top of the play area', () => {
    const frameBlock = source.slice(source.indexOf('const Frame = styled.div`'), source.indexOf('const Header'));
    expect(frameBlock).toMatch(/top:\s*20px/);
    expect(frameBlock).not.toMatch(/\bbottom:\s*20px/);
  });

  it('source-text: the collapsed show-button is anchored to the same corner as the panel', () => {
    const showBlock = source.slice(source.indexOf('const ShowButton = styled.button`'), source.indexOf('const BarTrack'));
    expect(showBlock).toMatch(/top:\s*20px/);
    expect(showBlock).not.toMatch(/\bbottom:\s*20px/);
  });
});

// SOURCE-TEXT ONLY. F2 was "xpCurve.js re-declares constants the API already
// sends" -- fixed by deleting the duplicate rather than patching it, so this
// checks the duplicate is actually gone rather than merely unused.
describe('F2: no local backend-constant duplication left (source-text, not behavioural)', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../../../CharacterSheet.jsx', import.meta.url)), 'utf8',
  );

  it("source-text: no RESPEC_BASE constant is declared in the sheet -- respecCost comes only from the API bundle", () => {
    // Checks for a DECLARATION specifically, not the bare word -- the
    // module header's own prose legitimately mentions RESPEC_BASE while
    // explaining why it was removed; that history is not the thing under
    // test here.
    expect(source).not.toMatch(/const\s+RESPEC_BASE/);
  });

  it('source-text: xpCurve.js (the deleted local reimplementation) is no longer imported', () => {
    expect(source).not.toMatch(/xpCurve\.js['"]/);
  });

  it('xpCurve.js the file itself no longer exists', () => {
    const xpCurvePath = fileURLToPath(new URL('../core/xpCurve.js', import.meta.url));
    expect(existsSync(xpCurvePath)).toBe(false);
  });
});
