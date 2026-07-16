import { describe, it, expect } from "vitest";
import { Player } from "../Player.js";
import { ChunkedMap } from "../../core/ChunkedMap.js";
import { MAP_TILE_SIZE } from "../../core/constants.js";

const N = 4;
const T = MAP_TILE_SIZE;
const DEFS = { grass: { walkable: true, speed: 1 }, water: { walkable: false } };
const allGrass = () => Array.from({ length: N }, () => Array(N).fill("grass"));

function chunkedMapWith(cx, cy, grid) {
  const m = new ChunkedMap(N, DEFS);
  m.setChunk(cx, cy, grid);
  return m;
}

describe("Player.update chunked branch", () => {
  it("moves via resolveMove on a ChunkedMap (no world clamp)", () => {
    const m = chunkedMapWith(0, 0, allGrass());
    const p = new Player();
    p.x = 50; p.y = 50; p.width = 20; p.height = 20; p.speed = 100; p.speedMultiplier = 1;
    const before = p.x;
    p.update(0.1, { d: true }, m); // move east
    expect(p.x).toBeGreaterThan(before);
    expect(p.y).toBe(50);
  });

  it("is blocked at an unloaded chunk frontier", () => {
    const m = chunkedMapWith(0, 0, allGrass()); // only (0,0) loaded
    const p = new Player();
    // place near east edge of chunk (0,0); a step east enters unloaded (1,0)
    p.x = N * T - 30; p.y = 50; p.width = 20; p.height = 20; p.speed = 100; p.speedMultiplier = 1;
    const before = p.x;
    p.update(1, { d: true }, m); // big dt, tries to cross frontier
    expect(p.x).toBe(before); // blocked
  });

  it("can move to negative world coordinates (no clamp to 0)", () => {
    const m = chunkedMapWith(-1, 0, allGrass()); // chunk (-1,0) loaded
    const p = new Player();
    p.x = 5; p.y = 50; p.width = 20; p.height = 20; p.speed = 100; p.speedMultiplier = 1;
    // dt=1 (not 0.1): with MAP_TILE_SIZE=100 a 0.1s step (10px) never leaves the
    // player's starting tile column (chunk (0,0)); dt=1 gives a 100px step that
    // actually crosses into the loaded chunk (-1,0), exercising the no-clamp path.
    p.update(1, { a: true }, m); // move west, toward negative x
    expect(p.x).toBeLessThan(5); // not clamped at 0
  });
});
