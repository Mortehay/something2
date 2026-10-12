import { describe, it, expect } from 'vitest';
import { screenRadiusWorld } from '../screenRadius.js';
import { cursorToWorld } from '../../core/aim.js';

describe('screenRadiusWorld (SOMET-605, spec §4.4)', () => {
  it('1280x720 is ~1064.33 world px', () => {
    // Hand arithmetic: ISO_K = 128 / (2*100) = 0.64. Corner (640, 360):
    // a = 640/0.64 = 1000, b = 2*360/0.64 = 1125, |w| = sqrt((a^2+b^2)/2)
    // = sqrt(1132812.5) = 1064.33.
    expect(screenRadiusWorld(1280, 720)).toBeCloseTo(1064.33, 1);
  });

  it('equals the world distance from the view centre to a canvas corner (independent projection path)', () => {
    const camera = { screenX: 0, screenY: 0 };
    const centre = cursorToWorld(640, 360, camera);
    const corner = cursorToWorld(0, 0, camera);
    expect(screenRadiusWorld(1280, 720)).toBeCloseTo(Math.hypot(corner.x - centre.x, corner.y - centre.y), 6);
  });

  it('is 0 for a zero or missing size', () => {
    expect(screenRadiusWorld(0, 720)).toBe(0);
    expect(screenRadiusWorld(undefined, undefined)).toBe(0);
  });
});
