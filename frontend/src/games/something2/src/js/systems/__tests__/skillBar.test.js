import { describe, it, expect, vi } from "vitest";
import { RenderSystem } from "../RenderSystem.js";
import { GAME_WIDTH, GAME_HEIGHT } from "../../core/constants.js";

describe("RenderSystem _drawSkillBar", () => {
  it("renders skill panel with 9 numbered slots directly above the level bar", () => {
    const rs = Object.create(RenderSystem.prototype);
    const strokeTexts = [];
    const fillTexts = [];
    const rects = [];

    const mockCtx = {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      closePath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      fillRect: vi.fn((x, y, w, h) => rects.push({ x, y, w, h })),
      rect: vi.fn((x, y, w, h) => rects.push({ x, y, w, h })),
      strokeRect: vi.fn((x, y, w, h) => rects.push({ x, y, w, h })),
      strokeText: vi.fn((text, x, y) => strokeTexts.push({ text, x, y })),
      fillText: vi.fn((text, x, y) => fillTexts.push({ text, x, y })),
      createLinearGradient: vi.fn(() => ({
        addColorStop: vi.fn(),
      })),
      font: "",
      lineWidth: 1,
      strokeStyle: "",
      fillStyle: "",
      textAlign: "",
      textBaseline: "",
    };

    rs.ctx = mockCtx;
    rs._drawSkillBar();

    // Verify 9 slot hotkey numbers from 1 to 9 are rendered
    const slotKeys = fillTexts.map(t => t.text);
    for (let i = 1; i <= 9; i++) {
      expect(slotKeys).toContain(String(i));
    }

    // Verify panel is positioned above the level bar (which sits at GAME_HEIGHT - 22)
    // Skill panel height is 46, panelY is GAME_HEIGHT - 22 - 14 - 46 = 638
    const expectedPanelY = GAME_HEIGHT - 22 - 14 - 46;
    expect(rects[0].y).toBe(expectedPanelY);
    expect(rects[0].x).toBe(Math.round((GAME_WIDTH - (9 * 36 + 8 * 5 + 12)) / 2));
  });

  it("safely handles being called without ctx or with empty skills", () => {
    const rs = Object.create(RenderSystem.prototype);
    rs.ctx = null;
    expect(() => rs._drawSkillBar()).not.toThrow();
  });

  it("renders assigned skills and highlights active form correctly", () => {
    const rs = Object.create(RenderSystem.prototype);
    const fillTexts = [];
    const mockCtx = {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      closePath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      fillRect: vi.fn(),
      rect: vi.fn(),
      strokeRect: vi.fn(),
      strokeText: vi.fn(),
      fillText: vi.fn((text, x, y) => fillTexts.push({ text, x, y })),
      createLinearGradient: vi.fn(() => ({
        addColorStop: vi.fn(),
      })),
      font: "",
      lineWidth: 1,
      strokeStyle: "",
      fillStyle: "",
      textAlign: "",
      textBaseline: "",
    };

    rs.ctx = mockCtx;
    const skills = new Map([
      [1, { id: "dru_bear_form", nameEn: "Bear Form", icon: "🐻" }],
      [2, { id: "war_crushing_blow", nameEn: "Crushing Blow", icon: "🔨" }],
    ]);

    expect(() => rs._drawSkillBar(skills, [], null, null, "bear", 1)).not.toThrow();

    const texts = fillTexts.map(t => t.text);
    expect(texts).toContain("🐻");
    expect(texts).toContain("🔨");
    expect(texts).toContain("ON"); // Active transformation badge
  });
});
