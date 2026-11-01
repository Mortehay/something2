import { describe, it, expect } from "vitest";
import { formFromBuffs } from "../activeForm.js";

describe("formFromBuffs", () => {
  it("reads the form buff", () => {
    expect(formFromBuffs([{ id: "x" }, { id: "dru_wolf_form" }])).toBe("wolf");
    expect(formFromBuffs([{ id: "dru_bear_form" }])).toBe("bear");
    expect(formFromBuffs([{ id: "dru_hawk_form" }])).toBe("hawk");
  });
  it("is null with no form buff or no buffs at all", () => {
    expect(formFromBuffs([])).toBeNull();
    expect(formFromBuffs([{ id: "dru_barkskin" }])).toBeNull();
    expect(formFromBuffs(undefined)).toBeNull();
    expect(formFromBuffs(null)).toBeNull();
  });
});
