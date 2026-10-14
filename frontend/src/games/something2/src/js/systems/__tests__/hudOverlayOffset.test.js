import { describe, it, expect, vi } from "vitest";
import { RenderSystem } from "../RenderSystem.js";

describe("HUD overlay layout and vertical non-overlapping stacking", () => {
  function makeRenderSystem() {
    const rs = Object.create(RenderSystem.prototype);
    rs._drawPoEOrb = vi.fn();
    rs._drawPoEDualOrb = vi.fn();
    rs._drawSkillBar = vi.fn();
    rs._drawXpBar = vi.fn();
    return rs;
  }

  it("renderHud offsets active buffs to y=104 when hasTrackedQuest is true", () => {
    const rs = makeRenderSystem();
    rs._drawActiveBuffs = vi.fn();

    const sampleBuffs = [{ id: "buff1", name: "Focus", durationMs: 2000 }];
    rs.renderHud({
      player: { hp: 100, maxHp: 100 },
      activeBuffs: sampleBuffs,
      hasTrackedQuest: true,
    });

    expect(rs._drawActiveBuffs).toHaveBeenCalledTimes(1);
    expect(rs._drawActiveBuffs).toHaveBeenCalledWith(sampleBuffs, 104);
  });

  it("renderHud keeps active buffs at top y=18 when hasTrackedQuest is false", () => {
    const rs = makeRenderSystem();
    rs._drawActiveBuffs = vi.fn();

    const sampleBuffs = [{ id: "buff1", name: "Focus", durationMs: 2000 }];
    rs.renderHud({
      player: { hp: 100, maxHp: 100 },
      activeBuffs: sampleBuffs,
      hasTrackedQuest: false,
    });

    expect(rs._drawActiveBuffs).toHaveBeenCalledTimes(1);
    expect(rs._drawActiveBuffs).toHaveBeenCalledWith(sampleBuffs, 18);
  });

  it("_drawActiveBuffs renders each buff container at the specified startY offset", () => {
    const rects = [];
    const dummyCtx = {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      roundRect: (x, y, w, h, r) => {
        rects.push({ x, y, w, h, r });
      },
      createLinearGradient: () => ({
        addColorStop: () => {},
      }),
      fill: vi.fn(),
      stroke: vi.fn(),
      fillRect: vi.fn(),
      fillText: vi.fn(),
      measureText: () => ({ width: 40 }),
    };

    const rs = Object.create(RenderSystem.prototype);
    rs.ctx = dummyCtx;

    const sampleBuffs = [
      { id: "focus_1", name: "Focus", durationMs: 2000 },
      { id: "focus_2", name: "Protection", durationMs: 5000 },
    ];

    // With startY = 104 (below Quest Tracker which is at y=16..94)
    rs._drawActiveBuffs(sampleBuffs, 104);

    // The main container rect for buff 0 should be at y=104, buff 1 at y=104 + (34 + 6) = 144
    const mainContainers = rects.filter((r) => r.w === 145 && r.h === 34);
    expect(mainContainers).toHaveLength(2);
    expect(mainContainers[0].x).toBe(18);
    expect(mainContainers[0].y).toBe(104);
    expect(mainContainers[1].x).toBe(18);
    expect(mainContainers[1].y).toBe(144);

    // Quest Tracker card sits at y = 16..94. Ensure buff containers do not overlap:
    expect(mainContainers[0].y).toBeGreaterThan(94);
  });
});
