import { describe, it, expect } from 'vitest';
import { anchorY, attackLift, LEGACY_ATTACK_LIFT } from '../attackAnchor.js';
import { ISO_TILE_H } from '../constants.js';

describe('attackLift', () => {
  it('uses the anchor the server resolved', () => {
    expect(attackLift(24)).toBe(24);
    expect(attackLift(54)).toBe(54);
    // `feet` is a real origin and its lift is 0 -- it must survive as itself
    // and not be swallowed by a falsy check into the legacy default.
    expect(attackLift(0)).toBe(0);
  });

  it('falls back to the retired tile constant when no anchor arrives', () => {
    // This is the version-skew path: a server that predates SOMET-326 sends no
    // `o`, and those frames must draw exactly where they always did.
    expect(LEGACY_ATTACK_LIFT).toBe(ISO_TILE_H / 2);
    for (const missing of [undefined, null, NaN, '', 'middle', {}, -1]) {
      expect(attackLift(missing)).toBe(LEGACY_ATTACK_LIFT);
    }
  });

  it('rejects a negative anchor rather than clamping it to the ground', () => {
    // Clamping to 0 would resolve junk to `feet` -- a real, legal origin -- so
    // a broken frame would look like a deliberate authoring choice.
    expect(attackLift(-5)).toBe(LEGACY_ATTACK_LIFT);
    expect(attackLift(-5)).not.toBe(0);
  });
});

describe('anchorY', () => {
  it('lifts upward, because screen y grows downward', () => {
    expect(anchorY(500, 24)).toBe(476);
    expect(anchorY(500, 0)).toBe(500);
    expect(anchorY(500, 54)).toBe(446);
  });

  it('separates a creature from a player at the same ground point', () => {
    // The defect, stated as a test. Both actors stand at the same projected
    // point; the 48px creature's attack must anchor LOWER on screen than the
    // 64px player's, because it is a shorter body -- not identical, which is
    // what one shared tile constant produced.
    const ground = 400;
    const player = anchorY(ground, 32);     // 64px body, middle
    const creature = anchorY(ground, 24);   // 48px body, middle
    expect(creature).toBeGreaterThan(player);
    expect(creature - player).toBe(8);
  });

  it('orders feet, middle and head up the body', () => {
    const ground = 400;
    expect(anchorY(ground, 0)).toBeGreaterThan(anchorY(ground, 32));
    expect(anchorY(ground, 32)).toBeGreaterThan(anchorY(ground, 54));
  });
});
