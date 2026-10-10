import { describe, it, expect } from "vitest";
import { CreatureManager } from "../CreatureManager.js";

describe("CreatureManager boss fields (SOMET-603)", () => {
  it("keeps tier, element, name and the server box size from the intro record", () => {
    const cm = new CreatureManager(null);
    cm.applySnapshot([{ id: "b", type: "zzBoss", name: "zzBoss", x: 0, y: 0, hp: 9, maxHp: 9,
      bossTier: "world", element: "ice", width: 96, height: 96 }]);
    const c = cm.all()[0];
    expect(c.bossTier).toBe("world");
    expect(c.element).toBe("ice");
    expect(c.name).toBe("zzBoss");
    expect(c.width).toBe(96);
    expect(c.height).toBe(96);
  });

  it("holds them on later frames that omit them", () => {
    const cm = new CreatureManager(null);
    cm.applySnapshot([{ id: "b", type: "zzBoss", name: "zzBoss", x: 0, y: 0, hp: 9, maxHp: 9,
      bossTier: "world", element: "ice", width: 96, height: 96 }]);
    cm.applySnapshot([{ id: "b", x: 5, y: 5, hp: 8, facing: "S", mode: "chase" }]);
    const c = cm.all()[0];
    expect(c.bossTier).toBe("world");
    expect(c.width).toBe(96);
  });

  it("an ordinary creature defaults to a 48 box, no tier, name = type", () => {
    const cm = new CreatureManager(null);
    cm.applySnapshot([{ id: "w", type: "Wolf", x: 0, y: 0, hp: 5, maxHp: 5 }]);
    const c = cm.all()[0];
    expect(c.width).toBe(48);
    expect(c.bossTier).toBe(null);
    expect(c.element).toBe(null);
    expect(c.name).toBe("Wolf");
  });
});
