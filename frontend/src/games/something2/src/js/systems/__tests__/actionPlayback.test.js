import { describe, it, expect } from "vitest";
import { RenderSystem } from "../RenderSystem.js";
import { EntityAnimState } from "../entityAnimState.js";

// SOMET-656: box sheets (sheet.json with `rows`) play idle/walk/attack/cast/
// damage in game; legacy atlases keep exactly today's behaviour.

const ACTIONS = ["idle", "walk", "attack", "cast", "damage"];
const DIRS = ["s", "se", "e", "ne", "n", "nw", "w", "sw"];
const N = 4; // frames per action -> one cycle = 500 ms at 8 fps

function boxSheet(actions = ACTIONS, dirs = DIRS, n = N) {
  const rows = [];
  const frames = {};
  let row = 0;
  for (const action of actions) {
    for (const direction of dirs) {
      rows.push({ row, action, direction, frames: n });
      for (let i = 0; i < n; i += 1) frames[`${action}/${direction}/${i}`] = [i * 64, row * 64, 64, 64];
      row += 1;
    }
  }
  return { version: 1, cell: [64, 64], actions, frames_per_action: n, rows, frames };
}

const ATLAS = { width: 256, height: 2560 };
const imgs = { get: (k) => (k === "atlas" ? ATLAS : null) };
const creature = (manifest, over = {}) => ({
  id: 9, x: 1000, y: 1000, tx: 1000, ty: 1000, width: 48, height: 48, facing: "E",
  render_mode: "static",
  sprite: { atlas_key: "atlas", manifest_key: "m", static_frame: "idle/s/0", manifest },
  ...over,
});

// The frame key whose rect resolveSprite returned.
function keyOf(manifest, crop) {
  return Object.keys(manifest.frames).find((k) => manifest.frames[k] === crop) || null;
}

function resolveAt(e, anim, now, key = "c:9", mode = "static") {
  const r = RenderSystem.resolveSprite(e, imgs, mode, now, anim, key);
  return r ? keyOf(e.sprite.manifest, r.crop) : null;
}

describe("RenderSystem.resolveSprite with a box sheet and anim state", () => {
  it("without anim state, shows the static frame exactly as before", () => {
    const m = boxSheet();
    const e = creature(m);
    expect(keyOf(m, RenderSystem.resolveSprite(e, imgs, "static", 1234).crop)).toBe("idle/s/0");
  });

  it("idles in the creature's facing, looping at 8 fps from its phase", () => {
    const m = boxSheet();
    const anim = new EntityAnimState();
    const e = creature(m);
    resolveAt(e, anim, 0); // first observation creates the record
    const phase = anim.stateFor("c:9").phase;
    expect(resolveAt(e, anim, phase)).toBe("idle/e/0");
    expect(resolveAt(e, anim, phase + 125)).toBe("idle/e/1");
    expect(resolveAt(e, anim, phase + 500)).toBe("idle/e/0");
  });

  it("walks while short of its snapshot target", () => {
    const m = boxSheet();
    const anim = new EntityAnimState();
    expect(resolveAt(creature(m, { tx: 1100 }), anim, 1000)).toMatch(/^walk\/e\//);
  });

  it("walks while its position changes, idles 150 ms after it stops", () => {
    const m = boxSheet();
    const anim = new EntityAnimState();
    const e = creature(m);
    resolveAt(e, anim, 0);
    e.x += 5; e.tx = e.x;
    expect(resolveAt(e, anim, 16)).toMatch(/^walk\//);
    expect(resolveAt(e, anim, 100)).toMatch(/^walk\//);
    expect(resolveAt(e, anim, 166)).toMatch(/^idle\//);
  });

  it("plays one attack cycle from the event, clamped to its last frame, then idles", () => {
    const m = boxSheet();
    const anim = new EntityAnimState();
    const e = creature(m);
    anim.noteAttack("c:9", 1000, false);
    expect(resolveAt(e, anim, 1000)).toBe("attack/e/0");
    expect(resolveAt(e, anim, 1250)).toBe("attack/e/2");
    expect(resolveAt(e, anim, 1499)).toBe("attack/e/3");
    expect(resolveAt(e, anim, 1500)).toMatch(/^idle\/e\//);
  });

  it("plays cast for a cast event", () => {
    const m = boxSheet();
    const anim = new EntityAnimState();
    anim.noteAttack("c:9", 1000, true);
    expect(resolveAt(creature(m), anim, 1125)).toBe("cast/e/1");
  });

  it("damage wins over an overlapping attack (no flicker between the two)", () => {
    const m = boxSheet();
    const anim = new EntityAnimState();
    const e = creature(m);
    anim.noteAttack("c:9", 1000, false);
    anim.noteHit("c:9", 1100);
    const seen = [];
    for (let t = 1100; t < 1400; t += 16) seen.push(resolveAt(e, anim, t).split("/")[0]);
    expect(new Set(seen)).toEqual(new Set(["damage"]));
    expect(resolveAt(e, anim, 1400)).toBe("attack/e/3");
  });

  it("a sheet with no damage rows keeps playing the attack through a hit", () => {
    const m = boxSheet(["idle", "attack"]);
    const anim = new EntityAnimState();
    anim.noteAttack("c:9", 1000, false);
    anim.noteHit("c:9", 1000);
    expect(resolveAt(creature(m), anim, 1125)).toBe("attack/e/1");
  });

  it("uses the nearest direction the sheet has", () => {
    const m = boxSheet(["idle", "attack"], ["s", "n"]);
    const anim = new EntityAnimState();
    anim.noteAttack("c:9", 0, false);
    expect(resolveAt(creature(m, { facing: "NE" }), anim, 0)).toBe("attack/n/0");
  });

  it("reads a player's lower-case facing", () => {
    const m = boxSheet();
    const anim = new EntityAnimState();
    anim.noteAttack("self", 0, false);
    expect(resolveAt(creature(m, { facing: "nw" }), anim, 0, "self")).toBe("attack/nw/0");
  });

  it("falls back to the static frame when the sheet has neither the action nor idle", () => {
    const m = boxSheet(["walk"], ["s"]);
    m.frames["idle/s/0"] = undefined;
    const e = creature(m, { sprite: { atlas_key: "atlas", static_frame: "walk/s/0", manifest: m } });
    const anim = new EntityAnimState();
    anim.noteAttack("c:9", 0, false);
    expect(resolveAt(e, anim, 0)).toBe("walk/s/0");
  });

  it("plays in animated mode too (box keys never match the legacy DIR/i lookup)", () => {
    const m = boxSheet();
    const anim = new EntityAnimState();
    anim.noteAttack("c:9", 0, false);
    expect(resolveAt(creature(m), anim, 0, "c:9", "animated")).toBe("attack/e/0");
  });

  it("rect mode still draws no sprite", () => {
    const anim = new EntityAnimState();
    expect(RenderSystem.resolveSprite(creature(boxSheet()), imgs, "rect", 0, anim, "c:9")).toBe(null);
  });
});

describe("legacy atlases are unchanged by anim state (regression)", () => {
  const legacy = {
    cell: [64, 64],
    frames: { "S/0": [0, 0, 64, 64], "S/1": [64, 0, 64, 64], "E/0": [0, 64, 64, 64], "E/1": [64, 64, 64, 64] },
  };
  const e = () => creature(legacy, { sprite: { atlas_key: "atlas", manifest: legacy } });

  it("static and animated pick the same frame with or without anim state", () => {
    for (const mode of ["static", "animated"]) {
      for (const t of [0, 100, 170, 400]) {
        const anim = new EntityAnimState();
        anim.noteAttack("c:9", t, false);
        anim.noteHit("c:9", t);
        const before = RenderSystem.resolveSprite(e(), imgs, mode, t);
        const after = RenderSystem.resolveSprite(e(), imgs, mode, t, anim, "c:9");
        expect(after).toEqual(before);
      }
    }
    expect(keyOf(legacy, RenderSystem.resolveSprite(e(), imgs, "animated", 170).crop)).toBe("E/1");
  });

  it("does not track a legacy actor", () => {
    const anim = new EntityAnimState();
    RenderSystem.resolveSprite(e(), imgs, "static", 0, anim, "c:9");
    expect(anim.size).toBe(0);
  });
});

describe("RenderSystem.animKeyFor", () => {
  it("names each drawable's actor", () => {
    expect(RenderSystem.animKeyFor({ kind: "player", ref: {} })).toBe("self");
    expect(RenderSystem.animKeyFor({ kind: "remote", ref: {}, userId: "42" })).toBe("p:42");
    expect(RenderSystem.animKeyFor({ kind: "entity", ref: { id: 7 } })).toBe("c:7");
    expect(RenderSystem.animKeyFor({ kind: "entity", ref: {} })).toBe(null);
    expect(RenderSystem.animKeyFor({ kind: "decoration", ref: { id: 7 } })).toBe(null);
  });
});

// The draw paths: the renderer's anim state and the override gate.
function recordingCanvas() {
  const calls = [];
  const ctx = {
    imageSmoothingEnabled: false, globalAlpha: 1, fillStyle: "", strokeStyle: "", lineWidth: 1, font: "", textAlign: "",
    drawImage: (...args) => calls.push(args), fillRect() {}, save() {}, restore() {}, translate() {}, transform() {},
    setTransform() {}, scale() {}, rotate() {}, ellipse() {}, beginPath() {}, closePath() {}, moveTo() {},
    lineTo() {}, arc() {}, fill() {}, stroke() {}, fillText() {}, strokeText() {}, measureText: () => ({ width: 10 }),
    createRadialGradient: () => ({ addColorStop() {} }), createLinearGradient: () => ({ addColorStop() {} }),
  };
  return { canvas: { getContext: () => ctx }, calls };
}

function drawnKey(m, calls) {
  const d = calls.find((a) => a[0] === ATLAS);
  if (!d) return null;
  const crop = d.slice(1, 5);
  return Object.keys(m.frames).find((k) => String(m.frames[k]) === String(crop)) || null;
}

describe("draw paths play box actions", () => {
  it("drawEntity plays a creature's attack via its key", () => {
    const m = boxSheet();
    const { canvas, calls } = recordingCanvas();
    const rs = new RenderSystem(canvas, imgs);
    rs.entityAnim = new EntityAnimState();
    rs.entityAnim.noteAttack("c:9", 1000, false);
    rs.nowMs = 1125;
    rs.drawEntity(creature(m), "c:9");
    expect(drawnKey(m, calls)).toBe("attack/e/1");
  });

  it("drawEntity without a key (decorations, point art) stays static", () => {
    const m = boxSheet();
    const { canvas, calls } = recordingCanvas();
    const rs = new RenderSystem(canvas, imgs);
    rs.entityAnim = new EntityAnimState();
    rs.nowMs = 1125;
    rs.drawEntity(creature(m));
    expect(drawnKey(m, calls)).toBe("idle/s/0");
    expect(rs.entityAnim.size).toBe(0);
  });

  it("a 'static' or 'rect' override turns playback off; 'animated' keeps it", () => {
    const m = boxSheet();
    for (const [override, want] of [["static", "idle/s/0"], ["rect", null], ["animated", "attack/e/1"], [null, "attack/e/1"]]) {
      const { canvas, calls } = recordingCanvas();
      const rs = new RenderSystem(canvas, imgs);
      rs.entityAnim = new EntityAnimState();
      rs.entityAnim.noteAttack("c:9", 1000, false);
      rs.renderModeOverride = override;
      rs.nowMs = 1125;
      rs.drawEntity(creature(m), "c:9");
      expect(drawnKey(m, calls)).toBe(want);
    }
  });

  it("drawCreature (players) plays via its key, and honours a static override", () => {
    const m = boxSheet();
    for (const [override, want] of [[null, "attack/sw/1"], ["static", "idle/s/0"]]) {
      const { canvas, calls } = recordingCanvas();
      const rs = new RenderSystem(canvas, imgs);
      rs.entityAnim = new EntityAnimState();
      rs.entityAnim.noteAttack("p:42", 1000, false);
      rs.renderModeOverride = override;
      rs.nowMs = 1125;
      const p = { x: 500, y: 500, width: 64, height: 64, facing: "sw", renderMode: "static", sprite: creature(m).sprite };
      rs.drawCreature(p, "player", 0.85, "42", "p:42");
      expect(drawnKey(m, calls)).toBe(want);
    }
  });
});
