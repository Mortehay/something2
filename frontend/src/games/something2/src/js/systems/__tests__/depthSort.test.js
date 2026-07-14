import { describe, it, expect } from "vitest";
import { RenderSystem } from "../RenderSystem.js";

describe("RenderSystem.buildDrawables", () => {
  it("returns drawables sorted back-to-front by world x+y", () => {
    const player = { x: 100, y: 100, width: 64, height: 64 };
    const map = { entities: [
      { x: 500, y: 500, width: 40, height: 40, color: "#0f0" }, // far
      { x: 0, y: 0, width: 40, height: 40, color: "#f00" },     // near-origin
    ] };
    const remote = new Map([[7, { x: 300, y: 300, hp: 10 }]]);

    const drawables = RenderSystem.buildDrawables(player, map, remote);
    const keys = drawables.map((d) => d.depth);
    const sorted = [...keys].sort((a, b) => a - b);
    expect(keys).toEqual(sorted);
    // origin entity first, far entity last
    expect(drawables[0].kind).toBe("entity");
    expect(drawables[drawables.length - 1].depth).toBe(1000);
  });

  it("includes the local player and each remote player", () => {
    const player = { x: 100, y: 100, width: 64, height: 64 };
    const map = { entities: [] };
    const remote = new Map([[7, { x: 300, y: 300, hp: 10 }]]);
    const drawables = RenderSystem.buildDrawables(player, map, remote);
    const kinds = drawables.map((d) => d.kind).sort();
    expect(kinds).toEqual(["player", "remote"]);
  });
});
