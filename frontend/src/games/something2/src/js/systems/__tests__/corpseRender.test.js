import { describe, it, expect } from "vitest";
import { RenderSystem } from "../RenderSystem.js";
import { makeCorpse, HOLD_MS, FADE_MS } from "../corpses.js";
import { DEATH_FRAME_MS } from "../sheetActions.js";
import { drawableScreenRect, pickDrawable } from "../inspect.js";
import { EntityAnimState } from "../entityAnimState.js";

const DIRS = ["s", "se", "e", "ne", "n", "nw", "w", "sw"];
function boxSheet(actions) {
  const rows = [];
  const frames = {};
  let row = 0;
  for (const action of actions) {
    for (const direction of DIRS) {
      rows.push({ row, action, direction, frames: 4 });
      for (let i = 0; i < 4; i += 1) frames[`${action}/${direction}/${i}`] = [i * 64, row * 64, 64, 64];
      row += 1;
    }
  }
  return { version: 1, cell: [64, 64], actions, frames_per_action: 4, rows, frames };
}
const M = boxSheet(["idle", "death"]);
const ATLAS = { width: 256, height: 2048 };
const creature = (over = {}) => ({
  id: 9, type: "Wolf", x: 1000, y: 1000, tx: 1000, ty: 1000, width: 48, height: 48, facing: "E",
  render_mode: "static", sprite: { atlas_key: "atlas", manifest: M }, ...over,
});

// A RenderSystem with no canvas: records each _drawSpriteFrame call and the
// alpha in force at that moment.
function renderer(now) {
  const rs = Object.create(RenderSystem.prototype);
  rs.ctx = { globalAlpha: 1 };
  rs.nowMs = now;
  rs.renderModeOverride = null;
  rs.imageManager = { get: (k) => (k === "atlas" ? ATLAS : null) };
  rs.calls = [];
  rs._drawSpriteFrame = (sprite, r) => rs.calls.push({ sprite, r, alpha: rs.ctx.globalAlpha });
  return rs;
}
const keyOf = (crop) => Object.keys(M.frames).find((k) => M.frames[k] === crop);

describe("RenderSystem.drawCorpse", () => {
  it("plays the death row, mirrored like the living east-facing creature (SOMET-767)", () => {
    const c = makeCorpse(creature(), 0);
    const rs = renderer(2 * DEATH_FRAME_MS);
    rs.drawCorpse(c);
    expect(rs.calls).toHaveLength(1);
    const { sprite, alpha } = rs.calls[0];
    expect(keyOf(sprite.crop)).toBe(`death/${c.dir}/2`);
    expect(sprite.flipX).toBe(true);
    expect(alpha).toBe(1);
    // The living creature facing east is drawn mirrored too.
    const live = RenderSystem.resolveSprite(creature(), rs.imageManager, "static", 0, new EntityAnimState(), "c:9");
    expect(live.flipX).toBe(true);
  });

  it("stands in the same box as drawEntity draws the living creature", () => {
    const live = creature();
    const rs = renderer(0);
    const seen = [];
    rs._drawSpriteFrame = (sprite, r) => seen.push(r);
    rs._drawEffectRings = () => {};
    rs._drawAuraEffects = () => {};
    rs._drawEffectPips = () => {};
    rs.drawEntity(live, null);
    rs.drawCorpse(makeCorpse(live, 0));
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual(seen[0]);
  });

  it("fades with the corpse alpha and restores the context alpha", () => {
    const c = makeCorpse(creature(), 0);
    const rs = renderer(4 * DEATH_FRAME_MS + HOLD_MS + FADE_MS / 2);
    rs.ctx.globalAlpha = 1;
    rs.drawCorpse(c);
    expect(keyOf(rs.calls[0].sprite.crop)).toBe(`death/${c.dir}/3`);
    expect(rs.calls[0].alpha).toBeCloseTo(0.5, 5);
    expect(rs.ctx.globalAlpha).toBe(1);
  });

  it("draws nothing once faded, or with no atlas loaded", () => {
    const c = makeCorpse(creature(), 0);
    const done = renderer(4 * DEATH_FRAME_MS + HOLD_MS + FADE_MS);
    done.drawCorpse(c);
    expect(done.calls).toHaveLength(0);
    const noAtlas = renderer(0);
    noAtlas.imageManager = { get: () => null };
    noAtlas.drawCorpse(c);
    expect(noAtlas.calls).toHaveLength(0);
  });
});

describe("a corpse is not hoverable", () => {
  it("inspect has no screen rect for it, so the cursor passes through", () => {
    const d = { kind: "corpse", ref: makeCorpse(creature(), 0), depth: 0, order: 0 };
    expect(drawableScreenRect(d)).toBe(null);
    expect(pickDrawable([d], { x: 0, y: 1280 })).toBe(null);
  });
});

describe("renderChunked draws corpses in the depth-sorted pass", () => {
  function chunkedRun(corpses, creatures = []) {
    const gradient = { addColorStop: () => {} };
    const special = { createLinearGradient: () => gradient, createRadialGradient: () => gradient, measureText: (t) => ({ width: String(t).length * 6 }) };
    const proxyCtx = new Proxy({}, { get: (_, k) => (k in special ? special[k] : () => {}), set: () => true });
    const rs = new RenderSystem({ getContext: () => proxyCtx }, { get: (k) => (k === "atlas" ? ATLAS : null) });
    const order = [];
    rs.drawCorpse = (c) => order.push(`corpse:${c.id}`);
    rs.drawEntity = (e) => order.push(`entity:${e.id}`);
    rs.drawCreature = () => order.push("player");
    rs.renderChunked({
      player: { x: 0, y: 0, width: 32, height: 32, hp: 10, maxHp: 10 },
      camera: { apply() {}, reset() {}, screenX: 0, screenY: 0, width: 800, height: 600 },
      chunkedMap: { chunkSize: 16, loadedKeys: () => [], getChunk: () => null, mapTiles: null },
      remotePlayers: new Map(), localUserId: 1, creatures, corpses,
    });
    return order;
  }
  it("sorts a corpse by its position among living creatures", () => {
    const near = { ...creature({ id: 1, x: 100, y: 100 }), render_mode: "static" };
    const far = { ...creature({ id: 3, x: 3000, y: 3000 }), render_mode: "static" };
    const corpse = makeCorpse(creature({ id: 2, x: 1000, y: 1000 }), 0);
    expect(chunkedRun([corpse], [far, near])).toEqual(["player", "entity:1", "corpse:2", "entity:3"]);
  });
  it("draws nothing extra with no corpses (the default)", () => {
    expect(chunkedRun(undefined, [])).toEqual(["player"]);
  });
});
