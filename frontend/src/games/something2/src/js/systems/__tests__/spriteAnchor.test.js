import { describe, it, expect } from "vitest";
import { RenderSystem } from "../RenderSystem.js";
import { worldToScreen } from "../../core/iso.js";
import { ISO_TILE_H, MAP_TILE_SIZE } from "../../core/constants.js";

// SOMET-319. An actor is a world BOX, and movement/collision resolve against
// that box's centre (systems/movement.js resolveMove). The renderer must stand
// the sprite's feet on the projection of that same point, or the player sees
// obstacles blocking somewhere up the figure instead of at the feet.
//
// These tests record the rect actually handed to the canvas, so they pin the
// drawn geometry rather than restating the formula: the old
// `drawY = s.y - h + ISO_TILE_H/2` fails every one of them by exactly
// ISO_TILE_H/2 (= the projection of a half-tile (+50,+50) world offset).

// Records the one call each draw path makes to place its sprite rect. Only the
// members RenderSystem touches are implemented; anything else would be a test
// of the stub rather than of the renderer.
function recordingCanvas() {
  const calls = [];
  const ctx = {
    imageSmoothingEnabled: true,
    globalAlpha: 1,
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textAlign: "",
    drawImage: (...args) => calls.push({ op: "drawImage", args }),
    fillRect: (...args) => calls.push({ op: "fillRect", args }),
    save() {}, restore() {}, beginPath() {}, closePath() {}, moveTo() {},
    lineTo() {}, ellipse() {}, arc() {}, fill() {}, stroke() {},
    fillText() {}, strokeText() {},
  };
  return { canvas: { getContext: () => ctx }, calls };
}

// The rect a draw path placed its sprite at: [x, y, w, h] for both the
// drawImage (sprite present) and fillRect (fallback) forms.
function spriteRect(calls) {
  const c = calls.find((k) => k.op === "drawImage" || k.op === "fillRect");
  if (!c) throw new Error("no sprite rect was drawn");
  // drawImage(img, dx, dy, dw, dh) | drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh)
  if (c.op === "drawImage") return c.args.slice(c.args.length - 4);
  return c.args;
}

describe("sprite anchoring (SOMET-319)", () => {
  it("stands a creature's feet on the projection of its collision anchor", () => {
    const { canvas, calls } = recordingCanvas();
    const rs = new RenderSystem(canvas, { get: () => ({ width: 64, height: 64 }) });

    // A player box exactly filling tile (3,4): collision anchors on its centre.
    const obj = { x: 300, y: 400, width: 64, height: 64 };
    rs.drawCreature(obj, "player");

    const [dx, dy, w, h] = spriteRect(calls);
    const anchor = worldToScreen(obj.x + obj.width / 2, obj.y + obj.height / 2);
    expect(dy + h).toBeCloseTo(anchor.y, 10); // feet ON the anchor, not below it
    expect(dx + w / 2).toBeCloseTo(anchor.x, 10);
    // Guards the specific regression rather than just the invariant: the old
    // lift put the feet a half-tile (+50,+50 world) toward the camera.
    expect(dy + h).not.toBeCloseTo(anchor.y + ISO_TILE_H / 2, 3);
  });

  it("stands a decoration's base on its own tile centre", () => {
    const { canvas, calls } = recordingCanvas();
    const rs = new RenderSystem(canvas, { get: () => null });

    // The shape collectDecorations builds: top-left tile corner, box sized to
    // the tile, sprite drawn at displayWidth/displayHeight (a tree is taller
    // than its tile — its BASE, not its box, is what must sit on the tile).
    const deco = {
      x: 6400, y: 6600, width: MAP_TILE_SIZE, height: MAP_TILE_SIZE,
      displayWidth: 64, displayHeight: 140,
    };
    rs.drawEntity(deco);

    const [dx, dy, w, h] = spriteRect(calls);
    const anchor = worldToScreen(deco.x + MAP_TILE_SIZE / 2, deco.y + MAP_TILE_SIZE / 2);
    expect(h).toBe(140); // displayHeight still sizes the sprite
    expect(dy + h).toBeCloseTo(anchor.y, 10);
    expect(dx + w / 2).toBeCloseTo(anchor.x, 10);
  });

  it("puts a creature and a decoration on the same tile on one ground line", () => {
    // The two paths are separate methods; a fix applied to only one of them
    // would leave actors floating relative to the trees they collide with.
    const a = recordingCanvas();
    const rsA = new RenderSystem(a.canvas, { get: () => null });
    rsA.drawEntity({ x: 1000, y: 1000, width: 48, height: 48 });

    const b = recordingCanvas();
    const rsB = new RenderSystem(b.canvas, { get: () => null });
    rsB.drawEntity({
      x: 1000 - MAP_TILE_SIZE / 2 + 24, y: 1000 - MAP_TILE_SIZE / 2 + 24,
      width: MAP_TILE_SIZE, height: MAP_TILE_SIZE, displayWidth: 80, displayHeight: 120,
    });

    const [, cy, , ch] = spriteRect(a.calls);
    const [, dy2, , dh] = spriteRect(b.calls);
    expect(cy + ch).toBeCloseTo(dy2 + dh, 10);
  });
});
