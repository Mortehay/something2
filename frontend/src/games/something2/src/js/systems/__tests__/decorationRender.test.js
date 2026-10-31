import { describe, it, expect } from "vitest";
import { RenderSystem } from "../RenderSystem.js";
import { depthKey, worldToScreen } from "../../core/iso.js";
import { MAP_TILE_SIZE, GAME_WIDTH, GAME_HEIGHT } from "../../core/constants.js";

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

  // SOMET-667. Every loaded chunk is far larger than the viewport, so without
  // this every decoration in the streamed neighbourhood (~1,480 on the entry
  // world) went through drawEntity every frame.
  describe("with a camera", () => {
    // A camera looking at the screen projection of `cell`'s tile center.
    function cameraOn(col, row) {
      const s = worldToScreen(col * MAP_TILE_SIZE + MAP_TILE_SIZE / 2, row * MAP_TILE_SIZE + MAP_TILE_SIZE / 2);
      return { screenX: s.x, screenY: s.y, width: GAME_WIDTH, height: GAME_HEIGHT };
    }
    const decoTypes = new Map([
      ["Rock", { name: "Rock", displayWidth: 64, displayHeight: 96 }],
      // Taller than the whole viewport: its base is off-screen below while
      // its crown is still in view.
      ["Tree", { name: "Tree", displayWidth: 200, displayHeight: 900 }],
    ]);

    it("drops a decoration whose drawn sprite is fully off-screen", () => {
      const chunkedMap = stubMap(64, {
        "0,0": [
          { name: "Rock", row: 10, col: 10, blocking: true },
          { name: "Rock", row: 40, col: 40, blocking: true },
        ],
      });
      const out = RenderSystem.collectDecorations(chunkedMap, cameraOn(10, 10), decoTypes);
      expect(out.map((d) => [d.ref.x, d.ref.y])).toEqual([[10 * MAP_TILE_SIZE, 10 * MAP_TILE_SIZE]]);
    });

    // Screen offsets from tile (10,10)'s center: each +1 col moves a tile
    // center +64 px right and +32 px down; each +1 row moves it -64 px right
    // and +32 px down (iso.js, ISO_K = 0.64 per world px).
    it("keeps a tall sprite whose base is off-screen but whose crown is in view", () => {
      // (+8, +8): base 512 px below center, past the 360 px bottom edge; a
      // 900 px sprite reaches up to -388, i.e. into view.
      const chunkedMap = stubMap(64, {
        "0,0": [{ name: "Tree", row: 18, col: 18, blocking: true }],
      });
      const cam = cameraOn(10, 10);
      const base = worldToScreen(18 * MAP_TILE_SIZE + MAP_TILE_SIZE / 2, 18 * MAP_TILE_SIZE + MAP_TILE_SIZE / 2);
      expect(base.y - cam.screenY).toBe(512);
      const out = RenderSystem.collectDecorations(chunkedMap, cam, decoTypes);
      expect(out).toHaveLength(1);
    });

    it("keeps a sprite straddling the left edge and drops one just past it", () => {
      // Camera nudged 15 px right so (row 10, col 0) is centred at x = -655:
      // past the -640 edge, but a 64 px-wide rock still reaches -623. Col -1
      // is centred at -719; its right side, at -687, is fully off-screen.
      const cam = cameraOn(10, 10);
      cam.screenX += 15;
      const chunkedMap = stubMap(64, {
        "0,0": [
          { name: "Rock", row: 10, col: 0, blocking: true },
          { name: "Rock", row: 10, col: -1, blocking: true },
        ],
      });
      const s = worldToScreen(0 * MAP_TILE_SIZE + MAP_TILE_SIZE / 2, 10 * MAP_TILE_SIZE + MAP_TILE_SIZE / 2);
      expect(s.x - cam.screenX).toBe(-655);
      const out = RenderSystem.collectDecorations(chunkedMap, cam, decoTypes);
      expect(out.map((d) => d.ref.x)).toEqual([0]);
    });
  });
});
