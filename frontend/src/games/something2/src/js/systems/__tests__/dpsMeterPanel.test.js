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
  it("handles buffs, skills without numbers, no weapon, weapon", () => {
    expect(damageLine({ type: "buff" }, 50)).toBeNull();
    expect(damageLine({ id: "x", type: "melee" }, 50)).toBeNull();
    const sk = { id: "x", type: "melee", cast: 40, hitRef: 8, hits: 1 };
    expect(damageLine(sk, 0)).toBe("Damage 34 (no weapon bonus)");
    // share 15%: 40 x 0.85 + 50 x (40 / 8) x 0.15 = 71.5
    expect(damageLine(sk, 50)).toBe("Damage 71.5 (15% scales with your weapon, 50)");
    const multi = { ...sk, hits: 4 };
    expect(damageLine(multi, 50)).toBe("Damage 17.9 x 4 hits (71.5 total) (15% scales with your weapon, 50)");
    // the average weapon of the skill's level changes nothing: that is what "average" means
    expect(skillDamagePreview(sk, 8).total).toBeCloseTo(40, 9);
  });
});

describe("scalesWithLine", () => {
  it("names the skill's attribute, and says nothing for a buff or an unknown attribute", async () => {
    const { scalesWithLine } = await import("../skillDamageLine.js");
    expect(scalesWithLine({ type: "melee", attribute: "strength" })).toBe("Scales with STR");
    expect(scalesWithLine({ type: "magic", attribute: "charisma" })).toBe("Scales with CHA");
    expect(scalesWithLine({ type: "buff", attribute: "strength" })).toBeNull();
    expect(scalesWithLine({ type: "melee" })).toBeNull();
    expect(scalesWithLine(null)).toBeNull();
  });
});
