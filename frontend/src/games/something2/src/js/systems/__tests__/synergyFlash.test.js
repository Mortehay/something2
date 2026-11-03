import { describe, it, expect } from "vitest";
import { layoutSynergyFlash, SYNERGY_FLASH_MS } from "../synergyFlash.js";

describe("layoutSynergyFlash", () => {
  const fx = { name: "Shatter", mult: 1.3, chain: 2, at: 1000 };
  it("is null without fx, when expired, or with nothing to show", () => {
    expect(layoutSynergyFlash(null, 0)).toBeNull();
    expect(layoutSynergyFlash(fx, 1000 + SYNERGY_FLASH_MS)).toBeNull();
    expect(layoutSynergyFlash({ name: null, mult: 1, chain: 0, at: 1000 }, 1100)).toBeNull();
  });
  it("builds title and chain text", () => {
    const L = layoutSynergyFlash(fx, 1100);
    expect(L.title).toBe("SHATTER x1.30");
    expect(L.chainText).toBe("Chain x2 (+12%)");
    expect(L.chainY).toBeGreaterThan(L.y);
  });
  it("chain-only has no title and fades and rises with age", () => {
    const a = layoutSynergyFlash({ name: null, mult: 1.06, chain: 1, at: 0 }, 100);
    const b = layoutSynergyFlash({ name: null, mult: 1.06, chain: 1, at: 0 }, 1700);
    expect(a.title).toBeNull();
    expect(a.chainText).toBe("Chain x1 (+6%)");
    expect(b.y).toBeLessThan(a.y);
    expect(b.alpha).toBeLessThan(a.alpha);
  });
});
