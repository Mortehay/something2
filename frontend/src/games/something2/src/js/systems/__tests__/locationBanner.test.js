import { describe, it, expect } from "vitest";
import { RenderSystem } from "../RenderSystem.js";
import { Game } from "../../core/Game.js";

function drawBanner(banner) {
  const texts = [];
  const ctx = {
    save() {}, restore() {}, strokeText() {},
    fillText: (t) => texts.push(t),
  };
  const rs = Object.create(RenderSystem.prototype);
  rs.ctx = ctx;
  rs.renderLocationBanner(banner);
  return texts;
}

describe("arrival banner", () => {
  const announce = (loc) => {
    const g = Object.create(Game.prototype);
    g._announceLocation(loc);
    return g.locationBanner;
  };

  it("shows the monster level band as min-max", () => {
    expect(announce({ name: "Thornbriar Reach", levelMin: 3, levelMax: 9 }).levelText).toBe("Monsters: level 3-9");
  });

  it("collapses an equal band to a single level and tolerates a missing band", () => {
    expect(announce({ name: "Vale Crossing", levelMin: 1, levelMax: 1 }).levelText).toBe("Monsters: level 1");
    expect(announce({ name: "Somewhere", levelMin: null, levelMax: null }).levelText).toBeNull();
  });

  it("shows nothing without a place name", () => {
    expect(announce({ levelMin: 1, levelMax: 2 })).toBeNull();
    expect(announce(undefined)).toBeNull();
  });

  it("draws the name and the level line while it is live, nothing once expired", () => {
    const now = performance.now();
    const live = drawBanner({ name: "Rimehollow", levelText: "Monsters: level 3-9", startedAt: now - 2000, expiresAt: now + 2000 });
    expect(live).toContain("Rimehollow");
    expect(live).toContain("Monsters: level 3-9");
    expect(drawBanner({ name: "Rimehollow", levelText: "x", startedAt: now - 9000, expiresAt: now - 1 })).toEqual([]);
  });
});
