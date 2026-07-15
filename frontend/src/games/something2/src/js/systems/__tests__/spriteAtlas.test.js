import { describe, it, expect } from "vitest";
import { frameRect, staticFrameKey, animatedFrameKey, facingToDir } from "../spriteAtlas.js";
import { RenderSystem } from "../RenderSystem.js";

const MANIFEST = {
  cell: [32, 40],
  frames: { "S/0": [0, 0, 32, 40], "N/0": [32, 0, 32, 40], "E/0": [0, 40, 32, 40] },
};

// Two-frame south walk cycle for animation tests.
const ANIM = { cell: [1, 1], frames: { "S/0": [0, 0, 1, 1], "S/1": [1, 0, 1, 1] } };

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

describe("facingToDir", () => {
  it("passes valid directions through, defaults to S", () => {
    expect(facingToDir("NE")).toBe("NE");
    expect(facingToDir(undefined)).toBe("S");
    expect(facingToDir("nonsense")).toBe("S");
  });
});

describe("animatedFrameKey", () => {
  it("cycles a direction's frames over time at 6fps", () => {
    expect(animatedFrameKey(ANIM, "S", 0)).toBe("S/0");
    expect(animatedFrameKey(ANIM, "S", 200)).toBe("S/1");   // 0.2s*6 = 1.2 -> idx 1
    expect(animatedFrameKey(ANIM, "S", 1000 / 6 * 2)).toBe("S/0"); // wraps (2 % 2)
  });
  it("returns null for a direction with no frames", () => {
    expect(animatedFrameKey(ANIM, "W", 0)).toBeNull();
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

  it("cycles frames by facing in animated mode", () => {
    const animAtlas = { width: 2, height: 1 };
    const im2 = { get: (k) => (k === "atlas.png" ? animAtlas : null) };
    const e = { facing: "S", sprite: { atlas_key: "atlas.png", manifest: ANIM } };
    expect(RenderSystem.resolveSprite(e, im2, "animated", 0).crop).toEqual([0, 0, 1, 1]);
    expect(RenderSystem.resolveSprite(e, im2, "animated", 200).crop).toEqual([1, 0, 1, 1]);
  });

  it("returns null (=> rect fallback) when the atlas isn't loaded or manifest missing", () => {
    expect(RenderSystem.resolveSprite({ sprite: { atlas_key: "missing", manifest: MANIFEST } }, im, "static")).toBeNull();
    expect(RenderSystem.resolveSprite({ sprite: { atlas_key: "atlas.png" } }, im, "static")).toBeNull();
    expect(RenderSystem.resolveSprite({}, im, "static")).toBeNull();
  });
});
