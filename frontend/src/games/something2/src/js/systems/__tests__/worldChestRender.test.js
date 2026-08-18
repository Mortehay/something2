import { describe, it, expect } from "vitest";
import { RenderSystem } from "../RenderSystem.js";

// SOMET-372 -- world chests had no renderer at all, so the server's positions
// were received and discarded. These assert the two things a player reads off
// a chest before touching a key: WHICH STATE it is in, and WHETHER pressing
// the key here would do anything.

function stubCtx() {
  const texts = [];
  const fills = [];
  return {
    texts,
    fills,
    save() {}, restore() {},
    fillRect() {}, strokeRect() {},
    beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, arc() {},
    fill() { fills.push(this._fillStyle); }, stroke() {},
    fillText(text, x, y) { texts.push({ text, x, y }); },
    set fillStyle(v) { this._fillStyle = v; },
    get fillStyle() { return this._fillStyle; },
    set strokeStyle(_v) {}, set lineWidth(_v) {}, set font(_v) {},
    set textBaseline(_v) {}, set textAlign(_v) {},
  };
}

function draw(chest, player) {
  const ctx = stubCtx();
  const rs = new RenderSystem({ getContext: () => ctx }, null);
  rs.drawWorldChest(chest, player);
  return ctx;
}

const AT = (x, y) => ({ x, y, width: 64, height: 64 });

describe("drawWorldChest", () => {
  it("labels each server state distinctly", () => {
    const label = (state) => draw({ id: "c", x: 0, y: 0, state }, null).texts[0].text;
    // 'locked' means the guard is still alive -- a player who cannot tell that
    // from 'unlocked' walks into a fight they did not choose.
    expect(label("locked")).toBe("Treasure (guarded)");
    expect(label("unlocked")).toBe("Treasure");
    expect(label("opened")).toBe("Looted");
  });

  it("colours the body by state so it reads across a clearing", () => {
    const body = (state) => draw({ id: "c", x: 0, y: 0, state }, null).fills[0];
    expect(new Set([body("locked"), body("unlocked"), body("opened")]).size).toBe(3);
  });

  it("defaults a stateless entry to locked rather than drawing an openable chest", () => {
    expect(draw({ id: "c", x: 0, y: 0 }, null).texts[0].text).toBe("Treasure (guarded)");
  });

  it("shows the open hint only when the player is near", () => {
    const hint = (ctx) => ctx.texts.some((t) => t.text === "[f] open");
    // Player centre is x+width/2, y+height/2 -- the same point the authority
    // measures from.
    expect(hint(draw({ id: "c", x: 100, y: 100, state: "unlocked" }, AT(68, 68)))).toBe(true);
    expect(hint(draw({ id: "c", x: 100, y: 100, state: "unlocked" }, AT(900, 900)))).toBe(false);
  });

  it("never hints at an already-looted chest, however close the player stands", () => {
    const ctx = draw({ id: "c", x: 100, y: 100, state: "opened" }, AT(68, 68));
    expect(ctx.texts.some((t) => t.text === "[f] open")).toBe(false);
  });
});
