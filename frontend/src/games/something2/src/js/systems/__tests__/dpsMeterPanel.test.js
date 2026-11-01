import { describe, it, expect } from "vitest";
import { layoutDpsMeter, drawDpsMeter } from "../dpsMeterPanel.js";
import { isTrainingDummy, drawTrainingDummy } from "../trainingDummyArt.js";
import { damageLine } from "../skillDamageLine.js";
import { skillDamagePreview } from "../../core/skillsData.js";

const stub = () => new Proxy({ calls: [] }, {
  get: (t, k) => (k in t ? t[k] : (...a) => { t.calls.push([k, a]); return { addColorStop() {} }; }),
  set: (t, k, v) => { t[k] = v; return true; },
});
const m = { dps: 123.4, avg: 110, total: 4500, hits: 30, max: 80, secs: 41.2, at: 1000 };

describe("dps meter", () => {
  it("hides without data or after 8s", () => {
    expect(layoutDpsMeter(null, 0)).toBeNull();
    expect(layoutDpsMeter(m, 9000)).toBeNull();
  });
  it("formats lines and idles after 1.5s", () => {
    const a = layoutDpsMeter(m, 1200);
    expect(a.big).toBe("DPS 123");
    expect(a.line1).toContain("Max hit 80");
    expect(a.line2).toContain("41.2s");
    expect(a.line2).toContain("30 hits");
    expect(a.idle).toBe(false);
    expect(layoutDpsMeter(m, 3000).title).toContain("(idle)");
  });
  it("draws", () => {
    const c = stub();
    expect(drawDpsMeter(c, m, 1200)).not.toBeNull();
    expect(c.calls.some(([k]) => k === "fillText")).toBe(true);
    expect(drawDpsMeter(stub(), m, 20000)).toBeNull();
  });
});

describe("training dummy art", () => {
  it("detects and draws", () => {
    expect(isTrainingDummy({ type: "Training Dummy" })).toBe(true);
    expect(isTrainingDummy({ dummy: 1 })).toBe(true);
    expect(isTrainingDummy({ type: "Wolf" })).toBe(false);
    const c = stub();
    drawTrainingDummy(c, 0, 0, 64, 64);
    expect(c.calls.filter(([k]) => k === "arc").length).toBeGreaterThan(4);
  });
});

describe("damageLine", () => {
  it("handles buffs, no weapon, weapon", () => {
    expect(damageLine({ type: "buff" }, 50)).toBeNull();
    const sk = { id: "x", type: "melee", damage: 10 };
    const p = skillDamagePreview(sk, 50);
    if (p) {
      expect(damageLine(sk, 0)).toMatch(/^Damage .* \(no weapon bonus\)$/);
      expect(damageLine(sk, 50)).toMatch(/^Damage .* weapon \(50\) = /);
    }
  });
});
