import { describe, it, expect } from "vitest";
import { Player } from "./Player.js";

// SOMET-606: local prediction must move at the server's slowed rate, or the
// reconcile snaps the player back every frame.
const openMap = { isWalkable: () => true, speedAt: () => 1 };
describe("Player.update with an aura slow", () => {
  it("a 0.6 auraSpeedMult moves 0.6x as far as none", () => {
    const a = new Player(); a.x = 0; a.y = 0;
    a.update(0.05, { d: true }, openMap, false);
    const b = new Player(); b.x = 0; b.y = 0; b.auraSpeedMult = 0.6;
    b.update(0.05, { d: true }, openMap, false);
    expect(a.x).toBeGreaterThan(0);
    expect(b.x).toBeCloseTo(a.x * 0.6, 6);
  });
});
