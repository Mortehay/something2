import { describe, it, expect } from "vitest";
import { frameRect, staticFrameKey } from "../spriteAtlas.js";
import { RenderSystem } from "../RenderSystem.js";

const MANIFEST = {
  cell: [32, 40],
  frames: { "S/0": [0, 0, 32, 40], "N/0": [32, 0, 32, 40], "E/0": [0, 40, 32, 40] },
};

describe("frameRect", () => {
  it("returns the rect for a known frame, null otherwise", () => {
    expect(frameRect(MANIFEST, "N/0")).toEqual([32, 0, 32, 40]);
    expect(frameRect(MANIFEST, "W/0")).toBeNull();
    expect(frameRect(null, "S/0")).toBeNull();
  });
});

describe("staticFrameKey", () => {
  it("prefers the declared static_frame when present", () => {
    expect(staticFrameKey({ static_frame: "E/0" }, MANIFEST)).toBe("E/0");
  });
  it("falls back to S/0, then the first frame", () => {
    expect(staticFrameKey({ static_frame: "ZZ" }, MANIFEST)).toBe("S/0");
    expect(staticFrameKey({}, { frames: { "N/0": [0, 0, 1, 1] } })).toBe("N/0");
  });
  it("returns null when there are no frames", () => {
    expect(staticFrameKey({}, { frames: {} })).toBeNull();
  });
});

describe("RenderSystem.resolveSprite", () => {
  const atlasImg = { width: 64, height: 80 };
  const im = { get: (k) => (k === "atlas.png" ? atlasImg : null) };

  it("returns null in rect mode", () => {
    const e = { sprite: { atlas_key: "atlas.png", manifest: MANIFEST } };
    expect(RenderSystem.resolveSprite(e, im, "rect")).toBeNull();
  });

  it("crops the static frame when atlas + manifest are ready", () => {
    const e = { sprite: { atlas_key: "atlas.png", manifest: MANIFEST, static_frame: "E/0" } };
    const r = RenderSystem.resolveSprite(e, im, "static");
    expect(r.img).toBe(atlasImg);
    expect(r.crop).toEqual([0, 40, 32, 40]);
  });

  it("returns null (=> rect fallback) when the atlas isn't loaded or manifest missing", () => {
    expect(RenderSystem.resolveSprite({ sprite: { atlas_key: "missing", manifest: MANIFEST } }, im, "static")).toBeNull();
    expect(RenderSystem.resolveSprite({ sprite: { atlas_key: "atlas.png" } }, im, "static")).toBeNull();
    expect(RenderSystem.resolveSprite({}, im, "static")).toBeNull();
  });
});
