import { describe, it, expect } from "vitest";
import { RenderSystem } from "../RenderSystem.js";

// Entity atlases come in two shapes:
//  - directional (from /api/sprite-jobs):  frames keyed "S/0", "N/1", …
//  - flat        (from /api/entity-jobs):  frames keyed "0", "1", …  (the tile
//    pipeline, reused for props and non-facing creatures)
// resolveSprite has to animate BOTH; before flat support it silently froze on
// one frame because animatedFrameKey only ever looks for "<DIR>/<idx>".

const ATLAS = { flag: "atlas-image" };
const imageManager = { get: (key) => (key === "k/atlas.png" ? ATLAS : null) };

const flatManifest = {
  cell: [8, 8],
  frames: { 0: [0, 0, 8, 8], 1: [8, 0, 8, 8], 2: [16, 0, 8, 8], 3: [24, 0, 8, 8] },
};

const dirManifest = {
  cell: [8, 8],
  frames: { "S/0": [0, 0, 8, 8], "S/1": [8, 0, 8, 8], "N/0": [16, 0, 8, 8] },
};

function flatEntity() {
  return {
    facing: "S",
    sprite: { atlas_key: "k/atlas.png", manifest: flatManifest, frames: 4 },
  };
}

describe("resolveSprite with a flat (non-directional) entity atlas", () => {
  it("animates through the flat frames as time advances", () => {
    const e = flatEntity();
    // tileFrameKey cycles at 4fps: 0ms -> frame 0, 250ms -> frame 1, 500 -> 2.
    const at0 = RenderSystem.resolveSprite(e, imageManager, "animated", 0);
    const at250 = RenderSystem.resolveSprite(e, imageManager, "animated", 250);
    const at500 = RenderSystem.resolveSprite(e, imageManager, "animated", 500);

    expect(at0.crop).toEqual([0, 0, 8, 8]);
    expect(at250.crop).toEqual([8, 0, 8, 8]);
    expect(at500.crop).toEqual([16, 0, 8, 8]);
    expect(at0.img).toBe(ATLAS);
  });

  it("shows a single frame in static mode", () => {
    const e = flatEntity();
    const s = RenderSystem.resolveSprite(e, imageManager, "static", 250);
    // No "S/0" in a flat manifest — falls back to the first frame rather than
    // returning null and dropping to a colored rectangle.
    expect(s.crop).toEqual([0, 0, 8, 8]);
  });

  it("still prefers the facing's frames on a directional atlas", () => {
    const e = { facing: "N", sprite: { atlas_key: "k/atlas.png", manifest: dirManifest } };
    // "N" has one frame, so every timestamp resolves to it — and crucially NOT
    // to a flat-index frame, which the manifest doesn't have.
    expect(RenderSystem.resolveSprite(e, imageManager, "animated", 0).crop).toEqual([16, 0, 8, 8]);
    expect(RenderSystem.resolveSprite(e, imageManager, "animated", 250).crop).toEqual([16, 0, 8, 8]);
  });

  it("returns null when the atlas image has not loaded yet", () => {
    const e = flatEntity();
    const empty = { get: () => null };
    expect(RenderSystem.resolveSprite(e, empty, "animated", 0)).toBe(null);
  });
});
