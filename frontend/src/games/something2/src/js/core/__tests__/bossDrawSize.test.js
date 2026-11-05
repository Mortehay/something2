import { describe, it, expect } from "vitest";
import { bossDrawSize, PLAYER_DRAW_SIZE } from "../bossDrawSize.js";
import { Player } from "../../entities/Player.js";
import { entityScreenRect } from "../../systems/inspect.js";

describe("bossDrawSize", () => {
  it("sizes each tier relative to the player", () => {
    expect(bossDrawSize("miniboss")).toBe(PLAYER_DRAW_SIZE * 1.5);
    expect(bossDrawSize("dungeon_elite")).toBe(PLAYER_DRAW_SIZE * 2);
    expect(bossDrawSize("dungeon_end")).toBe(PLAYER_DRAW_SIZE * 2.5);
    expect(bossDrawSize("world")).toBe(PLAYER_DRAW_SIZE * 3);
  });

  it("every tier ends up bigger than the largest seeded hitbox of that tier", () => {
    expect(bossDrawSize("miniboss")).toBeGreaterThan(72);
    expect(bossDrawSize("dungeon_elite")).toBeGreaterThan(80);
    expect(bossDrawSize("dungeon_end")).toBeGreaterThan(112);
    expect(bossDrawSize("world")).toBeGreaterThan(96);
  });

  it("ignores a seeded display size below the tier's, and keeps one above it", () => {
    expect(bossDrawSize("world", 96)).toBe(192);
    expect(bossDrawSize("world", 240)).toBe(240);
  });

  it("an unknown tier still draws as a boss", () => {
    expect(bossDrawSize("new_tier")).toBe(PLAYER_DRAW_SIZE * 1.5);
  });

  it("matches the size the player is really built at", () => {
    const p = new Player();
    expect(p.width).toBe(PLAYER_DRAW_SIZE);
    expect(p.height).toBe(PLAYER_DRAW_SIZE);
  });
});

describe("the inspect hit area follows the drawn boss", () => {
  it("covers the scaled art of a boss, and is unchanged for an ordinary creature", () => {
    const boss = { bossTier: "world", x: 0, y: 0, width: 96, height: 96, displayWidth: 96, displayHeight: 96 };
    expect(entityScreenRect(boss)).toMatchObject({ w: 192, h: 192 });
    const creature = { bossTier: null, x: 0, y: 0, width: 48, height: 48 };
    expect(entityScreenRect(creature)).toMatchObject({ w: 48, h: 48 });
  });
});
