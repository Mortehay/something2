import { describe, it, expect } from "vitest";
import { selfSpeedMult, debuffHudEntries, prettyAuraName, resetSelfAura, newlyAppliedAuraNames } from "../auraDebuffs.js";

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

describe("resetSelfAura (SOMET-606 fix)", () => {
  it("clears a slowed state back to speed 1 and no rows", () => {
    const g = { selfSpeedMult: 0.6, player: { debuffSpeedMult: 0.6 }, auraDebuffRows: [{ id: "aura:x" }] };
    resetSelfAura(g);
    expect(g.selfSpeedMult).toBe(1);
    expect(g.player.debuffSpeedMult).toBe(1);
    expect(g.auraDebuffRows).toEqual([]);
  });
  it("also clears selfAuraNames (SOMET-607), so a world switch does not replay old auras as newly-applied", () => {
    const g = { selfAuraNames: new Set(["dread"]) };
    resetSelfAura(g);
    expect(g.selfAuraNames).toEqual(new Set());
  });
  it("debuffHudEntries skips null entries", () => {
    expect(debuffHudEntries([null, { n: "dread", d: 1, f: 0.7, s: 1 }]).map((r) => r.id)).toEqual(["aura:dread"]);
  });
});

// SOMET-607 (S5, spec §4.4): there is no one-shot wire event for "you just
// entered an aura" -- Game.js diffs this frame's debuff names against last
// frame's to synthesize one.
describe("newlyAppliedAuraNames (SOMET-607)", () => {
  it("a name absent last frame and present now is newly applied", () => {
    expect(newlyAppliedAuraNames(new Set(), [{ n: "dread" }])).toEqual(["dread"]);
  });
  it("a name already active last frame is not re-reported", () => {
    expect(newlyAppliedAuraNames(new Set(["dread"]), [{ n: "dread" }])).toEqual([]);
  });
  it("one held, one new: only the new one is reported", () => {
    expect(newlyAppliedAuraNames(new Set(["dread"]), [{ n: "dread" }, { n: "blight_field" }])).toEqual(["blight_field"]);
  });
  it("a name that drops off and is never reported again until it reapplies", () => {
    expect(newlyAppliedAuraNames(new Set(["dread"]), [])).toEqual([]);
  });
  it("accepts a plain array or iterable in place of a Set for prevNames", () => {
    expect(newlyAppliedAuraNames(["dread"], [{ n: "dread" }, { n: "blight_field" }])).toEqual(["blight_field"]);
  });
  it("empty / missing debuffs, null entries and a null/undefined n are all handled, never a throw", () => {
    expect(newlyAppliedAuraNames(new Set(), undefined)).toEqual([]);
    expect(newlyAppliedAuraNames(new Set(), [null, { n: "dread" }, { n: null }])).toEqual(["dread"]);
  });
});
