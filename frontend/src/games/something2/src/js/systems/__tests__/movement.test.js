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
    // Centre 80, footprint half-extent 5 (20/2 * FOOTPRINT_SCALE): the east
    // face 85 would reach 185, inside the water tile, so it clamps to 100-EPS
    // and x advances 99.99-85 = 14.99.
    expect(r.x).toBeCloseTo(84.99, 2);
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
    // Same footprint geometry as the water case, one chunk boundary out:
    // face 385 -> clamps to 400-EPS, so x advances 399.99-385 = 14.99.
    expect(r.x).toBeCloseTo(384.99, 2);
  });

  it("does not mutate the actor", () => {
    const a = actor();
    resolveMove(mapWith(allGrass()), a, 1, 0, 1);
    expect(a.x).toBe(10);
    expect(a.y).toBe(10);
  });

  // Footprint golden vectors — identical inputs & expected outputs to the
  // backend suite (backend/tests/authority_collision.test.js). If these two
  // ever disagree, client prediction has diverged from the server authority.
  const wallColumn = (blockedCol) => ({
    isWalkable: (wx) => Math.floor(wx / 100) !== blockedCol,
    speedAt: () => 1,
  });
  const gateColumn = (openCol) => ({
    isWalkable: (wx) => Math.floor(wx / 100) === openCol,
    speedAt: () => 1,
  });

  it("a blocked step clamps the footprint up to the wall face", () => {
    const r = resolveMove(wallColumn(1), { x: 20, y: 0, width: 64, height: 64, speed: 40 }, 1, 0, 1);
    expect(r.x).toBeCloseTo(51.99, 2);
    expect(r.x + 32 + 16).toBeCloseTo(99.99, 2); // face lands EPS shy of the line
    expect(r.y).toBe(0);
    expect(r.moved).toBe(true);
  });

  it("footprint lets an actor overlapping a wall move away from it", () => {
    const r = resolveMove(wallColumn(1), { x: 108, y: 0, width: 64, height: 64, speed: 40 }, -1, 0, 1);
    expect(r).toEqual({ x: 68, y: 0, moved: true });
  });

  it("the FOOTPRINT decides whether an actor fits, not the sprite box", () => {
    const r = resolveMove(gateColumn(1), { x: 88, y: 150, width: 64, height: 64, speed: 40 }, 0, 1, 1);
    expect(r).toEqual({ x: 88, y: 190, moved: true });
  });

  // Single wall TILE (depends on wy) so the two leading-edge corners can
  // disagree — pins the TWO-corner footprint. Same input/expected as the
  // backend suite's wallTile test.
  const wallTile = (col, row) => ({
    isWalkable: (wx, wy) => !(Math.floor(wx / 100) === col && Math.floor(wy / 100) === row),
    speedAt: () => 1,
  });

  it("footprint tests BOTH leading-edge corners (one corner in a wall tile blocks)", () => {
    const r = resolveMove(wallTile(1, 1), { x: 40, y: 68, width: 64, height: 64, speed: 40 }, 1, 0, 1);
    expect(r.x).toBeCloseTo(51.99, 2); // a one-corner regression would reach 80
    expect(r.y).toBe(68);
    expect(r.moved).toBe(true);
  });

  it("collision is dt-invariant near a wall (one big step == many small steps)", () => {
    const run = (dt, n) => {
      const a = { x: 0, y: 0, width: 64, height: 64, speed: 200 };
      for (let i = 0; i < n; i++) { const r = resolveMove(wallColumn(1), a, 1, 0, dt); a.x = r.x; a.y = r.y; }
      return a.x;
    };
    const big = run(0.05, 10);
    const small = run(0.05 / 3, 30);
    expect(Math.abs(big - small)).toBeLessThan(1e-9);
    expect(big).toBeCloseTo(51.99, 5);
  });

  it("flush against a wall, a parallel move slides at full speed", () => {
    const r = resolveMove(wallColumn(1), { x: 52, y: 0, width: 64, height: 64, speed: 200 }, 0, 1, 0.05);
    expect(r.y).toBe(10);
    expect(r.x).toBe(52);
    expect(r.moved).toBe(true);
  });
});
