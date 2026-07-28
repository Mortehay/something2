import { describe, it, expect } from "vitest";
import { RenderSystem } from "../RenderSystem.js";
import { depthKey } from "../../core/iso.js";
import { MAP_TILE_SIZE } from "../../core/constants.js";

// Minimal ChunkedMap stub: only the interface collectDecorations consumes
// (chunkSize, loadedKeys(), decorationsInChunk(cx,cy)) — no need for the real
// tile/collision machinery to exercise the pure collection logic.
function stubMap(chunkSize, chunks) {
  return {
    chunkSize,
    loadedKeys: () => Object.keys(chunks),
    decorationsInChunk: (cx, cy) => chunks[`${cx},${cy}`] || [],
  };
}

describe("RenderSystem.collectDecorations", () => {
  it("returns one drawable at the tile top-left world position, anchored on the tile center", () => {
    const chunkSize = 16;
    const chunkedMap = stubMap(chunkSize, {
      "1,2": [{ name: "Rock", row: 3, col: 5, blocking: true }],
    });
    // Real getEntityTypesMap rows carry ONLY displayWidth/displayHeight —
    // never width/height (there is no such column on entity_types). A
    // fixture that adds width/height here would mask drawEntity's
    // `(e.width||40)/2` anchor fallback, which is exactly the bug this test
    // pins (see the width/height=MAP_TILE_SIZE assertion below).
    const decoTypes = new Map([["Rock", { name: "Rock", displayWidth: 64, displayHeight: 96, place_order: 2 }]]);

    const out = RenderSystem.collectDecorations(chunkedMap, null, decoTypes);

    const expectedX = (1 * chunkSize + 5) * MAP_TILE_SIZE;
    const expectedY = (2 * chunkSize + 3) * MAP_TILE_SIZE;
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("decoration");
    expect(out[0].order).toBe(2);
    // Depth sorts at the tile CENTER (matching walls/actors), not the
    // top-left ref.x/ref.y used for drawing — see RenderSystem's comment at
    // the collectDecorations depth push.
    expect(out[0].depth).toBe(depthKey(expectedX + MAP_TILE_SIZE / 2, expectedY + MAP_TILE_SIZE / 2));
    expect(out[0].ref).toMatchObject({
      name: "Rock",
      displayWidth: 64,
      displayHeight: 96,
      x: expectedX,
      y: expectedY,
    });
    // Pins the tile-CENTER anchor: drawEntity computes worldToScreen(e.x +
    // (e.width||40)/2, e.y + (e.height||40)/2) — width/height here must be
    // MAP_TILE_SIZE so that math lands on the tile's true center (x+50 for a
    // 100px tile), not the `||40` fallback's x+20, which floats the
    // decoration above its tile. displayWidth/displayHeight (asserted above)
    // remain what actually sizes the drawn sprite.
    expect(out[0].ref.width).toBe(MAP_TILE_SIZE);
    expect(out[0].ref.height).toBe(MAP_TILE_SIZE);
  });

  it("skips a decoration whose type is not in decoTypes (no hole)", () => {
    const chunkedMap = stubMap(16, {
      "0,0": [{ name: "Unloaded", row: 0, col: 0, blocking: false }],
    });
    const decoTypes = new Map(); // sprite/type not loaded yet

    const out = RenderSystem.collectDecorations(chunkedMap, null, decoTypes);
    expect(out).toEqual([]);
  });

  it("collects decorations across every loaded chunk", () => {
    const chunkSize = 16;
    const chunkedMap = stubMap(chunkSize, {
      "0,0": [{ name: "Rock", row: 0, col: 0, blocking: true }],
      "1,0": [{ name: "Bush", row: 1, col: 1, blocking: false }],
    });
    const decoTypes = new Map([
      ["Rock", { name: "Rock", displayWidth: 64, displayHeight: 96 }],
      ["Bush", { name: "Bush", displayWidth: 32, displayHeight: 32 }],
    ]);

    const out = RenderSystem.collectDecorations(chunkedMap, null, decoTypes);
    const names = out.map((d) => d.ref.name).sort();
    expect(names).toEqual(["Bush", "Rock"]);
  });
});
