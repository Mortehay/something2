import { describe, it, expect } from "vitest";
import { resolveMove } from "../movement.js";
import { ChunkedMap } from "../../core/ChunkedMap.js";
import { MAP_TILE_SIZE } from "../../core/constants.js";

const N = 4;
const T = MAP_TILE_SIZE;
const DEFS = { grass: { walkable: true, speed: 1 }, water: { walkable: false, speed: 1 }, mud: { walkable: true, speed: 0.5 } };

function mapWith(rows) {
  const m = new ChunkedMap(N, DEFS);
  m.setChunk(0, 0, rows);
  return m;
}
const allGrass = () => Array.from({ length: N }, () => Array(N).fill("grass"));

// actor sized so its center is inside chunk (0,0)
const actor = () => ({ x: 10, y: 10, width: 20, height: 20, speed: 100 });

describe("resolveMove", () => {
  it("moves on grass in the requested direction", () => {
    const m = mapWith(allGrass());
    const r = resolveMove(m, actor(), 1, 0, 1); // 1 second east
    expect(r.x).toBeGreaterThan(10);
    expect(r.y).toBe(10);
    expect(r.moved).toBe(true);
  });

  it("is blocked by a water tile on that axis", () => {
    // Put water at local (0,1) so a step east from center of (0,0) hits it.
    const rows = allGrass();
    rows[0][1] = "water";
    const m = mapWith(rows);
    // actor center near right edge of tile (0,0) so a small east step crosses into (0,1)
    const a = { x: T - 30, y: 10, width: 20, height: 20, speed: 100 };
    const r = resolveMove(m, a, 1, 0, 1);
    expect(r.x).toBe(a.x); // blocked east
  });

  it("scales step by the current tile's speed", () => {
    const fast = resolveMove(mapWith(allGrass()), actor(), 1, 0, 1).x - 10;
    const rows = allGrass(); rows[0][0] = "mud"; // mud under the actor's center
    const slow = resolveMove(mapWith(rows), actor(), 1, 0, 1).x - 10;
    expect(slow).toBeCloseTo(fast * 0.5, 5);
  });

  it("normalizes diagonal movement (no speed boost)", () => {
    const straight = resolveMove(mapWith(allGrass()), actor(), 1, 0, 1).x - 10;
    const diag = resolveMove(mapWith(allGrass()), actor(), 1, 1, 1);
    const dist = Math.hypot(diag.x - 10, diag.y - 10);
    expect(dist).toBeCloseTo(straight, 5);
  });

  it("is blocked when stepping into an unloaded chunk (streaming frontier)", () => {
    const m = mapWith(allGrass()); // only chunk (0,0) loaded
    // actor near the east edge of chunk (0,0); a step east crosses into chunk (1,0), unloaded.
    const a = { x: N * T - 30, y: 10, width: 20, height: 20, speed: 100 };
    const r = resolveMove(m, a, 1, 0, 1);
    expect(r.x).toBe(a.x); // blocked at the frontier
  });

  it("does not mutate the actor", () => {
    const a = actor();
    resolveMove(mapWith(allGrass()), a, 1, 0, 1);
    expect(a.x).toBe(10);
    expect(a.y).toBe(10);
  });
});
