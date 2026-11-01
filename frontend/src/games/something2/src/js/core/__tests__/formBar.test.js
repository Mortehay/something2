import { describe, it, expect } from "vitest";
import { buildFormBar, formFromBuffs } from "../formBar.js";

const sk = (id, reqLvl) => ({ id, class: "Druid", reqLvl });
describe("formFromBuffs", () => {
  it("reads the form buff", () => {
    expect(formFromBuffs([{ id: "x" }, { id: "dru_wolf_form" }])).toBe("wolf");
    expect(formFromBuffs([])).toBeNull();
    expect(formFromBuffs(undefined)).toBeNull();
  });
});
describe("buildFormBar", () => {
  it("is empty outside a form", () => {
    expect(buildFormBar({ activeForm: null, ownedSkills: [sk("dru_bear_maul", 1)] }).size).toBe(0);
  });
  it("orders by reqLvl, filters by form, form skill last", () => {
    const owned = [sk("dru_bear_b", 10), sk("dru_bear_a", 3), sk("dru_hawk_x", 1), sk("dru_bear_form", 1), sk("dru_maul", 5), { id: "fire", reqLvl: 1 }];
    const bar = buildFormBar({ activeForm: "bear", ownedSkills: owned, formSkillId: "dru_bear_form" });
    expect([...bar.entries()].map(([k, v]) => `${k}:${v.id}`)).toEqual(["1:dru_bear_a", "2:dru_maul", "3:dru_bear_b", "9:dru_bear_form"]);
  });
  it("keeps at most 8 form skills plus the form skill in slot 9", () => {
    const owned = Array.from({ length: 12 }, (_, i) => sk(`dru_bear_s${i}`, i)).concat(sk("dru_bear_form", 1));
    const bar = buildFormBar({ activeForm: "bear", ownedSkills: owned, formSkillId: "dru_bear_form" });
    expect(bar.size).toBe(9);
    expect(bar.get(9).id).toBe("dru_bear_form");
    expect(bar.get(8).id).toBe("dru_bear_s7");
  });
});
