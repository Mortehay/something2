import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  ACHIEVABLE, DENSITY_TIERS, TILES_PER_SCREEN, nearestAchievable, isMisleading,
} from '../densityTargets.js';

describe('densityTargets', () => {
  // The drift guard. This table is a COPY of the backend's, so the test reads
  // the backend source text rather than restating the numbers here -- a test
  // that hardcoded 9/18/36/62/89 would agree with the copy and with itself
  // while both disagreed with the game.
  it('stays in step with backend/src/services/densityTiers.js', () => {
    const src = readFileSync(
      path.resolve(__dirname, '../../../../../backend/src/services/densityTiers.js'), 'utf8');
    for (const { tier, perThousand } of DENSITY_TIERS) {
      const re = new RegExp(`${tier}\\s*:\\s*\\{[^}]*perThousand\\s*:\\s*(\\d+)`, 's');
      const m = src.match(re);
      expect(m, `no perThousand found for tier "${tier}" in densityTiers.js`).toBeTruthy();
      expect(Number(m[1]), `tier "${tier}" drifted`).toBe(perThousand);
    }
    expect(src).toContain('225');
    expect(TILES_PER_SCREEN).toBe(225);
  });

  it('exposes the five achievable per-screen values', () => {
    expect(ACHIEVABLE.map(t => t.perScreen)).toEqual([2, 4.1, 8.1, 14, 20]);
  });

  it('a request of 6 lands on 4.1, which is a 32% shortfall', () => {
    const hit = nearestAchievable(6);
    expect(hit.tier).toBe('normal');
    expect(hit.perScreen).toBe(4.1);
    expect(hit.shortfall).toBeCloseTo(-0.317, 2);
    expect(isMisleading(6)).toBe(true);
  });

  it('the achievable values are not flagged against themselves', () => {
    for (const t of ACHIEVABLE) expect(isMisleading(t.perScreen)).toBe(false);
  });

  it('7 overshoots to 8.1 rather than dropping to 4.1', () => {
    // Nearest by absolute distance: |8.1-7| = 1.1 beats |4.1-7| = 2.9.
    expect(nearestAchievable(7).perScreen).toBe(8.1);
    expect(isMisleading(7)).toBe(true);
  });

  it('a tie goes to the lower tier, because overshooting costs bandwidth', () => {
    // 6.1 is exactly between 4.1 and 8.1.
    expect(nearestAchievable(6.1).perScreen).toBe(4.1);
  });

  it('non-numbers are null rather than a confident wrong tier', () => {
    expect(nearestAchievable('')).toBeNull();
    expect(nearestAchievable('abc')).toBeNull();
    expect(isMisleading(undefined)).toBe(false);
  });
});
