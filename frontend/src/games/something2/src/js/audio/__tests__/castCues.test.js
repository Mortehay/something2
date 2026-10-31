import { describe, it, expect } from "vitest";
import { CUES, cueDuration, playCue } from "../castCues.js";

function fakeCtx() {
  const made = [];
  const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {} });
  return {
    made,
    currentTime: 10,
    createOscillator: () => { const o = { type: "", frequency: param(), connect() {}, start() { o.started = true; }, stop() { o.stopped = true; } }; made.push(o); return o; },
    createGain: () => ({ gain: param(), connect() {} }),
  };
}

describe("cast cues", () => {
  it("the start cue lasts exactly the cast", () => {
    expect(cueDuration("cast-start")).toBe(2.5);
    expect(cueDuration("nope")).toBe(0);
  });

  it("every cue has audible, bounded voices", () => {
    for (const [name, voices] of Object.entries(CUES)) {
      expect(voices.length, name).toBeGreaterThan(0);
      for (const v of voices) {
        expect(v.gain).toBeGreaterThan(0);
        expect(v.gain).toBeLessThanOrEqual(0.1);
        expect(v.f0).toBeGreaterThan(40);
        expect(v.f1).toBeLessThan(4000);
        expect(v.dur).toBeGreaterThan(0);
      }
    }
  });

  it("playCue starts one oscillator per voice and returns a stop that ends them", () => {
    const ctx = fakeCtx();
    const stop = playCue(ctx, { connect() {} }, "cast-ready");
    expect(ctx.made.length).toBe(CUES["cast-ready"].length);
    expect(ctx.made.every((o) => o.started)).toBe(true);
    ctx.made.forEach((o) => { o.stopped = false; });
    stop();
    expect(ctx.made.every((o) => o.stopped)).toBe(true);
  });

  it("an unknown cue or a missing context plays nothing", () => {
    expect(playCue(fakeCtx(), {}, "nope")).toBeNull();
    expect(playCue(null, {}, "cast-start")).toBeNull();
  });
});
