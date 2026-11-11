// Amber Stance orbit: motes and wisps circling the crystal's base on a flat
// 2:1 isometric ellipse (core/amber.js, pure math).
import { describe, it, expect } from 'vitest';
import { AMBER_ORBIT_PERIOD_MS, orbitBuffer, orbitPoints, amberOrbitPhase } from '../amber.js';

const RX = 40, RY = 20;

describe('orbitPoints', () => {
  it('fills the preallocated buffer in place and returns the count', () => {
    const buf = orbitBuffer(6);
    const first = buf[0];
    expect(orbitPoints(1234, 5, RX, RY, 0, buf)).toBe(5);
    expect(buf[0]).toBe(first);
    expect(buf).toHaveLength(6);
  });

  it('every point lies on the ellipse, ry = rx / 2', () => {
    const buf = orbitBuffer(5);
    for (const t of [0, 377, 1500, 2999, 123456]) {
      orbitPoints(t, 5, RX, RY, 0.7, buf);
      for (const p of buf) {
        expect((p.x * p.x) / (RX * RX) + (p.y * p.y) / (RY * RY)).toBeCloseTo(1, 9);
      }
    }
  });

  it('one full turn every 3000 ms', () => {
    expect(AMBER_ORBIT_PERIOD_MS).toBe(3000);
    const a = orbitBuffer(5), b = orbitBuffer(5), half = orbitBuffer(5);
    orbitPoints(800, 5, RX, RY, 0, a);
    orbitPoints(800 + 3000, 5, RX, RY, 0, b);
    orbitPoints(800 + 1500, 5, RX, RY, 0, half);
    for (let i = 0; i < 5; i++) {
      expect(b[i].x).toBeCloseTo(a[i].x, 9);
      expect(b[i].y).toBeCloseTo(a[i].y, 9);
      // half a turn later each point is on the opposite side
      expect(half[i].x).toBeCloseTo(-a[i].x, 9);
      expect(half[i].y).toBeCloseTo(-a[i].y, 9);
    }
  });

  it('moves over time (not a static ring)', () => {
    const a = orbitBuffer(1), b = orbitBuffer(1);
    orbitPoints(0, 1, RX, RY, 0, a);
    orbitPoints(250, 1, RX, RY, 0, b);
    expect(Math.hypot(b[0].x - a[0].x, b[0].y - a[0].y)).toBeGreaterThan(1);
  });

  it('front = below the centre on screen (near side); depth follows y', () => {
    const buf = orbitBuffer(6);
    for (const t of [0, 400, 1100, 2600]) {
      orbitPoints(t, 6, RX, RY, 0.3, buf);
      for (const p of buf) {
        expect(p.front).toBe(p.y > 0);
        expect(p.depth).toBeCloseTo(p.y / RY, 9);
      }
      expect(buf.some((p) => p.front)).toBe(true);
      expect(buf.some((p) => !p.front)).toBe(true);
    }
  });

  it('points are spread evenly around the ring', () => {
    const buf = orbitBuffer(4);
    orbitPoints(0, 4, RX, RY, 0, buf);
    const ang = buf.map((p) => Math.atan2(p.y / RY, p.x / RX));
    for (let i = 1; i < 4; i++) {
      const d = (((ang[i] - ang[i - 1]) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      expect(Math.min(d, 2 * Math.PI - d)).toBeCloseTo(Math.PI / 2, 9);
    }
  });

  it('phase shifts the positions', () => {
    const a = orbitBuffer(5), b = orbitBuffer(5);
    orbitPoints(500, 5, RX, RY, 0, a);
    orbitPoints(500, 5, RX, RY, 0.5, b);
    expect(Math.hypot(b[0].x - a[0].x, b[0].y - a[0].y)).toBeGreaterThan(1);
  });

  it('a non-finite time or size draws a degenerate ring at the centre, never NaN', () => {
    const buf = orbitBuffer(3);
    orbitPoints(NaN, 3, NaN, undefined, NaN, buf);
    for (const p of buf) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.depth)).toBe(true);
    }
  });
});

describe('amberOrbitPhase', () => {
  it('is deterministic per arrival and in [0, 2pi)', () => {
    for (const a of [0, 1, 2, 7, 1e6]) {
      const ph = amberOrbitPhase(a);
      expect(ph).toBe(amberOrbitPhase(a));
      expect(ph).toBeGreaterThanOrEqual(0);
      expect(ph).toBeLessThan(2 * Math.PI);
    }
  });
  it('neighbouring arrivals are not in lockstep', () => {
    for (let a = 1; a < 20; a++) {
      const d = Math.abs(amberOrbitPhase(a) - amberOrbitPhase(a + 1)) % (2 * Math.PI);
      expect(Math.min(d, 2 * Math.PI - d)).toBeGreaterThan(0.3);
    }
  });
  it('a missing arrival gives phase 0', () => {
    expect(amberOrbitPhase(undefined)).toBe(0);
    expect(amberOrbitPhase(null)).toBe(0);
  });
});
