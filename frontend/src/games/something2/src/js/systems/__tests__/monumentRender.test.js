import { describe, it, expect } from "vitest";
import { RenderSystem } from "../RenderSystem.js";
import { compareDrawables } from "../wallRenderer.js";
import { ChunkedMap } from "../../core/ChunkedMap.js";
import { depthKey, worldToScreen } from "../../core/iso.js";
import { MAP_TILE_SIZE as T } from "../../core/constants.js";

// SOMET-776: a monument arrives as one anchor entry (front cell, monument
// {w,h}) plus hidden blockers, all `solid`.
function stubMap(chunkSize, chunks) {
  return { chunkSize, loadedKeys: () => Object.keys(chunks), decorationsInChunk: (cx, cy) => chunks[`${cx},${cy}`] || [] };
}
const tower = { name: "collapsed_tower", displayWidth: 360, displayHeight: 420 };

describe("monument decorations", () => {
  it("draws only the anchor, never the hidden footprint cells", () => {
    const map = stubMap(16, {
      "0,0": [
        { name: "collapsed_tower", row: 4, col: 4, blocking: true, solid: true, hidden: true },
        { name: "collapsed_tower", row: 5, col: 5, blocking: true, solid: true, monument: { w: 2, h: 2 } },
      ],
    });
    const out = RenderSystem.collectDecorations(map, null, new Map([["collapsed_tower", tower]]));
    expect(out).toHaveLength(1);
  });

  it("a square monument stands on its front cell and sorts at its depth", () => {
    const map = stubMap(16, { "0,0": [{ name: "collapsed_tower", row: 7, col: 9, blocking: true, solid: true, monument: { w: 3, h: 3 } }] });
    const [d] = RenderSystem.collectDecorations(map, null, new Map([["collapsed_tower", tower]]));
    expect(d.ref.x).toBe(9 * T);
    expect(d.ref.y).toBe(7 * T);
    // just behind the front cell: its chest (front tile, row 10 col 8 for a
    // 3x3 at rows/cols 5..7/7..9) and a player beside it draw over the sprite
    const chestDepth = depthKey(8.5 * T, 8.5 * T);
    expect(chestDepth).toBe(depthKey(9.5 * T, 7.5 * T));
    expect(d.depth).toBeLessThan(chestDepth);
    expect(d.depth).toBeGreaterThan(depthKey(9.5 * T, 7.5 * T) - T / 10);
  });

  it("the monument sorts before a chest on its front tile in the real comparator", () => {
    const map = stubMap(16, { "0,0": [{ name: "collapsed_tower", row: 7, col: 9, blocking: true, solid: true, monument: { w: 3, h: 3 } }] });
    const [mon] = RenderSystem.collectDecorations(map, null, new Map([["collapsed_tower", tower]]));
    const chest = { kind: "worldchest", order: 0, depth: depthKey(8.5 * T, 8.5 * T) };
    const sorted = [chest, mon].sort(compareDrawables);
    expect(sorted[0]).toBe(mon);
  });

  it("a non-square footprint is centred on its footprint's screen axis", () => {
    // footprint rows 5..7 (h 3), cols 8..9 (w 2); anchor = front cell (7,9)
    const o = RenderSystem.decorationOrigin(9, 7, { w: 2, h: 3 });
    const centre = worldToScreen(9 * T, 6.5 * T); // footprint centre (x = 8+1, y = 5+1.5)
    const drawn = worldToScreen(o.x + T / 2, o.y + T / 2);
    expect(drawn.x).toBeCloseTo(centre.x, 6);
    expect(o.x + o.y + T).toBeCloseTo((9.5 + 7.5) * T, 6); // front-cell depth
  });

  it("ChunkedMap blocks the whole tile of a solid cell, only the centre of a plain blocker", () => {
    const m = new ChunkedMap(16, { grass: { walkable: true } });
    const grid = Array.from({ length: 16 }, () => Array(16).fill("grass"));
    m.setChunk(0, 0, grid, [
      { name: "collapsed_tower", row: 2, col: 2, blocking: true, solid: true, hidden: true },
      { name: "Tree", row: 4, col: 4, blocking: true },
    ]);
    expect(m.isWalkable(2 * T + 5, 2 * T + 5)).toBe(false);
    expect(m.isWalkable(2 * T + 50, 2 * T + 50)).toBe(false);
    expect(m.isWalkable(4 * T + 5, 4 * T + 5)).toBe(true);
    expect(m.isWalkable(4 * T + 50, 4 * T + 50)).toBe(false);
  });
});
