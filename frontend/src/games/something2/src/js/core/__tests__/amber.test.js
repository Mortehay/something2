// Amber Stance, the pure client rules (core/amber.js).
import { describe, it, expect } from 'vitest';
import {
  AMBER_FADE_MS, countdownText, fadeAlpha, amberSheetFor, shouldBreak,
  snapshotAmber, amberRemainingMs, indexStatusVisuals,
} from '../amber.js';

describe('countdownText', () => {
  it('rounds up to whole seconds', () => {
    expect(countdownText(9001)).toBe('10');
    expect(countdownText(1)).toBe('1');
    expect(countdownText(0)).toBe('0');
  });
  it('never goes negative', () => {
    expect(countdownText(-50)).toBe('0');
  });
});

describe('fadeAlpha', () => {
  it('runs 1 -> 0 linearly over AMBER_FADE_MS', () => {
    expect(AMBER_FADE_MS).toBe(400);
    expect(fadeAlpha(0)).toBe(1);
    expect(fadeAlpha(200)).toBe(0.5);
    expect(fadeAlpha(400)).toBe(0);
    expect(fadeAlpha(1000)).toBe(0);
  });
});

describe('amberSheetFor', () => {
  const rows = indexStatusVisuals([
    { key: 'amber_stance_1', status_key: 'amber_stance', variant: 1, sprite_image: null, sprite_frames: 8 },
    { key: 'amber_stance_2', status_key: 'amber_stance', variant: 2, sprite_image: 'status/amber_2.png', sprite_frames: 8 },
  ]);
  it('unknown or spriteless variant draws fallback', () => {
    expect(amberSheetFor(null, rows)).toBe(null);
    expect(amberSheetFor(7, rows)).toBe(null);   // not in the list
    expect(amberSheetFor(1, rows)).toBe(null);   // sprite_image null = not approved
    expect(amberSheetFor(2, null)).toBe(null);   // library not loaded yet
  });
  it('an approved variant gives its row', () => {
    expect(amberSheetFor(2, rows)).toBe(rows.amber_stance_2);
  });
  it('indexes a missing or failed response as an empty library', () => {
    expect(indexStatusVisuals(null)).toEqual({});
    expect(indexStatusVisuals({ error: 'x' })).toEqual({});
  });
});

describe('shouldBreak', () => {
  const amber = { a: 5, ms: 9000, v: null };
  it('breaks on move, attack, skill and ground click once ready was sent for this arrival', () => {
    for (const input of ['move', 'attack', 'skill', 'ground']) {
      expect(shouldBreak({ amber, ready: 5, input })).toBe(true);
    }
  });
  it('never before ready, nor with a ready for another arrival', () => {
    expect(shouldBreak({ amber, ready: null, input: 'move' })).toBe(false);
    expect(shouldBreak({ amber, ready: 4, input: 'move' })).toBe(false);
  });
  it('not when unsealed, and not for interaction inputs', () => {
    expect(shouldBreak({ amber: null, ready: 5, input: 'move' })).toBe(false);
    for (const input of ['inventory', 'chat', 'interact', 'equip', undefined]) {
      expect(shouldBreak({ amber, ready: 5, input })).toBe(false);
    }
  });
});

describe('snapshotAmber', () => {
  it('takes { a, ms, v } and drops anything malformed', () => {
    expect(snapshotAmber({ a: 3, ms: 27000, v: 4 })).toEqual({ a: 3, ms: 27000, v: 4 });
    expect(snapshotAmber({ a: 3, ms: 27000 })).toEqual({ a: 3, ms: 27000, v: null });
    expect(snapshotAmber(undefined)).toBe(null);
    expect(snapshotAmber({ ms: 100 })).toBe(null);
    expect(snapshotAmber({ a: 1, ms: -5, v: null })).toEqual({ a: 1, ms: 0, v: null });
  });
});

describe('amberRemainingMs', () => {
  it("ticks the server's ms down locally between frames, never below 0", () => {
    const a = { a: 1, ms: 5000, v: null };
    expect(amberRemainingMs(a, 1000, 1000)).toBe(5000);
    expect(amberRemainingMs(a, 1000, 2500)).toBe(3500);
    expect(amberRemainingMs(a, 1000, 99999)).toBe(0);
    expect(amberRemainingMs(null, 0, 0)).toBe(0);
  });
});
