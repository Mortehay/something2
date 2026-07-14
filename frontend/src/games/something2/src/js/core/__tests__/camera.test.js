import { describe, it, expect } from "vitest";
import { Camera } from "../Camera.js";
import { worldToScreen } from "../iso.js";
import { GAME_WIDTH, GAME_HEIGHT } from "../constants.js";

function fakeCtx() {
  return {
    calls: [],
    save() { this.calls.push(["save"]); },
    restore() { this.calls.push(["restore"]); },
    translate(x, y) { this.calls.push(["translate", x, y]); },
  };
}

describe("iso camera", () => {
  it("stores the projected screen center of the target", () => {
    const cam = new Camera();
    const target = { x: 5000, y: 5000, width: 64, height: 64 };
    cam.update(target);
    const expected = worldToScreen(target.x + 32, target.y + 32);
    expect(cam.screenX).toBeCloseTo(expected.x, 6);
    expect(cam.screenY).toBeCloseTo(expected.y, 6);
  });

  it("apply() translates so the target sits at canvas center", () => {
    const cam = new Camera();
    cam.update({ x: 0, y: 0, width: 0, height: 0 }); // projects to (0,0)
    const ctx = fakeCtx();
    cam.apply(ctx);
    const translate = ctx.calls.find((c) => c[0] === "translate");
    expect(translate[1]).toBeCloseTo(GAME_WIDTH / 2, 6);
    expect(translate[2]).toBeCloseTo(GAME_HEIGHT / 2, 6);
  });
});
