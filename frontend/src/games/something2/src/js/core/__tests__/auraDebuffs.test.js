import { describe, it, expect } from "vitest";
import { selfSpeedMult, debuffHudEntries, prettyAuraName } from "../auraDebuffs.js";

describe("selfSpeedMult (SOMET-606)", () => {
  it("reads a finite positive speedMult, else 1", () => {
    expect(selfSpeedMult({ speedMult: 0.6 })).toBe(0.6);
    expect(selfSpeedMult({})).toBe(1);
    expect(selfSpeedMult({ speedMult: 0 })).toBe(1);
    expect(selfSpeedMult({ speedMult: NaN })).toBe(1);
    expect(selfSpeedMult(null)).toBe(1);
  });
});

describe("debuffHudEntries (SOMET-606)", () => {
  it("one persistent HUD row per aura, with what it does", () => {
    const rows = debuffHudEntries([
      { n: "blight_field", d: 0.8, f: 1, s: 0.6, dps: 4, el: "fire" },
      { n: "dread", d: 1, f: 0.7, s: 1 },
    ]);
    expect(rows.map((r) => r.id)).toEqual(["aura:blight_field", "aura:dread"]);
    expect(rows[0].nameEn).toBe("Blight Field");
    expect(rows[0].persistent).toBe(true);
    expect(rows[0].detail).toBe("-40% spd -20% dmg 4 fire/s");
    expect(rows[1].detail).toBe("-30% def");
    expect(rows[0].icon).toBe("🔥");
    expect(rows[1].icon).toBe("☠️");
  });
  it("empty / missing -> []", () => {
    expect(debuffHudEntries(undefined)).toEqual([]);
    expect(debuffHudEntries([])).toEqual([]);
  });
  it("prettyAuraName title-cases snake case", () => {
    expect(prettyAuraName("pack_leader")).toBe("Pack Leader");
  });
});
