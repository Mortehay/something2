import { describe, it, expect } from "vitest";
import { RenderSystem } from "../RenderSystem.js";
import { blastScreenRadiusX } from "../../core/blasts.js";

// SOMET-607 (S5). _drawAuraEffects draws a creature's active auras (names in
// e.auras, resolved against the aura_effects catalog) as a ground-plane
// ellipse, same convention _drawAuraRings (SOMET-523) and _drawEffectRings
// already use -- recorded here the same way bossRender.test.js records
// drawEntity's other canvas ops.
function setup(images = {}) {
  const calls = [];
  const ctx = {
    imageSmoothingEnabled: true, globalAlpha: 1, fillStyle: "", strokeStyle: "", lineWidth: 1,
    font: "", textAlign: "", shadowColor: "", shadowBlur: 0,
    drawImage: (...args) => calls.push({ op: "drawImage", args }),
    fillRect: (...args) => calls.push({ op: "fillRect", args }),
    fillText: (text) => calls.push({ op: "fillText", text }),
    ellipse: (...args) => calls.push({ op: "ellipse", args, color: ctx.strokeStyle }),
    stroke: () => calls.push({ op: "stroke", color: ctx.strokeStyle, alpha: ctx.globalAlpha }),
    fill: () => calls.push({ op: "fill", color: ctx.fillStyle, alpha: ctx.globalAlpha }),
    strokeText() {}, save() {}, restore() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, arc() {},
  };
  const rs = new RenderSystem({ getContext: () => ctx }, { get: (k) => images[k] || null });
  return { rs, calls };
}

const PACK_LEADER = { name: "pack_leader", target_side: "allies", radius: 260, shape: "ring", color: "#d4a017", pulse_ms: 0 };
const creature = (over = {}) => ({
  id: "c1", type: "wolf", name: "Wolf", x: 0, y: 0, width: 48, height: 48, color: "#888", ...over,
});

describe("aura rendering (SOMET-607)", () => {
  it("no auraDefs loaded yet: no ring, no throw", () => {
    const { rs, calls } = setup();
    expect(() => rs.drawEntity(creature({ auras: ["pack_leader"] }))).not.toThrow();
    expect(calls.some((c) => c.op === "ellipse" && c.color === "#d4a017")).toBe(false);
  });

  it("a creature with no auras draws no ring even with the library loaded", () => {
    const { rs, calls } = setup();
    rs.auraDefs = { pack_leader: PACK_LEADER };
    rs.drawEntity(creature());
    expect(calls.some((c) => c.op === "ellipse")).toBe(false);
  });

  it("Champion's pack_leader ring is visible: a known aura draws a stroked ellipse at its catalog color/radius", () => {
    const { rs, calls } = setup();
    rs.auraDefs = { pack_leader: PACK_LEADER };
    rs.drawEntity(creature({ auras: ["pack_leader"] }));
    const ring = calls.find((c) => c.op === "ellipse" && c.color === "#d4a017");
    expect(ring).toBeTruthy();
    const [, , rx, ry] = ring.args;
    expect(rx).toBeCloseTo(blastScreenRadiusX(260), 3);
    expect(ry).toBeCloseTo(rx / 2, 3);
    expect(calls.some((c) => c.op === "stroke" && c.color === "#d4a017")).toBe(true);
    expect(calls.some((c) => c.op === "fill" && c.color === "#d4a017")).toBe(false); // ring shape never fills
  });

  it("shape: disc fills as well as strokes", () => {
    const { rs, calls } = setup();
    rs.auraDefs = { abyssor_void_rend: { ...PACK_LEADER, name: "abyssor_void_rend", shape: "disc", color: "#7c3aed" } };
    rs.drawEntity(creature({ auras: ["abyssor_void_rend"] }));
    expect(calls.some((c) => c.op === "fill" && c.color === "#7c3aed")).toBe(true);
    expect(calls.some((c) => c.op === "stroke" && c.color === "#7c3aed")).toBe(true);
  });

  it("shape: particles falls back to the ring stroke, not a throw", () => {
    const { rs, calls } = setup();
    rs.auraDefs = { swarm: { ...PACK_LEADER, name: "swarm", shape: "particles", color: "#22c55e" } };
    expect(() => rs.drawEntity(creature({ auras: ["swarm"] }))).not.toThrow();
    expect(calls.some((c) => c.op === "stroke" && c.color === "#22c55e")).toBe(true);
  });

  it("an unknown aura name is skipped, never a throw", () => {
    const { rs, calls } = setup();
    rs.auraDefs = { pack_leader: PACK_LEADER };
    expect(() => rs.drawEntity(creature({ auras: ["zzNotReal", "pack_leader"] }))).not.toThrow();
    expect(calls.filter((c) => c.op === "ellipse").length).toBe(1);
  });

  it("drawCreature (the player/remote-player path) draws the same way", () => {
    const { rs, calls } = setup();
    rs.auraDefs = { pack_leader: PACK_LEADER };
    rs.drawCreature(creature({ auras: ["pack_leader"] }), "missing-image");
    expect(calls.some((c) => c.op === "ellipse" && c.color === "#d4a017")).toBe(true);
  });

  it("renderChunked's auraDefs param is applied the same way vfxDefs is", () => {
    // A catch-all ctx (same trick gameArt.test.js uses): renderChunked
    // touches dozens of optional surfaces, and only the auraDefs assignment
    // is under test here.
    const gradient = { addColorStop: () => {} };
    const special = { createLinearGradient: () => gradient, createRadialGradient: () => gradient, measureText: (t) => ({ width: String(t).length * 6 }) };
    const proxyCtx = new Proxy({}, { get: (_, k) => (k in special ? special[k] : () => {}), set: () => true });
    const rs = new RenderSystem({ getContext: () => proxyCtx }, { get: () => null });
    rs.renderChunked({
      player: { x: 100, y: 100, width: 32, height: 32, hp: 10, maxHp: 10 },
      camera: { apply() {}, reset() {}, screenX: 0, screenY: 0, width: 800, height: 600 },
      chunkedMap: { chunkSize: 16, loadedKeys: () => [], getChunk: () => null, mapTiles: null },
      remotePlayers: new Map(),
      localUserId: 1,
      auraDefs: { pack_leader: PACK_LEADER },
    });
    expect(rs.auraDefs).toEqual({ pack_leader: PACK_LEADER });
  });
});
