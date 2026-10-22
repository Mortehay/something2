// Biome scenery density, Task 5 — rendering: features anchored at their own
// sub-tile point, ground cover in its own flat pass, and a soft placeholder for
// a feature type with no art. Pure where possible (vitest is node-env, no DOM);
// the two canvas-level claims use a recording stub context.
import { describe, it, expect } from "vitest";
import { RenderSystem } from "../RenderSystem.js";
import { compareDrawables } from "../wallRenderer.js";
import { depthKey, worldToScreen } from "../../core/iso.js";
import { MAP_TILE_SIZE } from "../../core/constants.js";

const T = MAP_TILE_SIZE;

function stubMap(chunkSize, features, cover = {}) {
  const keys = new Set([...Object.keys(features), ...Object.keys(cover)]);
  return {
    chunkSize,
    mapTiles: null,
    loadedKeys: () => [...keys],
    getChunk: () => null,
    decorationsInChunk: (cx, cy) => features[`${cx},${cy}`] || [],
    coverInChunk: (cx, cy) => cover[`${cx},${cy}`] || { types: [], cells: [] },
  };
}

// A fake loaded image: what ImageManager.get hands back once decoded.
const img = (tag, width = 32, height = 16) => ({ tag, width, height });

describe("collectDecorations anchors each feature at its own point", () => {
  it("feature drawable depth follows its anchor", () => {
    const map = stubMap(16, {
      "0,0": [
        // Emitted back-row first, so a sort that ignored oy would keep this order.
        { name: "bush", row: 2, col: 3, ox: 40, oy: 70, blocking: false, layer: "feature" },
        { name: "bush", row: 2, col: 3, ox: 60, oy: 30, blocking: false, layer: "feature" },
      ],
    });
    const decoTypes = new Map([["bush", { displayWidth: 40, displayHeight: 40 }]]);
    const out = RenderSystem.collectDecorations(map, null, decoTypes);
    out.sort(compareDrawables);
    const tileX = 3 * T, tileY = 2 * T;
    // Front feature (oy 70) sorts AFTER the back one (oy 30).
    expect(out[1].depth).toBe(depthKey(tileX + 40, tileY + 70));
    expect(out[0].depth).toBe(depthKey(tileX + 60, tileY + 30));
    // ref.x/y are offset so drawEntity's +width/2 centring lands on the anchor.
    expect(out[1].ref.x + out[1].ref.width / 2).toBe(tileX + 40);
    expect(out[1].ref.y + out[1].ref.height / 2).toBe(tileY + 70);
    expect(out[0].ref.x + out[0].ref.width / 2).toBe(tileX + 60);
    expect(out[0].ref.y + out[0].ref.height / 2).toBe(tileY + 30);
  });

  it("missing ox/oy keeps the old tile-centre anchor", () => {
    const map = stubMap(16, { "1,0": [{ name: "Rock", row: 4, col: 5, blocking: true }] });
    const decoTypes = new Map([["Rock", { displayWidth: 64, displayHeight: 96 }]]);
    const [d] = RenderSystem.collectDecorations(map, null, decoTypes);
    const tileX = (16 + 5) * T, tileY = 4 * T;
    expect(d.ref.x).toBe(tileX);
    expect(d.ref.y).toBe(tileY);
    expect(d.depth).toBe(depthKey(tileX + T / 2, tileY + T / 2));
  });
});

describe("collectCover", () => {
  // Camera looks at the centre of tile (row 2, col 2) of chunk 0,0, with a
  // deliberately small margin so the per-item cull is exercised.
  const look = worldToScreen(2 * T + 50, 2 * T + 50);
  const camera = { screenX: look.x, screenY: look.y, width: 120, height: 120 };

  it("collectCover skips types without an image and culls outside the camera rect", () => {
    const grass = img("grass", 40, 20);
    const images = { get: (k) => (k === "grass.png" ? grass : null) };
    const decoTypes = new Map([
      ["grass_tuft", { displayWidth: 40, displayHeight: 20, image: "grass.png", render_mode: "static" }],
      ["fern", { displayWidth: 30, displayHeight: 30, image: null }],          // no art yet
      ["clover", { displayWidth: 30, displayHeight: 30, image: "clover.png", render_mode: "static" }], // art not loaded
    ]);
    const map = stubMap(16, {}, {
      "0,0": {
        types: ["grass_tuft", "fern", "clover", "unknown_type"],
        cells: [
          0, 2, 2, 50, 80, // visible grass  -> kept
          1, 2, 2, 30, 30, // fern, no image -> skipped
          2, 2, 2, 70, 30, // clover, image not loaded -> skipped
          3, 2, 2, 50, 50, // type not in decoTypes -> skipped
          0, 0, 15, 50, 50, // grass far right of the view (same chunk) -> culled
        ],
      },
      "9,9": { types: ["grass_tuft"], cells: [0, 1, 1, 50, 50] }, // chunk off-screen -> culled
    });

    const out = RenderSystem.collectCover(map, camera, decoTypes, images);
    expect(out).toHaveLength(1);
    const q = out[0];
    expect(q.img).toBe(grass);
    // Bottom-centre of the quad sits on the projected anchor point.
    const a = worldToScreen(2 * T + 50, 2 * T + 80);
    expect(q.x + q.w / 2).toBeCloseTo(a.x, 6);
    expect(q.y + q.h).toBeCloseTo(a.y, 6);
    expect(q.w).toBe(40);
    expect(q.h).toBe(20);
  });

  it("fits the image into the display box without stretching", () => {
    const tall = img("tall", 10, 40); // 1:4, box 40x20 -> 5x20
    const images = { get: () => tall };
    const decoTypes = new Map([["pebbles", { displayWidth: 40, displayHeight: 20, image: "p.png", render_mode: "static" }]]);
    const map = stubMap(16, {}, { "0,0": { types: ["pebbles"], cells: [0, 2, 2, 50, 50] } });
    const [q] = RenderSystem.collectCover(map, camera, decoTypes, images);
    expect(q.w).toBe(5);
    expect(q.h).toBe(20);
    const a = worldToScreen(2 * T + 50, 2 * T + 50);
    expect(q.x + q.w / 2).toBeCloseTo(a.x, 6);
    expect(q.y + q.h).toBeCloseTo(a.y, 6);
  });

  it("skips cover whose render mode resolves to rect (column default or the dev override)", () => {
    const grass = img("grass");
    const images = { get: () => grass };
    const map = stubMap(16, {}, { "0,0": { types: ["a", "b"], cells: [0, 2, 2, 50, 50, 1, 2, 2, 60, 60] } });
    const decoTypes = new Map([
      ["a", { displayWidth: 32, displayHeight: 16, image: "a.png" }],                       // default rect
      ["b", { displayWidth: 32, displayHeight: 16, image: "b.png", render_mode: "static" }],
    ]);
    expect(RenderSystem.collectCover(map, camera, decoTypes, images)).toHaveLength(1);
    expect(RenderSystem.collectCover(map, camera, decoTypes, images, null, "rect")).toHaveLength(0);
  });

  it("caches the resolved image per type name and refreshes when the image key changes", () => {
    let lookups = 0;
    const a = img("a"), b = img("b");
    const images = { get: (k) => { lookups++; return k === "a.png" ? a : b; } };
    const cache = new Map();
    const type = { displayWidth: 32, displayHeight: 16, image: "a.png", render_mode: "static" };
    const decoTypes = new Map([["moss", type]]);
    const map = stubMap(16, {}, { "0,0": { types: ["moss"], cells: [0, 2, 2, 50, 50, 0, 2, 2, 60, 60] } });
    RenderSystem.collectCover(map, camera, decoTypes, images, cache);
    RenderSystem.collectCover(map, camera, decoTypes, images, cache);
    expect(lookups).toBe(1);
    type.image = "b.png";
    const out = RenderSystem.collectCover(map, camera, decoTypes, images, cache);
    expect(out[0].img).toBe(b);
    expect(lookups).toBe(2);
  });
});

// Records the order of draw calls so "cover drew under the sorted list" is a
// claim about pixels, not about a helper's return value.
function recordingCtx(calls) {
  const gradient = { addColorStop: () => {} };
  const special = {
    createLinearGradient: () => gradient, createRadialGradient: () => gradient,
    measureText: (t) => ({ width: String(t).length * 6 }),
    drawImage: (im, ...rest) => calls.push({ op: "drawImage", img: im, rest }),
    fillRect: (...args) => calls.push({ op: "fillRect", args }),
    ellipse: (...args) => calls.push({ op: "ellipse", args }),
    fill: () => calls.push({ op: "fill" }),
  };
  const state = {};
  return new Proxy(state, {
    get: (_, k) => (k in special ? special[k] : k in state ? state[k] : () => {}),
    set: (_, k, v) => { state[k] = v; calls.push({ op: "set", k, v }); return true; },
  });
}

describe("cover in renderChunked", () => {
  it("cover never appears in the sorted drawables list", () => {
    const calls = [];
    const grass = img("grass", 40, 20);
    const tree = img("tree", 64, 96);
    const imgs = { "grass.png": grass, "tree.png": tree };
    const rs = new RenderSystem({ getContext: () => recordingCtx(calls) }, { get: (k) => imgs[k] || null });
    let painted = null;
    const orig = rs._resolveInspect.bind(rs);
    rs._resolveInspect = (inspect, drawables, panelOpen) => { painted = drawables; return orig(inspect, drawables, panelOpen); };
    const look = worldToScreen(2 * T + 50, 2 * T + 50);
    const decoTypes = new Map([
      ["grass_tuft", { displayWidth: 40, displayHeight: 20, image: "grass.png", render_mode: "static" }],
      ["Tree", { displayWidth: 64, displayHeight: 96, image: "tree.png", render_mode: "static" }],
    ]);
    const chunkedMap = stubMap(16,
      { "0,0": [{ name: "Tree", row: 2, col: 2, ox: 50, oy: 50, blocking: true, layer: "feature" }] },
      { "0,0": { types: ["grass_tuft"], cells: [0, 2, 2, 50, 90] } });
    rs.renderChunked({
      player: { x: 0, y: 0, width: 32, height: 32, hp: 10, maxHp: 10 },
      camera: { apply() {}, reset() {}, screenX: look.x, screenY: look.y, width: 800, height: 600 },
      chunkedMap, remotePlayers: new Map(), localUserId: 1, decoTypes,
    });

    expect(painted).not.toBeNull();
    // Only the feature joins the sort; nothing in the list carries the cover type.
    expect(painted.filter((d) => d.kind === "decoration").map((d) => d.ref.name)).toEqual(["Tree"]);
    expect(painted.some((d) => d.ref && d.ref.name === "grass_tuft")).toBe(false);
    // Cover pixels were written, and before the feature (beneath actors/features).
    const coverAt = calls.findIndex((c) => c.op === "drawImage" && c.img === grass);
    const treeAt = calls.findIndex((c) => c.op === "drawImage" && c.img === tree);
    expect(coverAt).toBeGreaterThanOrEqual(0);
    expect(treeAt).toBeGreaterThan(coverAt);
  });
});

describe("no-art feature placeholder", () => {
  function setup() {
    const calls = [];
    const ctx = recordingCtx(calls);
    const rs = new RenderSystem({ getContext: () => ctx }, { get: () => null });
    return { rs, calls };
  }

  it("a decoration with no image draws a soft ellipse in its colour, never a solid rect", () => {
    const { rs, calls } = setup();
    const map = stubMap(16, { "0,0": [{ name: "fern_large", row: 1, col: 1, ox: 30, oy: 60, blocking: false, layer: "feature" }] });
    const decoTypes = new Map([["fern_large", { displayWidth: 60, displayHeight: 90, color: "#2e7d32", image: null }]]);
    const [d] = RenderSystem.collectDecorations(map, null, decoTypes);
    rs.drawEntity(d.ref);

    expect(calls.some((c) => c.op === "fillRect")).toBe(false);
    const e = calls.find((c) => c.op === "ellipse");
    expect(e).toBeTruthy();
    const [cx, cy, rx, ry] = e.args;
    const a = worldToScreen(T + 30, T + 60);
    expect(cx).toBeCloseTo(a.x, 6);
    expect(cy).toBeCloseTo(a.y, 6);
    expect(rx).toBe(30);   // display_width / 2
    expect(ry).toBe(15);   // (display_height / 3) / 2
    const fillAt = calls.findIndex((c) => c.op === "fill");
    const before = calls.slice(0, fillAt);
    const lastFill = [...before].reverse().find((c) => c.op === "set" && c.k === "fillStyle");
    const lastAlpha = [...before].reverse().find((c) => c.op === "set" && c.k === "globalAlpha");
    expect(lastFill.v).toBe("#2e7d32");
    expect(lastAlpha.v).toBeCloseTo(0.6, 6);
  });

  it("a creature with no art still degrades to its rectangle (unchanged)", () => {
    const { rs, calls } = setup();
    rs.drawEntity({ id: "c1", x: 0, y: 0, width: 48, height: 48, color: "#888" });
    expect(calls.some((c) => c.op === "fillRect")).toBe(true);
    expect(calls.some((c) => c.op === "ellipse")).toBe(false);
  });
});

// Step 4 audit: inspect.js has no one-decoration-per-tile key (targetKey uses
// the ref's x/y, which now differ per anchor) and hit-tests with the same
// anchor rule drawEntity paints with. Pin both so a later anchor change in one
// place cannot silently desync the inspect card.
describe("inspect follows the feature anchor", () => {
  it("two features in one tile get distinct target keys and anchor-centred hit rects", async () => {
    const { drawableScreenRect, targetKey } = await import("../inspect.js");
    const map = stubMap(16, {
      "0,0": [
        { name: "bush", row: 0, col: 0, ox: 25, oy: 25, blocking: false, layer: "feature" },
        { name: "bush", row: 0, col: 0, ox: 75, oy: 75, blocking: false, layer: "feature" },
      ],
    });
    const decoTypes = new Map([["bush", { displayWidth: 40, displayHeight: 40 }]]);
    const [a, b] = RenderSystem.collectDecorations(map, null, decoTypes);
    expect(targetKey(a)).not.toBe(targetKey(b));
    for (const [d, ox, oy] of [[a, 25, 25], [b, 75, 75]]) {
      const r = drawableScreenRect(d);
      const s = worldToScreen(ox, oy);
      expect(r.x + r.w / 2).toBeCloseTo(s.x, 6);
      expect(r.y + r.h).toBeCloseTo(s.y, 6);
    }
  });
});
