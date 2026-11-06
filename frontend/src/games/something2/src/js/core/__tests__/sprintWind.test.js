import { describe, it, expect } from "vitest";
import { stepSprintWind, sprintEmitters, windAlpha, WIND_LIFE_S, MAX_PARTICLES } from "../sprintWind.js";

const rngOf = (v) => () => v;
const east = [{ id: 'me', x: 100, y: 100, dx: 1, dy: 0 }];

describe("sprint wind", () => {
  it("spawns behind the direction of motion", () => {
    const s = stepSprintWind(null, 0.1, east, rngOf(0.5));
    expect(s.particles.length).toBeGreaterThan(0);
    for (const p of s.particles) expect(p.x).toBeLessThan(100);   // moving east -> wind to the west
  });

  it("density does not depend on frame rate", () => {
    const run = (dt) => {
      let s = null; let total = 0;
      for (let t = 0; t < 1; t += dt) { const before = s ? s.particles.length : 0; s = stepSprintWind(s, dt, east, rngOf(0.5)); total += s.particles.length - before; }
      return total;
    };
    // particles also die while we count, so compare spawn totals only via the carry:
    expect(Math.abs(run(1 / 60) - run(1 / 20))).toBeLessThan(30);
  });

  it("particles fade and are removed after their life", () => {
    let s = stepSprintWind(null, 0.05, east, rngOf(0.5));
    expect(s.particles.length).toBeGreaterThan(0);
    for (let t = 0; t < WIND_LIFE_S * 2; t += 0.05) s = stepSprintWind(s, 0.05, [], rngOf(0.5));
    expect(s.particles).toHaveLength(0);
  });

  it("is bounded however many sprinters there are", () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ id: i, x: i, y: 0, dx: 1, dy: 0 }));
    let s = null;
    for (let i = 0; i < 30; i += 1) s = stepSprintWind(s, 0.1, many, rngOf(0.4));
    expect(s.particles.length).toBeLessThanOrEqual(MAX_PARTICLES);
  });

  it("ignores a sprinter with no direction or a bad position", () => {
    const s = stepSprintWind(null, 0.2, [{ id: 'a', x: 0, y: 0, dx: 0, dy: 0 }, { id: 'b', x: NaN, y: 0, dx: 1, dy: 0 }], rngOf(0.5));
    expect(s.particles).toHaveLength(0);
  });

  it("alpha goes from 1 to 0", () => {
    expect(windAlpha({ age: 0, life: 1 })).toBe(1);
    expect(windAlpha({ age: 1, life: 1 })).toBe(0);
  });
});

describe("sprintEmitters", () => {
  it("needs two frames, a sprint and real movement", () => {
    const last = new Map();
    expect(sprintEmitters([{ id: 'a', x: 0, y: 0, sprinting: true }], last)).toEqual([]);          // first sight
    const out = sprintEmitters([{ id: 'a', x: 10, y: 0, sprinting: true }], last);
    expect(out).toEqual([{ id: 'a', x: 10, y: 0, dx: 10, dy: 0 }]);
    expect(sprintEmitters([{ id: 'a', x: 10, y: 0, sprinting: true }], last)).toEqual([]);        // standing still
    expect(sprintEmitters([{ id: 'a', x: 20, y: 0, sprinting: false }], last)).toEqual([]);       // not sprinting
    expect(sprintEmitters([{ id: 'a', x: 5000, y: 0, sprinting: true }], last)).toEqual([]);      // teleport
  });
});
