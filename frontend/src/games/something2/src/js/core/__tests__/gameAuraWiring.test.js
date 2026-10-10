// Source gate (vitest is node-env, Game.js needs a canvas). It cannot prove the
// path RUNS -- Task 8's browser pass does -- but it fails if a consumer is
// dropped. Each regex names the exact consumer, not just the import.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const src = fs.readFileSync(path.join(__dirname, "..", "Game.js"), "utf8");
describe("Game.js aura wiring (SOMET-606)", () => {
  it("reconcile predicts with the server speed multiplier", () => {
    expect(src).toMatch(/speed:\s*PLAYER_SPEED_EFFECTIVE\s*\*\s*this\.selfSpeedMult/);
  });
  it("the local player predicts with it too, assigned every frame", () => {
    expect(src).toMatch(/this\.player\.auraSpeedMult\s*=\s*this\.selfSpeedMult/);
    expect(src).toMatch(/this\.selfSpeedMult\s*=\s*selfSpeedMult\(msg\)/);
  });
  it("HUD rows are rebuilt every frame and passed to the renderer", () => {
    expect(src).toMatch(/this\.auraDebuffRows\s*=\s*debuffHudEntries\(msg\.debuffs\)/);
    expect(src).toMatch(/activeBuffs:[^\n]*\.\.\.this\.auraDebuffRows/);
  });
  it("world switch and frames without self reset the slow and rows", () => {
    const init = src.slice(src.indexOf("async initChunked("));
    expect(init.slice(0, 1500)).toMatch(/resetSelfAura\(this\)/);
    const ws = src.slice(src.indexOf("this.selfSpeedMult = selfSpeedMult(msg)"));
    expect(ws.slice(0, 6000)).toMatch(/else\s*\{\s*(\/\/[^\n]*\n\s*)*resetSelfAura\(this\)/);
  });
});
