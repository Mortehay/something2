import { describe, it, expect } from "vitest";
import { bossDrawSize, BOSS_ART_SCALE } from "../bossDrawSize.js";
import { entityScreenRect } from "../../systems/inspect.js";

describe("bossDrawSize", () => {
  it("scales up when display is missing, equal or smaller than the hitbox", () => {
    expect(bossDrawSize(96, 96, 96)).toBe(96 * BOSS_ART_SCALE);
    expect(bossDrawSize(null, 96, 96)).toBe(96 * BOSS_ART_SCALE);
    expect(bossDrawSize(40, 96, 96)).toBe(96 * BOSS_ART_SCALE);
  });

  it("keeps a display size already above the hitbox", () => {
    expect(bossDrawSize(160, 96, 96)).toBe(160);
  });

  it("with no hitbox uses the display size, then the fallback", () => {
    expect(bossDrawSize(80, undefined, 96)).toBe(80);
    expect(bossDrawSize(undefined, undefined, 96)).toBe(96);
    expect(bossDrawSize(0, 0, 96)).toBe(96);
  });
});

describe("the inspect hit area follows the drawn boss", () => {
  it("covers the scaled art of a boss, and is unchanged for an ordinary creature", () => {
    const boss = { bossTier: "world", x: 0, y: 0, width: 96, height: 96, displayWidth: 96, displayHeight: 96 };
    expect(entityScreenRect(boss)).toMatchObject({ w: 144, h: 144 });
    const creature = { bossTier: null, x: 0, y: 0, width: 48, height: 48 };
    expect(entityScreenRect(creature)).toMatchObject({ w: 48, h: 48 });
  });
});
