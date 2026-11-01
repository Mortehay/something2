import { describe, it, expect } from "vitest";
import { synergyLines } from "../synergyText.js";
import { SKILLS } from "../../core/skillsData.js";

describe("synergyLines", () => {
  it("is empty for no skill", () => {
    expect(synergyLines(null)).toEqual([]);
  });
  it("caps each group at 2 and uses the expected shape", () => {
    let any = false;
    for (const s of SKILLS) {
      const lines = synergyLines(s);
      expect(lines.filter((l) => l.startsWith("Starts:")).length).toBeLessThanOrEqual(2);
      expect(lines.filter((l) => l.startsWith("Finishes:")).length).toBeLessThanOrEqual(2);
      for (const l of lines) {
        any = true;
        expect(l).toMatch(/^(Starts: .+ \(-> .+, x\d\.\d\d\)|Finishes: .+ \(after .+, x\d\.\d\d\))$/);
      }
    }
    expect(any).toBe(true);
  });
});
